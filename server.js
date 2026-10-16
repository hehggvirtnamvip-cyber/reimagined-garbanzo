/**
 * ========================================================================
 * HOANG VIP v8 - NHẬN DIỆN CẦU FULL
 * ========================================================================
 * ✅ CHỈ predict khi có tín hiệu rõ (bệt 4+, cầu 2-2, 3-3, 1-1, ...)
 * ✅ Không có tín hiệu → CHỜ (không đoán mò)
 * ✅ Nhận diện 12+ loại cầu:
 *    - Bệt: 4-5-6-7-8-9-10+
 *    - Cầu 1-1 (đảo liên tục)
 *    - Cầu 2-2, 3-3, 4-4
 *    - Cầu 1-2-1, 2-1-2, 1-3-1
 *    - Cầu 2-1-1, 1-1-2
 *    - Cầu 3-2-3, 2-3-2
 *    - Cầu tăng tiến (1-2-3-4)
 * ✅ Track accuracy riêng trên phiên có predict
 * ✅ UI đẹp + badge loại cầu
 * ✅ Fix DiceSum 3-10=Xỉu, 11-18=Tài
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
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 500);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 8000);
const FETCH_RETRIES = 3;

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
function now() { return new Date().toISOString(); }
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }

function labelFromTX(code) {
  if (code === 'T') return 'Tài';
  if (code === 'X') return 'Xỉu';
  return null;
}
function codeFromLabel(label) {
  if (label === 'Tài') return 'T';
  if (label === 'Xỉu') return 'X';
  return null;
}

function safeReadJson(fp, fb = null) {
  try {
    if (!fs.existsSync(fp)) return fb;
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw || !raw.trim()) return fb;
    return JSON.parse(raw);
  } catch (e) { return fb; }
}

function safeAtomicWrite(fp, data) {
  try {
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return true;
  } catch (e) { return false; }
}

function getCurrentTimeSlot(date = new Date()) {
  const h = date.getHours();
  if (h >= 6 && h < 12) return 'Sang';
  if (h >= 12 && h < 18) return 'Chieu';
  if (h >= 18 && h < 24) return 'Toi';
  return 'Dem';
}

// ============ ✅ FIX: TÍNH KẾT QUẢ TỪ DICESUM ============
function itemToDice(item) {
  if (!item) return [0, 0, 0];
  return [
    safeInt(item.FirstDice, 0),
    safeInt(item.SecondDice, 0),
    safeInt(item.ThirdDice, 0)
  ];
}

function itemToSum(item) {
  if (!item) return 0;
  const d = itemToDice(item);
  const s = d[0] + d[1] + d[2];
  if (s >= 3 && s <= 18) return s;
  if (item.DiceSum !== undefined) {
    const ds = safeInt(item.DiceSum, 0);
    if (ds >= 3 && ds <= 18) return ds;
  }
  return 0;
}

function itemToResult(item) {
  if (!item) return null;
  const sum = itemToSum(item);
  if (sum >= 3 && sum <= 18) return sum >= 11 ? 'T' : 'X';
  return null;
}

// ============ DB ============
function defaultDB() {
  return {
    version: 8,
    createdAt: now(), updatedAt: now(),
    history: [],
    stats: { total: 0, wins: 0, losses: 0, skips: 0, currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0 },
    // ✅ NEW: Stats riêng cho phiên CÓ predict
    signalStats: { total: 0, wins: 0, losses: 0, accuracy: 0 },
    byType: {},  // { 'BỆT4': {total, wins}, 'CAU_2_2': {total, wins}, ... }
    lastProcessedSession: null,
    checkpoints: [],
    brierHistory: []
  };
}

function migrateDB(db) {
  if (!db || typeof db !== 'object') return defaultDB();
  const def = defaultDB();
  for (const k in def) if (db[k] === undefined || db[k] === null) db[k] = def[k];
  if (!Array.isArray(db.history)) db.history = [];
  if (!Array.isArray(db.checkpoints)) db.checkpoints = [];
  if (!Array.isArray(db.brierHistory)) db.brierHistory = [];
  if (!db.stats || typeof db.stats !== 'object') db.stats = def.stats;
  if (!Number.isFinite(db.stats.skips)) db.stats.skips = 0;
  if (!db.signalStats) db.signalStats = def.signalStats;
  if (!db.byType || typeof db.byType !== 'object') db.byType = {};
  if (!db.version) db.version = 8;
  db.history = db.history.filter(h => h && typeof h === 'object' && h.phien !== undefined);
  return db;
}

function loadDatabase(game) {
  let db = safeReadJson(DB_FILES[game]) || safeReadJson(BACKUP_FILES[game]) || defaultDB();
  return migrateDB(db);
}

function saveDatabase(game, db) {
  db.updatedAt = now();
  if (db.checkpoints.length > 50) db.checkpoints = db.checkpoints.slice(-50);
  if (db.brierHistory.length > 500) db.brierHistory = db.brierHistory.slice(-500);
  safeAtomicWrite(DB_FILES[game], db);
  safeAtomicWrite(BACKUP_FILES[game], db);
}

// ========================================================================
// 🎯 CORE: NHẬN DIỆN CẦU - 12 LOẠI
// ========================================================================
/**
 * Input: seq (array T/X, cũ→mới)
 * Output: { type, next, confidence, description }
 */
function detectAllPatterns(seq) {
  if (!seq || seq.length < 4) {
    return { type: 'none', next: null, confidence: 0, description: 'Không đủ data' };
  }

  const n = seq.length;
  const last = seq[n - 1];

  // ========== 1. BỆT (STREAK) ==========
  {
    let len = 1;
    for (let i = n - 2; i >= 0; i--) {
      if (seq[i] === last) len++; else break;
    }
    
    // Bệt 4-7: theo bệt (khả năng cao còn tiếp)
    if (len >= 4 && len <= 7) {
      return {
        type: `BỆT${len}`,
        next: last,
        confidence: 0.70 + Math.min((len - 4) * 0.03, 0.10),
        description: `Bệt ${len} phiên ${labelFromTX(last)} → theo bệt`
      };
    }
    
    // Bệt 8-10: bắt đầu nghi ngờ gãy
    if (len >= 8 && len <= 10) {
      return {
        type: `BỆT${len}_NGHI`,
        next: last,
        confidence: 0.55,
        description: `Bệt ${len} phiên → khả năng gãy sắp tới (vẫn theo)`
      };
    }
    
    // Bệt 11+: gãy
    if (len >= 11) {
      return {
        type: `BỆT${len}_GÃY`,
        next: last === 'T' ? 'X' : 'T',
        confidence: 0.62,
        description: `Bệt ${len} phiên → khả năng cao gãy`
      };
    }
  }

  // ========== 2. CẦU 1-1 (ĐẢO LIÊN TỤC) ==========
  {
    let alt = 0;
    for (let i = n - 1; i >= 1; i--) {
      if (seq[i] !== seq[i - 1]) alt++;
      else break;
    }
    if (alt >= 5) {
      const next = last === 'T' ? 'X' : 'T';
      return {
        type: `CẦU_1_1_${alt + 1}`,
        next,
        confidence: Math.min(0.62 + (alt - 5) * 0.04, 0.80),
        description: `Cầu 1-1 đảo ${alt + 1} phiên → đảo tiếp`
      };
    }
  }

  // ========== 3. CẦU 2-2 (TTXXTTXX) ==========
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TTXXTTXX') return { type: 'CẦU_2_2', next: 'T', confidence: 0.75, description: 'Cầu 2-2 chu kỳ đầy đủ → T' };
    if (p8 === 'XXTTXXTT') return { type: 'CẦU_2_2', next: 'X', confidence: 0.75, description: 'Cầu 2-2 chu kỳ đầy đủ → X' };
  }
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6 === 'TTXXTT') return { type: 'CẦU_2_2', next: 'X', confidence: 0.68, description: 'Cầu 2-2 → X' };
    if (p6 === 'XXTTXX') return { type: 'CẦU_2_2', next: 'T', confidence: 0.68, description: 'Cầu 2-2 → T' };
  }
  if (n >= 4) {
    const p4 = seq.slice(-4).join('');
    if (p4 === 'TTXX') return { type: 'CẦU_2_2', next: 'T', confidence: 0.62, description: 'Cầu 2-2 mới bắt đầu → T' };
    if (p4 === 'XXTT') return { type: 'CẦU_2_2', next: 'X', confidence: 0.62, description: 'Cầu 2-2 mới bắt đầu → X' };
  }

  // ========== 4. CẦU 3-3 (TTTXXXTTT) ==========
  if (n >= 9) {
    const p9 = seq.slice(-9).join('');
    if (p9 === 'TTTXXXTTT') return { type: 'CẦU_3_3', next: 'X', confidence: 0.78, description: 'Cầu 3-3 chu kỳ đầy đủ → X' };
    if (p9 === 'XXXTTTXXX') return { type: 'CẦU_3_3', next: 'T', confidence: 0.78, description: 'Cầu 3-3 chu kỳ đầy đủ → T' };
  }
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6 === 'TTTXXX') return { type: 'CẦU_3_3', next: 'T', confidence: 0.72, description: 'Cầu 3-3 → T' };
    if (p6 === 'XXXTTT') return { type: 'CẦU_3_3', next: 'X', confidence: 0.72, description: 'Cầu 3-3 → X' };
  }
  if (n >= 3) {
    const p3 = seq.slice(-3).join('');
    if (p3 === 'TTT') return { type: 'CẦU_3_3_MỚI', next: 'X', confidence: 0.58, description: '3 Tài liên tiếp → có thể bắt đầu 3-3' };
    if (p3 === 'XXX') return { type: 'CẦU_3_3_MỚI', next: 'T', confidence: 0.58, description: '3 Xỉu liên tiếp → có thể bắt đầu 3-3' };
  }

  // ========== 5. CẦU 4-4 (TTTTXXXX) ==========
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TTTTXXXX') return { type: 'CẦU_4_4', next: 'T', confidence: 0.72, description: 'Cầu 4-4 → T' };
    if (p8 === 'XXXXTTTT') return { type: 'CẦU_4_4', next: 'X', confidence: 0.72, description: 'Cầu 4-4 → X' };
  }

  // ========== 6. CẦU 1-2-1 (TXXTXXT) ==========
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TXXTXXTX') return { type: 'CẦU_1_2_1', next: 'T', confidence: 0.70, description: 'Cầu 1-2-1 → T' };
    if (p8 === 'XTTXTTXT') return { type: 'CẦU_1_2_1', next: 'X', confidence: 0.70, description: 'Cầu 1-2-1 → X' };
  }
  if (n >= 5) {
    const p5 = seq.slice(-5).join('');
    if (p5 === 'TXXTX') return { type: 'CẦU_1_2_1', next: 'X', confidence: 0.62, description: 'Cầu 1-2-1 mới → X' };
    if (p5 === 'XTTXT') return { type: 'CẦU_1_2_1', next: 'T', confidence: 0.62, description: 'Cầu 1-2-1 mới → T' };
  }

  // ========== 7. CẦU 2-1-2 (TTXTTX) ==========
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6 === 'TTXTTX') return { type: 'CẦU_2_1_2', next: 'T', confidence: 0.65, description: 'Cầu 2-1-2 → T' };
    if (p6 === 'XXTXXT') return { type: 'CẦU_2_1_2', next: 'X', confidence: 0.65, description: 'Cầu 2-1-2 → X' };
  }

  // ========== 8. CẦU 1-3-1 (TXXXT) ==========
  if (n >= 5) {
    const p5 = seq.slice(-5).join('');
    if (p5 === 'TXXXT') return { type: 'CẦU_1_3_1', next: 'X', confidence: 0.60, description: 'Cầu 1-3-1 → X' };
    if (p5 === 'XTTTX') return { type: 'CẦU_1_3_1', next: 'T', confidence: 0.60, description: 'Cầu 1-3-1 → T' };
  }

  // ========== 9. CẦU 2-1-1 (TTXT) ==========
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TTXTTXTT') return { type: 'CẦU_2_1_1', next: 'X', confidence: 0.68, description: 'Cầu 2-1-1 → X' };
    if (p8 === 'XXTXXTXX') return { type: 'CẦU_2_1_1', next: 'T', confidence: 0.68, description: 'Cầu 2-1-1 → T' };
  }

  // ========== 10. CẦU 2-3-2 (TTXXXTT) ==========
  if (n >= 7) {
    const p7 = seq.slice(-7).join('');
    if (p7 === 'TTXXXTT') return { type: 'CẦU_2_3_2', next: 'X', confidence: 0.68, description: 'Cầu 2-3-2 → X' };
    if (p7 === 'XXTTTXX') return { type: 'CẦU_2_3_2', next: 'T', confidence: 0.68, description: 'Cầu 2-3-2 → T' };
  }

  // ========== 11. CẦU 3-2-3 (TTTXXTTT) ==========
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TTTXXTTT') return { type: 'CẦU_3_2_3', next: 'X', confidence: 0.70, description: 'Cầu 3-2-3 → X' };
    if (p8 === 'XXXTTXXX') return { type: 'CẦU_3_2_3', next: 'T', confidence: 0.70, description: 'Cầu 3-2-3 → T' };
  }

  // ========== 12. CẦU TĂNG TIẾN (1-2-3-4) ==========
  // Kiểm tra block size có tăng dần không
  {
    const blocks = [];
    let curType = seq[0];
    let curLen = 1;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === curType) curLen++;
      else {
        blocks.push({ type: curType, len: curLen });
        curType = seq[i];
        curLen = 1;
      }
    }
    blocks.push({ type: curType, len: curLen });

    // Lấy 3-4 block cuối
    if (blocks.length >= 3) {
      const last3 = blocks.slice(-3);
      const lens = last3.map(b => b.len);
      // Kiểm tra tăng: 1-2-3, 2-3-4, 1-2-4, ...
      if (lens[0] < lens[1] && lens[1] < lens[2] && lens[2] <= 5) {
        const expectedNext = last3[2].len + 1;
        // Nếu block cuối đã đủ len → dự đoán đảo
        if (expectedNext <= 5) {
          return {
            type: 'CẦU_TĂNG_TIẾN',
            next: last3[2].type === 'T' ? 'X' : 'T',
            confidence: 0.58,
            description: `Cầu tăng tiến ${lens.join('-')} → đảo`
          };
        }
      }
    }
  }

  // ========== 13. CẦU GIẢM TIẾN (4-3-2-1) ==========
  {
    const blocks = [];
    let curType = seq[0];
    let curLen = 1;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === curType) curLen++;
      else {
        blocks.push({ type: curType, len: curLen });
        curType = seq[i];
        curLen = 1;
      }
    }
    blocks.push({ type: curType, len: curLen });

    if (blocks.length >= 3) {
      const last3 = blocks.slice(-3);
      const lens = last3.map(b => b.len);
      if (lens[0] > lens[1] && lens[1] > lens[2] && lens[0] <= 5) {
        return {
          type: 'CẦU_GIẢM_TIẾN',
          next: last3[2].type === 'T' ? 'X' : 'T',
          confidence: 0.55,
          description: `Cầu giảm tiến ${lens.join('-')} → đảo`
        };
      }
    }
  }

  // ========== KHÔNG CÓ TÍN HIỆU ==========
  return {
    type: 'NONE',
    next: null,
    confidence: 0,
    description: 'Không có tín hiệu rõ ràng → CHỜ'
  };
}

// ============ PREDICT ============
function runPrediction(db, seq) {
  if (!Array.isArray(seq) || seq.length < 4) {
    return {
      code: null, label: null, tiLe: 'CHỜ',
      pattern: { type: 'NONE', confidence: 0, description: 'Không đủ data' },
      streakInfo: { type: 'none', length: 0 },
      shouldPredict: false
    };
  }

  const pattern = detectAllPatterns(seq);
  const shouldPredict = pattern.type !== 'NONE' && pattern.next !== null && pattern.confidence >= 0.55;

  // Streak info để hiển thị
  const lastType = seq[seq.length - 1];
  let streakLen = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === lastType) streakLen++;
    else break;
  }
  const streakInfo = { type: lastType, length: streakLen };

  if (!shouldPredict) {
    return {
      code: null, label: null, tiLe: 'CHỜ',
      pattern,
      streakInfo,
      shouldPredict: false
    };
  }

  const tiLePct = (pattern.confidence * 100).toFixed(1) + '%';
  return {
    code: pattern.next,
    label: labelFromTX(pattern.next),
    tiLe: tiLePct,
    pattern,
    streakInfo,
    shouldPredict: true
  };
}

// ============ FETCH ============
async function fetchWithRetry(url, attempts = FETCH_RETRIES) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.get(url, { timeout: API_TIMEOUT_MS, headers: { 'User-Agent': 'HoangVip/8.0' } });
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

  // Reverse nếu mới nhất ở đầu
  if (arr.length >= 2) {
    const first = Number(arr[0].SessionId || arr[0].session || 0);
    const last = Number(arr[arr.length - 1].SessionId || arr[arr.length - 1].session || 0);
    if (first > last) arr = arr.slice().reverse();
  }
  return arr;
}

// ============ MAIN TICK ============
async function processGameTick(game) {
  try {
    const api = APIS[game];
    if (!api) return;
    const resp = await fetchWithRetry(api);
    const historyList = parseHistoryResponse(resp.data);
    if (!Array.isArray(historyList) || !historyList.length) return;

    const latest = historyList[historyList.length - 1];
    const currentSession = safeInt(latest.SessionId || latest.session, 0);
    if (!currentSession) return;

    const db = loadDatabase(game);
    if (db.lastProcessedSession === currentSession) return;

    const seq = historyList.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    if (seq.length < 4) return;

    const pred = runPrediction(db, seq);

    // Evaluate previous prediction
    const lastRecorded = db.history[db.history.length - 1];
    if (lastRecorded && safeInt(lastRecorded.phienDuDoan, 0) === currentSession) {
      const actual = itemToResult(latest);
      const lastCode = lastRecorded.DU_DOAN_CODE;

      lastRecorded.ketQua = actual;
      lastRecorded.ketQuaLabel = labelFromTX(actual);

      if (lastCode === null || lastCode === undefined) {
        // Không predict → SKIP
        lastRecorded.trangThai = 'BỎ QUA';
        db.stats.skips = (db.stats.skips || 0) + 1;
      } else {
        const wasCorrect = (lastCode === actual);
        lastRecorded.trangThai = wasCorrect ? 'ĐÚNG' : 'SAI';
        db.stats.total++;

        const slot = getCurrentTimeSlot();
        if (!db.timeStats) db.timeStats = {};
        if (!db.timeStats[slot]) db.timeStats[slot] = { total: 0, wins: 0 };
        db.timeStats[slot].total++;

        if (wasCorrect) {
          db.stats.wins++;
          db.timeStats[slot].wins++;
          db.stats.currentStreak = db.stats.currentStreak >= 0 ? db.stats.currentStreak + 1 : 1;
          if (db.stats.currentStreak > db.stats.maxWinStreak) db.stats.maxWinStreak = db.stats.currentStreak;
        } else {
          db.stats.losses++;
          db.stats.currentStreak = db.stats.currentStreak <= 0 ? db.stats.currentStreak - 1 : -1;
          const al = Math.abs(db.stats.currentStreak);
          if (al > db.stats.maxLossStreak) db.stats.maxLossStreak = al;
        }

        // ✅ Track theo type
        const pType = lastRecorded.pattern && lastRecorded.pattern.type;
        if (pType && pType !== 'NONE') {
          if (!db.byType[pType]) db.byType[pType] = { total: 0, wins: 0 };
          db.byType[pType].total++;
          if (wasCorrect) db.byType[pType].wins++;
        }

        // ✅ Signal stats (chỉ phiên có predict)
        db.signalStats.total++;
        if (wasCorrect) db.signalStats.wins++;
        else db.signalStats.losses++;
        db.signalStats.accuracy = db.signalStats.total > 0
          ? Number((db.signalStats.wins / db.signalStats.total * 100).toFixed(2))
          : 0;
      }
    }

    // New prediction entry
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
      pattern: pred.pattern,
      streak: pred.streakInfo,
      trangThai: 'ĐANG CHỜ',
      thoiGian: now()
    };

    db.history.push(newEntry);
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);
    db.lastProcessedSession = currentSession;

    saveDatabase(game, db);

    const pat = pred.shouldPredict ? ` [${pred.pattern.type}]` : ' [CHỜ]';
    console.log(`[TICK] ${game} #${currentSession} sum=${newEntry.tong} kq=${newEntry.ketQuaLabel} → ${newEntry.DU_DOAN}${pat}`);
  } catch (e) {
    console.error(`[TICK ERR] ${game}`, e && e.message ? e.message : e);
  }
}

// ============ POLLING ============
let pollingActive = true;
function startPolling() {
  async function tick() {
    if (!pollingActive) return;
    await Promise.all(Object.keys(APIS).map(async g => { try { await processGameTick(g); } catch (_) {} }));
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
    tong: it.tong !== undefined ? it.tong : 0,
    ketQua: it.ketQua || null,
    ketQuaLabel: it.ketQuaLabel || (it.ketQua ? labelFromTX(it.ketQua) : null),
    phienDuDoan: it.phienDuDoan,
    duDoan: it.DU_DOAN || 'CHỜ',
    duDoanCode: it.DU_DOAN_CODE || null,
    tiLe: it.TI_LE || 'CHỜ',
    pattern: it.pattern || null,
    streak: it.streak || null,
    trangThai: it.trangThai || null,
    thoiGian: it.thoiGian || null
  };
}

// ============ API ============
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });
  try {
    const r = await fetchWithRetry(APIS[game]);
    const list = parseHistoryResponse(r.data);
    if (!list.length) return res.status(204).send();

    const seq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const db = loadDatabase(game);
    const pred = runPrediction(db, seq);
    const latest = list[list.length - 1];
    const cs = safeInt(latest.SessionId || latest.session, 0);

    return res.json({
      phien: cs,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: itemToResult(latest),
      ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: cs + 1,
      duDoan: pred.shouldPredict ? pred.label : 'CHỜ',
      duDoanCode: pred.shouldPredict ? pred.code : null,
      tiLe: pred.tiLe,
      pattern: pred.pattern,
      streak: pred.streakInfo,
      shouldPredict: pred.shouldPredict
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'fetch error' });
  }
});

app.get('/api/history/:game', (req, res) => {
  const game = req.params.game;
  if (game === 'all') return handleHistoryAll(req, res);
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });
  const db = loadDatabase(game);
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 200)));
  const slice = db.history.slice(-limit).reverse();
  return res.json({
    game, count: slice.length, exportedAt: now(),
    items: slice.map(formatHistoryItem).filter(Boolean)
  });
});

function handleHistoryAll(req, res) {
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 500)));
  const result = { exportedAt: now(), limit, games: {} };
  for (const game of Object.keys(DB_FILES)) {
    try {
      const db = loadDatabase(game);
      const slice = db.history.slice(-limit).reverse();
      const globalAcc = db.stats.total > 0 ? (db.stats.wins / db.stats.total * 100) : 0;
      result.games[game] = {
        count: slice.length,
        stats: {
          total: db.stats.total,
          wins: db.stats.wins,
          losses: db.stats.losses,
          skips: db.stats.skips || 0,
          globalAccuracy: Number(globalAcc.toFixed(2)),
          currentStreak: db.stats.currentStreak,
          maxWinStreak: db.stats.maxWinStreak,
          maxLossStreak: db.stats.maxLossStreak
        },
        signalStats: db.signalStats,
        byType: db.byType,
        items: slice.map(formatHistoryItem).filter(Boolean)
      };
    } catch (e) {
      result.games[game] = { error: e.message };
    }
  }
  return res.json(result);
}

app.get('/api/history/all', handleHistoryAll);

app.get('/api/history/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Bàn chơi không hợp lệ.');
  const db = loadDatabase(game);
  const exportObj = {
    game, exportedAt: now(), version: db.version,
    stats: db.stats,
    signalStats: db.signalStats,
    byType: db.byType,
    history: db.history.map(formatHistoryItem).filter(Boolean)
  };
  const fname = `history_${game}_${(new Date()).toISOString().replace(/[:.]/g, '-')}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.send(JSON.stringify(exportObj, null, 2));
});

app.get('/api/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Bàn chơi không hợp lệ.');
  const db = loadDatabase(game);
  let csv = 'Phiên,XúcXắc,Tổng,KếtQuả,PhiênDựĐoán,DựĐoán,TỉLệ,LoạiCầu,TrạngThái,ThờiGian\n';
  db.history.forEach(item => {
    const dice = (item.xucXac || []).join('-');
    const pType = item.pattern && item.pattern.type ? item.pattern.type : '';
    csv += `${item.phien},"${dice}",${item.tong || ''},${item.ketQuaLabel || ''},${item.phienDuDoan},${item.DU_DOAN || ''},${item.TI_LE || ''},"${pType}",${item.trangThai || ''},${item.thoiGian || ''}\n`;
  });
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`lich_su_${game}.csv`);
  res.send('\uFEFF' + csv);
});

// ============ ADMIN ============
app.get('/admin/metrics/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const globalAcc = db.stats.total > 0 ? Number((db.stats.wins / db.stats.total * 100).toFixed(2)) : 0;
  return res.json({
    globalStats: {
      total: db.stats.total,
      wins: db.stats.wins,
      losses: db.stats.losses,
      skips: db.stats.skips || 0,
      accuracy: globalAcc
    },
    signalStats: db.signalStats,
    byType: db.byType,
    lastProcessedSession: db.lastProcessedSession
  });
});

app.get('/admin/config', (req, res) => {
  res.json({
    VERSION: 8,
    RULE: 'DiceSum 3-10=Xỉu, 11-18=Tài',
    MIN_CONFIDENCE: 0.55,
    PATTERNS: [
      'BỆT 4-7 (theo)', 'BỆT 8-10 (nghi ngờ)', 'BỆT 11+ (gãy)',
      'CẦU 1-1', 'CẦU 2-2', 'CẦU 3-3', 'CẦU 4-4',
      'CẦU 1-2-1', 'CẦU 2-1-2', 'CẦU 1-3-1',
      'CẦU 2-1-1', 'CẦU 2-3-2', 'CẦU 3-2-3',
      'CẦU TĂNG TIẾN', 'CẦU GIẢM TIẾN'
    ]
  });
});

// ============ UI ============
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Trang không tồn tại.');

  const db = loadDatabase(game);
  const globalAcc = db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) : '0.00';
  const signalAcc = db.signalStats.accuracy || 0;
  const rows = db.history.slice(-50).reverse();
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  // Build byType rows
  const typeRows = Object.keys(db.byType || {}).sort().map(type => {
    const t = db.byType[type];
    const acc = t.total > 0 ? (t.wins / t.total * 100).toFixed(1) : '0.0';
    return `<tr>
      <td><span class="type-badge">${type}</span></td>
      <td>${t.total}</td>
      <td class="dung">${t.wins}</td>
      <td class="sai">${t.total - t.wins}</td>
      <td class="${parseFloat(acc) >= 60 ? 'dung' : (parseFloat(acc) >= 50 ? 'cho' : 'sai')}"><b>${acc}%</b></td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>HOANG VIP v8 - ${game.toUpperCase()}</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:linear-gradient(135deg,#0a0e27 0%,#0f172a 50%,#1a1f3a 100%);
    color:#e6eef6;padding:12px;margin:0;min-height:100vh;
  }
  .header{
    background:linear-gradient(135deg,#1e3a8a,#3b82f6);
    padding:16px;border-radius:14px;margin-bottom:14px;
    box-shadow:0 8px 24px rgba(59,130,246,0.3);
  }
  h1{color:#fff;font-size:17px;margin:0;font-weight:700}
  .subtitle{color:#bfdbfe;font-size:11px;margin-top:4px}

  .stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
  .stat-card{
    background:linear-gradient(135deg,#1e293b,#0f172a);
    padding:10px;border-radius:10px;text-align:center;
    border:1px solid #334155;
  }
  .stat-card .label{font-size:10px;color:#94a3b8;text-transform:uppercase}
  .stat-card .value{font-size:20px;font-weight:700;margin-top:2px}
  .value.green{color:#22c55e}.value.red{color:#ef4444}
  .value.blue{color:#38bdf8}.value.yellow{color:#eab308}
  .value.purple{color:#a78bfa}.value.orange{color:#fb923c}

  .section-title{
    font-size:12px;color:#94a3b8;text-transform:uppercase;
    margin:14px 0 8px;font-weight:700;letter-spacing:1px;
  }

  .table-wrap{
    background:linear-gradient(135deg,#0f172a,#1e293b);
    border-radius:12px;overflow:hidden;
    border:1px solid #334155;margin-bottom:14px;
  }
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{
    background:linear-gradient(135deg,#1e40af,#3b82f6);
    color:#fff;padding:8px 4px;font-weight:600;
    text-transform:uppercase;font-size:9px;
  }
  td{padding:8px 4px;text-align:center;border-bottom:1px solid #1e293b}
  tr:hover{background:rgba(59,130,246,0.08)}
  .tai{color:#22c55e;font-weight:700}
  .xiu{color:#ef4444;font-weight:700}
  .dung{color:#22c55e;font-weight:600}
  .sai{color:#ef4444;font-weight:600}
  .cho{color:#eab308;font-weight:600;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
  .dice{font-family:'Courier New',monospace;font-weight:600;color:#fbbf24}
  .sum-badge{
    display:inline-block;padding:2px 6px;border-radius:4px;
    background:rgba(251,191,36,0.15);color:#fbbf24;font-weight:700;
  }
  .session{font-family:'Courier New',monospace;font-size:10px;color:#94a3b8}
  .ti-le{font-size:10px;color:#a5b4fc}
  .pattern-badge{
    display:inline-block;font-size:9px;
    padding:2px 5px;border-radius:4px;font-weight:700;
    background:#1e40af;color:#93c5fd;
  }
  .pattern-badge.bet{background:#7c2d12;color:#fdba74}
  .pattern-badge.none{background:#374151;color:#9ca3af}
  .type-badge{
    display:inline-block;font-size:9px;
    padding:2px 6px;border-radius:4px;font-weight:600;
    background:#1e40af;color:#93c5fd;
  }
  .wait{
    color:#94a3b8;font-style:italic;
  }
  .copy-btn{
    background:#10b981;color:#fff;border:none;
    padding:4px 10px;border-radius:6px;
    font-size:10px;font-weight:600;cursor:pointer;
  }
  .link-row{
    font-family:'Courier New',monospace;font-size:11px;color:#d1fae5;
    background:rgba(0,0,0,0.3);padding:8px;border-radius:6px;
    margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;
  }
  .link-box{
    background:linear-gradient(135deg,#064e3b,#065f46);
    padding:12px;border-radius:12px;margin-bottom:14px;
    border:1px solid #10b981;
  }
  .link-box .title{font-size:12px;color:#6ee7b7;font-weight:600;margin-bottom:6px}
</style>
<script>
  setTimeout(()=>location.reload(), 10000);
  function copyText(text, btn){
    const done = ()=>{const old=btn.textContent;btn.textContent='✓';setTimeout(()=>btn.textContent=old,1500)};
    if(navigator.clipboard){navigator.clipboard.writeText(text).then(done).catch(done)}
    else{
      const ta=document.createElement('textarea');ta.value=text;
      document.body.appendChild(ta);ta.select();document.execCommand('copy');
      document.body.removeChild(ta);done();
    }
  }
</script>
</head>
<body>
  <div class="header">
    <h1>🎯 HOANG VIP v8 — NHẬN DIỆN CẦU</h1>
    <div class="subtitle">Bàn: ${game.toUpperCase()} • Chỉ predict khi có tín hiệu</div>
  </div>

  <div class="stats-grid">
    <div class="stat-card"><div class="label">Có predict</div><div class="value blue">${db.stats.total}</div></div>
    <div class="stat-card"><div class="label">Thắng</div><div class="value green">${db.stats.wins}</div></div>
    <div class="stat-card"><div class="label">Thua</div><div class="value red">${db.stats.losses}</div></div>
    <div class="stat-card"><div class="label">Bỏ qua</div><div class="value orange">${db.stats.skips || 0}</div></div>
    <div class="stat-card"><div class="label">Acc (có predict)</div><div class="value ${signalAcc >= 60 ? 'green' : (signalAcc >= 50 ? 'yellow' : 'red')}">${signalAcc}%</div></div>
    <div class="stat-card"><div class="label">Acc tổng</div><div class="value ${parseFloat(globalAcc) >= 50 ? 'green' : 'yellow'}">${globalAcc}%</div></div>
  </div>

  <div class="link-box">
    <div class="title">🔗 Link</div>
    <div class="link-row">
      <span>${baseUrl}/api/predict/${game}</span>
      <button class="copy-btn" onclick="copyText('${baseUrl}/api/predict/${game}', this)">Copy</button>
    </div>
    <div class="link-row">
      <span>${baseUrl}/api/history/all</span>
      <button class="copy-btn" onclick="copyText('${baseUrl}/api/history/all', this)">Copy</button>
    </div>
  </div>

  <div class="section-title">📊 Lịch sử 50 phiên</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Phiên</th><th>XX</th><th>Tổng</th><th>KQ</th>
          <th>Phiên DĐ</th><th>Dự đoán</th><th>Tỉ lệ</th><th>Loại cầu</th><th>TT</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(it => {
          const dice = (it.xucXac || []).join('-');
          const kq = it.ketQuaLabel || labelFromTX(it.ketQua) || '';
          const kqCls = it.ketQua === 'T' ? 'tai' : (it.ketQua === 'X' ? 'xiu' : '');
          const isWait = !it.DU_DOAN_CODE;
          const ddCls = isWait ? 'wait' : (it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu');
          const ttCls = it.trangThai === 'ĐÚNG' ? 'dung' 
                      : (it.trangThai === 'SAI' ? 'sai' 
                      : (it.trangThai === 'BỎ QUA' ? 'wait' : 'cho'));
          const pType = it.pattern && it.pattern.type ? it.pattern.type : 'NONE';
          const isBet = pType.startsWith('BỆT');
          const patCls = pType === 'NONE' ? 'none' : (isBet ? 'bet' : '');
          return `<tr>
            <td class="session">${it.phien}</td>
            <td class="dice">${dice}</td>
            <td><span class="sum-badge">${it.tong || ''}</span></td>
            <td class="${kqCls}">${kq}</td>
            <td class="session">${it.phienDuDoan}</td>
            <td class="${ddCls}">${isWait ? 'CHỜ' : it.DU_DOAN}</td>
            <td class="ti-le">${it.TI_LE || 'CHỜ'}</td>
            <td>${pType !== 'NONE' ? `<span class="pattern-badge ${patCls}">${pType}</span>` : '<span class="wait">—</span>'}</td>
            <td class="${ttCls}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  ${typeRows ? `
  <div class="section-title">🎯 Accuracy theo loại cầu</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Loại cầu</th><th>Tổng</th><th>Thắng</th><th>Thua</th><th>Acc</th></tr>
      </thead>
      <tbody>${typeRows}</tbody>
    </table>
  </div>
  ` : ''}

  <div style="text-align:center;font-size:10px;color:#475569;margin-top:14px">
    Auto refresh 10s • HOANG VIP v8
  </div>
</body>
</html>`;
  res.send(html);
});

// ============ SERVER ============
const server = app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 HOANG VIP v8 - NHẬN DIỆN CẦU FULL`);
  console.log(`========================================`);
  console.log(`Port: ${PORT} | Polling: ${POLL_INTERVAL_MS}ms`);
  console.log(`✅ CHỈ predict khi có tín hiệu (bệt 4+, cầu rõ)`);
  console.log(`✅ Không đoán mò → "CHỜ"`);
  console.log(`✅ 12+ loại cầu: 1-1, 2-2, 3-3, 4-4, 1-2-1, 2-1-2, ...`);
  console.log(`✅ Track accuracy riêng từng loại cầu`);
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
