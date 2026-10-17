/**
 * ========================================================================
 * HOANG VIP v10 — FULL ENGINE
 * ========================================================================
 * v10 nâng cấp so với v9:
 *  ✅ Ensemble Voting (đa pattern bỏ phiếu)
 *  ✅ Markov Chain bậc 1-2-3 (học từ lịch sử)
 *  ✅ Stoploss / Bankroll Protection
 *  ✅ Telegram Webhook thông báo
 *  ✅ Time-of-day Analysis
 *  ✅ Cầu theo Tổng xúc xắc (Chẵn/Lẻ, Cao/Thấp)
 *  ✅ Exponential Smoothing confidence
 *  ✅ Hazard-rate phân tích bệt
 *
 * 🔒 TOÀN BỘ THUẬT TOÁN NẰM SERVER-SIDE
 *    UI chỉ hiển thị: tên cầu, %, kết quả
 *    API public: KHÔNG trả weights / công thức / markov table
 * ========================================================================
 */

'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============ CONFIG ============
const VERSION = 10;
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 500);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 8000);
const FETCH_RETRIES = 3;
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE || 0.58);
const ENSEMBLE_MIN_VOTES = Number(process.env.ENSEMBLE_MIN_VOTES || 2);
const STOPLOSS_LOSS_STREAK = Number(process.env.STOPLOSS_LOSS_STREAK || 3);
const STOPLOSS_RECOVER_SESSIONS = Number(process.env.STOPLOSS_RECOVER_SESSIONS || 5);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT || '';
const TELEGRAM_MIN_CONF = Number(process.env.TELEGRAM_MIN_CONF || 0.75);

const APIS = {
  md5: process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: process.env.API_TAIXIU || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

const DB_DIR = process.env.DB_DIR || __dirname;
try { if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {}

const DB_FILES = {
  md5: path.join(DB_DIR, 'db_md5.json'),
  taixiu: path.join(DB_DIR, 'db_taixiu.json')
};
const BACKUP_FILES = {
  md5: path.join(DB_DIR, 'backup_db_md5.json'),
  taixiu: path.join(DB_DIR, 'backup_db_taixiu.json')
};

// ============ HELPERS ============
const now = () => new Date().toISOString();
const safeInt = (x, def = 0) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; };
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);
const labelFromTX = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);

function safeReadJson(fp, fb = null) {
  try {
    if (!fs.existsSync(fp)) return fb;
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw || !raw.trim()) return fb;
    return JSON.parse(raw);
  } catch { return fb; }
}
function safeAtomicWrite(fp, data) {
  try {
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return true;
  } catch { return false; }
}
function getCurrentTimeSlot(date = new Date()) {
  const h = date.getHours();
  if (h >= 6 && h < 12) return 'Sang';
  if (h >= 12 && h < 18) return 'Chieu';
  if (h >= 18 && h < 24) return 'Toi';
  return 'Dem';
}

// ============ DICE → RESULT ============
function itemToDice(item) {
  if (!item) return [0, 0, 0];
  return [safeInt(item.FirstDice), safeInt(item.SecondDice), safeInt(item.ThirdDice)];
}
function itemToSum(item) {
  if (!item) return 0;
  const s = itemToDice(item).reduce((a, b) => a + b, 0);
  if (s >= 3 && s <= 18) return s;
  const ds = safeInt(item.DiceSum);
  return (ds >= 3 && ds <= 18) ? ds : 0;
}
function itemToResult(item) {
  const sum = itemToSum(item);
  if (sum >= 3 && sum <= 18) return sum >= 11 ? 'T' : 'X';
  return null;
}
function itemToParity(item) {
  const s = itemToSum(item);
  if (s < 3) return null;
  return s % 2 === 0 ? 'E' : 'O';
}
function itemToHalf(item) {
  const s = itemToSum(item);
  if (s < 3) return null;
  return s <= 10 ? 'L' : 'H';
}

// ============ DB ============
function defaultDB() {
  return {
    version: VERSION,
    createdAt: now(), updatedAt: now(),
    history: [],
    stats: {
      total: 0, wins: 0, losses: 0, skips: 0,
      currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0
    },
    signalStats: { total: 0, wins: 0, losses: 0, accuracy: 0 },
    byType: {},
    timeStats: {},
    lastProcessedSession: null,
    stoploss: { active: false, recoverUntil: 0, reason: '' },
    lastSignaledSession: null
  };
}
function migrateDB(db) {
  if (!db || typeof db !== 'object') return defaultDB();
  const def = defaultDB();
  for (const k in def) if (db[k] === undefined || db[k] === null) db[k] = def[k];
  if (!Array.isArray(db.history)) db.history = [];
  if (!db.stats || typeof db.stats !== 'object') db.stats = def.stats;
  if (!db.stats.skips && db.stats.skips !== 0) db.stats.skips = 0;
  if (!db.signalStats) db.signalStats = def.signalStats;
  if (!db.byType || typeof db.byType !== 'object') db.byType = {};
  if (!db.timeStats || typeof db.timeStats !== 'object') db.timeStats = {};
  if (!db.stoploss || typeof db.stoploss !== 'object') db.stoploss = def.stoploss;
  if (!db.version) db.version = VERSION;
  db.history = db.history.filter(h => h && typeof h === 'object' && h.phien !== undefined);
  return db;
}
function loadDatabase(game) {
  const db = safeReadJson(DB_FILES[game]) || safeReadJson(BACKUP_FILES[game]) || defaultDB();
  return migrateDB(db);
}
function saveDatabase(game, db) {
  db.updatedAt = now();
  safeAtomicWrite(DB_FILES[game], db);
  safeAtomicWrite(BACKUP_FILES[game], db);
}

// ========================================================================
// 🎯 SERVER-SIDE ENGINE — KHÔNG BAO GIỜ EXPORT RA API
// ========================================================================

function analyzeStreak(seq) {
  const n = seq.length;
  if (n === 0) return { type: null, length: 0 };
  const last = seq[n - 1];
  let len = 1;
  for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
  return { type: last, length: len };
}

// ---------- HAZARD RATE ----------
function computeHazardRates(db, field = 'ketQua') {
  const hist = (db.history || []).filter(h => h[field]);
  const streaks = [];
  let cur = null, curLen = 0;
  for (const h of hist) {
    const v = h[field];
    if (v === cur) curLen++;
    else {
      if (cur !== null && curLen > 0) streaks.push({ type: cur, len: curLen });
      cur = v; curLen = 1;
    }
  }
  if (cur !== null) streaks.push({ type: cur, len: curLen });

  const maxL = 15;
  const hazard = {};
  for (let L = 2; L <= maxL; L++) {
    let atL = 0, brokeAtL = 0;
    // Đếm streak đạt độ dài L và streak kế tiếp có đổi type không
    for (let i = 0; i < streaks.length - 1; i++) {
      if (streaks[i].len >= L) atL++;
      if (streaks[i].len === L && streaks[i + 1].type !== streaks[i].type) brokeAtL++;
    }
    if (atL >= 3) hazard[L] = brokeAtL / Math.max(1, streaks.filter(s => s.len === L).length);
    else hazard[L] = 0.5;
  }
  return hazard;
}

// ---------- MARKOV CHAIN bậc 1-3 ----------
function buildMarkov(seq, order = 2) {
  const counts = {};
  for (let i = order; i < seq.length; i++) {
    const key = seq.slice(i - order, i).join('');
    const next = seq[i];
    if (!counts[key]) counts[key] = { T: 0, X: 0 };
    counts[key][next]++;
  }
  return counts;
}
function markovPredict(counts, seq, order) {
  if (seq.length < order) return null;
  const key = seq.slice(-order).join('');
  const c = counts[key];
  if (!c) return null;
  const total = c.T + c.X;
  if (total < 3) return null; // insufficient
  return {
    next: c.T >= c.X ? 'T' : 'X',
    prob: Math.max(c.T, c.X) / total,
    samples: total
  };
}

// ---------- PATTERN DETECT (giữ v9 + mở rộng) ----------
function detectPatterns(seq) {
  const n = seq.length;
  if (n < 4) return [];
  const last = seq[n - 1];
  const results = [];

  // BỆT
  const s = analyzeStreak(seq);
  if (s.length >= 4) {
    if (s.length <= 7) {
      results.push({ type: `BỆT_${s.length}`, next: last, confidence: Math.min(0.66 + (s.length - 4) * 0.04, 0.85), family: 'bet' });
    } else if (s.length <= 10) {
      results.push({ type: `BỆT_${s.length}_NGHI`, next: last, confidence: 0.55, family: 'bet' });
    } else {
      results.push({ type: `BỆT_${s.length}_GÃY`, next: flip(last), confidence: 0.62, family: 'bet' });
    }
  }

  // 1-1
  {
    let alt = 0;
    for (let i = n - 1; i >= 1; i--) { if (seq[i] !== seq[i - 1]) alt++; else break; }
    if (alt >= 5) results.push({ type: 'CẦU_1_1', next: flip(last), confidence: Math.min(0.62 + (alt - 5) * 0.04, 0.82), family: 'cycle' });
  }

  const matchTail = (tail) => {
    const t = tail.join('');
    if (seq.length < t.length) return false;
    return seq.slice(-t.length).join('') === t;
  };
  const T = 'T', X = 'X';

  const cycleMap = [
    ['CẦU_2_2', [T,T,X,X,T,T,X,X], T],
    ['CẦU_2_2', [X,X,T,T,X,X,T,T], X],
    ['CẦU_2_2', [T,T,X,X,T,T], X],
    ['CẦU_2_2', [X,X,T,T,X,X], T],
    ['CẦU_2_2', [T,T,X,X], T],
    ['CẦU_2_2', [X,X,T,T], X],
    ['CẦU_3_3', [T,T,T,X,X,X,T,T,T], X],
    ['CẦU_3_3', [X,X,X,T,T,T,X,X,X], T],
    ['CẦU_3_3', [T,T,T,X,X,X], T],
    ['CẦU_3_3', [X,X,X,T,T,T], X],
    ['CẦU_4_4', [T,T,T,T,X,X,X,X], T],
    ['CẦU_4_4', [X,X,X,X,T,T,T,T], X],
    ['CẦU_5_5', [T,T,T,T,T,X,X,X,X,X], T],
    ['CẦU_5_5', [X,X,X,X,X,T,T,T,T,T], X],
    ['CẦU_1_2_1', [T,X,X,T,X,X,T,X], T],
    ['CẦU_1_2_1', [X,T,T,X,T,T,X,T], X],
    ['CẦU_1_2_1', [T,X,X,T,X], X],
    ['CẦU_1_2_1', [X,T,T,X,T], T],
    ['CẦU_2_1_2', [T,T,X,T,T,X], T],
    ['CẦU_2_1_2', [X,X,T,X,X,T], X],
    ['CẦU_1_3_1', [T,X,X,X,T], X],
    ['CẦU_1_3_1', [X,T,T,T,X], T],
    ['CẦU_2_1_1', [T,T,X,T,T,X,T,T], X],
    ['CẦU_2_1_1', [X,X,T,X,X,T,X,X], T],
    ['CẦU_1_1_2', [T,X,T,T,X,T,T], X],
    ['CẦU_1_1_2', [X,T,X,X,T,X,X], T],
    ['CẦU_3_2_3', [T,T,T,X,X,T,T,T], X],
    ['CẦU_3_2_3', [X,X,X,T,T,X,X,X], T],
    ['CẦU_2_3_2', [T,T,X,X,X,T,T], X],
    ['CẦU_2_3_2', [X,X,T,T,T,X,X], T],
    ['CẦU_3_1_3', [T,T,T,X,T,T,T], X],
    ['CẦU_3_1_3', [X,X,X,T,X,X,X], T],
    ['CẦU_MIRROR', [T,X,X,T], T],
    ['CẦU_MIRROR', [X,T,T,X], X],
  ];
  cycleMap.sort((a, b) => b[1].length - a[1].length);
  for (const [type, tail, next] of cycleMap) {
    if (matchTail(tail)) {
      const baseConf = 0.58 + Math.min((tail.length - 4) * 0.03, 0.18);
      results.push({ type, next, confidence: Math.min(baseConf, 0.85), family: 'cycle' });
      break;
    }
  }

  // Tăng/giảm tiến
  {
    const blocks = [];
    let curT = seq[0], curL = 1;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === curT) curL++;
      else { blocks.push({ type: curT, len: curL }); curT = seq[i]; curL = 1; }
    }
    blocks.push({ type: curT, len: curL });
    if (blocks.length >= 3) {
      const last3 = blocks.slice(-3);
      const [a, b, c] = last3.map(x => x.len);
      if (a < b && b < c && c <= 5) {
        results.push({ type: 'CẦU_TĂNG_TIẾN', next: flip(last3[2].type), confidence: 0.60, family: 'progression' });
      } else if (a > b && b > c && a <= 5) {
        results.push({ type: 'CẦU_GIẢM_TIẾN', next: flip(last3[2].type), confidence: 0.58, family: 'progression' });
      }
    }
  }

  // Chu kỳ lặp 5/6/7
  for (const period of [5, 6, 7]) {
    if (n < period * 2) continue;
    const p1 = seq.slice(-period * 2, -period).join('');
    const p2 = seq.slice(-period).join('');
    if (p1 === p2) {
      results.push({ type: `CẦU_LẶP_${period}`, next: seq[n - period], confidence: 0.68, family: 'periodic' });
    }
  }

  return results;
}

// ---------- ENSEMBLE VOTING ----------
function ensembleVote(patterns, markov, hazard, seq) {
  let votes = { T: 0, X: 0 };
  let detail = [];

  for (const p of patterns) {
    const weight = p.confidence;
    votes[p.next] += weight;
    detail.push({ type: p.type, next: p.next, conf: p.confidence, weight });
  }

  // Markov vote
  if (markov) {
    const w = markov.prob * 0.8; // scale down vì có thể thiếu sample
    votes[markov.next] += w;
    detail.push({ type: `MARKOV_b${markov.samples >= 5 ? 'R' : '?'}`, next: markov.next, conf: markov.prob, weight: w });
  }

  // Hazard vote cho bệt dài
  const streak = analyzeStreak(seq);
  if (streak.length >= 6 && hazard) {
    const h = hazard[Math.min(streak.length, 15)] || 0.5;
    if (h > 0.55) {
      const w = (h - 0.5) * 1.2;
      votes[flip(streak.type)] += w;
      detail.push({ type: 'HAZARD', next: flip(streak.type), conf: h, weight: w });
    }
  }

  const total = votes.T + votes.X;
  if (total === 0) return { next: null, confidence: 0, votes, detail };

  const next = votes.T >= votes.X ? 'T' : 'X';
  const rawProb = Math.max(votes.T, votes.X) / total;

  // Agreement bonus: càng nhiều pattern đồng thuận → tăng conf
  const agreeing = detail.filter(d => d.next === next).length;
  const totalSig = detail.length;
  const agreement = totalSig > 0 ? agreeing / totalSig : 0;

  // Scale to realistic range (0.5 - 0.92)
  let confidence = 0.5 + (rawProb - 0.5) * 0.6 + agreement * 0.15;
  confidence = Math.max(0.35, Math.min(0.92, confidence));

  return { next, confidence, votes, detail, agreement, totalVotes: totalSig };
}

// ---------- EXPONENTIAL SMOOTHING cho byType ----------
function smoothConfidence(type, rawConf, db, alpha = 0.3) {
  const t = db.byType[type];
  if (!t || t.total < 5) return rawConf;
  const acc = t.wins / t.total;
  // Blend với historical accuracy
  return rawConf * (1 - alpha) + acc * alpha;
}

// ---------- STOPLOSS ----------
function checkStoploss(db, session) {
  const sl = db.stoploss || { active: false, recoverUntil: 0, reason: '' };
  if (sl.active && session < sl.recoverUntil) {
    return { active: true, reason: sl.reason, recoverUntil: sl.recoverUntil };
  }
  // Auto-clear nếu qua thời gian
  if (sl.active && session >= sl.recoverUntil) {
    db.stoploss = { active: false, recoverUntil: 0, reason: '' };
  }
  return { active: false };
}
function updateStoploss(db, wasCorrect, wasPredict, session) {
  if (!wasPredict) return;
  const sl = db.stoploss || { active: false, recoverUntil: 0, reason: '' };
  if (wasCorrect) return;
  // Vừa thua — kiểm tra streak
  const recent = db.history.slice(-STOPLOSS_LOSS_STREAK).filter(h => h.trangThai === 'SAI');
  if (recent.length >= STOPLOSS_LOSS_STREAK) {
    db.stoploss = {
      active: true,
      recoverUntil: session + STOPLOSS_RECOVER_SESSIONS,
      reason: `Thua ${STOPLOSS_LOSS_STREAK} phiên liên tiếp`
    };
    console.log(`[STOPLOSS] Active — nghỉ đến phiên ${session + STOPLOSS_RECOVER_SESSIONS}`);
  }
}

// ---------- MAIN PREDICT ----------
function runPrediction(db, seq, game, session) {
  const empty = {
    code: null, label: null, tiLe: 'CHỜ',
    pattern: { type: 'NONE', confidence: 0 },
    streak: analyzeStreak(seq || []),
    shouldPredict: false,
    stoploss: { active: false }
  };
  if (!Array.isArray(seq) || seq.length < 4) return empty;

  // Stoploss check
  const sl = checkStoploss(db, session);
  if (sl.active) {
    return { ...empty, stoploss: sl, tiLe: 'NGHỈ' };
  }

  // Patterns
  const patterns = detectPatterns(seq);

  // Markov bậc 1,2,3
  const markovs = [1, 2, 3].map(o => {
    const counts = buildMarkov(seq, o);
    return markovPredict(counts, seq, o);
  }).filter(Boolean);
  const markov = markovs.length > 0 ? markovs.reduce((best, m) => (!best || m.prob > best.prob) ? m : best) : null;

  // Hazard
  const hazard = computeHazardRates(db);

  // Ensemble
  const vote = ensembleVote(patterns, markov, hazard, seq);

  if (!vote.next) {
    return { ...empty, pattern: { type: 'NONE', confidence: 0 }, stoploss: { active: false } };
  }

  // Smooth theo lịch sử của type chính
  const mainPattern = patterns.find(p => p.next === vote.next);
  let finalConf = vote.confidence;
  if (mainPattern) finalConf = smoothConfidence(mainPattern.type, finalConf, db, 0.25);

  // Chỉ predict khi đủ điều kiện
  const shouldPredict = finalConf >= MIN_CONFIDENCE && vote.totalVotes >= ENSEMBLE_MIN_VOTES;

  // Gộp tên cầu để hiển thị (KHÔNG lộ chi tiết)
  let displayType = 'NONE';
  if (patterns.length > 0) {
    const topPatterns = patterns.filter(p => p.next === vote.next).slice(0, 2);
    if (topPatterns.length > 0) displayType = topPatterns.map(p => p.type).join('+');
    else displayType = patterns[0].type;
  } else if (markov) {
    displayType = 'MARKOV';
  }

  return {
    code: shouldPredict ? vote.next : null,
    label: shouldPredict ? labelFromTX(vote.next) : null,
    tiLe: shouldPredict ? (finalConf * 100).toFixed(1) + '%' : 'CHỜ',
    pattern: {
      type: displayType,
      confidence: Number(finalConf.toFixed(3)),
      // KHÔNG trả votes/detail/hazard về client
    },
    streak: analyzeStreak(seq),
    shouldPredict,
    stoploss: { active: false }
  };
}

// ========================================================================
// TELEGRAM NOTIFY
// ========================================================================
async function notifyTelegram(game, session, pred) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  if (!pred.shouldPredict) return;
  const conf = parseFloat(pred.tiLe);
  if (!(conf >= TELEGRAM_MIN_CONF * 100)) return;

  const text = `🎯 <b>${game.toUpperCase()} #${session + 1}</b>\n` +
    `📊 <b>${pred.label}</b> (${pred.tiLe})\n` +
    `🎲 Cầu: ${pred.pattern.type}\n` +
    `⏰ ${new Date().toLocaleTimeString('vi-VN')}`;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML'
    }, { timeout: 5000 });
    console.log(`[TELEGRAM] Sent ${game} #${session + 1}`);
  } catch (e) {
    console.error(`[TELEGRAM ERR]`, e?.message);
  }
}

// ========================================================================
// FETCH
// ========================================================================
async function fetchWithRetry(url, attempts = FETCH_RETRIES) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.get(url, { timeout: API_TIMEOUT_MS, headers: { 'User-Agent': 'HoangVip/10.0' } });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 200 + i * 200));
    }
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

// ========================================================================
// MAIN TICK
// ========================================================================
async function processGameTick(game) {
  try {
    const api = APIS[game];
    if (!api) return;
    const resp = await fetchWithRetry(api);
    const list = parseHistoryResponse(resp.data);
    if (!list.length) return;

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId || latest.session);
    if (!session) return;

    const db = loadDatabase(game);
    if (db.lastProcessedSession === session) return;

    const seq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    if (seq.length < 4) return;

    // Evaluate previous
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
      const actual = itemToResult(latest);
      prev.ketQua = actual;
      prev.ketQuaLabel = labelFromTX(actual);

      if (!prev.DU_DOAN_CODE) {
        prev.trangThai = 'BỎ QUA';
        db.stats.skips = (db.stats.skips || 0) + 1;
      } else {
        const correct = prev.DU_DOAN_CODE === actual;
        prev.trangThai = correct ? 'ĐÚNG' : 'SAI';
        db.stats.total++;

        const slot = getCurrentTimeSlot();
        if (!db.timeStats[slot]) db.timeStats[slot] = { total: 0, wins: 0 };
        db.timeStats[slot].total++;

        if (correct) {
          db.stats.wins++;
          db.timeStats[slot].wins++;
          db.stats.currentStreak = db.stats.currentStreak >= 0 ? db.stats.currentStreak + 1 : 1;
          if (db.stats.currentStreak > db.stats.maxWinStreak) db.stats.maxWinStreak = db.stats.currentStreak;
        } else {
          db.stats.losses++;
          db.stats.currentStreak = db.stats.currentStreak <= 0 ? db.stats.currentStreak - 1 : -1;
          if (Math.abs(db.stats.currentStreak) > db.stats.maxLossStreak) db.stats.maxLossStreak = Math.abs(db.stats.currentStreak);
        }

        const pType = prev.pattern?.type;
        if (pType && pType !== 'NONE') {
          if (!db.byType[pType]) db.byType[pType] = { total: 0, wins: 0 };
          db.byType[pType].total++;
          if (correct) db.byType[pType].wins++;
        }

        db.signalStats.total++;
        if (correct) db.signalStats.wins++;
        else db.signalStats.losses++;
        db.signalStats.accuracy = db.signalStats.total > 0
          ? Number((db.signalStats.wins / db.signalStats.total * 100).toFixed(2)) : 0;

        // Update stoploss
        updateStoploss(db, correct, true, session);
      }
    }

    // New prediction
    const pred = runPrediction(db, seq, game, session);

    db.history.push({
      phien: session,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: itemToResult(latest),
      ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: session + 1,
      DU_DOAN_CODE: pred.shouldPredict ? pred.code : null,
      DU_DOAN: pred.shouldPredict ? pred.label : (pred.stoploss?.active ? 'NGHỈ' : 'CHỜ'),
      TI_LE: pred.tiLe,
      pattern: pred.pattern,
      streak: pred.streak,
      trangThai: 'ĐANG CHỜ',
      thoiGian: now()
    });
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);
    db.lastProcessedSession = session;

    saveDatabase(game, db);

    console.log(`[TICK] ${game} #${session} ${itemToSum(latest)}(${labelFromTX(itemToResult(latest))}) → ${pred.shouldPredict ? pred.label : (pred.stoploss?.active ? 'NGHỈ' : 'CHỜ')} [${pred.pattern.type} ${pred.tiLe}]`);

    // Telegram only once per session
    if (pred.shouldPredict && db.lastSignaledSession !== session) {
      db.lastSignaledSession = session;
      notifyTelegram(game, session, pred).catch(() => {});
    }
  } catch (e) {
    console.error(`[TICK ERR] ${game}`, e?.message || e);
  }
}

// ========================================================================
// POLLING
// ========================================================================
let pollingActive = true;
function startPolling() {
  async function tick() {
    if (!pollingActive) return;
    await Promise.all(Object.keys(APIS).map(async g => {
      try { await processGameTick(g); } catch {}
    }));
    if (pollingActive) setTimeout(tick, POLL_INTERVAL_MS);
  }
  tick();
}

// ========================================================================
// FORMAT (chỉ những field AN TOÀN, KHÔNG lộ thuật toán)
// ========================================================================
function formatItem(it) {
  if (!it) return null;
  return {
    phien: it.phien,
    xucXac: Array.isArray(it.xucXac) ? it.xucXac : [0, 0, 0],
    tong: it.tong ?? 0,
    ketQua: it.ketQua || null,
    ketQuaLabel: it.ketQuaLabel || labelFromTX(it.ketQua),
    phienDuDoan: it.phienDuDoan,
    duDoan: it.DU_DOAN || 'CHỜ',
    duDoanCode: it.DU_DOAN_CODE || null,
    tiLe: it.TI_LE || 'CHỜ',
    pattern: it.pattern && it.pattern.type ? { type: it.pattern.type } : null, // CHỈ tên
    trangThai: it.trangThai || null,
    thoiGian: it.thoiGian || null
  };
}

// ========================================================================
// API PUBLIC (không lộ thuật toán)
// ========================================================================
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ ok: false, error: 'Bàn chơi không hợp lệ.' });
  try {
    const r = await fetchWithRetry(APIS[game]);
    const list = parseHistoryResponse(r.data);
    if (!list.length) return res.status(204).send();

    const seq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const db = loadDatabase(game);
    const latest = list[list.length - 1];
    const cs = safeInt(latest.SessionId || latest.session);
    const pred = runPrediction(db, seq, game, cs);

    return res.json({
      ok: true,
      game,
      phien: cs,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: itemToResult(latest),
      ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: cs + 1,
      duDoan: pred.shouldPredict ? pred.label : (pred.stoploss?.active ? 'NGHỈ' : 'CHỜ'),
      duDoanCode: pred.shouldPredict ? pred.code : null,
      tiLe: pred.tiLe,
      // CHỈ trả tên pattern, không trả chi tiết
      pattern: pred.pattern && pred.pattern.type !== 'NONE' ? pred.pattern.type : null,
      shouldPredict: pred.shouldPredict,
      stoploss: pred.stoploss?.active ? { active: true, reason: pred.stoploss.reason } : { active: false },
      serverTime: now()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/json/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ ok: false, error: 'Bàn chơi không hợp lệ.' });
  const db = loadDatabase(game);
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 100)));
  return res.json({
    ok: true, game, version: db.version,
    stats: db.stats, signalStats: db.signalStats,
    byType: db.byType, timeStats: db.timeStats,
    stoploss: db.stoploss,
    items: db.history.slice(-limit).reverse().map(formatItem)
  });
});

app.get('/api/history/:game', (req, res) => {
  const game = req.params.game;
  if (game === 'all') return handleHistoryAll(req, res);
  if (!DB_FILES[game]) return res.status(400).json({ ok: false, error: 'Bàn chơi không hợp lệ.' });
  const db = loadDatabase(game);
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 200)));
  return res.json({ ok: true, game, items: db.history.slice(-limit).reverse().map(formatItem) });
});

function handleHistoryAll(req, res) {
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 500)));
  const result = { ok: true, games: {} };
  for (const game of Object.keys(DB_FILES)) {
    try {
      const db = loadDatabase(game);
      result.games[game] = {
        stats: db.stats, signalStats: db.signalStats,
        byType: db.byType,
        items: db.history.slice(-limit).reverse().map(formatItem)
      };
    } catch (e) { result.games[game] = { error: e.message }; }
  }
  return res.json(result);
}
app.get('/api/history/all', handleHistoryAll);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true, version: VERSION, uptime: process.uptime(),
    polling: pollingActive, pollMs: POLL_INTERVAL_MS,
    games: Object.keys(APIS), serverTime: now()
  });
});

// CSV Export
app.get('/api/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Invalid game');
  const db = loadDatabase(game);
  let csv = 'Phiên,XúcXắc,Tổng,KếtQuả,PhiênDựĐoán,DựĐoán,TỉLệ,LoạiCầu,TrạngThái,ThờiGian\n';
  db.history.forEach(it => {
    const dice = (it.xucXac || []).join('-');
    const pType = it.pattern?.type || '';
    csv += `${it.phien},"${dice}",${it.tong || ''},${it.ketQuaLabel || ''},${it.phienDuDoan},${it.DU_DOAN || ''},${it.TI_LE || ''},"${pType}",${it.trangThai || ''},${it.thoiGian || ''}\n`;
  });
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`lich_su_${game}.csv`);
  res.send('\uFEFF' + csv);
});

// ========================================================================
// UI — KHÔNG CÓ LOGIC THUẬT TOÁN NÀO TRONG HTML
// ========================================================================
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Trang không tồn tại.');

  const db = loadDatabase(game);
  const globalAcc = db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) : '0.00';
  const signalAcc = db.signalStats.accuracy || 0;
  const rows = db.history.slice(-50).reverse();
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const slActive = db.stoploss?.active;

  const shortType = t => t
    .replace(/^CẦU_/, '')
    .replace(/_/g, '-')
    .replace(/^BỆT_/, 'BỆT ');

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>HOANG VIP v10 - ${game.toUpperCase()}</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:linear-gradient(135deg,#0a0e27 0%,#0f172a 50%,#1a1f3a 100%);
    color:#e6eef6;padding:12px;margin:0;min-height:100vh;}
  .header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;
    margin-bottom:14px;box-shadow:0 8px 24px rgba(59,130,246,.3);}
  h1{color:#fff;font-size:17px;margin:0;font-weight:700}
  .subtitle{color:#bfdbfe;font-size:11px;margin-top:4px}
  .stoploss-banner{background:linear-gradient(135deg,#7f1d1d,#991b1b);padding:12px;
    border-radius:12px;margin-bottom:14px;border:1px solid #ef4444;text-align:center}
  .stoploss-banner .t{font-weight:700;color:#fecaca;font-size:13px}
  .stoploss-banner .r{font-size:11px;color:#fca5a5;margin-top:4px}
  .stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
  .stat-card{background:linear-gradient(135deg,#1e293b,#0f172a);padding:10px;border-radius:10px;
    text-align:center;border:1px solid #334155;}
  .stat-card .label{font-size:10px;color:#94a3b8;text-transform:uppercase}
  .stat-card .value{font-size:20px;font-weight:700;margin-top:2px}
  .value.green{color:#22c55e}.value.red{color:#ef4444}
  .value.blue{color:#38bdf8}.value.yellow{color:#eab308}.value.orange{color:#fb923c}
  .section-title{font-size:12px;color:#94a3b8;text-transform:uppercase;margin:14px 0 8px;
    font-weight:700;letter-spacing:1px}
  .table-wrap{background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:12px;overflow:hidden;
    border:1px solid #334155;margin-bottom:14px}
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{background:linear-gradient(135deg,#1e40af,#3b82f6);color:#fff;padding:8px 4px;
    font-weight:600;text-transform:uppercase;font-size:9px}
  td{padding:8px 4px;text-align:center;border-bottom:1px solid #1e293b}
  tr:hover{background:rgba(59,130,246,.08)}
  .tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
  .dung{color:#22c55e;font-weight:600}.sai{color:#ef4444;font-weight:600}
  .cho{color:#eab308;font-weight:600;animation:pulse 1.5s infinite}
  .nghi{color:#94a3b8;font-weight:600;font-style:italic}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  .dice{font-family:'Courier New',monospace;font-weight:600;color:#fbbf24}
  .sum-badge{display:inline-block;padding:2px 6px;border-radius:4px;
    background:rgba(251,191,36,.15);color:#fbbf24;font-weight:700}
  .session{font-family:'Courier New',monospace;font-size:10px;color:#94a3b8}
  .ti-le{font-size:10px;color:#a5b4fc}
  .pattern-badge{display:inline-block;font-size:9px;padding:2px 5px;border-radius:4px;
    font-weight:700;background:#1e40af;color:#93c5fd}
  .pattern-badge.bet{background:#7c2d12;color:#fdba74}
  .wait{color:#94a3b8;font-style:italic}
  .copy-btn{background:#10b981;color:#fff;border:none;padding:4px 10px;border-radius:6px;
    font-size:10px;font-weight:600;cursor:pointer}
  .link-row{font-family:'Courier New',monospace;font-size:11px;color:#d1fae5;
    background:rgba(0,0,0,.3);padding:8px;border-radius:6px;margin-bottom:6px;
    display:flex;justify-content:space-between;align-items:center;gap:8px}
  .link-box{background:linear-gradient(135deg,#064e3b,#065f46);padding:12px;border-radius:12px;
    margin-bottom:14px;border:1px solid #10b981}
  .link-box .title{font-size:12px;color:#6ee7b7;font-weight:600;margin-bottom:6px}
</style>
<script>
  setTimeout(()=>location.reload(), 10000);
  function copyText(text, btn){
    const done=()=>{const old=btn.textContent;btn.textContent='✓';setTimeout(()=>btn.textContent=old,1500)};
    if(navigator.clipboard){navigator.clipboard.writeText(text).then(done).catch(done)}
    else{const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);
      ta.select();document.execCommand('copy');document.body.removeChild(ta);done();}
  }
</script>
</head>
<body>
  <div class="header">
    <h1>🎯 HOANG VIP v10</h1>
    <div class="subtitle">Bàn: ${game.toUpperCase()} • Chỉ dự đoán khi đủ tín hiệu</div>
  </div>

  ${slActive ? `
  <div class="stoploss-banner">
    <div class="t">⚠️ ĐANG NGHỈ (STOPLOSS)</div>
    <div class="r">${db.stoploss.reason} — hồi phục sau phiên ${db.stoploss.recoverUntil}</div>
  </div>` : ''}

  <div class="stats-grid">
    <div class="stat-card"><div class="label">Dự đoán</div><div class="value blue">${db.stats.total}</div></div>
    <div class="stat-card"><div class="label">Thắng</div><div class="value green">${db.stats.wins}</div></div>
    <div class="stat-card"><div class="label">Thua</div><div class="value red">${db.stats.losses}</div></div>
    <div class="stat-card"><div class="label">Bỏ qua</div><div class="value orange">${db.stats.skips || 0}</div></div>
    <div class="stat-card"><div class="label">Acc signal</div><div class="value ${signalAcc >= 60 ? 'green' : (signalAcc >= 50 ? 'yellow' : 'red')}">${signalAcc}%</div></div>
    <div class="stat-card"><div class="label">Acc tổng</div><div class="value ${parseFloat(globalAcc) >= 50 ? 'green' : 'yellow'}">${globalAcc}%</div></div>
  </div>

  <div class="link-box">
    <div class="title">🔗 API</div>
    <div class="link-row">
      <span>${baseUrl}/api/predict/${game}</span>
      <button class="copy-btn" onclick="copyText('${baseUrl}/api/predict/${game}', this)">Copy</button>
    </div>
    <div class="link-row">
      <span>${baseUrl}/json/${game}</span>
      <button class="copy-btn" onclick="copyText('${baseUrl}/json/${game}', this)">Copy</button>
    </div>
  </div>

  <div class="section-title">📊 50 phiên gần nhất</div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Phiên</th><th>XX</th><th>Tổng</th><th>KQ</th><th>Dự đoán</th>
        <th>Tỉ lệ</th><th>Loại</th><th>KQ</th>
      </tr></thead>
      <tbody>
        ${rows.map(it => {
          const dice = (it.xucXac || []).join('-');
          const kq = it.ketQuaLabel || labelFromTX(it.ketQua) || '';
          const kqCls = it.ketQua === 'T' ? 'tai' : (it.ketQua === 'X' ? 'xiu' : '');
          const isWait = !it.DU_DOAN_CODE;
          const isNghi = it.DU_DOAN === 'NGHỈ';
          const ddCls = isNghi ? 'nghi' : (isWait ? 'wait' : (it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu'));
          const ttCls = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : (it.trangThai === 'BỎ QUA' ? 'wait' : 'cho'));
          const pType = it.pattern?.type || 'NONE';
          const isBet = pType.startsWith('BỆT');
          return `<tr>
            <td class="session">${it.phien}</td>
            <td class="dice">${dice}</td>
            <td><span class="sum-badge">${it.tong || ''}</span></td>
            <td class="${kqCls}">${kq}</td>
            <td class="${ddCls}">${isNghi ? 'NGHỈ' : (isWait ? 'CHỜ' : it.DU_DOAN)}</td>
            <td class="ti-le">${it.TI_LE || '—'}</td>
            <td>${pType !== 'NONE' ? `<span class="pattern-badge ${isBet ? 'bet' : ''}">${shortType(pType)}</span>` : '<span class="wait">—</span>'}</td>
            <td class="${ttCls}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <div style="text-align:center;font-size:10px;color:#475569;margin-top:14px">
    Tự refresh 10s • HOANG VIP v10
  </div>
</body>
</html>`;
  res.send(html);
});

// ========================================================================
// SERVER
// ========================================================================
const server = app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 HOANG VIP v${VERSION} — FULL ENGINE`);
  console.log(`========================================`);
  console.log(`Port: ${PORT} | Poll: ${POLL_INTERVAL_MS}ms | MinConf: ${MIN_CONFIDENCE}`);
  console.log(`✅ Ensemble Voting + Markov b1-3 + Hazard + Stoploss`);
  console.log(`✅ UI/HTML KHÔNG chứa logic thuật toán`);
  console.log(`✅ Telegram: ${TELEGRAM_TOKEN ? 'ON' : 'OFF'}`);
  console.log(`Endpoints:`);
  console.log(`  /${Object.keys(APIS)[0]}            (UI)`);
  console.log(`  /api/predict/{game}   (JSON predict)`);
  console.log(`  /json/{game}          (JSON full)`);
  console.log(`  /api/health           (health)`);
  console.log(`========================================`);
  startPolling();
});

function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down...`);
  pollingActive = false;
  server.close(() => { console.log('[OK] Closed.'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
