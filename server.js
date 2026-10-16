/**
 * ========================================================================
 * HOANG VIP ADAPTIVE v3 - FULL FIX ALL - DETERMINISTIC EDITION
 * ========================================================================
 * 
 * ✅ FIXED:
 *  - Deterministic hoàn toàn (không Math.random, cùng input → cùng output)
 *  - Adam optimizer ổn định, không bị NaN
 *  - Wilson score chống overfit pattern nhỏ
 *  - Hedge ensemble với regret tracking + floor weight
 *  - Logit-space debias không phá calibration
 *  - Variable-order Markov (1-5) với backoff smoothing
 *  - Adaptive gating theo rolling accuracy
 *  - Feature engineering mở rộng (multi-EWMA, alternation, entropy)
 *  - Rolling Brier score monitoring
 *  - JSON output chuẩn: phien/xucXac/tong/ketQua/phienDuDoan/duDoan/tiLe
 *  - /api/history/all trả full JSON
 *  - Auto-migration DB cũ → schema mới
 *  - Safe atomic write + backup
 *  - Validation input, chống crash khi API lỗi
 *  - Graceful shutdown
 *  - Không duplicate session
 *  - Clamp tất cả xác suất, chống NaN/Infinity
 *  - UI hiển thị đầy đủ + auto refresh
 * 
 * Run: npm i express axios && node server.js
 * ========================================================================
 */

'use strict';

// ============ IMPORTS ============
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============ CONFIG ============
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 500);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 8000);
const FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 3);

const APIS = {
  md5: process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: process.env.API_TAIXIU || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

const DB_DIR = process.env.DB_DIR || __dirname;
try {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
} catch (e) {
  console.error('[FATAL] Cannot create DB_DIR:', e.message);
  process.exit(1);
}

const DB_FILES = {
  md5: path.join(DB_DIR, 'db_md5.json'),
  taixiu: path.join(DB_DIR, 'db_taixiu.json')
};
const BACKUP_FILES = {
  md5: path.join(DB_DIR, 'backup_db_md5.json'),
  taixiu: path.join(DB_DIR, 'backup_db_taixiu.json')
};

// ============ HYPERPARAMS ============
let LR_LEARNING_RATE = Number(process.env.LR_LEARNING_RATE || 0.05);
const LR_REGULARIZATION = Number(process.env.LR_REGULARIZATION || 2e-4);
const ADAM_BETA1 = 0.9;
const ADAM_BETA2 = 0.999;
const ADAM_EPS = 1e-8;
const GRAD_CLIP = Number(process.env.GRAD_CLIP || 5.0);

const MARKOV_MAX_ORDER = 5;
const PATTERN_MAX_LEN = 12;
const PATTERN_MIN_SUPPORT = 2;
const PATTERN_TOP_N = 40;
const PATTERN_DECAY_HALF_LIFE = 250;

const CALIBRATION_LR = Number(process.env.CALIBRATION_LR || 0.015);
const CONFIDENCE_THRESHOLD = 0.78;
const ENTROPY_THRESHOLD = 0.65;
const ENSEMBLE_ETA = 0.10;
const WILSON_Z = 1.96;

const MAX_CHECKPOINTS = 50;
const MAX_BIAS_CORRECTIONS = 100;
const MAX_BRIER_HISTORY = 500;

// ============ GLOBAL ERROR HANDLERS ============
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// ============ HELPERS ============
function now() { return new Date().toISOString(); }

function safeNum(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function safeInt(x, def = 0) {
  const n = parseInt(x, 10);
  return Number.isFinite(n) ? n : def;
}

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

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[READ_JSON]', filePath, e.message);
    return fallback;
  }
}

function safeAtomicWrite(filePath, data) {
  try {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    console.error('[WRITE_JSON]', filePath, e.message);
    return false;
  }
}

function sigmoid(z) {
  if (!Number.isFinite(z)) return 0.5;
  if (z >= 0) {
    const e = Math.exp(-z);
    if (!Number.isFinite(e)) return 1;
    return 1 / (1 + e);
  } else {
    const e = Math.exp(z);
    if (!Number.isFinite(e)) return 0;
    return e / (1 + e);
  }
}

function entropyFromProb(p) {
  const eps = 1e-12;
  const pc = Math.min(Math.max(p, eps), 1 - eps);
  return -(pc * Math.log(pc) + (1 - pc) * Math.log(1 - pc));
}

function clamp(x, min = 1e-6, max = 1 - 1e-6) {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(Math.max(x, min), max);
}

function getCurrentTimeSlot(date = new Date()) {
  const h = date.getHours();
  if (h >= 6 && h < 12) return 'Sang';
  if (h >= 12 && h < 18) return 'Chieu';
  if (h >= 18 && h < 24) return 'Toi';
  return 'Dem';
}

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
  if (item.DiceSum !== undefined) return safeInt(item.DiceSum, 0);
  const d = itemToDice(item);
  return d[0] + d[1] + d[2];
}

function itemToResult(item) {
  if (!item) return null;
  if (item.BetSide !== undefined) {
    return safeInt(item.BetSide, 0) === 1 ? 'T' : 'X';
  }
  const sum = itemToSum(item);
  return sum >= 11 ? 'T' : 'X';
}

// ============ DETERMINISTIC SEED ============
function deterministicHash(str) {
  const hash = crypto.createHash('sha256').update(String(str)).digest();
  return hash.readUInt32BE(0) / 0xFFFFFFFF;
}

function deterministicInitWeights(dim, seed = 'default') {
  const weights = new Array(dim);
  for (let i = 0; i < dim; i++) {
    const h = deterministicHash(`${seed}::${i}`);
    weights[i] = (h - 0.5) * 0.02;
  }
  return weights;
}

// ============ DB SCHEMA & MIGRATION ============
function defaultDB() {
  return {
    version: 3,
    createdAt: now(),
    updatedAt: now(),
    history: [],
    stats: {
      total: 0, wins: 0, losses: 0,
      currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0
    },
    timeStats: {
      Sang: { total: 0, wins: 0 },
      Chieu: { total: 0, wins: 0 },
      Toi: { total: 0, wins: 0 },
      Dem: { total: 0, wins: 0 }
    },
    lastProcessedSession: null,
    model: {
      weights: null,
      bias: 0,
      iter: 0,
      createdAt: now(),
      version: 1,
      bestAcc: 0,
      seed: 'hoang_vip_v3'
    },
    calibration: { a: 1.0, b: 0.0, iter: 0 },
    optimizer: { m: null, v: null, t: 0 },
    ensembleRegret: { model: 0, pattern: 0, markov: 0 },
    patterns: { lastExtractedAt: null, list: [] },
    ensembleWeights: { model: 0.34, pattern: 0.33, markov: 0.33 },
    checkpoints: [],
    biasCorrections: [],
    brierHistory: [],
    _strictUnbiased: true
  };
}

function migrateDB(db) {
  if (!db || typeof db !== 'object') return defaultDB();
  const def = defaultDB();

  // Top-level fields
  for (const k in def) {
    if (db[k] === undefined || db[k] === null) {
      db[k] = def[k];
    }
  }

  // Sub-structure validation
  if (!Array.isArray(db.history)) db.history = [];
  if (!Array.isArray(db.checkpoints)) db.checkpoints = [];
  if (!Array.isArray(db.biasCorrections)) db.biasCorrections = [];
  if (!Array.isArray(db.brierHistory)) db.brierHistory = [];

  if (!db.stats || typeof db.stats !== 'object') db.stats = def.stats;
  for (const k in def.stats) {
    if (typeof db.stats[k] !== 'number' || !Number.isFinite(db.stats[k])) {
      db.stats[k] = def.stats[k];
    }
  }

  if (!db.timeStats || typeof db.timeStats !== 'object') db.timeStats = def.timeStats;
  for (const slot of ['Sang', 'Chieu', 'Toi', 'Dem']) {
    if (!db.timeStats[slot]) db.timeStats[slot] = { total: 0, wins: 0 };
    if (typeof db.timeStats[slot].total !== 'number') db.timeStats[slot].total = 0;
    if (typeof db.timeStats[slot].wins !== 'number') db.timeStats[slot].wins = 0;
  }

  if (!db.model || typeof db.model !== 'object') db.model = def.model;
  if (!Array.isArray(db.model.weights) && db.model.weights !== null) db.model.weights = null;
  if (typeof db.model.bias !== 'number' || !Number.isFinite(db.model.bias)) db.model.bias = 0;
  if (typeof db.model.iter !== 'number') db.model.iter = 0;
  if (typeof db.model.version !== 'number') db.model.version = 1;
  if (typeof db.model.bestAcc !== 'number') db.model.bestAcc = 0;
  if (typeof db.model.seed !== 'string') db.model.seed = 'hoang_vip_v3';

  if (!db.calibration || typeof db.calibration !== 'object') db.calibration = def.calibration;
  if (typeof db.calibration.a !== 'number' || !Number.isFinite(db.calibration.a)) db.calibration.a = 1.0;
  if (typeof db.calibration.b !== 'number' || !Number.isFinite(db.calibration.b)) db.calibration.b = 0.0;
  if (typeof db.calibration.iter !== 'number') db.calibration.iter = 0;

  if (!db.optimizer || typeof db.optimizer !== 'object') db.optimizer = def.optimizer;
  if (!Array.isArray(db.optimizer.m)) db.optimizer.m = null;
  if (!Array.isArray(db.optimizer.v)) db.optimizer.v = null;
  if (typeof db.optimizer.t !== 'number') db.optimizer.t = 0;

  if (!db.ensembleRegret || typeof db.ensembleRegret !== 'object') db.ensembleRegret = def.ensembleRegret;
  for (const k of ['model', 'pattern', 'markov']) {
    if (typeof db.ensembleRegret[k] !== 'number' || !Number.isFinite(db.ensembleRegret[k])) {
      db.ensembleRegret[k] = 0;
    }
  }

  if (!db.patterns || typeof db.patterns !== 'object') db.patterns = def.patterns;
  if (!Array.isArray(db.patterns.list)) db.patterns.list = [];

  if (!db.ensembleWeights || typeof db.ensembleWeights !== 'object') {
    db.ensembleWeights = def.ensembleWeights;
  }
  for (const k of ['model', 'pattern', 'markov']) {
    if (typeof db.ensembleWeights[k] !== 'number' || !Number.isFinite(db.ensembleWeights[k])) {
      db.ensembleWeights[k] = def.ensembleWeights[k];
    }
  }

  if (typeof db._strictUnbiased !== 'boolean') db._strictUnbiased = true;
  if (db.version === undefined) db.version = 3;
  if (!db.createdAt) db.createdAt = now();

  // Validate history items
  db.history = db.history.filter(h => h && typeof h === 'object' && h.phien !== undefined);

  return db;
}

function loadDatabase(game) {
  const file = DB_FILES[game];
  const backup = BACKUP_FILES[game];
  let db = safeReadJson(file);
  if (!db) db = safeReadJson(backup);
  if (!db) db = defaultDB();
  return migrateDB(db);
}

function saveDatabase(game, db) {
  db.updatedAt = now();
  // Trim large arrays
  if (db.checkpoints.length > MAX_CHECKPOINTS) {
    db.checkpoints = db.checkpoints.slice(-MAX_CHECKPOINTS);
  }
  if (db.biasCorrections.length > MAX_BIAS_CORRECTIONS) {
    db.biasCorrections = db.biasCorrections.slice(-MAX_BIAS_CORRECTIONS);
  }
  if (db.brierHistory.length > MAX_BRIER_HISTORY) {
    db.brierHistory = db.brierHistory.slice(-MAX_BRIER_HISTORY);
  }
  safeAtomicWrite(DB_FILES[game], db);
  safeAtomicWrite(BACKUP_FILES[game], db);
}

// ============ DEBIAS ============
function getRecentMeanPred(db, windowSize = 200) {
  const hist = (db.history || []).slice(-windowSize);
  if (!hist.length) return 0.5;
  let sum = 0, cnt = 0;
  for (const h of hist) {
    if (h && h.meta) {
      const v = h.meta.combinedProb !== undefined ? h.meta.combinedProb
              : h.meta.calibratedProb !== undefined ? h.meta.calibratedProb
              : null;
      if (v !== null && Number.isFinite(v)) { sum += v; cnt++; }
    }
  }
  return cnt ? (sum / cnt) : 0.5;
}

function debiasProbability(db, p, windowSize = 200) {
  if (!db._strictUnbiased) return clamp(p);
  const mean = getRecentMeanPred(db, windowSize);
  const shift = mean - 0.5;
  if (Math.abs(shift) < 0.01) return clamp(p);

  const pc = clamp(p, 1e-6, 1 - 1e-6);
  const logit = Math.log(pc / (1 - pc));
  const correctedLogit = logit - shift * 2;
  let corrected = sigmoid(correctedLogit);

  if (Math.abs(pc - 0.5) > 0.15 && Math.abs(corrected - 0.5) < Math.abs(pc - 0.5) * 0.3) {
    corrected = pc * 0.7 + corrected * 0.3;
  }
  return clamp(corrected);
}

// ============ PATTERN MINING ============
function extractFrequentPatterns(sequence, minSupport = PATTERN_MIN_SUPPORT, maxLen = PATTERN_MAX_LEN, topN = PATTERN_TOP_N) {
  const n = sequence.length;
  if (n < 2) return [];
  const freq = Object.create(null);
  const maxL = Math.min(maxLen, n - 1);

  for (let i = 0; i + 1 < n; i++) {
    let pat = '';
    for (let l = 1; l <= maxL && i + l < n; l++) {
      pat += sequence[i + l - 1];
      const next = sequence[i + l];
      let meta = freq[pat];
      if (!meta) meta = { count: 0, t: 0, x: 0, lastIndex: -1 };
      meta.count++;
      if (next === 'T') meta.t++; else meta.x++;
      meta.lastIndex = i;
      freq[pat] = meta;
    }
  }

  const countT = sequence.filter(s => s === 'T').length;
  const baseT = countT / (n || 1);
  const baseX = 1 - baseT;
  const baseTClamped = Math.max(baseT, 1e-6);
  const baseXClamped = Math.max(baseX, 1e-6);

  const patterns = [];
  for (const pat in freq) {
    const m = freq[pat];
    if (m.count < minSupport) continue;
    const pT = (m.t + 1) / (m.count + 2);
    const pX = (m.x + 1) / (m.count + 2);
    const oddsT = Math.log(pT / baseTClamped);
    const oddsX = Math.log(pX / baseXClamped);
    const divergence = Math.max(Math.abs(oddsT), Math.abs(oddsX));
    const strength = divergence * Math.log(1 + m.count);
    const recency = 1 + (m.lastIndex / Math.max(1, n - 1));
    const rawScore = strength * recency;
    if (!Number.isFinite(rawScore)) continue;
    patterns.push({
      pattern: pat,
      count: m.count,
      pT: Number(pT.toFixed(4)),
      pX: Number(pX.toFixed(4)),
      lastIndex: m.lastIndex,
      rawScore
    });
  }

  patterns.sort((a, b) => b.rawScore - a.rawScore);
  return patterns.slice(0, topN);
}

function mergeAndDecayPatterns(dbPatterns, newPatterns, seqLen) {
  const map = Object.create(null);
  const halfLife = PATTERN_DECAY_HALF_LIFE;

  for (const p of (dbPatterns || [])) {
    if (!p || !p.pattern) continue;
    const age = Math.max(0, seqLen - (p.lastIndex || 0));
    const decay = Math.pow(0.5, age / Math.max(1, halfLife));
    map[p.pattern] = {
      pattern: p.pattern,
      score: (p.score || p.rawScore || 0) * decay,
      count: p.count || 0,
      lastIndex: p.lastIndex || -1,
      pT: p.pT || 0,
      pX: p.pX || 0
    };
  }

  for (const np of (newPatterns || [])) {
    if (!np || !np.pattern) continue;
    const ex = map[np.pattern];
    if (ex) {
      ex.score = (ex.score || 0) + np.rawScore;
      ex.count = (ex.count || 0) + np.count;
      ex.lastIndex = Math.max(ex.lastIndex || -1, np.lastIndex || -1);
      ex.pT = np.pT;
      ex.pX = np.pX;
    } else {
      map[np.pattern] = {
        pattern: np.pattern,
        score: np.rawScore,
        count: np.count,
        lastIndex: np.lastIndex,
        pT: np.pT,
        pX: np.pX
      };
    }
  }

  const merged = Object.keys(map).map(k => map[k]);
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, Math.max(PATTERN_TOP_N * 2, 100));
}

// ============ WILSON SCORE ============
function wilsonLowerBound(wins, total, z = WILSON_Z) {
  if (total <= 0) return 0;
  const p = wins / total;
  const denom = 1 + z * z / total;
  const centre = p + z * z / (2 * total);
  const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));
  const res = (centre - margin) / denom;
  return Number.isFinite(res) ? Math.max(0, res) : 0;
}

function computePatternSignal(mergedPatterns) {
  const top = (mergedPatterns || []).slice(0, 10);
  let weightedSum = 0, totalWeight = 0;
  for (const p of top) {
    const n = p.count || 0;
    if (n < 3) continue;
    const winsT = Math.round((p.pT || 0) * n);
    const winsX = Math.round((p.pX || 0) * n);
    const confT = wilsonLowerBound(winsT, n);
    const confX = wilsonLowerBound(winsX, n);
    const diff = confT - confX;
    if (!Number.isFinite(diff)) continue;
    const w = Math.log(1 + n) * Math.abs(diff);
    weightedSum += diff * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return 0.5;
  const score = weightedSum / totalWeight;
  return sigmoid(score * 3.5);
}

// ============ MARKOV ============
function buildMarkov(sequence, maxOrder = MARKOV_MAX_ORDER) {
  const n = sequence.length;
  const models = {};
  for (let order = 1; order <= maxOrder; order++) {
    const freq = Object.create(null);
    for (let i = 0; i + order < n; i++) {
      const ctx = sequence.slice(i, i + order).join('');
      const next = sequence[i + order];
      if (!freq[ctx]) freq[ctx] = { T: 0, X: 0 };
      freq[ctx][next]++;
    }
    models[order] = freq;
  }
  return models;
}

function markovPredict(models, sequence) {
  const orders = Object.keys(models).map(Number).sort((a, b) => b - a);
  const predictions = [];

  for (const order of orders) {
    if (sequence.length < order) continue;
    const ctx = sequence.slice(-order).join('');
    const e = models[order][ctx];
    if (!e) continue;
    const n = e.T + e.X;
    if (n < 2) continue;
    const weight = 1 - Math.exp(-n / 8);
    const pT = (e.T + 1) / (n + 2);
    predictions.push({ order, pT, weight });
  }

  if (predictions.length === 0) return { T: 0.5, X: 0.5, orderUsed: 0 };

  let totalW = 0, weightedT = 0;
  for (const p of predictions) {
    const w = p.weight * (1 + 0.1 * p.order);
    weightedT += p.pT * w;
    totalW += w;
  }
  const pT = totalW > 0 ? weightedT / totalW : 0.5;
  return { T: pT, X: 1 - pT, orderUsed: predictions[0].order };
}

// ============ FEATURES ============
function ngramContextDiff(sequence, n) {
  if (sequence.length < n + 1) return 0;
  const ctx = sequence.slice(-n).join('');
  let t = 0, x = 0;
  for (let i = 0; i + n < sequence.length; i++) {
    if (sequence.slice(i, i + n).join('') === ctx) {
      const nxt = sequence[i + n];
      if (nxt === 'T') t++; else x++;
    }
  }
  if (t + x === 0) return 0;
  return (t - x) / (t + x);
}

function buildBaseFeatures(sequence) {
  const f = [1.0];

  const alphas = [0.3, 0.15, 0.07, 0.03, 0.015];
  for (const a of alphas) {
    let s = 0;
    for (let i = 0; i < sequence.length; i++) {
      s = a * (sequence[i] === 'T' ? 1 : -1) + (1 - a) * s;
    }
    f.push(Number.isFinite(s) ? s : 0);
  }

  const last = sequence[sequence.length - 1];
  let streak = 1;
  for (let i = sequence.length - 2; i >= 0; i--) {
    if (sequence[i] === last) streak++; else break;
  }
  f.push(Math.tanh(streak / 6));
  f.push(Math.tanh(streak / 12));

  let alt = 0;
  const win = Math.min(20, sequence.length - 1);
  for (let i = sequence.length - win; i < sequence.length - 1; i++) {
    if (sequence[i] !== sequence[i + 1]) alt++;
  }
  f.push(win > 0 ? (alt / win) * 2 - 1 : 0);

  f.push(ngramContextDiff(sequence, 1));
  f.push(ngramContextDiff(sequence, 2));
  f.push(ngramContextDiff(sequence, 3));
  f.push(ngramContextDiff(sequence, 4));

  const seq20 = sequence.slice(-20);
  if (seq20.length >= 3) {
    const tr = { TT: 0, TX: 0, XT: 0, XX: 0 };
    for (let i = 0; i < seq20.length - 1; i++) {
      tr[seq20[i] + seq20[i + 1]]++;
    }
    const total = seq20.length - 1;
    let H = 0;
    for (const k in tr) {
      const p = tr[k] / total;
      if (p > 0) H -= p * Math.log(p);
    }
    f.push((H - Math.log(4)) / Math.log(4));
  } else f.push(0);

  const h = new Date().getHours();
  f.push((h >= 6 && h < 12) ? 1 : 0);
  f.push((h >= 12 && h < 18) ? 1 : 0);
  f.push((h >= 18 && h < 24) ? 1 : 0);
  f.push((h < 6) ? 1 : 0);

  return f;
}

function buildPatternFeatures(sequence, mergedPatterns, topN = PATTERN_TOP_N) {
  const tail = sequence.join('');
  const scores = [];
  for (let i = 0; i < topN; i++) {
    const p = mergedPatterns[i];
    if (!p || !p.pattern) { scores.push(0); continue; }
    const pat = p.pattern;
    let occ = 0;
    let idx = tail.indexOf(pat);
    while (idx !== -1 && occ < 1000) {
      occ++;
      idx = tail.indexOf(pat, idx + 1);
    }
    const endsWith = tail.endsWith(pat) ? 1 : 0;
    const sign = (p.pT >= p.pX) ? 1 : -1;
    const matchScore = sign * Math.abs((p.pT || 0) - (p.pX || 0)) * Math.log(1 + occ) + endsWith * 0.6 * sign;
    scores.push(Number.isFinite(matchScore) ? matchScore : 0);
  }
  const maxAbs = Math.max(...scores.map(Math.abs), 1e-9);
  return scores.map(s => s / maxAbs);
}

function buildFeatureVector(sequence, mergedPatterns) {
  const base = buildBaseFeatures(sequence);
  const pat = buildPatternFeatures(sequence, mergedPatterns, PATTERN_TOP_N);
  const vector = base.concat(pat);
  return {
    vector,
    meta: {
      baseLen: base.length,
      patternLen: pat.length,
      topPatterns: mergedPatterns.slice(0, PATTERN_TOP_N)
    }
  };
}

// ============ MODEL ============
function initModelIfNeeded(db, dim, game = 'default') {
  db.model = db.model || {};
  if (!Array.isArray(db.model.weights) || db.model.weights.length !== dim) {
    db.model.weights = deterministicInitWeights(dim, `${game}::${db.model.version || 1}`);
    db.model.bias = 0;
    db.model.iter = 0;
    db.model.version = db.model.version || 1;
    db.model.createdAt = db.model.createdAt || now();
    db.model.seed = 'hoang_vip_v3';
    db.optimizer = { m: null, v: null, t: 0 };
  }
}

function predictLogit(db, x) {
  initModelIfNeeded(db, x.length);
  let z = db.model.bias || 0;
  for (let i = 0; i < x.length; i++) {
    z += (db.model.weights[i] || 0) * (x[i] || 0);
  }
  return Number.isFinite(z) ? z : 0;
}

function predictProb(db, x) {
  return sigmoid(predictLogit(db, x));
}

function clipGradients(gradW, clip = GRAD_CLIP) {
  let norm = 0;
  for (let i = 0; i < gradW.length; i++) norm += gradW[i] * gradW[i];
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return gradW;
  if (norm > clip) {
    const scale = clip / norm;
    for (let i = 0; i < gradW.length; i++) gradW[i] *= scale;
  }
  return gradW;
}

// ============ ADAM ============
function adamUpdateModel(db, x, labelT) {
  initModelIfNeeded(db, x.length);
  const opt = db.optimizer;
  if (!Array.isArray(opt.m) || opt.m.length !== x.length) {
    opt.m = new Array(x.length).fill(0);
  }
  if (!Array.isArray(opt.v) || opt.v.length !== x.length) {
    opt.v = new Array(x.length).fill(0);
  }
  opt.t = (opt.t || 0) + 1;

  const z = predictLogit(db, x);
  const pred = sigmoid(z);
  const err = labelT - pred;

  const grad = new Array(x.length);
  for (let i = 0; i < x.length; i++) {
    grad[i] = err * (x[i] || 0) - LR_REGULARIZATION * (db.model.weights[i] || 0);
  }
  clipGradients(grad, GRAD_CLIP);

  const bias1 = 1 - Math.pow(ADAM_BETA1, opt.t);
  const bias2 = 1 - Math.pow(ADAM_BETA2, opt.t);

  for (let i = 0; i < x.length; i++) {
    opt.m[i] = ADAM_BETA1 * opt.m[i] + (1 - ADAM_BETA1) * grad[i];
    opt.v[i] = ADAM_BETA2 * opt.v[i] + (1 - ADAM_BETA2) * grad[i] * grad[i];
    const mHat = opt.m[i] / Math.max(bias1, 1e-12);
    const vHat = opt.v[i] / Math.max(bias2, 1e-12);
    const step = LR_LEARNING_RATE * mHat / (Math.sqrt(vHat) + ADAM_EPS);
    if (Number.isFinite(step)) {
      db.model.weights[i] -= step;
    }
  }

  const biasStep = LR_LEARNING_RATE * err / Math.sqrt(opt.t + 1);
  if (Number.isFinite(biasStep)) {
    db.model.bias += biasStep;
  }
  db.model.iter = (db.model.iter || 0) + 1;

  const loss = -(labelT * Math.log(pred + 1e-12) + (1 - labelT) * Math.log(1 - pred + 1e-12));
  return { pred, err, loss: Number.isFinite(loss) ? loss : 0, lr: LR_LEARNING_RATE };
}

// ============ CALIBRATION ============
function calibrate(db, logit) {
  const a = Number.isFinite(db.calibration.a) ? db.calibration.a : 1.0;
  const b = Number.isFinite(db.calibration.b) ? db.calibration.b : 0.0;
  return sigmoid(a * logit + b);
}

function calibrationUpdate(db, logit, labelT) {
  const a = db.calibration.a || 1.0;
  const b = db.calibration.b || 0.0;
  const pred = sigmoid(a * logit + b);
  const err = labelT - pred;

  db.calibration.iter = (db.calibration.iter || 0) + 1;
  const adapt = 1 / Math.sqrt(1 + db.calibration.iter / 500);
  const lr = CALIBRATION_LR * adapt;

  let gradA = -err * logit;
  let gradB = -err;
  const maxg = 10;
  if (gradA > maxg) gradA = maxg; if (gradA < -maxg) gradA = -maxg;
  if (gradB > maxg) gradB = maxg; if (gradB < -maxg) gradB = -maxg;

  db.calibration.a = a - lr * gradA;
  db.calibration.b = b - lr * gradB;

  if (!Number.isFinite(db.calibration.a)) db.calibration.a = 1.0;
  if (!Number.isFinite(db.calibration.b)) db.calibration.b = 0.0;

  return { pred, err };
}

// ============ ENSEMBLE ============
function combineSignals(db, modelProb, patternProb, markovProb) {
  const w = db.ensembleWeights || { model: 0.34, pattern: 0.33, markov: 0.33 };
  const raw = (w.model * modelProb) + (w.pattern * patternProb) + (w.markov * markovProb);
  return { p: clamp(raw), weights: w };
}

function updateEnsembleWeights(db, losses, eta = ENSEMBLE_ETA) {
  const keys = ['model', 'pattern', 'markov'];
  const w = db.ensembleWeights || { model: 0.34, pattern: 0.33, markov: 0.33 };
  db.ensembleRegret = db.ensembleRegret || { model: 0, pattern: 0, markov: 0 };

  let total = 0;
  for (const k of keys) {
    const li = Math.max(0, Math.min(1, losses[k] || 0.5));
    db.ensembleRegret[k] += li;
    if (!Number.isFinite(db.ensembleRegret[k])) db.ensembleRegret[k] = 0;
    w[k] = Math.exp(-eta * db.ensembleRegret[k]);
    if (!Number.isFinite(w[k])) w[k] = 1e-6;
    total += w[k];
  }
  if (total <= 0) {
    w.model = 0.34; w.pattern = 0.33; w.markov = 0.33;
  } else {
    for (const k of keys) w[k] /= total;
  }
  const floor = 0.08;
  for (const k of keys) w[k] = Math.max(floor, w[k]);
  const s = w.model + w.pattern + w.markov;
  for (const k of keys) w[k] /= s;

  db.ensembleWeights = w;
  return w;
}

// ============ GATING ============
function adaptiveThresholds(db) {
  const recent = (db.history || [])
    .filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI')
    .slice(-50);
  if (recent.length < 20) {
    return { confThresh: CONFIDENCE_THRESHOLD, entThresh: ENTROPY_THRESHOLD };
  }
  const correct = recent.filter(h => h.trangThai === 'ĐÚNG').length;
  const acc = correct / recent.length;
  const confThresh = Math.max(0.65, Math.min(0.85, CONFIDENCE_THRESHOLD + (0.75 - acc) * 0.4));
  const entThresh = Math.max(0.55, Math.min(0.75, ENTROPY_THRESHOLD + (0.75 - acc) * 0.3));
  return { confThresh, entThresh };
}

function gatingDecision(db, calibratedProb, entropy, comps) {
  const { confThresh, entThresh } = adaptiveThresholds(db);
  const final = calibratedProb >= 0.5 ? 'T' : 'X';
  let agree = 0;
  if ((comps.modelProb >= 0.5 ? 'T' : 'X') === final) agree++;
  if ((comps.patternProb >= 0.5 ? 'T' : 'X') === final) agree++;
  if ((comps.markovProb >= 0.5 ? 'T' : 'X') === final) agree++;

  if (calibratedProb < confThresh) return { pass: false, reason: 'low_confidence', confThresh, entThresh, agree };
  if (entropy > entThresh) return { pass: false, reason: 'high_entropy', confThresh, entThresh, agree };
  if (agree < 2) return { pass: false, reason: 'low_agreement', confThresh, entThresh, agree };
  return { pass: true, reason: 'ok', agree, confThresh, entThresh };
}

// ============ BIAS DETECTION ============
function detectAndCorrectBias(db, game) {
  try {
    const LOOK = 60;
    const EXTREME = 0.90;
    const recent = (db.history || []).slice(-LOOK);
    if (!recent || recent.length < 10) return;

    let cntT = 0, cntX = 0;
    for (const r of recent) {
      if (!r || !r.DU_DOAN_CODE) continue;
      if (r.DU_DOAN_CODE === 'T') cntT++;
      else if (r.DU_DOAN_CODE === 'X') cntX++;
    }
    const total = cntT + cntX;
    if (total < 8) return;

    const pT = cntT / total;
    const pX = cntX / total;

    if (pT > EXTREME || pX > EXTREME) {
      console.warn(`[BIAS DETECT] game=${game} pT=${pT.toFixed(3)} pX=${pX.toFixed(3)} => correcting`);
      db.ensembleWeights = { model: 0.34, pattern: 0.33, markov: 0.33 };
      db.ensembleRegret = { model: 0, pattern: 0, markov: 0 };
      db.optimizer = { m: null, v: null, t: 0 };

      if (db.model && Array.isArray(db.model.weights)) {
        for (let i = 0; i < db.model.weights.length; i++) {
          db.model.weights[i] *= 0.35;
        }
        if (typeof db.model.bias === 'number') db.model.bias *= 0.35;
      }
      db.calibration = { a: 1.0, b: 0.0, iter: 0 };
      db.biasCorrections.push({
        at: now(),
        pT: Number(pT.toFixed(4)),
        pX: Number(pX.toFixed(4))
      });
    }
  } catch (err) {
    console.error('[BIAS]', err.message);
  }
}

// ============ CHECKPOINT & BRIER ============
function maybeCheckpoint(db, game) {
  try {
    const window = Math.max(20, Math.min(200, Math.floor(MAX_HISTORY / 2)));
    const completed = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const tail = completed.slice(-window);
    if (tail.length < Math.max(10, Math.floor(window / 4))) return;

    const correct = tail.filter(t => t.trangThai === 'ĐÚNG').length;
    const acc = correct / tail.length;
    const prevBest = db.model.bestAcc || 0;

    if (acc > prevBest + 0.005) {
      db.model.bestAcc = acc;
      db.model.version = (db.model.version || 1) + 1;
      const snap = {
        at: now(),
        version: db.model.version,
        acc,
        model: { weights: db.model.weights, bias: db.model.bias }
      };
      db.checkpoints.push(snap);
      try {
        safeAtomicWrite(path.join(DB_DIR, `model_snapshot_${game}_v${db.model.version}.json`), snap);
      } catch (e) {}
    }
  } catch (err) {
    console.error('[CHECKPOINT]', err.message);
  }
}

function computeBrierScore(db, window = 100) {
  const recent = (db.history || [])
    .filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI')
    .slice(-window);
  if (recent.length === 0) return null;

  let brier = 0, n = 0;
  for (const h of recent) {
    const label = h.ketQua === 'T' ? 1 : (h.ketQua === 'X' ? 0 : null);
    if (label === null) continue;
    const p = (h.meta && h.meta.combinedProb !== undefined) ? h.meta.combinedProb : 0.5;
    brier += Math.pow(p - label, 2);
    n++;
  }
  return n > 0 ? brier / n : null;
}

// ============ BACKTEST ============
function backtest(db) {
  try {
    const sim = {
      weights: Array.isArray(db.model.weights) ? db.model.weights.slice() : null,
      bias: db.model.bias || 0,
      iter: 0
    };
    let correct = 0, total = 0;

    for (const rec of db.history) {
      const fv = (rec.meta && Array.isArray(rec.meta.featureVector)) ? rec.meta.featureVector : null;
      if (!fv) continue;
      if (!sim.weights || sim.weights.length !== fv.length) {
        sim.weights = deterministicInitWeights(fv.length, 'backtest');
      }

      let z = sim.bias;
      for (let i = 0; i < fv.length; i++) z += sim.weights[i] * fv[i];
      const p = sigmoid(z);
      const pred = p >= 0.5 ? 'T' : 'X';

      if (rec.ketQua && rec.ketQua === pred) correct++;
      total++;

      if (rec.ketQua) {
        const label = rec.ketQua === 'T' ? 1 : 0;
        const err = label - p;
        sim.iter++;
        const lr = LR_LEARNING_RATE * (1 / Math.sqrt(1 + sim.iter / 1000));
        for (let i = 0; i < fv.length; i++) {
          sim.weights[i] += lr * (err * fv[i] - LR_REGULARIZATION * sim.weights[i]);
        }
        sim.bias += lr * err;
      }
    }
    return { accuracy: total ? (correct / total) : 0, total, correct };
  } catch (err) {
    return { accuracy: 0, total: 0, correct: 0, error: err.message };
  }
}

// ============ FETCH ============
async function fetchWithRetry(url, attempts = FETCH_RETRIES) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.get(url, {
        timeout: API_TIMEOUT_MS,
        headers: { 'User-Agent': 'HoangVipAdaptive/3.0' }
      });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, 200 + i * 200));
      }
    }
  }
  throw lastErr || new Error('Fetch failed');
}

function parseHistoryResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && data.data && Array.isArray(data.data.list)) return data.data.list;
  return [];
}

// ============ PREDICT CORE ============
function runPrediction(db, seq, game = 'default') {
  if (!Array.isArray(seq) || seq.length === 0) {
    return {
      featureVector: [],
      logit: 0,
      calibrated: 0.5,
      combined: 0.5,
      pModel: 0.5,
      pPattern: 0.5,
      pMarkov: 0.5,
      entropy: 1,
      gate: { pass: false, reason: 'no_data' },
      comps: { modelProb: 0.5, patternProb: 0.5, markovProb: 0.5 },
      predCode: 'T',
      predLabel: 'Tài',
      tiLe: '50.0% (LOW)',
      mergedPatterns: [],
      fvMeta: { topPatterns: [] }
    };
  }

  const newPatterns = extractFrequentPatterns(seq);
  const merged = mergeAndDecayPatterns(db.patterns.list || [], newPatterns, seq.length);
  db.patterns.list = merged;
  db.patterns.lastExtractedAt = now();

  const fvInfo = buildFeatureVector(seq, merged);
  const x = fvInfo.vector;

  initModelIfNeeded(db, x.length, game);
  const logit = predictLogit(db, x);
  const pModel = sigmoid(logit);

  const mm = buildMarkov(seq, MARKOV_MAX_ORDER);
  const mk = markovPredict(mm, seq);
  const pMarkov = mk.T;

  const pPattern = computePatternSignal(merged);
  const combined = combineSignals(db, pModel, pPattern, pMarkov);
  const calibrated = calibrate(db, logit);

  let finalP = clamp(0.9 * calibrated + 0.1 * combined.p);
  finalP = debiasProbability(db, finalP, 200);

  const entropy = entropyFromProb(finalP);
  const comps = { modelProb: pModel, patternProb: pPattern, markovProb: pMarkov };
  const gate = gatingDecision(db, finalP, entropy, comps);
  const predCode = finalP >= 0.5 ? 'T' : 'X';
  const predLabel = labelFromTX(predCode);
  const tiLe = (Math.max(finalP, 1 - finalP) * 100).toFixed(1) + '%' + (gate.pass ? '' : ' (LOW)');

  return {
    featureVector: x,
    logit,
    calibrated,
    combined: finalP,
    pModel,
    pPattern,
    pMarkov,
    entropy,
    gate,
    comps,
    predCode,
    predLabel,
    tiLe,
    mergedPatterns: merged,
    fvMeta: fvInfo.meta
  };
}

// ============ MAIN TICK ============
async function processGameTick(game) {
  try {
    const api = APIS[game];
    if (!api) return;

    const resp = await fetchWithRetry(api);
    const historyList = parseHistoryResponse(resp.data);

    if (!Array.isArray(historyList) || historyList.length === 0) return;

    const latest = historyList[historyList.length - 1];
    const currentSession = safeInt(latest.SessionId || latest.session, 0);
    if (!currentSession) return;

    const db = loadDatabase(game);
    if (db.lastProcessedSession === currentSession) return;

    const seq = historyList.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    if (seq.length < 2) return;

    const pred = runPrediction(db, seq, game);

    // Evaluate previous prediction
    const lastRecorded = db.history[db.history.length - 1];
    if (lastRecorded && safeInt(lastRecorded.phienDuDoan, 0) === currentSession) {
      const actual = itemToResult(latest);
      const lastCode = lastRecorded.DU_DOAN_CODE || codeFromLabel(lastRecorded.DU_DOAN);
      const wasCorrect = (lastCode === actual);

      lastRecorded.ketQua = actual;
      lastRecorded.ketQuaLabel = labelFromTX(actual);
      lastRecorded.trangThai = wasCorrect ? 'ĐÚNG' : 'SAI';

      db.stats.total++;
      const slot = getCurrentTimeSlot();
      if (!db.timeStats[slot]) db.timeStats[slot] = { total: 0, wins: 0 };
      db.timeStats[slot].total++;

      if (wasCorrect) {
        db.stats.wins++;
        db.timeStats[slot].wins++;
        db.stats.currentStreak = db.stats.currentStreak >= 0 ? db.stats.currentStreak + 1 : 1;
        if (db.stats.currentStreak > db.stats.maxWinStreak) {
          db.stats.maxWinStreak = db.stats.currentStreak;
        }
      } else {
        db.stats.losses++;
        db.stats.currentStreak = db.stats.currentStreak <= 0 ? db.stats.currentStreak - 1 : -1;
        const absLoss = Math.abs(db.stats.currentStreak);
        if (absLoss > db.stats.maxLossStreak) {
          db.stats.maxLossStreak = absLoss;
        }
      }

      try {
        const storedFV = (lastRecorded.meta && Array.isArray(lastRecorded.meta.featureVector))
          ? lastRecorded.meta.featureVector : null;
        const storedLogit = (lastRecorded.meta && lastRecorded.meta.logit !== undefined)
          ? lastRecorded.meta.logit : null;

        if (storedFV && storedFV.length > 0) {
          const labelT = actual === 'T' ? 1 : 0;
          const upd = adamUpdateModel(db, storedFV, labelT);
          lastRecorded.meta = lastRecorded.meta || {};
          lastRecorded.meta.modelUpdate = {
            err: upd.err,
            loss: upd.loss,
            lr: upd.lr,
            at: now()
          };
          if (storedLogit !== null && Number.isFinite(storedLogit)) {
            calibrationUpdate(db, storedLogit, labelT);
          }

          const compsMeta = (lastRecorded.meta && lastRecorded.meta.components) || {};
          const compLosses = {
            model: Math.abs(sigmoid(storedLogit !== null ? storedLogit : 0) - labelT),
            pattern: Math.abs((compsMeta.patternProb || 0.5) - labelT),
            markov: Math.abs((compsMeta.markovProb || 0.5) - labelT)
          };
          updateEnsembleWeights(db, compLosses);
        }
      } catch (e) {
        console.error('[UPDATE]', e.message);
      }

      const b = computeBrierScore(db, 50);
      if (b !== null && Number.isFinite(b)) {
        db.brierHistory.push({ at: now(), brier: Number(b.toFixed(4)) });
      }
    }

    // Create new entry
    const newEntry = {
      phien: currentSession,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: itemToResult(latest),
      ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: currentSession + 1,
      DU_DOAN_CODE: pred.predCode,
      DU_DOAN: pred.predLabel,
      TI_LE: pred.tiLe,
      mauCau: (pred.fvMeta && pred.fvMeta.topPatterns)
        ? pred.fvMeta.topPatterns.map(p => p.pattern).slice(0, 6).join('; ')
        : 'Auto',
      trangThai: 'ĐANG CHỜ',
      thoiGian: now(),
      meta: {
        featureVector: pred.featureVector,
        logit: pred.logit,
        calibratedProb: Number(pred.calibrated.toFixed(4)),
        combinedProb: Number(pred.combined.toFixed(4)),
        rawModelProb: Number(pred.pModel.toFixed(4)),
        patternProb: Number(pred.pPattern.toFixed(4)),
        markovProb: Number(pred.pMarkov.toFixed(4)),
        entropy: Number(pred.entropy.toFixed(6)),
        components: pred.comps,
        gate: pred.gate,
        createdAt: now()
      }
    };

    db.history.push(newEntry);
    if (db.history.length > MAX_HISTORY) {
      db.history.splice(0, db.history.length - MAX_HISTORY);
    }
    db.lastProcessedSession = currentSession;

    detectAndCorrectBias(db, game);
    maybeCheckpoint(db, game);
    saveDatabase(game, db);

    console.log(`[TICK] ${game} session=${currentSession} → predict=${pred.predLabel} (${pred.tiLe})`);
  } catch (e) {
    console.error(`[TICK ERR] game=${game}`, e && e.message ? e.message : e);
  }
}

// ============ POLLING ============
let pollingActive = true;

function startPolling() {
  async function tick() {
    if (!pollingActive) return;
    await Promise.all(Object.keys(APIS).map(async g => {
      try { await processGameTick(g); } catch (_) {}
    }));
    if (pollingActive) {
      setTimeout(tick, POLL_INTERVAL_MS);
    }
  }
  tick();
}

// ============ FORMAT HELPERS ============
function formatHistoryItem(it) {
  if (!it) return null;
  return {
    phien: it.phien,
    xucXac: Array.isArray(it.xucXac) ? it.xucXac : [0, 0, 0],
    tong: it.tong !== undefined ? it.tong : 0,
    ketQua: it.ketQua || null,
    ketQuaLabel: it.ketQuaLabel || (it.ketQua ? labelFromTX(it.ketQua) : null),
    phienDuDoan: it.phienDuDoan,
    duDoan: it.DU_DOAN || null,
    duDoanCode: it.DU_DOAN_CODE || codeFromLabel(it.DU_DOAN),
    tiLe: it.TI_LE || null,
    mauCau: it.mauCau || null,
    trangThai: it.trangThai || null,
    thoiGian: it.thoiGian || (it.meta && it.meta.createdAt) || null
  };
}

// ============ API: PREDICT ============
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });

  try {
    const r = await fetchWithRetry(APIS[game]);
    const list = parseHistoryResponse(r.data);
    if (!Array.isArray(list) || !list.length) return res.status(204).send();

    const seq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const db = loadDatabase(game);
    const pred = runPrediction(db, seq, game);

    const latest = list[list.length - 1];
    const currentSession = safeInt(latest.SessionId || latest.session, 0);

    return res.json({
      phien: currentSession,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: itemToResult(latest),
      ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: currentSession + 1,
      duDoan: pred.predLabel,
      duDoanCode: pred.predCode,
      tiLe: pred.tiLe,
      chiTiet: {
        finalProb: Number(pred.combined.toFixed(4)),
        calibrated: Number(pred.calibrated.toFixed(4)),
        modelProb: Number(pred.pModel.toFixed(4)),
        patternProb: Number(pred.pPattern.toFixed(4)),
        markovProb: Number(pred.pMarkov.toFixed(4)),
        entropy: Number(pred.entropy.toFixed(6)),
        gate: pred.gate,
        topPatterns: pred.mergedPatterns.slice(0, 12)
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'fetch error' });
  }
});

// ============ API: HISTORY (single) ============
app.get('/api/history/:game', (req, res) => {
  const game = req.params.game;
  if (game === 'all') return handleHistoryAll(req, res);
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });

  const db = loadDatabase(game);
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 200)));
  const slice = db.history.slice(-limit).reverse();

  return res.json({
    game,
    count: slice.length,
    exportedAt: now(),
    items: slice.map(formatHistoryItem).filter(Boolean)
  });
});

// ============ API: HISTORY ALL ============
function handleHistoryAll(req, res) {
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 500)));
  const result = {
    exportedAt: now(),
    limit,
    games: {}
  };

  for (const game of Object.keys(DB_FILES)) {
    try {
      const db = loadDatabase(game);
      const slice = db.history.slice(-limit).reverse();
      result.games[game] = {
        count: slice.length,
        stats: {
          total: db.stats.total,
          wins: db.stats.wins,
          losses: db.stats.losses,
          winRate: db.stats.total > 0
            ? Number(((db.stats.wins / db.stats.total) * 100).toFixed(2))
            : 0,
          currentStreak: db.stats.currentStreak,
          maxWinStreak: db.stats.maxWinStreak,
          maxLossStreak: db.stats.maxLossStreak
        },
        model: {
          version: db.model.version || 1,
          bestAcc: db.model.bestAcc || 0,
          iter: db.model.iter || 0,
          weightCount: Array.isArray(db.model.weights) ? db.model.weights.length : 0
        },
        ensembleWeights: db.ensembleWeights,
        ensembleRegret: db.ensembleRegret,
        brierScore: computeBrierScore(db, 200),
        items: slice.map(formatHistoryItem).filter(Boolean)
      };
    } catch (e) {
      result.games[game] = { error: e.message };
    }
  }

  return res.json(result);
}

app.get('/api/history/all', handleHistoryAll);

// ============ API: EXPORT JSON ============
app.get('/api/history/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Bàn chơi không hợp lệ.');

  const db = loadDatabase(game);
  const exportObj = {
    game,
    exportedAt: now(),
    version: db.version,
    stats: db.stats,
    timeStats: db.timeStats,
    ensembleWeights: db.ensembleWeights,
    ensembleRegret: db.ensembleRegret,
    model: {
      version: db.model.version,
      bestAcc: db.model.bestAcc,
      iter: db.model.iter,
      weightCount: Array.isArray(db.model.weights) ? db.model.weights.length : 0
    },
    calibration: db.calibration,
    brierScore: computeBrierScore(db, 200),
    brierHistory: db.brierHistory || [],
    biasCorrections: db.biasCorrections || [],
    history: db.history.map(formatHistoryItem).filter(Boolean)
  };

  const fname = `history_${game}_${(new Date()).toISOString().replace(/[:.]/g, '-')}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.send(JSON.stringify(exportObj, null, 2));
});

// ============ API: EXPORT CSV ============
app.get('/api/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Bàn chơi không hợp lệ.');

  const db = loadDatabase(game);
  let csv = 'Phiên,XúcXắc,Tổng,KếtQuả,PhiênDựĐoán,DựĐoán,TỉLệ,MẫuCầu,TrạngThái,ThờiGian\n';

  db.history.forEach(item => {
    const dice = (item.xucXac || []).join('-');
    const mauCau = (item.mauCau || '').replace(/"/g, '\'');
    csv += `${item.phien},"${dice}",${item.tong || ''},${item.ketQuaLabel || ''},${item.phienDuDoan},${item.DU_DOAN || ''},${item.TI_LE || ''},"${mauCau}",${item.trangThai || ''},${item.thoiGian || ''}\n`;
  });

  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`lich_su_${game}.csv`);
  res.send('\uFEFF' + csv);
});

// ============ API: ANALYZE ============
app.get('/api/analyze/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });

  const db = loadDatabase(game);
  const latest = db.history[db.history.length - 1] || {};
  const winRate = db.stats.total > 0
    ? ((db.stats.wins / db.stats.total) * 100).toFixed(2)
    : '0.00';

  return res.json({
    game: game.toUpperCase(),
    latest: formatHistoryItem(latest),
    stats: db.stats,
    timeStats: db.timeStats,
    winRate: `${winRate}%`,
    model: {
      weightsCount: Array.isArray(db.model.weights) ? db.model.weights.length : 0,
      bias: db.model.bias,
      version: db.model.version,
      bestAcc: db.model.bestAcc || 0,
      iter: db.model.iter || 0
    },
    calibration: db.calibration,
    weights: db.ensembleWeights,
    regret: db.ensembleRegret,
    brierScore: computeBrierScore(db, 200),
    patterns: Array.isArray(db.patterns.list) ? db.patterns.list.slice(0, 60) : [],
    biasCorrections: db.biasCorrections || []
  });
});

// ============ ADMIN ============
app.get('/admin/patterns/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  return res.json({
    lastExtractedAt: db.patterns.lastExtractedAt,
    count: Array.isArray(db.patterns.list) ? db.patterns.list.length : 0,
    patterns: Array.isArray(db.patterns.list) ? db.patterns.list.slice(0, 200) : []
  });
});

app.get('/admin/model/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  return res.json({
    model: db.model,
    calibration: db.calibration,
    optimizer: { t: db.optimizer ? db.optimizer.t : 0 },
    weights: db.ensembleWeights,
    regret: db.ensembleRegret,
    checkpoints: (db.checkpoints || []).slice(-10),
    biasCorrections: (db.biasCorrections || []).slice(-20)
  });
});

app.post('/admin/reset-model/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  db.model = {
    weights: null,
    bias: 0,
    iter: 0,
    version: (db.model.version || 1) + 1,
    createdAt: now(),
    bestAcc: 0,
    seed: 'hoang_vip_v3'
  };
  db.calibration = { a: 1.0, b: 0.0, iter: 0 };
  db.optimizer = { m: null, v: null, t: 0 };
  db.ensembleWeights = { model: 0.34, pattern: 0.33, markov: 0.33 };
  db.ensembleRegret = { model: 0, pattern: 0, markov: 0 };
  saveDatabase(game, db);
  return res.json({ ok: true, msg: 'Model reset (deterministic)' });
});

app.get('/admin/backtest/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  return res.json({ ok: true, report: backtest(db) });
});

app.get('/admin/metrics/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const tail = (db.history || [])
    .filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI')
    .slice(-200);
  const acc = tail.length
    ? (tail.filter(h => h.trangThai === 'ĐÚNG').length / tail.length)
    : 0;

  return res.json({
    rollingCount: tail.length,
    rollingAccuracy: Number(acc.toFixed(4)),
    rollingBrier: computeBrierScore(db, 200),
    totalEvaluations: db.stats.total,
    globalAccuracy: db.stats.total
      ? Number((db.stats.wins / db.stats.total).toFixed(4))
      : 0,
    ensembleWeights: db.ensembleWeights,
    ensembleRegret: db.ensembleRegret,
    biasCorrections: db.biasCorrections ? db.biasCorrections.length : 0,
    modelVersion: db.model.version || 1,
    bestAcc: db.model.bestAcc || 0
  });
});

app.get('/admin/config', (req, res) => {
  res.json({
    LR_LEARNING_RATE,
    LR_REGULARIZATION,
    ADAM_BETA1, ADAM_BETA2, ADAM_EPS,
    GRAD_CLIP,
    MARKOV_MAX_ORDER,
    PATTERN_MAX_LEN,
    PATTERN_MIN_SUPPORT,
    PATTERN_TOP_N,
    PATTERN_DECAY_HALF_LIFE,
    CALIBRATION_LR,
    CONFIDENCE_THRESHOLD,
    ENTROPY_THRESHOLD,
    ENSEMBLE_ETA,
    WILSON_Z,
    DETERMINISTIC: true,
    VERSION: 3
  });
});

app.post('/admin/config', (req, res) => {
  const body = req.body || {};
  if (body.LR_LEARNING_RATE !== undefined) {
    const v = Number(body.LR_LEARNING_RATE);
    if (Number.isFinite(v) && v > 0 && v < 1) LR_LEARNING_RATE = v;
  }
  return res.json({ ok: true, LR_LEARNING_RATE });
});

// ============ UI ============
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Trang không tồn tại.');

  const db = loadDatabase(game);
  const winRate = db.stats.total > 0
    ? ((db.stats.wins / db.stats.total) * 100).toFixed(2)
    : '0.00';
  const rows = db.history.slice(-30).reverse();

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HOANG VIP ADAPTIVE v3 - ${game.toUpperCase()}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#071024;color:#e6eef6;padding:16px;margin:0}
  h1{color:#38bdf8;font-size:20px;margin:0 0 12px}
  .box{background:#0f172a;padding:14px;border-radius:10px;margin-bottom:14px;border:1px solid #1e293b}
  .stats{display:flex;gap:16px;flex-wrap:wrap;font-size:14px}
  .stats b{color:#38bdf8}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:8px;border:1px solid #283347;text-align:center}
  th{background:#0369a1;color:white;font-weight:600}
  tr:nth-child(even){background:#0b1220}
  .tai{color:#22c55e;font-weight:bold}
  .xiu{color:#ef4444;font-weight:bold}
  .dung{color:#22c55e}
  .sai{color:#ef4444}
  .cho{color:#eab308}
  small{opacity:0.7;font-size:11px}
</style>
<script>setTimeout(()=>location.reload(), 12000)</script>
</head>
<body>
  <h1>🎯 HOANG VIP ADAPTIVE v3 — ${game.toUpperCase()}</h1>

  <div class="box">
    <div class="stats">
      <div>Tổng: <b>${db.stats.total}</b></div>
      <div>Thắng: <b>${db.stats.wins}</b></div>
      <div>Thua: <b>${db.stats.losses}</b></div>
      <div>Tỉ lệ: <b>${winRate}%</b></div>
      <div>Model v: <b>${db.model.version || 1}</b></div>
      <div>BestAcc: <b>${((db.model.bestAcc || 0) * 100).toFixed(1)}%</b></div>
    </div>
  </div>

  <div class="box">
    <table>
      <tr>
        <th>Phiên</th>
        <th>Xúc xắc</th>
        <th>Tổng</th>
        <th>KQ</th>
        <th>Phiên dự đoán</th>
        <th>Dự đoán</th>
        <th>Tỉ lệ</th>
        <th>Mẫu</th>
        <th>Trạng thái</th>
      </tr>
      ${rows.map(it => {
        const dice = (it.xucXac || []).join('-');
        const kq = it.ketQuaLabel || labelFromTX(it.ketQua) || '';
        const kqClass = it.ketQua === 'T' ? 'tai' : (it.ketQua === 'X' ? 'xiu' : '');
        const ddClass = it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu';
        const ttClass = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho');
        return `<tr>
          <td>${it.phien}</td>
          <td>${dice}</td>
          <td>${it.tong || ''}</td>
          <td class="${kqClass}">${kq}</td>
          <td>${it.phienDuDoan}</td>
          <td class="${ddClass}"><b>${it.DU_DOAN || ''}</b></td>
          <td><small>${it.TI_LE || ''}</small></td>
          <td><small>${(it.mauCau || '').slice(0, 30)}</small></td>
          <td class="${ttClass}">${it.trangThai}</td>
        </tr>`;
      }).join('')}
    </table>
  </div>
</body>
</html>`;
  res.send(html);
});

// ============ SERVER ============
const server = app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 HOANG VIP ADAPTIVE v3 (DETERMINISTIC)`);
  console.log(`========================================`);
  console.log(`Port: ${PORT}`);
  console.log(`Polling: ${POLL_INTERVAL_MS}ms`);
  console.log(`Max history: ${MAX_HISTORY}`);
  console.log(`DB dir: ${DB_DIR}`);
  console.log(`----------------------------------------`);
  console.log(`📊 Endpoints:`);
  console.log(`   GET  /md5                          - UI MD5`);
  console.log(`   GET  /taixiu                       - UI Tài Xỉu`);
  console.log(`   GET  /api/predict/:game            - Dự đoán`);
  console.log(`   GET  /api/history/:game            - Lịch sử 1 game`);
  console.log(`   GET  /api/history/all              - Lịch sử TẤT CẢ`);
  console.log(`   GET  /api/analyze/:game            - Phân tích`);
  console.log(`   GET  /api/export/:game             - CSV`);
  console.log(`   GET  /api/history/export/:game     - JSON`);
  console.log(`   GET  /admin/metrics/:game          - Metrics`);
  console.log(`   GET  /admin/config                 - Config`);
  console.log(`========================================`);
  startPolling();
});

// ============ GRACEFUL SHUTDOWN ============
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down...`);
  pollingActive = false;
  server.close(() => {
    console.log('[OK] Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
