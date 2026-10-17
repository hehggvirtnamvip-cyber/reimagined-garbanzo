/**
 * ========================================================================
 * HOANG VIP v12 - BALANCED DETECTION - RENDER-SAFE
 * ========================================================================
 * FIX BIAS "Tài nhiều, Xỉu ít":
 *   ✅ Cầu TÀI riêng: đảo bệt X, momentum X→T, đối xứng X-T-X
 *   ✅ Cầu XỈU riêng: đảo bệt T, momentum T→X, đối xứng T-X-T
 *   ✅ Cầu CHUNG: 1-1, 2-2, 3-3, 4-4, 1-2-1...
 *   ✅ Balance Guard: nếu predict lệch > 62% trong 50 phiên → force balance
 *   ✅ Algo bias tracking: algo nào bias Tài/Xỉu → giảm weight
 *
 * 18 THUẬT TOÁN + ENSEMBLE + REGIME + BALANCE
 * Run: npm i express axios && node server.js
 * ========================================================================
 */

'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ============ CORS ============
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============ CONFIG ============
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = 3000;
const API_TIMEOUT_MS = 8000;
const FETCH_RETRIES = 3;
const MIN_CONFIDENCE = 0.55;
const MIN_ALGO_TOTAL = 15;
const SNAPSHOT_INTERVAL = 100;

// ✅ Balance guard config
const BALANCE_WINDOW = 50;         // Look back 50 phiên
const BALANCE_THRESHOLD = 0.62;    // Nếu lệch > 62% → force balance
const BALANCE_FORCE = 0.65;        // Khi force → 65% predict theo phía thiếu

// ✅ Bias penalty cho algo
const ALGO_BIAS_PENALTY = 0.30;    // Giảm 30% weight nếu algo bias

const API_KEY = process.env.API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || '';
const CUSTOM_WEBHOOK = process.env.CUSTOM_WEBHOOK || '';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 300);
const rateLimitStore = new Map();

const CB_LOSS_STREAK = 5;
const CB_COOLDOWN = 10;

const APIS = {
  md5: process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: process.env.API_TAIXIU || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

// ============ FS SAFE ============
const IS_RENDER = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
let DB_DIR = process.env.DB_DIR || (IS_RENDER ? '/tmp/hoang_vip_data' : __dirname);
let FILESYSTEM_WRITABLE = true;

function tryInitDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const testFile = path.join(dir, '.write_test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return true;
  } catch (e) {
    console.warn(`[FS] Cannot use ${dir}: ${e.message}`);
    return false;
  }
}

if (!tryInitDir(DB_DIR)) {
  DB_DIR = '/tmp/hoang_vip_data';
  if (!tryInitDir(DB_DIR)) {
    console.warn(`[FS] /tmp not writable — IN-MEMORY mode`);
    FILESYSTEM_WRITABLE = false;
  }
}

console.log(`[FS] DB_DIR=${DB_DIR} | Writable=${FILESYSTEM_WRITABLE} | Render=${IS_RENDER}`);

const DB_FILES = {
  md5: path.join(DB_DIR, 'db_md5.json'),
  taixiu: path.join(DB_DIR, 'db_taixiu.json')
};

const MEMORY_STORE = {};

// ============ MIDDLEWARE ============
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const t = Date.now();
  let entry = rateLimitStore.get(ip);
  if (!entry || t > entry.resetAt) { entry = { count: 0, resetAt: t + RATE_LIMIT_WINDOW_MS }; rateLimitStore.set(ip, entry); }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return res.status(429).json({ error: 'Rate limit exceeded' });
  next();
}

function checkApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  const publicPaths = ['/', '/health', '/api/config'];
  if (publicPaths.some(p => req.path === p)) return next();
  if (req.path.startsWith('/api/public/')) return next();
  if (key !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of rateLimitStore) if (t > v.resetAt) rateLimitStore.delete(k);
}, 60 * 1000);

// ============ HELPERS ============
function now() { return new Date().toISOString(); }
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function labelFromTX(code) { return code === 'T' ? 'Tài' : code === 'X' ? 'Xỉu' : null; }

function safeReadJson(fp, fb = null) {
  try {
    if (MEMORY_STORE[fp]) return JSON.parse(JSON.stringify(MEMORY_STORE[fp]));
    if (!FILESYSTEM_WRITABLE) return fb;
    if (!fs.existsSync(fp)) return fb;
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw || !raw.trim()) return fb;
    return JSON.parse(raw);
  } catch (e) { return fb; }
}

function safeAtomicWrite(fp, data) {
  try {
    MEMORY_STORE[fp] = JSON.parse(JSON.stringify(data));
    if (!FILESYSTEM_WRITABLE) return true;
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return true;
  } catch (e) { return true; }
}

function sigmoid(z) {
  if (!Number.isFinite(z)) return 0.5;
  if (z >= 0) { const e = Math.exp(-z); return Number.isFinite(e) ? 1 / (1 + e) : 1; }
  else { const e = Math.exp(z); return Number.isFinite(e) ? e / (1 + e) : 0; }
}
function clamp(x, min = 0, max = 1) {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(Math.max(x, min), max);
}

// ============ DICE ============
function itemToDice(item) {
  if (!item) return [0, 0, 0];
  return [safeInt(item.FirstDice, 0), safeInt(item.SecondDice, 0), safeInt(item.ThirdDice, 0)];
}
function itemToSum(item) {
  if (!item) return 0;
  const d = itemToDice(item);
  const s = d[0] + d[1] + d[2];
  if (s >= 3 && s <= 18) return s;
  if (item.DiceSum !== undefined) { const ds = safeInt(item.DiceSum, 0); if (ds >= 3 && ds <= 18) return ds; }
  return 0;
}
function itemToResult(item) {
  if (!item) return null;
  const sum = itemToSum(item);
  if (sum >= 3 && sum <= 18) return sum >= 11 ? 'T' : 'X';
  return null;
}

// ============ REGIME ============
function detectRegime(seq) {
  if (!seq || seq.length < 20) return { type: 'unknown', confidence: 0 };
  const recent = seq.slice(-30);
  const n = recent.length;
  let transitions = 0;
  for (let i = 1; i < n; i++) if (recent[i] !== recent[i - 1]) transitions++;
  const transitionRate = transitions / (n - 1);
  let maxStreak = 1, curStreak = 1;
  for (let i = 1; i < n; i++) {
    if (recent[i] === recent[i - 1]) curStreak++; else curStreak = 1;
    if (curStreak > maxStreak) maxStreak = curStreak;
  }
  const cntT = recent.filter(x => x === 'T').length;
  const pT = cntT / n;
  const entropy = -((pT || 1e-9) * Math.log2(pT || 1e-9) + ((1 - pT) || 1e-9) * Math.log2((1 - pT) || 1e-9));
  if (maxStreak >= 5) return { type: 'BỆT', confidence: Math.min(maxStreak / 10, 0.9), maxStreak, transitionRate, entropy };
  if (transitionRate >= 0.75) return { type: 'CẦU_1_1', confidence: 0.75, maxStreak, transitionRate, entropy };
  if (transitionRate <= 0.30) return { type: 'BỆT', confidence: 0.65, maxStreak, transitionRate, entropy };
  if (transitionRate >= 0.45 && transitionRate <= 0.55) return { type: 'RANDOM', confidence: 0.6, maxStreak, transitionRate, entropy };
  return { type: 'HỖN_HỢP', confidence: 0.5, maxStreak, transitionRate, entropy };
}

// ========================================================================
// ✅ NEW: CẦU TÀI RIÊNG
// ========================================================================
function algoCauTai(seq) {
  if (!seq || seq.length < 4) return { code: null, conf: 0, reason: 'no_data' };
  const n = seq.length, last = seq[n - 1];

  // 1. Đảo bệt X dài → bắt đầu Tài
  // Nếu vừa có >= 4 Xỉu liên tiếp và vừa gãy (phiên cuối là T)
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6.endsWith('T') && seq.slice(-6, -1).every(x => x === 'X')) {
      return { code: 'T', conf: 0.68, reason: 'TÀI_SAU_BỆT_X' };
    }
  }

  // 2. Momentum X→T: 3 Xỉu → 1 Tài → tiếp tục Tài
  if (n >= 5) {
    const p5 = seq.slice(-5);
    if (p5[0] === 'X' && p5[1] === 'X' && p5[2] === 'X' && p5[3] === 'T' && p5[4] === 'T') {
      return { code: 'T', conf: 0.62, reason: 'TÀI_MOMENTUM' };
    }
  }

  // 3. Cầu đối xứng X-T-X: đang ở T giữa → sang X tiếp
  // (nhưng ngược lại cầu T-X-T sẽ ở algoCauXiu)

  // 4. Cầu Tài mới hình thành: T-X-T-X-T... đang ở T
  if (n >= 7) {
    const p7 = seq.slice(-7).join('');
    if (p7 === 'XTXTXTX') return { code: 'T', conf: 0.68, reason: 'TÀI_1_1_PHASE' };
    if (p7 === 'TXTXTXT') return { code: 'X', conf: 0.68, reason: 'XỈU_1_1_PHASE' };
  }

  // 5. Bệt Tài nhỏ 2-3 đang bắt đầu
  if (n >= 5) {
    const p5 = seq.slice(-5).join('');
    if (p5 === 'XXTTT') return { code: 'T', conf: 0.62, reason: 'TÀI_BỆT_START' };
    if (p5 === 'XXTTT'.replace(/T/g, 'X').replace(/X/g, 'T')) return { code: 'X', conf: 0.62, reason: 'XỈU_BỆT_START' };
  }

  // 6. Cầu 2-2 chuyển phase: đang ở XX → chuyển TT
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6 === 'TTXXTT') return { code: 'X', conf: 0.68, reason: 'TÀI_2_2_PHASE' };
    if (p6 === 'XXTTXX') return { code: 'T', conf: 0.68, reason: 'TÀI_2_2_PHASE' };
  }

  // 7. Reversal after pattern: XT-XT-XT-T (kỳ vọng chu kỳ dài 2)
  if (n >= 4) {
    const p4 = seq.slice(-4).join('');
    if (p4 === 'XTXT') return { code: 'X', conf: 0.58, reason: 'TÀI_1_1_PRED_X' };
    if (p4 === 'TXTX') return { code: 'T', conf: 0.58, reason: 'TÀI_1_1_PRED_T' };
  }

  return { code: null, conf: 0, reason: 'no_signal' };
}

// ========================================================================
// ✅ NEW: CẦU XỈU RIÊNG
// ========================================================================
function algoCauXiu(seq) {
  if (!seq || seq.length < 4) return { code: null, conf: 0, reason: 'no_data' };
  const n = seq.length, last = seq[n - 1];

  // 1. Đảo bệt T dài → bắt đầu Xỉu
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6.endsWith('X') && seq.slice(-6, -1).every(x => x === 'T')) {
      return { code: 'X', conf: 0.68, reason: 'XỈU_SAU_BỆT_T' };
    }
  }

  // 2. Momentum T→X: 3 Tài → 1 Xỉu → tiếp Xỉu
  if (n >= 5) {
    const p5 = seq.slice(-5);
    if (p5[0] === 'T' && p5[1] === 'T' && p5[2] === 'T' && p5[3] === 'X' && p5[4] === 'X') {
      return { code: 'X', conf: 0.62, reason: 'XỈU_MOMENTUM' };
    }
  }

  // 3. Bệt Xỉu mới bắt đầu 2-3
  if (n >= 5) {
    const p5 = seq.slice(-5).join('');
    if (p5 === 'TTXXX') return { code: 'X', conf: 0.62, reason: 'XỈU_BỆT_START' };
    if (p5 === 'XXTTT') return { code: 'T', conf: 0.62, reason: 'TÀI_BỆT_START' };
  }

  // 4. Cầu đối xứng T-X-T: đang ở X giữa → sang T
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6 === 'TXXTXX') return { code: 'T', conf: 0.68, reason: 'XỈU_1_2_1' };
    if (p6 === 'XTTXTT') return { code: 'X', conf: 0.68, reason: 'TÀI_1_2_1' };
  }

  // 5. Sau bệt Tài ngắn 3-4, khả năng cao chuyển X
  if (n >= 4) {
    let streak = 1;
    for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) streak++; else break; }
    if (last === 'T' && streak >= 3 && streak <= 5) {
      return { code: 'X', conf: 0.58 + Math.min((streak - 3) * 0.03, 0.08), reason: `ĐẢO_BỆT_T${streak}` };
    }
    if (last === 'X' && streak >= 3 && streak <= 5) {
      return { code: 'T', conf: 0.58 + Math.min((streak - 3) * 0.03, 0.08), reason: `ĐẢO_BỆT_X${streak}` };
    }
  }

  // 6. Cầu giảm tiến kết thúc
  if (n >= 6) {
    const blocks = [];
    let curType = seq[0], curLen = 1;
    for (let i = 1; i < n; i++) {
      if (seq[i] === curType) curLen++;
      else { blocks.push({ type: curType, len: curLen }); curType = seq[i]; curLen = 1; }
    }
    blocks.push({ type: curType, len: curLen });
    if (blocks.length >= 3) {
      const l3 = blocks.slice(-3);
      if (l3[0].len > l3[1].len && l3[1].len > l3[2].len) {
        const next = l3[2].type === 'T' ? 'X' : 'T';
        return { code: next, conf: 0.60, reason: 'GIẢM_TIẾN' };
      }
    }
  }

  return { code: null, conf: 0, reason: 'no_signal' };
}

// ========================================================================
// CẦU CHUNG (đã có từ v11)
// ========================================================================
function algoCau(seq) {
  if (!seq || seq.length < 4) return { code: null, conf: 0, reason: 'no_data' };
  const n = seq.length, last = seq[n - 1];
  let alt = 0;
  for (let i = n - 1; i >= 1; i--) { if (seq[i] !== seq[i - 1]) alt++; else break; }
  if (alt >= 5) return { code: last === 'T' ? 'X' : 'T', conf: Math.min(0.62 + (alt - 5) * 0.04, 0.80), reason: 'CẦU_1_1' };
  if (n >= 8) { const p8 = seq.slice(-8).join(''); if (p8 === 'TTXXTTXX') return { code: 'T', conf: 0.75, reason: 'CẦU_2_2' }; if (p8 === 'XXTTXXTT') return { code: 'X', conf: 0.75, reason: 'CẦU_2_2' }; }
  if (n >= 6) { const p6 = seq.slice(-6).join(''); if (p6 === 'TTXXTT') return { code: 'X', conf: 0.68, reason: 'CẦU_2_2' }; if (p6 === 'XXTTXX') return { code: 'T', conf: 0.68, reason: 'CẦU_2_2' }; }
  if (n >= 9) { const p9 = seq.slice(-9).join(''); if (p9 === 'TTTXXXTTT') return { code: 'X', conf: 0.78, reason: 'CẦU_3_3' }; if (p9 === 'XXXTTTXXX') return { code: 'T', conf: 0.78, reason: 'CẦU_3_3' }; }
  if (n >= 6) { const p6 = seq.slice(-6).join(''); if (p6 === 'TTTXXX') return { code: 'T', conf: 0.72, reason: 'CẦU_3_3' }; if (p6 === 'XXXTTT') return { code: 'X', conf: 0.72, reason: 'CẦU_3_3' }; }
  if (n >= 8) { const p8 = seq.slice(-8).join(''); if (p8 === 'TTTTXXXX') return { code: 'T', conf: 0.72, reason: 'CẦU_4_4' }; if (p8 === 'XXXXTTTT') return { code: 'X', conf: 0.72, reason: 'CẦU_4_4' }; }
  if (n >= 8) { const p8 = seq.slice(-8).join(''); if (p8 === 'TXXTXXTX') return { code: 'T', conf: 0.70, reason: 'CẦU_1_2_1' }; if (p8 === 'XTTXTTXT') return { code: 'X', conf: 0.70, reason: 'CẦU_1_2_1' }; }
  if (n >= 5) { const p5 = seq.slice(-5).join(''); if (p5 === 'TXXTX') return { code: 'X', conf: 0.62, reason: 'CẦU_1_2_1' }; if (p5 === 'XTTXT') return { code: 'T', conf: 0.62, reason: 'CẦU_1_2_1' }; }
  if (n >= 6) { const p6 = seq.slice(-6).join(''); if (p6 === 'TTXTTX') return { code: 'T', conf: 0.65, reason: 'CẦU_2_1_2' }; if (p6 === 'XXTXXT') return { code: 'X', conf: 0.65, reason: 'CẦU_2_1_2' }; }
  return { code: null, conf: 0, reason: 'no_signal' };
}

// ============ CÁC ALGO CÒN LẠI ============
function algoStreak(seq) {
  if (!seq || seq.length < 4) return { code: null, conf: 0, reason: 'no_data' };
  const last = seq[seq.length - 1];
  let len = 1;
  for (let i = seq.length - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
  if (len >= 4 && len <= 7) return { code: last, conf: 0.70 + Math.min((len - 4) * 0.03, 0.10), reason: `BỆT${len}` };
  if (len >= 8 && len <= 10) return { code: last, conf: 0.55, reason: `BỆT${len}_NGHI` };
  if (len >= 11) return { code: last === 'T' ? 'X' : 'T', conf: 0.62, reason: `BỆT${len}_GÃY` };
  return { code: null, conf: 0, reason: 'no_signal' };
}

function algoMarkov(seq, maxOrder = 5) {
  if (!seq || seq.length < 10) return { code: null, conf: 0, reason: 'no_data' };
  const models = {};
  for (let order = 1; order <= maxOrder; order++) {
    const freq = {};
    for (let i = 0; i + order < seq.length; i++) {
      const ctx = seq.slice(i, i + order).join('');
      const next = seq[i + order];
      if (!freq[ctx]) freq[ctx] = { T: 0, X: 0 };
      freq[ctx][next]++;
    }
    models[order] = freq;
  }
  for (let order = maxOrder; order >= 1; order--) {
    if (seq.length < order) continue;
    const ctx = seq.slice(-order).join('');
    const e = models[order][ctx];
    if (!e) continue;
    const n = e.T + e.X;
    if (n < 3) continue;
    const pT = (e.T + 1) / (n + 2);
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.15) continue;
    return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.30, 0.75), reason: `MARKOV_O${order}` };
  }
  return { code: null, conf: 0, reason: 'no_signal' };
}

function algoNgram(seq, maxLen = 7) {
  if (!seq || seq.length < 30) return { code: null, conf: 0, reason: 'no_data' };
  const patterns = {};
  for (let len = 3; len <= maxLen; len++) {
    for (let i = 0; i + len < seq.length; i++) {
      const pat = seq.slice(i, i + len).join('');
      const next = seq[i + len];
      if (!patterns[pat]) patterns[pat] = { T: 0, X: 0 };
      patterns[pat][next]++;
    }
  }
  for (let len = maxLen; len >= 3; len--) {
    if (seq.length < len) continue;
    const pat = seq.slice(-len).join('');
    const e = patterns[pat];
    if (!e) continue;
    const n = e.T + e.X;
    if (n < 3) continue;
    const pT = (e.T + 1) / (n + 2);
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.20) continue;
    return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.35, 0.78), reason: `NGRAM_${len}` };
  }
  return { code: null, conf: 0, reason: 'no_signal' };
}

function algoBayesian(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  let cntT = 0;
  for (const s of seq) if (s === 'T') cntT++;
  const priorT = (cntT + 1) / (seq.length + 2);
  const priorX = 1 - priorT;
  const cond = {};
  for (let len = 2; len <= 6; len++) {
    for (let i = 0; i + len < seq.length; i++) {
      const ctx = seq.slice(i, i + len).join('');
      const next = seq[i + len];
      if (!cond[ctx]) cond[ctx] = { T: 0, X: 0 };
      cond[ctx][next]++;
    }
  }
  for (let len = 6; len >= 2; len--) {
    if (seq.length < len) continue;
    const ctx = seq.slice(-len).join('');
    const e = cond[ctx];
    if (!e) continue;
    const n = e.T + e.X;
    if (n < 4) continue;
    const likT = (e.T + 1) / (n + 2);
    const likX = (e.X + 1) / (n + 2);
    const postT = likT * priorT;
    const postX = likX * priorX;
    const pT = postT / (postT + postX);
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.15) continue;
    return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.40, 0.78), reason: `BAYES_${len}` };
  }
  return { code: null, conf: 0, reason: 'no_signal' };
}

function algoTrend(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  const recent = seq.slice(-20);
  const cntT = recent.filter(x => x === 'T').length;
  if (cntT >= 13) return { code: 'X', conf: 0.58, reason: `TREND_X` };
  if (cntT <= 7) return { code: 'T', conf: 0.58, reason: `TREND_T` };
  return { code: null, conf: 0, reason: 'no_signal' };
}

function algoLSTMSim(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  const alphas = [0.5, 0.3, 0.15, 0.07, 0.03];
  const values = [];
  for (const a of alphas) {
    let s = 0;
    for (const x of seq) s = a * (x === 'T' ? 1 : -1) + (1 - a) * s;
    values.push(s);
  }
  const g1 = sigmoid(values[0] * 2 + values[1] * 1.5);
  const g2 = sigmoid(values[2] * 3);
  const g3 = sigmoid(values[3] * 4 + values[4] * 2);
  const output = (g1 * 0.4 + g2 * 0.3 + g3 * 0.3) * 2 - 1;
  const conf = Math.abs(output);
  if (conf < 0.15) return { code: null, conf: 0, reason: 'LSTM_LOW' };
  return { code: output >= 0 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.35, 0.78), reason: 'LSTM_SIM' };
}

function algoARIMA(seq, p = 5) {
  if (!seq || seq.length < 30) return { code: null, conf: 0, reason: 'no_data' };
  const vals = seq.map(x => x === 'T' ? 1 : 0);
  const n = vals.length;
  const X = [], Y = [];
  for (let i = p; i < n; i++) { X.push(vals.slice(i - p, i)); Y.push(vals[i]); }
  if (X.length < 10) return { code: null, conf: 0, reason: 'ARIMA_NO_DATA' };
  const coef = new Array(p).fill(0);
  const lr = 0.01;
  for (let iter = 0; iter < 50; iter++) {
    const grad = new Array(p).fill(0);
    for (let k = 0; k < X.length; k++) {
      let pred = 0;
      for (let j = 0; j < p; j++) pred += coef[j] * X[k][j];
      const err = Y[k] - pred;
      for (let j = 0; j < p; j++) grad[j] += err * X[k][j];
    }
    for (let j = 0; j < p; j++) coef[j] += lr * grad[j] / X.length;
  }
  const lastP = vals.slice(-p);
  let pred = 0;
  for (let j = 0; j < p; j++) pred += coef[j] * lastP[j];
  const conf = Math.abs(pred - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'ARIMA_LOW' };
  return { code: pred >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.30, 0.72), reason: `ARIMA_P${p}` };
}

function algoKalman(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  const vals = seq.map(x => x === 'T' ? 1 : 0);
  let x = 0.5, P = 1.0;
  const Q = 0.01, R = 0.1;
  for (const v of vals) {
    const xPred = x, PPred = P + Q;
    const K = PPred / (PPred + R);
    x = xPred + K * (v - xPred);
    P = (1 - K) * PPred;
  }
  const conf = Math.abs(x - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'KALMAN_LOW' };
  return { code: x >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.35, 0.75), reason: 'KALMAN' };
}

function extractFeatures(seq) {
  const f = [1.0];
  for (const a of [0.3, 0.15, 0.07]) {
    let s = 0;
    for (const x of seq) s = a * (x === 'T' ? 1 : -1) + (1 - a) * s;
    f.push(s);
  }
  const last = seq[seq.length - 1];
  let streak = 1;
  for (let i = seq.length - 2; i >= 0; i--) { if (seq[i] === last) streak++; else break; }
  f.push(Math.tanh(streak / 6));
  let alt = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) alt++;
  f.push((alt / (seq.length - 1)) * 2 - 1);
  f.push(seq[seq.length - 1] === 'T' ? 1 : -1);
  f.push(seq[seq.length - 2] === 'T' ? 1 : -1);
  f.push(seq[seq.length - 3] === 'T' ? 1 : -1);
  return f;
}

function fitLogistic(X, Y) {
  const dim = X[0].length;
  const coef = new Array(dim).fill(0);
  const lr = 0.05;
  for (let iter = 0; iter < 30; iter++) {
    const grad = new Array(dim).fill(0);
    for (let k = 0; k < X.length; k++) {
      let z = 0;
      for (let j = 0; j < dim; j++) z += coef[j] * X[k][j];
      const err = Y[k] - sigmoid(z);
      for (let j = 0; j < dim; j++) grad[j] += err * X[k][j];
    }
    for (let j = 0; j < dim; j++) coef[j] += lr * grad[j] / X.length;
  }
  return coef;
}

function algoRandomForest(seq) {
  if (!seq || seq.length < 40) return { code: null, conf: 0, reason: 'no_data' };
  const n = seq.length;
  const features = [], labels = [];
  for (let i = 20; i < n; i++) { features.push(extractFeatures(seq.slice(i - 20, i))); labels.push(seq[i] === 'T' ? 1 : 0); }
  if (features.length < 20) return { code: null, conf: 0, reason: 'RF_NO_DATA' };
  const trees = [];
  for (let t = 0; t < 10; t++) {
    const sampleX = [], sampleY = [];
    for (let i = 0; i < features.length; i++) {
      const j = (i * 7 + t * 13) % features.length;
      sampleX.push(features[j]); sampleY.push(labels[j]);
    }
    trees.push(fitLogistic(sampleX, sampleY));
  }
  const curFeat = extractFeatures(seq.slice(-20));
  let votes = 0;
  for (const coef of trees) {
    let z = 0;
    for (let i = 0; i < coef.length; i++) z += coef[i] * curFeat[i];
    votes += sigmoid(z);
  }
  const pT = votes / trees.length;
  const conf = Math.abs(pT - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'RF_LOW' };
  return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.35, 0.78), reason: 'RF_10T' };
}

function algoGradientBoost(seq) {
  if (!seq || seq.length < 40) return { code: null, conf: 0, reason: 'no_data' };
  const n = seq.length;
  const features = [], labels = [];
  for (let i = 20; i < n; i++) { features.push(extractFeatures(seq.slice(i - 20, i))); labels.push(seq[i] === 'T' ? 1 : 0); }
  if (features.length < 20) return { code: null, conf: 0, reason: 'GB_NO_DATA' };
  // Simplified — just use logistic on all data with sample weights
  const coef = fitLogistic(features, labels);
  const curFeat = extractFeatures(seq.slice(-20));
  let z = 0;
  for (let j = 0; j < coef.length; j++) z += coef[j] * curFeat[j];
  const pT = sigmoid(z);
  const conf = Math.abs(pT - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'GB_LOW' };
  return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.35, 0.78), reason: 'GB' };
}

function algoChaos(seq) {
  if (!seq || seq.length < 30) return { code: null, conf: 0, reason: 'no_data' };
  const vals = seq.map(x => x === 'T' ? 0.9 : 0.1);
  let bestR = 3.9, bestErr = 1e9;
  for (let r = 3.5; r <= 4.0; r += 0.05) {
    let err = 0;
    for (let i = 1; i < vals.length; i++) err += Math.abs(r * vals[i - 1] * (1 - vals[i - 1]) - vals[i]);
    if (err < bestErr) { bestErr = err; bestR = r; }
  }
  const last = vals[vals.length - 1];
  const pred = bestR * last * (1 - last);
  const conf = Math.abs(pred - 0.5) * 2;
  if (conf < 0.20) return { code: null, conf: 0, reason: 'CHAOS_LOW' };
  return { code: pred >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.30, 0.72), reason: `CHAOS` };
}

function algoFourier(seq) {
  if (!seq || seq.length < 40) return { code: null, conf: 0, reason: 'no_data' };
  const N = Math.min(64, seq.length);
  const vals = seq.slice(-N).map(x => x === 'T' ? 1 : -1);
  const freqs = [];
  for (let k = 1; k <= 8; k++) {
    let real = 0, imag = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      real += vals[n] * Math.cos(angle);
      imag -= vals[n] * Math.sin(angle);
    }
    freqs.push({ k, mag: Math.sqrt(real * real + imag * imag) / N, phase: Math.atan2(imag, real) });
  }
  freqs.sort((a, b) => b.mag - a.mag);
  const d = freqs[0];
  if (d.mag < 0.2) return { code: null, conf: 0, reason: 'FOURIER_LOW' };
  const angle = (2 * Math.PI * d.k * N) / N;
  const pred = d.mag * 2 * Math.cos(angle + d.phase);
  const conf = Math.min(Math.abs(pred), 0.75);
  if (conf < 0.15) return { code: null, conf: 0, reason: 'FOURIER_LOW2' };
  return { code: pred >= 0 ? 'T' : 'X', conf, reason: `FOURIER_K${d.k}` };
}

function algoEntropy(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  const recent = seq.slice(-20);
  const cntT = recent.filter(x => x === 'T').length;
  const pT = cntT / recent.length;
  const entropy = -(pT * Math.log2(pT || 1e-9) + (1 - pT) * Math.log2((1 - pT) || 1e-9));
  if (entropy < 0.75) return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + (1 - entropy) * 0.5, 0.72), reason: `ENTROPY_LOW` };
  if (entropy > 0.95) return { code: seq[seq.length - 1] === 'T' ? 'X' : 'T', conf: 0.55, reason: 'ENTROPY_HIGH' };
  return { code: null, conf: 0, reason: 'no_signal' };
}

function algoMetaLearner(seq, allAlgoResults, regime, algoStats) {
  if (!allAlgoResults) return { code: null, conf: 0, reason: 'no_data' };
  const weights = {};
  for (const name of Object.keys(allAlgoResults)) {
    const r = allAlgoResults[name];
    if (!r.code) { weights[name] = 0; continue; }
    const stats = algoStats[name] || { total: 0, wins: 0 };
    const acc = stats.total > 0 ? stats.wins / stats.total : 0.5;
    const regWeight = regimeWeight(name, regime.type);
    weights[name] = r.conf * acc * regWeight;
  }
  const votes = { T: 0, X: 0 };
  for (const name of Object.keys(allAlgoResults)) {
    const r = allAlgoResults[name];
    if (!r.code) continue;
    votes[r.code] += weights[name];
  }
  const total = votes.T + votes.X;
  if (total < 0.1) return { code: null, conf: 0, reason: 'META_NO_SIGNAL' };
  const pT = votes.T / total;
  const conf = Math.abs(pT - 0.5) * 2;
  if (conf < 0.10) return { code: null, conf: 0, reason: 'META_TOO_CLOSE' };
  return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.55 + conf * 0.30, 0.80), reason: `META_${regime.type}` };
}

function regimeWeight(algo, regimeType) {
  // ✅ UPDATED: có CAU_TAI, CAU_XIU
  const map = {
    'BỆT': { STREAK: 2.5, CAU: 1.0, CAU_TAI: 1.8, CAU_XIU: 1.8, MARKOV: 1.5, NGRAM: 1.2, BAYESIAN: 1.0, TREND: 0.8, LSTM_SIM: 1.3, ARIMA: 1.0, KALMAN: 0.8, RANDOM_FOREST: 1.2, GRADIENT_BOOST: 1.3, CHAOS: 0.5, FOURIER: 0.7, ENTROPY: 1.5 },
    'CẦU_1_1': { STREAK: 0.5, CAU: 3.0, CAU_TAI: 1.5, CAU_XIU: 1.5, MARKOV: 1.0, NGRAM: 1.5, BAYESIAN: 1.2, TREND: 0.6, LSTM_SIM: 1.0, ARIMA: 1.0, KALMAN: 0.8, RANDOM_FOREST: 1.2, GRADIENT_BOOST: 1.2, CHAOS: 0.5, FOURIER: 2.0, ENTROPY: 0.7 },
    'RANDOM': { STREAK: 0.5, CAU: 0.5, CAU_TAI: 0.8, CAU_XIU: 0.8, MARKOV: 1.0, NGRAM: 1.2, BAYESIAN: 1.5, TREND: 0.5, LSTM_SIM: 1.0, ARIMA: 1.2, KALMAN: 1.3, RANDOM_FOREST: 1.5, GRADIENT_BOOST: 1.5, CHAOS: 1.0, FOURIER: 0.8, ENTROPY: 1.5 },
    'HỖN_HỢP': { STREAK: 1, CAU: 1, CAU_TAI: 1, CAU_XIU: 1, MARKOV: 1, NGRAM: 1, BAYESIAN: 1, TREND: 1, LSTM_SIM: 1, ARIMA: 1, KALMAN: 1, RANDOM_FOREST: 1, GRADIENT_BOOST: 1, CHAOS: 1, FOURIER: 1, ENTROPY: 1 },
    'unknown': { STREAK: 1, CAU: 1, CAU_TAI: 1, CAU_XIU: 1, MARKOV: 1, NGRAM: 1, BAYESIAN: 1, TREND: 1, LSTM_SIM: 1, ARIMA: 1, KALMAN: 1, RANDOM_FOREST: 1, GRADIENT_BOOST: 1, CHAOS: 1, FOURIER: 1, ENTROPY: 1 }
  };
  return (map[regimeType] && map[regimeType][algo]) || 1.0;
}

// ========================================================================
// ✅ NEW: BIAS TRACKING THEO TỪNG ALGO
// ========================================================================
function getAlgoBias(db, algoName, windowSize = 50) {
  // Đếm dự đoán T vs X của algo trong 50 phiên gần
  const recent = (db.history || []).slice(-windowSize);
  let cntT = 0, cntX = 0;
  for (const h of recent) {
    if (h.algoPreds && h.algoPreds[algoName] && h.algoPreds[algoName].code) {
      if (h.algoPreds[algoName].code === 'T') cntT++;
      else if (h.algoPreds[algoName].code === 'X') cntX++;
    }
  }
  const total = cntT + cntX;
  if (total < 10) return { bias: 0, cntT, cntX, total };
  const pT = cntT / total;
  // bias > 0 → thiên Tài | bias < 0 → thiên Xỉu
  return { bias: pT - 0.5, cntT, cntX, total };
}

function algoBiasPenalty(biasInfo) {
  // bias càng lớn → penalty càng cao
  // |bias| > 0.15 → penalty max
  const absBias = Math.abs(biasInfo.bias);
  if (absBias < 0.10) return 1.0;  // Không penalty
  if (absBias > 0.20) return 1.0 - ALGO_BIAS_PENALTY;  // Penalty max
  // Linear interpolation
  const ratio = (absBias - 0.10) / 0.10;
  return 1.0 - ALGO_BIAS_PENALTY * ratio;
}

// ========================================================================
// RUN ALL ALGORITHMS
// ========================================================================
function runAllAlgorithms(seq, db) {
  const baseResults = {
    STREAK: algoStreak(seq),
    CAU: algoCau(seq),
    CAU_TAI: algoCauTai(seq),     // ✅ NEW
    CAU_XIU: algoCauXiu(seq),     // ✅ NEW
    MARKOV: algoMarkov(seq),
    NGRAM: algoNgram(seq),
    BAYESIAN: algoBayesian(seq),
    TREND: algoTrend(seq),
    LSTM_SIM: algoLSTMSim(seq),
    ARIMA: algoARIMA(seq),
    KALMAN: algoKalman(seq),
    RANDOM_FOREST: algoRandomForest(seq),
    GRADIENT_BOOST: algoGradientBoost(seq),
    CHAOS: algoChaos(seq),
    FOURIER: algoFourier(seq),
    ENTROPY: algoEntropy(seq)
  };
  const regime = detectRegime(seq);
  baseResults.META_LEARNER = algoMetaLearner(seq, baseResults, regime, db.algoStats || {});

  // Ensemble with bias penalty
  const votes = { T: 0, X: 0 };
  const details = [];
  for (const name of Object.keys(baseResults)) {
    if (name === 'META_LEARNER') continue;
    const r = baseResults[name];
    if (!r.code) continue;
    const stat = (db.algoStats && db.algoStats[name]) || { total: 0, wins: 0 };
    const acc = stat.total >= MIN_ALGO_TOTAL ? stat.wins / stat.total : 0.5;

    // ✅ Bias penalty
    const biasInfo = getAlgoBias(db, name);
    const biasPenalty = algoBiasPenalty(biasInfo);

    const w = r.conf * Math.max(0.3, acc) * biasPenalty;
    votes[r.code] += w;
    details.push({ name, code: r.code, conf: r.conf, acc, biasPenalty, w });
  }
  const total = votes.T + votes.X;
  let ensembleResult;
  if (total < 0.5) ensembleResult = { code: null, conf: 0, reason: 'ENSEMBLE_NO_SIGNAL' };
  else {
    const pT = votes.T / total;
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.10) ensembleResult = { code: null, conf: 0, reason: 'ENSEMBLE_TOO_CLOSE' };
    else ensembleResult = { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.55 + conf * 0.30, 0.82), reason: `ENSEMBLE_${details.length}v`, details, votes };
  }
  baseResults.ENSEMBLE = ensembleResult;
  return { algorithms: baseResults, regime };
}

// ========================================================================
// ✅ NEW: BALANCE GUARD
// ========================================================================
function getRecentPredictionDistribution(db, windowSize = BALANCE_WINDOW) {
  const recent = (db.history || []).slice(-windowSize).filter(h => h.DU_DOAN_CODE);
  let cntT = 0, cntX = 0;
  for (const h of recent) {
    if (h.DU_DOAN_CODE === 'T') cntT++;
    else if (h.DU_DOAN_CODE === 'X') cntX++;
  }
  return { cntT, cntX, total: cntT + cntX };
}

function applyBalanceGuard(db, finalCode, finalConf) {
  const dist = getRecentPredictionDistribution(db);
  if (dist.total < 20) {
    // Chưa đủ data → không can thiệp
    return { code: finalCode, conf: finalConf, applied: false, reason: null, dist };
  }

  const pT = dist.cntT / dist.total;

  // Nếu predict Tài > 62% → force thiên Xỉu
  if (pT > BALANCE_THRESHOLD && finalCode === 'T') {
    return {
      code: 'X',
      conf: Math.max(finalConf * 0.7, BALANCE_FORCE),
      applied: true,
      reason: `BALANCE_GUARD_X (pT=${pT.toFixed(2)})`,
      dist
    };
  }

  // Nếu predict Xỉu > 62% → force thiên Tài
  if (pT < (1 - BALANCE_THRESHOLD) && finalCode === 'X') {
    return {
      code: 'T',
      conf: Math.max(finalConf * 0.7, BALANCE_FORCE),
      applied: true,
      reason: `BALANCE_GUARD_T (pX=${(1-pT).toFixed(2)})`,
      dist
    };
  }

  return { code: finalCode, conf: finalConf, applied: false, reason: null, dist };
}

// ============ FETCH ============
async function fetchWithRetry(url, attempts = FETCH_RETRIES) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try { return await axios.get(url, { timeout: API_TIMEOUT_MS, headers: { 'User-Agent': 'HoangVip/12.0' } }); }
    catch (e) { lastErr = e; if (i < attempts - 1) await new Promise(r => setTimeout(r, 200 + i * 200)); }
  }
  throw lastErr || new Error('Fetch failed');
}

function parseHistoryResponse(data) {
  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (data && Array.isArray(data.data)) arr = data.data;
  else if (data && Array.isArray(data.list)) arr = data.list;
  else if (data && data.data && Array.isArray(data.data.list)) arr = data.data.list;
  else return [];
  if (arr.length >= 2) {
    const first = Number(arr[0].SessionId || arr[0].session || 0);
    const last = Number(arr[arr.length - 1].SessionId || arr[arr.length - 1].session || 0);
    if (first > last) arr = arr.slice().reverse();
  }
  return arr;
}

// ============ DB ============
const ALL_ALGOS = ['STREAK', 'CAU', 'CAU_TAI', 'CAU_XIU', 'MARKOV', 'NGRAM', 'BAYESIAN', 'TREND', 'LSTM_SIM', 'ARIMA', 'KALMAN', 'RANDOM_FOREST', 'GRADIENT_BOOST', 'CHAOS', 'FOURIER', 'ENTROPY', 'META_LEARNER', 'ENSEMBLE'];

function defaultDB() {
  const algoStats = {};
  for (const name of ALL_ALGOS) algoStats[name] = { total: 0, wins: 0, losses: 0, skips: 0, brierSum: 0, brierCount: 0 };
  return {
    version: 12.0,
    createdAt: now(), updatedAt: now(),
    history: [],
    algoStats,
    algoWeights: Object.fromEntries(ALL_ALGOS.map(a => [a, 1.0])),
    byType: {}, byRegime: {},
    lastProcessedSession: null,
    currentRegime: { type: 'unknown' },
    circuitBreaker: { active: false, until: 0 },
    snapshots: [],
    lastNotified: null,
    balanceGuard: { applied: 0, lastApplied: null }
  };
}

function migrateDB(db) {
  if (!db || typeof db !== 'object') return defaultDB();
  const def = defaultDB();
  for (const k in def) if (db[k] === undefined || db[k] === null) db[k] = def[k];
  if (!Array.isArray(db.history)) db.history = [];
  if (!db.algoStats) db.algoStats = def.algoStats;
  for (const name of ALL_ALGOS) {
    if (!db.algoStats[name]) db.algoStats[name] = { total: 0, wins: 0, losses: 0, skips: 0, brierSum: 0, brierCount: 0 };
    if (!Number.isFinite(db.algoStats[name].brierSum)) db.algoStats[name].brierSum = 0;
    if (!Number.isFinite(db.algoStats[name].brierCount)) db.algoStats[name].brierCount = 0;
  }
  if (!db.algoWeights) db.algoWeights = Object.fromEntries(ALL_ALGOS.map(a => [a, 1.0]));
  if (!db.byType || typeof db.byType !== 'object') db.byType = {};
  if (!db.byRegime || typeof db.byRegime !== 'object') db.byRegime = {};
  if (!db.circuitBreaker) db.circuitBreaker = { active: false, until: 0 };
  if (!Array.isArray(db.snapshots)) db.snapshots = [];
  if (!db.currentRegime) db.currentRegime = { type: 'unknown' };
  if (!db.balanceGuard) db.balanceGuard = { applied: 0, lastApplied: null };
  if (!db.version) db.version = 12.0;
  db.history = db.history.filter(h => h && typeof h === 'object' && h.phien !== undefined);
  return db;
}

function loadDatabase(game) {
  return migrateDB(safeReadJson(DB_FILES[game]) || defaultDB());
}
function saveDatabase(game, db) {
  try { db.updatedAt = now(); safeAtomicWrite(DB_FILES[game], db); }
  catch (e) { console.warn(`[SAVE] ${game}: ${e.message}`); }
}

// ============ PREDICT ============
function predict(db, seq) {
  if (!Array.isArray(seq) || seq.length < 4) {
    return {
      code: null, label: null, tiLe: 'CHỜ',
      algorithms: runAllAlgorithms(seq || [], db).algorithms,
      regime: { type: 'unknown' },
      shouldPredict: false
    };
  }
  const { algorithms, regime } = runAllAlgorithms(seq, db);
  const meta = algorithms.META_LEARNER;
  const ens = algorithms.ENSEMBLE;
  let final = meta.code && meta.conf >= MIN_CONFIDENCE ? meta : ens;
  let shouldPredict = final.code && final.conf >= MIN_CONFIDENCE;

  // ✅ Balance Guard
  let balanceInfo = null;
  if (shouldPredict) {
    balanceInfo = applyBalanceGuard(db, final.code, final.conf);
    if (balanceInfo.applied) {
      console.log(`[BALANCE GUARD] ${balanceInfo.reason} | ${final.code} → ${balanceInfo.code}`);
      final = { code: balanceInfo.code, conf: balanceInfo.conf, reason: balanceInfo.reason };
    }
  }

  const recent = (db.history || []).slice(-20).filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
  let lossStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].trangThai === 'SAI') lossStreak++;
    else break;
  }
  if (lossStreak >= CB_LOSS_STREAK) {
    const cooldownEnd = recent[recent.length - 1].phien + CB_COOLDOWN;
    if (db.lastProcessedSession < cooldownEnd) {
      shouldPredict = false;
      final = { code: null, conf: 0, reason: 'CIRCUIT_BREAKER' };
    }
  }

  const lastType = seq[seq.length - 1];
  let streakLen = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === lastType) streakLen++;
    else break;
  }

  if (!shouldPredict) {
    return { code: null, label: null, tiLe: 'CHỜ', algorithms, regime, shouldPredict: false, streak: { type: lastType, length: streakLen } };
  }

  return {
    code: final.code, label: labelFromTX(final.code),
    tiLe: (final.conf * 100).toFixed(1) + '%',
    algorithms, regime, shouldPredict: true,
    streak: { type: lastType, length: streakLen },
    reason: final.reason,
    balanceInfo
  };
}

function updateWeights(db) {
  for (const name of ALL_ALGOS) {
    const s = db.algoStats[name];
    if (!s || s.total < MIN_ALGO_TOTAL) continue;
    const acc = s.wins / s.total;
    db.algoWeights[name] = Math.max(0.3, Math.min(3.0, Math.exp((acc - 0.5) * 5)));
  }
}

// ============ WEBHOOK ============
async function sendWebhook(entry, game) {
  const text = `🎯 [${game.toUpperCase()}] Phiên #${entry.phienDuDoan}\nKQ: ${entry.ketQuaLabel || '?'}\nDự đoán: **${entry.DU_DOAN}** ${entry.TI_LE !== 'CHỜ' ? `(${entry.TI_LE})` : ''}\nLý do: ${entry.ensReason || 'N/A'}\nRegime: ${entry.regimeType || 'unknown'}`;
  const tasks = [];
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) tasks.push(axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }).catch(e => console.error('[TG]', e.message)));
  if (DISCORD_WEBHOOK) tasks.push(axios.post(DISCORD_WEBHOOK, { content: text }).catch(e => console.error('[DISCORD]', e.message)));
  if (SLACK_WEBHOOK) tasks.push(axios.post(SLACK_WEBHOOK, { text }).catch(e => console.error('[SLACK]', e.message)));
  if (CUSTOM_WEBHOOK) tasks.push(axios.post(CUSTOM_WEBHOOK, { game, entry, timestamp: now() }, { timeout: 5000 }).catch(e => console.error('[CUSTOM]', e.message)));
  await Promise.all(tasks);
}

// ============ MAIN TICK ============
async function processGameTick(game) {
  try {
    const api = APIS[game];
    if (!api) return;
    const resp = await fetchWithRetry(api);
    const historyList = parseHistoryResponse(resp.data);
    if (!historyList.length) return;

    const latest = historyList[historyList.length - 1];
    const currentSession = safeInt(latest.SessionId || latest.session, 0);
    if (!currentSession) return;

    const db = loadDatabase(game);
    if (db.lastProcessedSession === currentSession) return;

    const seq = historyList.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    if (seq.length < 4) return;

    const pred = predict(db, seq);

    const lastRec = db.history[db.history.length - 1];
    if (lastRec && safeInt(lastRec.phienDuDoan, 0) === currentSession) {
      const actual = itemToResult(latest);
      lastRec.ketQua = actual;
      lastRec.ketQuaLabel = labelFromTX(actual);

      if (lastRec.algoPreds) {
        for (const name of Object.keys(lastRec.algoPreds)) {
          const predData = lastRec.algoPreds[name];
          const predCode = predData.code;
          const stat = db.algoStats[name];
          if (!stat) continue;
          if (predCode === null || predCode === undefined) stat.skips++;
          else {
            stat.total++;
            const correct = predCode === actual;
            if (correct) stat.wins++; else stat.losses++;
            const prob = predCode === 'T' ? predData.conf : (1 - predData.conf);
            const actualVal = actual === 'T' ? 1 : 0;
            stat.brierSum += Math.pow(prob - actualVal, 2);
            stat.brierCount++;
          }
        }
      }

      const finalCode = lastRec.DU_DOAN_CODE;
      lastRec.trangThai = finalCode ? (finalCode === actual ? 'ĐÚNG' : 'SAI') : 'BỎ QUA';

      const pType = lastRec.ensReason || 'NONE';
      if (finalCode) {
        if (!db.byType[pType]) db.byType[pType] = { total: 0, wins: 0 };
        db.byType[pType].total++;
        if (finalCode === actual) db.byType[pType].wins++;
      }
      const regime = lastRec.regimeType || 'unknown';
      if (finalCode) {
        if (!db.byRegime[regime]) db.byRegime[regime] = { total: 0, wins: 0 };
        db.byRegime[regime].total++;
        if (finalCode === actual) db.byRegime[regime].wins++;
      }

      updateWeights(db);
    }

    const algoPreds = {};
    for (const name of Object.keys(pred.algorithms)) {
      const a = pred.algorithms[name];
      algoPreds[name] = { code: a.code, conf: a.conf || 0, reason: a.reason };
    }

    const newEntry = {
      phien: currentSession,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: itemToResult(latest),
      ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: currentSession + 1,
      DU_DOAN_CODE: pred.shouldPredict ? pred.code : null,
      DU_DOAN: pred.shouldPredict ? pred.label : 'CHỜ',
      TI_LE: pred.tiLe,
      ensReason: pred.reason || pred.algorithms.ENSEMBLE.reason,
      regimeType: pred.regime.type,
      streak: pred.streak,
      algoPreds,
      balanceApplied: pred.balanceInfo ? pred.balanceInfo.applied : false,
      trangThai: 'ĐANG CHỜ',
      thoiGian: now()
    };

    db.history.push(newEntry);
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);
    db.lastProcessedSession = currentSession;
    db.currentRegime = pred.regime;

    // Track balance guard
    if (pred.balanceInfo && pred.balanceInfo.applied) {
      db.balanceGuard.applied = (db.balanceGuard.applied || 0) + 1;
      db.balanceGuard.lastApplied = now();
    }

    saveDatabase(game, db);

    if (pred.shouldPredict && db.lastNotified !== newEntry.phienDuDoan) {
      db.lastNotified = newEntry.phienDuDoan;
      sendWebhook(newEntry, game).catch(e => console.error('[WEBHOOK]', e.message));
      saveDatabase(game, db);
    }

    const bal = pred.balanceInfo && pred.balanceInfo.applied ? ` [BALANCE]` : '';
    console.log(`[TICK] ${game} #${currentSession} → ${newEntry.DU_DOAN} ${pred.shouldPredict ? `[${pred.reason}]` : '[CHỜ]'}${bal}`);
  } catch (e) {
    console.error(`[TICK ERR] ${game}`, e && e.message ? e.message : e);
  }
}

// ============ POLLING ============
let pollingActive = true;
function startPolling() {
  async function tick() {
    if (!pollingActive) return;
    try { await Promise.all(Object.keys(APIS).map(async g => { try { await processGameTick(g); } catch (_) {} })); }
    catch (e) { console.error('[POLL]', e.message); }
    if (pollingActive) setTimeout(tick, POLL_INTERVAL_MS);
  }
  tick();
}

// ============ FORMAT ============
function formatHistoryItem(it) {
  if (!it) return null;
  return {
    phien: it.phien,
    xucXac: Array.isArray(it.xucXac) ? it.xucXac : [0, 0, 0],
    tong: it.tong || 0,
    ketQua: it.ketQua || null,
    ketQuaLabel: it.ketQuaLabel || (it.ketQua ? labelFromTX(it.ketQua) : null),
    phienDuDoan: it.phienDuDoan,
    duDoan: it.DU_DOAN || 'CHỜ',
    duDoanCode: it.DU_DOAN_CODE || null,
    tiLe: it.TI_LE || 'CHỜ',
    ensReason: it.ensReason || null,
    regimeType: it.regimeType || null,
    streak: it.streak || null,
    balanceApplied: it.balanceApplied || false,
    trangThai: it.trangThai || null,
    thoiGian: it.thoiGian || null
  };
}

// ============ API ============
app.get('/health', (req, res) => {
  res.json({
    ok: true, version: 12.0, uptime: process.uptime(), timestamp: now(),
    fs: { dir: DB_DIR, writable: FILESYSTEM_WRITABLE, isRender: IS_RENDER },
    endpoints: Object.keys(APIS)
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    version: 12.0,
    algorithms: ALL_ALGOS,
    minConfidence: MIN_CONFIDENCE,
    balanceGuard: { window: BALANCE_WINDOW, threshold: BALANCE_THRESHOLD, force: BALANCE_FORCE },
    apiKeyRequired: !!API_KEY,
    webhooks: { telegram: !!TELEGRAM_BOT_TOKEN, discord: !!DISCORD_WEBHOOK, slack: !!SLACK_WEBHOOK, custom: !!CUSTOM_WEBHOOK }
  });
});

app.get('/api/predict/:game', rateLimit, checkApiKey, async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game', valid: Object.keys(APIS) });
  try {
    const r = await fetchWithRetry(APIS[game]);
    const list = parseHistoryResponse(r.data);
    if (!list.length) return res.status(204).send();

    const seq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const db = loadDatabase(game);
    const pred = predict(db, seq);
    const latest = list[list.length - 1];
    const cs = safeInt(latest.SessionId || latest.session, 0);

    const algoDetail = {};
    for (const name of Object.keys(pred.algorithms)) {
      const a = pred.algorithms[name];
      const stat = db.algoStats[name] || {};
      const biasInfo = getAlgoBias(db, name);
      algoDetail[name] = {
        code: a.code, label: a.code ? labelFromTX(a.code) : null,
        confidence: a.conf, reason: a.reason,
        accuracy: stat.total > 0 ? Number((stat.wins / stat.total * 100).toFixed(2)) : 0,
        brier: stat.brierCount > 0 ? Number((stat.brierSum / stat.brierCount).toFixed(4)) : null,
        total: stat.total || 0, skips: stat.skips || 0,
        bias: Number(biasInfo.bias.toFixed(3)),
        biasPenalty: algoBiasPenalty(biasInfo)
      };
    }

    const dist = getRecentPredictionDistribution(db);
    res.json({
      success: true, game: game.toUpperCase(),
      phien: cs, xucXac: itemToDice(latest), tong: itemToSum(latest),
      ketQua: itemToResult(latest), ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: cs + 1,
      duDoan: pred.shouldPredict ? pred.label : 'CHỜ',
      duDoanCode: pred.shouldPredict ? pred.code : null,
      tiLe: pred.tiLe, reason: pred.reason, regime: pred.regime,
      shouldPredict: pred.shouldPredict,
      balanceGuard: pred.balanceInfo ? { applied: pred.balanceInfo.applied, reason: pred.balanceInfo.reason } : null,
      distribution: { tai: dist.cntT, xiu: dist.cntX, ratio: dist.total > 0 ? `${dist.cntT}/${dist.cntX}` : 'N/A' },
      algorithms: algoDetail, thoiGian: now()
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'fetch error' });
  }
});

app.get('/api/simple/:game', rateLimit, checkApiKey, async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const last = db.history[db.history.length - 1];
  if (last) {
    return res.json({
      game: game.toUpperCase(), phien: last.phienDuDoan,
      duDoan: last.DU_DOAN, duDoanCode: last.DU_DOAN_CODE, tiLe: last.TI_LE,
      regime: last.regimeType, reason: last.ensReason, updated: last.thoiGian
    });
  }
  res.status(202).json({ message: 'Chưa có dự đoán, đang chờ data...' });
});

app.get('/api/public/predict/:game', rateLimit, async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const last = db.history[db.history.length - 1];
  if (!last) return res.status(204).send();
  res.json({ game: game.toUpperCase(), phien: last.phienDuDoan, duDoan: last.DU_DOAN, tiLe: last.TI_LE, regime: last.regimeType, updated: last.thoiGian });
});

app.get('/api/history/:game', rateLimit, checkApiKey, (req, res) => {
  const game = req.params.game;
  if (game === 'all') return handleHistoryAll(req, res);
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 200)));
  const slice = db.history.slice(-limit).reverse();
  res.json({ game, count: slice.length, exportedAt: now(), items: slice.map(formatHistoryItem).filter(Boolean) });
});

function handleHistoryAll(req, res) {
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 500)));
  const result = { exportedAt: now(), limit, games: {} };
  for (const game of Object.keys(DB_FILES)) {
    try {
      const db = loadDatabase(game);
      const slice = db.history.slice(-limit).reverse();
      const algosReport = {};
      for (const name of Object.keys(db.algoStats)) {
        const s = db.algoStats[name];
        algosReport[name] = {
          total: s.total, wins: s.wins, losses: s.losses, skips: s.skips,
          accuracy: s.total > 0 ? Number((s.wins / s.total * 100).toFixed(2)) : 0,
          brier: s.brierCount > 0 ? Number((s.brierSum / s.brierCount).toFixed(4)) : null
        };
      }
      const dist = getRecentPredictionDistribution(db);
      result.games[game] = {
        count: slice.length, algoStats: algosReport, algoWeights: db.algoWeights,
        byType: db.byType, byRegime: db.byRegime, currentRegime: db.currentRegime,
        distribution: { tai: dist.cntT, xiu: dist.cntX, ratio: dist.total > 0 ? `${dist.cntT}/${dist.cntX}` : 'N/A' },
        balanceGuard: db.balanceGuard,
        items: slice.map(formatHistoryItem).filter(Boolean)
      };
    } catch (e) { result.games[game] = { error: e.message }; }
  }
  res.json(result);
}

app.get('/api/history/all', rateLimit, checkApiKey, handleHistoryAll);

app.get('/admin/metrics/:game', rateLimit, (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const report = {};
  for (const name of Object.keys(db.algoStats)) {
    const s = db.algoStats[name];
    const biasInfo = getAlgoBias(db, name);
    report[name] = {
      total: s.total, wins: s.wins, losses: s.losses, skips: s.skips,
      accuracy: s.total > 0 ? Number((s.wins / s.total * 100).toFixed(2)) : 0,
      brier: s.brierCount > 0 ? Number((s.brierSum / s.brierCount).toFixed(4)) : null,
      bias: Number(biasInfo.bias.toFixed(3)),
      biasCounts: { T: biasInfo.cntT, X: biasInfo.cntX }
    };
  }
  const ranking = Object.entries(report).filter(([_, v]) => v.total >= 5).sort((a, b) => b[1].accuracy - a[1].accuracy).map(([name, v]) => ({ name, ...v }));
  const dist = getRecentPredictionDistribution(db);
  res.json({
    game, algorithms: report, ranking,
    byType: db.byType, byRegime: db.byRegime,
    weights: db.algoWeights, currentRegime: db.currentRegime,
    distribution: { tai: dist.cntT, xiu: dist.cntX, ratio: dist.total > 0 ? `${dist.cntT}/${dist.cntX}` : 'N/A', pT: dist.total > 0 ? Number((dist.cntT / dist.total).toFixed(3)) : 0.5 },
    balanceGuard: db.balanceGuard
  });
});

// ============ UI ============
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Trang không tồn tại. Dùng /md5 hoặc /taixiu');

  const db = loadDatabase(game);
  const rows = db.history.slice(-40).reverse();
  const algos = {};
  for (const name of Object.keys(db.algoStats)) {
    const s = db.algoStats[name];
    const biasInfo = getAlgoBias(db, name);
    algos[name] = { ...s, accuracy: s.total > 0 ? (s.wins / s.total * 100) : 0, brier: s.brierCount > 0 ? (s.brierSum / s.brierCount) : null, bias: biasInfo.bias };
  }

  const latest = db.history[db.history.length - 1];
  const latestPred = latest ? latest.DU_DOAN : 'CHỜ';
  const latestCode = latest ? latest.DU_DOAN_CODE : null;
  const latestTiLe = latest ? latest.TI_LE : 'CHỜ';
  const latestReason = latest ? latest.ensReason : 'N/A';
  const latestRegime = db.currentRegime ? db.currentRegime.type : 'unknown';

  const dist = getRecentPredictionDistribution(db);
  const pT = dist.total > 0 ? (dist.cntT / dist.total * 100).toFixed(1) : '50.0';

  const algoRows = Object.keys(algos).map(name => {
    const a = algos[name];
    const accCls = a.accuracy >= 60 ? 'dung' : (a.accuracy >= 50 ? 'cho' : 'sai');
    const brierStr = a.brier !== null ? a.brier.toFixed(4) : '—';
    const biasStr = (a.bias * 100).toFixed(0);
    const biasCls = Math.abs(a.bias) < 0.1 ? 'dung' : (Math.abs(a.bias) < 0.2 ? 'cho' : 'sai');
    return `<tr>
      <td><span class="algo-badge">${name}</span></td>
      <td>${a.total}</td>
      <td class="dung">${a.wins}</td>
      <td class="sai">${a.losses}</td>
      <td class="wait">${a.skips}</td>
      <td class="${accCls}"><b>${a.accuracy.toFixed(1)}%</b></td>
      <td class="brier">${brierStr}</td>
      <td class="${biasCls}">${biasStr > 0 ? '+' : ''}${biasStr}%</td>
    </tr>`;
  }).join('');

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const html = `<!DOCTYPE html><html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HOANG VIP v12 - ${game.toUpperCase()}</title>
<style>
  *{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#0a0e27,#0f172a 50%,#1a1f3a);color:#e6eef6;padding:12px;margin:0;min-height:100vh}
  .header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:14px}
  h1{color:#fff;font-size:17px;margin:0}.subtitle{color:#bfdbfe;font-size:11px;margin-top:4px}
  .hero{background:linear-gradient(135deg,#7c3aed,#4f46e5);padding:20px;border-radius:14px;margin-bottom:14px;text-align:center}
  .hero .label{font-size:11px;color:#ddd6fe;text-transform:uppercase}.hero .pred{font-size:36px;font-weight:800;margin:8px 0}
  .hero .pred.tai{color:#86efac}.hero .pred.xiu{color:#fca5a5}.hero .pred.cho{color:#fde047}
  .hero .meta{font-size:11px;color:#ddd6fe;margin-top:6px}
  .hero .regime{display:inline-block;margin-top:8px;padding:4px 10px;background:rgba(0,0,0,0.3);border-radius:20px;font-size:10px;color:#c4b5fd}
  .balance-box{background:linear-gradient(135deg,#065f46,#064e3b);padding:12px;border-radius:12px;margin-bottom:14px;border:1px solid #10b981}
  .balance-box .title{font-size:12px;color:#6ee7b7;font-weight:600;margin-bottom:6px}
  .balance-box .bar{height:8px;background:#0f172a;border-radius:4px;overflow:hidden;margin-top:4px;display:flex}
  .balance-box .bar-t{background:#22c55e;height:100%}
  .balance-box .bar-x{background:#ef4444;height:100%}
  .balance-box .stats{display:flex;justify-content:space-between;font-size:10px;color:#a7f3d0;margin-top:4px}
  .section-title{font-size:12px;color:#94a3b8;text-transform:uppercase;margin:14px 0 8px;font-weight:700}
  .table-wrap{background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:12px;overflow:hidden;border:1px solid #334155;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{background:linear-gradient(135deg,#1e40af,#3b82f6);color:#fff;padding:8px 4px;text-transform:uppercase;font-size:9px}
  td{padding:8px 4px;text-align:center;border-bottom:1px solid #1e293b}
  .tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
  .dung{color:#22c55e;font-weight:600}.sai{color:#ef4444;font-weight:600}
  .cho{color:#eab308;font-weight:600}.wait{color:#64748b;font-style:italic}
  .brier{color:#a78bfa;font-family:monospace;font-size:10px}
  .algo-badge{display:inline-block;font-size:9px;padding:2px 6px;border-radius:4px;font-weight:700;background:#7c3aed;color:#ddd6fe}
  .ens-badge{display:inline-block;font-size:9px;padding:2px 5px;border-radius:4px;font-weight:700;background:#1e40af;color:#93c5fd}
  .regime-badge{display:inline-block;font-size:9px;padding:2px 6px;border-radius:4px;font-weight:600;background:#7c2d12;color:#fdba74}
  .balance-badge{display:inline-block;font-size:9px;padding:2px 5px;border-radius:4px;font-weight:700;background:#065f46;color:#6ee7b7}
  .link-box{background:linear-gradient(135deg,#064e3b,#065f46);padding:12px;border-radius:12px;margin-bottom:14px;border:1px solid #10b981}
  .link-box .title{font-size:12px;color:#6ee7b7;font-weight:600;margin-bottom:6px}
  .link-row{font-family:monospace;font-size:11px;color:#d1fae5;background:rgba(0,0,0,0.3);padding:8px;border-radius:6px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px}
  .link-row span{word-break:break-all;flex:1}
  .copy-btn{background:#10b981;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer}
</style>
<script>setTimeout(()=>location.reload(),10000);function copyText(t,b){const d=()=>{const o=b.textContent;b.textContent='✓';setTimeout(()=>b.textContent=o,1500)};if(navigator.clipboard){navigator.clipboard.writeText(t).then(d).catch(d)}else{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);d()}}</script>
</head><body>
  <div class="header"><h1>🎯 HOANG VIP v12 — BALANCED DETECTION</h1><div class="subtitle">Bàn: ${game.toUpperCase()} • 18 algo + Balance Guard</div></div>

  <div class="hero">
    <div class="label">Dự đoán phiên tiếp theo</div>
    <div class="pred ${latestCode === 'T' ? 'tai' : (latestCode === 'X' ? 'xiu' : 'cho')}">${latestPred} ${latestTiLe !== 'CHỜ' ? latestTiLe : ''}</div>
    <div class="meta">${latestReason || 'Chờ tín hiệu'} • Phiên ${latest ? latest.phienDuDoan : '—'}</div>
    <div class="regime">Regime: ${latestRegime}</div>
  </div>

  <div class="balance-box">
    <div class="title">⚖️ Balance Distribution (50 phiên gần)</div>
    <div class="bar">
      <div class="bar-t" style="width:${pT}%"></div>
      <div class="bar-x" style="width:${100 - parseFloat(pT)}%"></div>
    </div>
    <div class="stats"><span style="color:#22c55e">Tài: ${dist.cntT} (${pT}%)</span><span style="color:#ef4444">Xỉu: ${dist.cntX} (${(100 - parseFloat(pT)).toFixed(1)}%)</span></div>
    <div style="font-size:10px;color:#a7f3d0;margin-top:6px">Balance Guard applied: ${db.balanceGuard.applied || 0} lần</div>
  </div>

  <div class="link-box">
    <div class="title">🔗 API</div>
    <div class="link-row"><span>${baseUrl}/api/predict/${game}</span><button class="copy-btn" onclick="copyText('${baseUrl}/api/predict/${game}',this)">Copy</button></div>
    <div class="link-row"><span>${baseUrl}/api/simple/${game}</span><button class="copy-btn" onclick="copyText('${baseUrl}/api/simple/${game}',this)">Copy</button></div>
    <div class="link-row"><span>${baseUrl}/api/history/all</span><button class="copy-btn" onclick="copyText('${baseUrl}/api/history/all',this)">Copy</button></div>
  </div>

  <div class="section-title">📊 18 Thuật toán</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Algo</th><th>T</th><th>W</th><th>L</th><th>Skip</th><th>Acc</th><th>Brier</th><th>Bias</th></tr></thead>
    <tbody>${algoRows}</tbody>
  </table></div>

  <div class="section-title">📜 40 phiên gần nhất</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Phiên</th><th>XX</th><th>Tổng</th><th>KQ</th><th>Dự đoán</th><th>Tỉ lệ</th><th>Reason</th><th>Regime</th><th>TT</th></tr></thead>
    <tbody>${rows.map(it => {
      const dice = (it.xucXac || []).join('-');
      const kq = it.ketQuaLabel || '';
      const kqCls = it.ketQua === 'T' ? 'tai' : (it.ketQua === 'X' ? 'xiu' : '');
      const isWait = !it.DU_DOAN_CODE;
      const ddCls = isWait ? 'wait' : (it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu');
      const ttCls = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : (it.trangThai === 'BỎ QUA' ? 'wait' : 'cho'));
      const reason = it.balanceApplied ? '<span class="balance-badge">BALANCE</span>' : (it.ensReason ? `<span class="ens-badge">${it.ensReason}</span>` : '—');
      return `<tr>
        <td style="font-family:monospace;font-size:10px;color:#94a3b8">${it.phien}</td>
        <td style="color:#fbbf24;font-weight:600">${dice}</td>
        <td>${it.tong || ''}</td>
        <td class="${kqCls}">${kq}</td>
        <td class="${ddCls}">${isWait ? 'CHỜ' : it.DU_DOAN}</td>
        <td style="color:#a5b4fc;font-size:10px">${it.TI_LE || 'CHỜ'}</td>
        <td>${reason}</td>
        <td><span class="regime-badge">${it.regimeType || '—'}</span></td>
        <td class="${ttCls}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>

  <div style="text-align:center;font-size:10px;color:#475569;margin-top:14px">HOANG VIP v12 • Balanced Detection</div>
</body></html>`;
  res.send(html);
});

// ============ SERVER ============
const server = app.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(`🚀 HOANG VIP v12 - BALANCED DETECTION`);
  console.log(`========================================`);
  console.log(`Server: http://${HOST}:${PORT}`);
  console.log(`FS Dir: ${DB_DIR} | Writable: ${FILESYSTEM_WRITABLE}`);
  console.log(`Algorithms: ${ALL_ALGOS.length} (thêm CAU_TAI, CAU_XIU)`);
  console.log(`Balance Guard: window=${BALANCE_WINDOW}, threshold=${BALANCE_THRESHOLD}, force=${BALANCE_FORCE}`);
  console.log(`========================================`);
  startPolling();
});

server.on('error', (e) => { console.error('[SERVER ERROR]', e.message); process.exit(1); });

function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down...`);
  pollingActive = false;
  server.close(() => { console.log('[OK] Closed.'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e.message, e.stack));
process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e && e.message ? e.message : e));
