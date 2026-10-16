/**
 * ========================================================================
 * HOANG VIP ADAPTIVE v5 - FULL FIX ALL
 * ========================================================================
 * ✅ FIX BUG "predict toàn Xỉu":
 *    - Bỏ debias shift (nguyên nhân chính gây collapse)
 *    - Blend 3 nguồn không cho 1 nguồn dominate
 *    - Floor weight 15% mỗi signal
 *    - Force balance khi p gần 0.5
 *    - Check agreement 3 nguồn
 *    - Anchor về avg signal khi lệch quá xa
 *    - Confidence floor (không predict khi quá 50/50)
 * ✅ FIX bug Sum=8 ghi Tài (luôn tính từ 3 xúc xắc)
 * ✅ Deterministic 100% (không Math.random)
 * ✅ Adam optimizer + Wilson + Hedge + Variable Markov
 * ✅ UI đẹp mobile, có nút copy link
 * ✅ /api/link/:game trả link dự đoán riêng
 * ========================================================================
 */

'use strict';

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

// ============ HYPERPARAMS ============
let LR_LEARNING_RATE = 0.05;
const LR_REGULARIZATION = 2e-4;
const ADAM_BETA1 = 0.9, ADAM_BETA2 = 0.999, ADAM_EPS = 1e-8;
const GRAD_CLIP = 5.0;
const MARKOV_MAX_ORDER = 5;
const PATTERN_MAX_LEN = 12;
const PATTERN_MIN_SUPPORT = 2;
const PATTERN_TOP_N = 40;
const PATTERN_DECAY_HALF_LIFE = 250;
const CALIBRATION_LR = 0.015;
const CONFIDENCE_THRESHOLD = 0.72;
const ENTROPY_THRESHOLD = 0.68;
const ENSEMBLE_ETA = 0.10;
const WILSON_Z = 1.96;

// ✅ NEW: Ngưỡng confidence floor
const MIN_CONFIDENCE = 0.03;         // Không predict nếu |p-0.5| < 3%
const MIN_SIGNAL_WEIGHT = 0.15;      // Mỗi signal tối thiểu 15%
const MAX_SIGNAL_WEIGHT = 0.55;      // Mỗi signal tối đa 55%

// ============ HELPERS ============
function now() { return new Date().toISOString(); }
function safeNum(x, def = 0) { const n = Number(x); return Number.isFinite(n) ? n : def; }
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

function sigmoid(z) {
  if (!Number.isFinite(z)) return 0.5;
  if (z >= 0) { const e = Math.exp(-z); return Number.isFinite(e) ? 1 / (1 + e) : 1; }
  else { const e = Math.exp(z); return Number.isFinite(e) ? e / (1 + e) : 0; }
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

// ============ 🎯 FIX: LUÔN TÍNH TỪ 3 XÚC XẮC ============
function itemToDice(item) {
  if (!item) return [0, 0, 0];
  return [safeInt(item.FirstDice, 0), safeInt(item.SecondDice, 0), safeInt(item.ThirdDice, 0)];
}

function itemToSum(item) {
  if (!item) return 0;
  const d = itemToDice(item);
  const s = d[0] + d[1] + d[2];
  if (s > 0 && s <= 18) return s;
  if (item.DiceSum !== undefined) return safeInt(item.DiceSum, 0);
  return 0;
}

/**
 * ✅ FIX BUG: Sum >= 11 → Tài, Sum <= 10 → Xỉu
 * KHÔNG dùng BetSide từ API (có thể sai)
 */
function itemToResult(item) {
  if (!item) return null;
  const sum = itemToSum(item);
  if (sum >= 3 && sum <= 18) return sum >= 11 ? 'T' : 'X';
  if (item.BetSide !== undefined) return safeInt(item.BetSide, 0) === 1 ? 'T' : 'X';
  return null;
}

// ============ DETERMINISTIC ============
function deterministicHash(str) {
  const hash = crypto.createHash('sha256').update(String(str)).digest();
  return hash.readUInt32BE(0) / 0xFFFFFFFF;
}

function deterministicInitWeights(dim, seed = 'default') {
  const w = new Array(dim);
  for (let i = 0; i < dim; i++) w[i] = (deterministicHash(`${seed}::${i}`) - 0.5) * 0.02;
  return w;
}

// ============ DB ============
function defaultDB() {
  return {
    version: 5,
    createdAt: now(), updatedAt: now(),
    history: [],
    stats: { total: 0, wins: 0, losses: 0, currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0 },
    timeStats: {
      Sang: { total: 0, wins: 0 }, Chieu: { total: 0, wins: 0 },
      Toi: { total: 0, wins: 0 }, Dem: { total: 0, wins: 0 }
    },
    lastProcessedSession: null,
    model: { weights: null, bias: 0, iter: 0, createdAt: now(), version: 1, bestAcc: 0, seed: 'hoang_vip_v5' },
    calibration: { a: 1.0, b: 0.0, iter: 0 },
    optimizer: { m: null, v: null, t: 0 },
    ensembleRegret: { model: 0, pattern: 0, markov: 0 },
    patterns: { lastExtractedAt: null, list: [] },
    ensembleWeights: { model: 0.34, pattern: 0.33, markov: 0.33 },
    checkpoints: [], biasCorrections: [], brierHistory: [],
    _strictUnbiased: true
  };
}

function migrateDB(db) {
  if (!db || typeof db !== 'object') return defaultDB();
  const def = defaultDB();
  for (const k in def) if (db[k] === undefined || db[k] === null) db[k] = def[k];
  if (!Array.isArray(db.history)) db.history = [];
  if (!Array.isArray(db.checkpoints)) db.checkpoints = [];
  if (!Array.isArray(db.biasCorrections)) db.biasCorrections = [];
  if (!Array.isArray(db.brierHistory)) db.brierHistory = [];
  if (!db.stats || typeof db.stats !== 'object') db.stats = def.stats;
  for (const k in def.stats) if (!Number.isFinite(db.stats[k])) db.stats[k] = def.stats[k];
  if (!db.timeStats || typeof db.timeStats !== 'object') db.timeStats = def.timeStats;
  for (const s of ['Sang', 'Chieu', 'Toi', 'Dem']) if (!db.timeStats[s]) db.timeStats[s] = { total: 0, wins: 0 };
  if (!db.model || typeof db.model !== 'object') db.model = def.model;
  if (!Array.isArray(db.model.weights) && db.model.weights !== null) db.model.weights = null;
  if (!Number.isFinite(db.model.bias)) db.model.bias = 0;
  if (!Number.isFinite(db.model.iter)) db.model.iter = 0;
  if (!Number.isFinite(db.model.version)) db.model.version = 1;
  if (!Number.isFinite(db.model.bestAcc)) db.model.bestAcc = 0;
  if (!db.calibration || typeof db.calibration !== 'object') db.calibration = def.calibration;
  if (!Number.isFinite(db.calibration.a)) db.calibration.a = 1;
  if (!Number.isFinite(db.calibration.b)) db.calibration.b = 0;
  if (!db.optimizer) db.optimizer = { m: null, v: null, t: 0 };
  if (!db.ensembleRegret) db.ensembleRegret = { model: 0, pattern: 0, markov: 0 };
  if (!db.patterns) db.patterns = { lastExtractedAt: null, list: [] };
  if (!Array.isArray(db.patterns.list)) db.patterns.list = [];
  if (!db.ensembleWeights) db.ensembleWeights = { model: 0.34, pattern: 0.33, markov: 0.33 };
  if (typeof db._strictUnbiased !== 'boolean') db._strictUnbiased = true;
  if (!db.version) db.version = 5;
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
  if (db.biasCorrections.length > 100) db.biasCorrections = db.biasCorrections.slice(-100);
  if (db.brierHistory.length > 500) db.brierHistory = db.brierHistory.slice(-500);
  safeAtomicWrite(DB_FILES[game], db);
  safeAtomicWrite(BACKUP_FILES[game], db);
}

// ============ 🎯 FIX: BỎ DEBIAS CỨNG ============
// Nguyên nhân chính gây bug "toàn Xỉu" - đã bỏ hoàn toàn
function getRecentMeanPred(db, windowSize = 200) {
  const hist = (db.history || []).slice(-windowSize);
  if (!hist.length) return 0.5;
  let sum = 0, cnt = 0;
  for (const h of hist) {
    if (h && h.meta) {
      const v = h.meta.combinedProb !== undefined ? h.meta.combinedProb
              : h.meta.calibratedProb !== undefined ? h.meta.calibratedProb : null;
      if (v !== null && Number.isFinite(v)) { sum += v; cnt++; }
    }
  }
  return cnt ? (sum / cnt) : 0.5;
}

function debiasProbability(db, p, windowSize = 200) {
  // ✅ FIX: KHÔNG shift logit. Chỉ pass-through
  const pc = clamp(p, 1e-6, 1 - 1e-6);
  return pc;
}

// ============ ✅ FIX: FORCE BALANCE ============
function forceBalance(db, p) {
  const pc = clamp(p, 1e-6, 1 - 1e-6);
  // Nếu |p - 0.5| < 0.02 → kéo về 0.5 để không predict khi quá gần
  if (Math.abs(pc - 0.5) < 0.02) return 0.5;
  // Nếu |p - 0.5| < 0.05 → amplify nhẹ để có tín hiệu rõ
  if (Math.abs(pc - 0.5) < 0.05) {
    const sign = pc >= 0.5 ? 1 : -1;
    return clamp(0.5 + sign * (Math.abs(pc - 0.5) * 1.3));
  }
  return pc;
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
  const baseT = Math.max(countT / (n || 1), 1e-6);
  const baseX = Math.max(1 - baseT, 1e-6);
  const patterns = [];
  for (const pat in freq) {
    const m = freq[pat];
    if (m.count < minSupport) continue;
    const pT = (m.t + 1) / (m.count + 2);
    const pX = (m.x + 1) / (m.count + 2);
    const oddsT = Math.log(pT / baseT);
    const oddsX = Math.log(pX / baseX);
    const divergence = Math.max(Math.abs(oddsT), Math.abs(oddsX));
    const strength = divergence * Math.log(1 + m.count);
    const recency = 1 + (m.lastIndex / Math.max(1, n - 1));
    const rawScore = strength * recency;
    if (!Number.isFinite(rawScore)) continue;
    patterns.push({
      pattern: pat, count: m.count,
      pT: Number(pT.toFixed(4)), pX: Number(pX.toFixed(4)),
      lastIndex: m.lastIndex, rawScore
    });
  }
  patterns.sort((a, b) => b.rawScore - a.rawScore);
  return patterns.slice(0, topN);
}

function mergeAndDecayPatterns(dbPatterns, newPatterns, seqLen) {
  const map = Object.create(null);
  for (const p of (dbPatterns || [])) {
    if (!p || !p.pattern) continue;
    const age = Math.max(0, seqLen - (p.lastIndex || 0));
    const decay = Math.pow(0.5, age / Math.max(1, PATTERN_DECAY_HALF_LIFE));
    map[p.pattern] = {
      pattern: p.pattern,
      score: (p.score || p.rawScore || 0) * decay,
      count: p.count || 0, lastIndex: p.lastIndex || -1,
      pT: p.pT || 0, pX: p.pX || 0
    };
  }
  for (const np of (newPatterns || [])) {
    if (!np || !np.pattern) continue;
    const ex = map[np.pattern];
    if (ex) {
      ex.score = (ex.score || 0) + np.rawScore;
      ex.count = (ex.count || 0) + np.count;
      ex.lastIndex = Math.max(ex.lastIndex || -1, np.lastIndex || -1);
      ex.pT = np.pT; ex.pX = np.pX;
    } else {
      map[np.pattern] = {
        pattern: np.pattern, score: np.rawScore,
        count: np.count, lastIndex: np.lastIndex,
        pT: np.pT, pX: np.pX
      };
    }
  }
  const merged = Object.keys(map).map(k => map[k]);
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, Math.max(PATTERN_TOP_N * 2, 100));
}

// ============ WILSON ============
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
    const diff = wilsonLowerBound(winsT, n) - wilsonLowerBound(winsX, n);
    if (!Number.isFinite(diff)) continue;
    const w = Math.log(1 + n) * Math.abs(diff);
    weightedSum += diff * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return 0.5;
  return sigmoid((weightedSum / totalWeight) * 3.5);
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
    predictions.push({ order, pT: (e.T + 1) / (n + 2), weight });
  }
  if (predictions.length === 0) return { T: 0.5, X: 0.5, orderUsed: 0 };
  let totalW = 0, weightedT = 0;
  for (const p of predictions) {
    const w = p.weight * (1 + 0.1 * p.order);
    weightedT += p.pT * w; totalW += w;
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
      if (sequence[i + n] === 'T') t++; else x++;
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
    for (let i = 0; i < sequence.length; i++) s = a * (sequence[i] === 'T' ? 1 : -1) + (1 - a) * s;
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
    for (let i = 0; i < seq20.length - 1; i++) tr[seq20[i] + seq20[i + 1]]++;
    const total = seq20.length - 1;
    let H = 0;
    for (const k in tr) { const p = tr[k] / total; if (p > 0) H -= p * Math.log(p); }
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
    let occ = 0, idx = tail.indexOf(pat);
    while (idx !== -1 && occ < 1000) { occ++; idx = tail.indexOf(pat, idx + 1); }
    const endsWith = tail.endsWith(pat) ? 1 : 0;
    const sign = (p.pT >= p.pX) ? 1 : -1;
    const ms = sign * Math.abs((p.pT || 0) - (p.pX || 0)) * Math.log(1 + occ) + endsWith * 0.6 * sign;
    scores.push(Number.isFinite(ms) ? ms : 0);
  }
  const maxAbs = Math.max(...scores.map(Math.abs), 1e-9);
  return scores.map(s => s / maxAbs);
}

function buildFeatureVector(sequence, mergedPatterns) {
  const base = buildBaseFeatures(sequence);
  const pat = buildPatternFeatures(sequence, mergedPatterns, PATTERN_TOP_N);
  return {
    vector: base.concat(pat),
    meta: { baseLen: base.length, patternLen: pat.length, topPatterns: mergedPatterns.slice(0, PATTERN_TOP_N) }
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
    db.optimizer = { m: null, v: null, t: 0 };
  }
}

function predictLogit(db, x) {
  initModelIfNeeded(db, x.length);
  let z = db.model.bias || 0;
  for (let i = 0; i < x.length; i++) z += (db.model.weights[i] || 0) * (x[i] || 0);
  return Number.isFinite(z) ? z : 0;
}

function clipGradients(g, clip = GRAD_CLIP) {
  let norm = 0;
  for (let i = 0; i < g.length; i++) norm += g[i] * g[i];
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm === 0) return g;
  if (norm > clip) { const s = clip / norm; for (let i = 0; i < g.length; i++) g[i] *= s; }
  return g;
}

function adamUpdateModel(db, x, labelT) {
  initModelIfNeeded(db, x.length);
  const opt = db.optimizer;
  if (!Array.isArray(opt.m) || opt.m.length !== x.length) opt.m = new Array(x.length).fill(0);
  if (!Array.isArray(opt.v) || opt.v.length !== x.length) opt.v = new Array(x.length).fill(0);
  opt.t = (opt.t || 0) + 1;

  const z = predictLogit(db, x);
  const pred = sigmoid(z);
  const err = labelT - pred;

  const grad = new Array(x.length);
  for (let i = 0; i < x.length; i++) grad[i] = err * (x[i] || 0) - LR_REGULARIZATION * (db.model.weights[i] || 0);
  clipGradients(grad, GRAD_CLIP);

  const b1 = 1 - Math.pow(ADAM_BETA1, opt.t);
  const b2 = 1 - Math.pow(ADAM_BETA2, opt.t);

  for (let i = 0; i < x.length; i++) {
    opt.m[i] = ADAM_BETA1 * opt.m[i] + (1 - ADAM_BETA1) * grad[i];
    opt.v[i] = ADAM_BETA2 * opt.v[i] + (1 - ADAM_BETA2) * grad[i] * grad[i];
    const step = LR_LEARNING_RATE * (opt.m[i] / Math.max(b1, 1e-12)) / (Math.sqrt(opt.v[i] / Math.max(b2, 1e-12)) + ADAM_EPS);
    if (Number.isFinite(step)) db.model.weights[i] -= step;
  }
  const biasStep = LR_LEARNING_RATE * err / Math.sqrt(opt.t + 1);
  if (Number.isFinite(biasStep)) db.model.bias += biasStep;
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
  const a = db.calibration.a || 1.0, b = db.calibration.b || 0.0;
  const pred = sigmoid(a * logit + b);
  const err = labelT - pred;
  db.calibration.iter = (db.calibration.iter || 0) + 1;
  const lr = CALIBRATION_LR * (1 / Math.sqrt(1 + db.calibration.iter / 500));
  let gA = -err * logit, gB = -err;
  const mg = 10;
  if (gA > mg) gA = mg; if (gA < -mg) gA = -mg;
  if (gB > mg) gB = mg; if (gB < -mg) gB = -mg;
  db.calibration.a = a - lr * gA;
  db.calibration.b = b - lr * gB;
  if (!Number.isFinite(db.calibration.a)) db.calibration.a = 1.0;
  if (!Number.isFinite(db.calibration.b)) db.calibration.b = 0.0;
  return { pred, err };
}

// ============ 🎯 FIX: ENSEMBLE VỚI FLOOR WEIGHT ============
function combineSignals(db, pm, pp, pk) {
  let w = db.ensembleWeights || { model: 0.34, pattern: 0.33, markov: 0.33 };

  // ✅ FIX: Floor 15% và cap 55% mỗi nguồn
  w = {
    model: Math.max(MIN_SIGNAL_WEIGHT, Math.min(MAX_SIGNAL_WEIGHT, w.model || 0.34)),
    pattern: Math.max(MIN_SIGNAL_WEIGHT, Math.min(MAX_SIGNAL_WEIGHT, w.pattern || 0.33)),
    markov: Math.max(MIN_SIGNAL_WEIGHT, Math.min(MAX_SIGNAL_WEIGHT, w.markov || 0.33))
  };
  const s = w.model + w.pattern + w.markov;
  w.model /= s; w.pattern /= s; w.markov /= s;

  const raw = w.model * pm + w.pattern * pp + w.markov * pk;
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
  if (total <= 0) { w.model = 0.34; w.pattern = 0.33; w.markov = 0.33; }
  else for (const k of keys) w[k] /= total;

  // ✅ FIX: Floor 15%
  for (const k of keys) w[k] = Math.max(MIN_SIGNAL_WEIGHT, w[k]);
  const s = w.model + w.pattern + w.markov;
  for (const k of keys) w[k] /= s;

  db.ensembleWeights = w;
  return w;
}

// ============ 🎯 FIX: GATING CHẶT HƠN ============
function adaptiveThresholds(db) {
  const recent = (db.history || []).filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI').slice(-50);
  if (recent.length < 20) return { confThresh: CONFIDENCE_THRESHOLD, entThresh: ENTROPY_THRESHOLD };
  const acc = recent.filter(h => h.trangThai === 'ĐÚNG').length / recent.length;
  return {
    confThresh: Math.max(0.65, Math.min(0.85, CONFIDENCE_THRESHOLD + (0.75 - acc) * 0.4)),
    entThresh: Math.max(0.55, Math.min(0.75, ENTROPY_THRESHOLD + (0.75 - acc) * 0.3))
  };
}

function gatingDecision(db, cp, ent, comps) {
  const { confThresh, entThresh } = adaptiveThresholds(db);
  const final = cp >= 0.5 ? 'T' : 'X';
  let agree = 0;
  if ((comps.modelProb >= 0.5 ? 'T' : 'X') === final) agree++;
  if ((comps.patternProb >= 0.5 ? 'T' : 'X') === final) agree++;
  if ((comps.markovProb >= 0.5 ? 'T' : 'X') === final) agree++;

  // ✅ FIX: Cần ít nhất 2/3 đồng ý
  if (agree < 2) return { pass: false, reason: 'low_agreement', agree, confThresh, entThresh };

  // ✅ FIX: Nếu quá gần 0.5 → không tự tin
  if (Math.abs(cp - 0.5) < MIN_CONFIDENCE) {
    return { pass: false, reason: 'too_close_50_50', agree, confThresh, entThresh };
  }

  if (cp < confThresh) return { pass: false, reason: 'low_confidence', agree, confThresh, entThresh };
  if (ent > entThresh) return { pass: false, reason: 'high_entropy', agree, confThresh, entThresh };
  return { pass: true, reason: 'ok', agree, confThresh, entThresh };
}

// ============ BIAS DETECTION ============
function detectAndCorrectBias(db, game) {
  try {
    const recent = (db.history || []).slice(-60);
    if (recent.length < 10) return;
    let cT = 0, cX = 0;
    for (const r of recent) {
      if (r.DU_DOAN_CODE === 'T') cT++;
      else if (r.DU_DOAN_CODE === 'X') cX++;
    }
    const total = cT + cX;
    if (total < 8) return;
    const pT = cT / total, pX = cX / total;
    if (pT > 0.92 || pX > 0.92) {
      console.warn(`[BIAS] game=${game} pT=${pT.toFixed(3)} pX=${pX.toFixed(3)} correcting`);
      db.ensembleWeights = { model: 0.34, pattern: 0.33, markov: 0.33 };
      db.ensembleRegret = { model: 0, pattern: 0, markov: 0 };
      db.optimizer = { m: null, v: null, t: 0 };
      if (db.model && Array.isArray(db.model.weights)) {
        for (let i = 0; i < db.model.weights.length; i++) db.model.weights[i] *= 0.5;
        if (typeof db.model.bias === 'number') db.model.bias *= 0.5;
      }
      db.biasCorrections.push({ at: now(), pT: Number(pT.toFixed(4)), pX: Number(pX.toFixed(4)) });
    }
  } catch (e) {}
}

// ============ CHECKPOINT & BRIER ============
function maybeCheckpoint(db, game) {
  try {
    const window = Math.max(20, Math.min(200, Math.floor(MAX_HISTORY / 2)));
    const completed = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
    const tail = completed.slice(-window);
    if (tail.length < Math.max(10, Math.floor(window / 4))) return;
    const acc = tail.filter(t => t.trangThai === 'ĐÚNG').length / tail.length;
    const prevBest = db.model.bestAcc || 0;
    if (acc > prevBest + 0.005) {
      db.model.bestAcc = acc;
      db.model.version = (db.model.version || 1) + 1;
      const snap = { at: now(), version: db.model.version, acc, model: { weights: db.model.weights, bias: db.model.bias } };
      db.checkpoints.push(snap);
      try { safeAtomicWrite(path.join(DB_DIR, `model_snapshot_${game}_v${db.model.version}.json`), snap); } catch (e) {}
    }
  } catch (e) {}
}

function computeBrierScore(db, window = 100) {
  const recent = (db.history || []).filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI').slice(-window);
  if (!recent.length) return null;
  let brier = 0, n = 0;
  for (const h of recent) {
    const label = h.ketQua === 'T' ? 1 : (h.ketQua === 'X' ? 0 : null);
    if (label === null) continue;
    const p = (h.meta && h.meta.combinedProb !== undefined) ? h.meta.combinedProb : 0.5;
    brier += Math.pow(p - label, 2); n++;
  }
  return n > 0 ? brier / n : null;
}

// ============ FETCH ============
async function fetchWithRetry(url, attempts = FETCH_RETRIES) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.get(url, { timeout: API_TIMEOUT_MS, headers: { 'User-Agent': 'HoangVipAdaptive/5.0' } });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 200 + i * 200));
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

// ============ 🎯 FIX: RUN PREDICTION ============
function runPrediction(db, seq, game = 'default') {
  if (!Array.isArray(seq) || seq.length === 0) {
    return {
      featureVector: [], logit: 0, calibrated: 0.5, combined: 0.5,
      pModel: 0.5, pPattern: 0.5, pMarkov: 0.5, entropy: 1,
      gate: { pass: false, reason: 'no_data' },
      comps: { modelProb: 0.5, patternProb: 0.5, markovProb: 0.5 },
      predCode: 'T', predLabel: 'Tài', tiLe: '50.0% (LOW)',
      mergedPatterns: [], fvMeta: { topPatterns: [] }
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

  // ✅ FIX: Blend 4 nguồn cân bằng hơn
  let finalP = clamp(
    0.35 * calibrated +
    0.25 * pModel +
    0.20 * pPattern +
    0.20 * pMarkov
  );

  // ✅ FIX: Bỏ debias shift
  finalP = debiasProbability(db, finalP, 200);

  // ✅ FIX: Force balance
  finalP = forceBalance(db, finalP);

  // ✅ FIX: Anchor về avg nếu lệch quá xa
  const avgSignal = (pModel + pPattern + pMarkov) / 3;
  if (Math.abs(finalP - avgSignal) > 0.15) {
    finalP = clamp(0.6 * finalP + 0.4 * avgSignal);
  }

  const entropy = entropyFromProb(finalP);
  const comps = { modelProb: pModel, patternProb: pPattern, markovProb: pMarkov };
  const gate = gatingDecision(db, finalP, entropy, comps);
  const predCode = finalP >= 0.5 ? 'T' : 'X';
  const predLabel = labelFromTX(predCode);
  const tiLe = (Math.max(finalP, 1 - finalP) * 100).toFixed(1) + '%' + (gate.pass ? '' : ' (LOW)');

  return {
    featureVector: x, logit, calibrated, combined: finalP,
    pModel, pPattern, pMarkov, entropy, gate, comps,
    predCode, predLabel, tiLe, mergedPatterns: merged, fvMeta: fvInfo.meta
  };
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
    if (seq.length < 2) return;

    const pred = runPrediction(db, seq, game);

    // Evaluate previous
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
        if (db.stats.currentStreak > db.stats.maxWinStreak) db.stats.maxWinStreak = db.stats.currentStreak;
      } else {
        db.stats.losses++;
        db.stats.currentStreak = db.stats.currentStreak <= 0 ? db.stats.currentStreak - 1 : -1;
        const al = Math.abs(db.stats.currentStreak);
        if (al > db.stats.maxLossStreak) db.stats.maxLossStreak = al;
      }

      try {
        const sfv = (lastRecorded.meta && Array.isArray(lastRecorded.meta.featureVector)) ? lastRecorded.meta.featureVector : null;
        const sl = (lastRecorded.meta && lastRecorded.meta.logit !== undefined) ? lastRecorded.meta.logit : null;
        if (sfv && sfv.length > 0) {
          const labelT = actual === 'T' ? 1 : 0;
          const upd = adamUpdateModel(db, sfv, labelT);
          lastRecorded.meta = lastRecorded.meta || {};
          lastRecorded.meta.modelUpdate = { err: upd.err, loss: upd.loss, lr: upd.lr, at: now() };
          if (sl !== null && Number.isFinite(sl)) calibrationUpdate(db, sl, labelT);
          const cm = (lastRecorded.meta && lastRecorded.meta.components) || {};
          updateEnsembleWeights(db, {
            model: Math.abs(sigmoid(sl !== null ? sl : 0) - labelT),
            pattern: Math.abs((cm.patternProb || 0.5) - labelT),
            markov: Math.abs((cm.markovProb || 0.5) - labelT)
          });
        }
      } catch (e) {}

      const b = computeBrierScore(db, 50);
      if (b !== null && Number.isFinite(b)) db.brierHistory.push({ at: now(), brier: Number(b.toFixed(4)) });
    }

    // New entry
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
      mauCau: (pred.fvMeta && pred.fvMeta.topPatterns) ? pred.fvMeta.topPatterns.map(p => p.pattern).slice(0, 6).join('; ') : 'Auto',
      trangThai: 'ĐANG CHỜ',
      thoiGian: now(),
      meta: {
        featureVector: pred.featureVector, logit: pred.logit,
        calibratedProb: Number(pred.calibrated.toFixed(4)),
        combinedProb: Number(pred.combined.toFixed(4)),
        rawModelProb: Number(pred.pModel.toFixed(4)),
        patternProb: Number(pred.pPattern.toFixed(4)),
        markovProb: Number(pred.pMarkov.toFixed(4)),
        entropy: Number(pred.entropy.toFixed(6)),
        components: pred.comps, gate: pred.gate, createdAt: now()
      }
    };

    db.history.push(newEntry);
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);
    db.lastProcessedSession = currentSession;

    detectAndCorrectBias(db, game);
    maybeCheckpoint(db, game);
    saveDatabase(game, db);

    console.log(`[TICK] ${game} #${currentSession} dice=[${newEntry.xucXac.join(',')}] sum=${newEntry.tong} kq=${newEntry.ketQuaLabel} → predict=${pred.predLabel} (${pred.tiLe})`);
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
    duDoan: it.DU_DOAN || null,
    duDoanCode: it.DU_DOAN_CODE || codeFromLabel(it.DU_DOAN),
    tiLe: it.TI_LE || null,
    mauCau: it.mauCau || null,
    trangThai: it.trangThai || null,
    thoiGian: it.thoiGian || (it.meta && it.meta.createdAt) || null
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
    const pred = runPrediction(db, seq, game);
    const latest = list[list.length - 1];
    const cs = safeInt(latest.SessionId || latest.session, 0);

    return res.json({
      phien: cs,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: itemToResult(latest),
      ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: cs + 1,
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
    return res.status(500).json({ error: e.message || 'fetch error' });
  }
});

// ============ API: LINK RIÊNG ============
app.get('/api/link/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });
  try {
    const r = await fetchWithRetry(APIS[game]);
    const list = parseHistoryResponse(r.data);
    if (!list.length) return res.status(204).send();

    const seq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const db = loadDatabase(game);
    const pred = runPrediction(db, seq, game);
    const latest = list[list.length - 1];
    const cs = safeInt(latest.SessionId || latest.session, 0);

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    return res.json({
      ok: true,
      game: game.toUpperCase(),
      phienHienTai: cs,
      phienDuDoan: cs + 1,
      duDoan: pred.predLabel,
      duDoanCode: pred.predCode,
      tiLe: pred.tiLe,
      doTinCay: pred.gate.pass ? 'CAO' : 'THẤP',
      lyDo: pred.gate.reason,
      thoiGian: now(),
      links: {
        ui: `${baseUrl}/${game}`,
        predict: `${baseUrl}/api/predict/${game}`,
        history: `${baseUrl}/api/history/${game}?limit=100`,
        historyAll: `${baseUrl}/api/history/all?limit=500`,
        analyze: `${baseUrl}/api/analyze/${game}`,
        exportJson: `${baseUrl}/api/history/export/${game}`,
        exportCsv: `${baseUrl}/api/export/${game}`,
        metrics: `${baseUrl}/admin/metrics/${game}`
      },
      chiTiet: {
        modelProb: Number(pred.pModel.toFixed(4)),
        patternProb: Number(pred.pPattern.toFixed(4)),
        markovProb: Number(pred.pMarkov.toFixed(4)),
        calibrated: Number(pred.calibrated.toFixed(4)),
        finalProb: Number(pred.combined.toFixed(4))
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'fetch error' });
  }
});

// ============ API: HISTORY ============
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
      result.games[game] = {
        count: slice.length,
        stats: {
          total: db.stats.total, wins: db.stats.wins, losses: db.stats.losses,
          winRate: db.stats.total > 0 ? Number(((db.stats.wins / db.stats.total) * 100).toFixed(2)) : 0,
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

// ============ API: EXPORT ============
app.get('/api/history/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Bàn chơi không hợp lệ.');
  const db = loadDatabase(game);
  const exportObj = {
    game, exportedAt: now(), version: db.version,
    stats: db.stats, timeStats: db.timeStats,
    ensembleWeights: db.ensembleWeights, ensembleRegret: db.ensembleRegret,
    model: {
      version: db.model.version, bestAcc: db.model.bestAcc,
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

app.get('/api/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Bàn chơi không hợp lệ.');
  const db = loadDatabase(game);
  let csv = 'Phiên,XúcXắc,Tổng,KếtQuả,PhiênDựĐoán,DựĐoán,TỉLệ,MẫuCầu,TrạngThái,ThờiGian\n';
  db.history.forEach(item => {
    const dice = (item.xucXac || []).join('-');
    const mc = (item.mauCau || '').replace(/"/g, '\'');
    csv += `${item.phien},"${dice}",${item.tong || ''},${item.ketQuaLabel || ''},${item.phienDuDoan},${item.DU_DOAN || ''},${item.TI_LE || ''},"${mc}",${item.trangThai || ''},${item.thoiGian || ''}\n`;
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
  const winRate = db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) : '0.00';
  return res.json({
    game: game.toUpperCase(),
    latest: formatHistoryItem(latest),
    stats: db.stats, timeStats: db.timeStats,
    winRate: `${winRate}%`,
    model: {
      weightsCount: Array.isArray(db.model.weights) ? db.model.weights.length : 0,
      bias: db.model.bias, version: db.model.version,
      bestAcc: db.model.bestAcc || 0, iter: db.model.iter || 0
    },
    calibration: db.calibration,
    weights: db.ensembleWeights, regret: db.ensembleRegret,
    brierScore: computeBrierScore(db, 200),
    patterns: Array.isArray(db.patterns.list) ? db.patterns.list.slice(0, 60) : [],
    biasCorrections: db.biasCorrections || []
  });
});

// ============ ADMIN ============
app.get('/admin/metrics/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const tail = (db.history || []).filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI').slice(-200);
  const acc = tail.length ? (tail.filter(h => h.trangThai === 'ĐÚNG').length / tail.length) : 0;

  // Count predictions Tài vs Xỉu trong 50 phiên gần nhất
  const recent = (db.history || []).slice(-50);
  let cntT = 0, cntX = 0;
  for (const h of recent) {
    if (h.DU_DOAN_CODE === 'T') cntT++;
    else if (h.DU_DOAN_CODE === 'X') cntX++;
  }

  return res.json({
    rollingCount: tail.length,
    rollingAccuracy: Number(acc.toFixed(4)),
    rollingBrier: computeBrierScore(db, 200),
    totalEvaluations: db.stats.total,
    globalAccuracy: db.stats.total ? Number((db.stats.wins / db.stats.total).toFixed(4)) : 0,
    distribution: { tai: cntT, xiu: cntX, ratio: cntT + cntX > 0 ? `${cntT}/${cntX}` : 'N/A' },
    ensembleWeights: db.ensembleWeights,
    ensembleRegret: db.ensembleRegret,
    biasCorrections: db.biasCorrections ? db.biasCorrections.length : 0,
    modelVersion: db.model.version || 1,
    bestAcc: db.model.bestAcc || 0
  });
});

app.get('/admin/config', (req, res) => {
  res.json({
    LR_LEARNING_RATE, LR_REGULARIZATION,
    MARKOV_MAX_ORDER, PATTERN_TOP_N,
    CONFIDENCE_THRESHOLD, ENTROPY_THRESHOLD,
    MIN_CONFIDENCE, MIN_SIGNAL_WEIGHT, MAX_SIGNAL_WEIGHT,
    DETERMINISTIC: true, VERSION: 5
  });
});

// ============ UI ============
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Trang không tồn tại.');

  const db = loadDatabase(game);
  const winRate = db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) : '0.00';
  const rows = db.history.slice(-40).reverse();
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>HOANG VIP v5 - ${game.toUpperCase()}</title>
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
    position:relative;overflow:hidden;
  }
  .header::before{
    content:'';position:absolute;top:-50%;right:-50%;
    width:200%;height:200%;
    background:radial-gradient(circle,rgba(255,255,255,0.1) 0%,transparent 70%);
    animation:shine 3s infinite linear;
  }
  @keyframes shine{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}
  h1{color:#fff;font-size:17px;margin:0;font-weight:700;letter-spacing:0.5px;position:relative;z-index:1}
  .subtitle{color:#bfdbfe;font-size:11px;margin-top:4px;position:relative;z-index:1}

  .stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
  .stat-card{
    background:linear-gradient(135deg,#1e293b,#0f172a);
    padding:10px;border-radius:10px;text-align:center;
    border:1px solid #334155;box-shadow:0 4px 12px rgba(0,0,0,0.3);
  }
  .stat-card .label{font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px}
  .stat-card .value{font-size:20px;font-weight:700;margin-top:2px}
  .value.green{color:#22c55e}.value.red{color:#ef4444}
  .value.blue{color:#38bdf8}.value.yellow{color:#eab308}

  .link-box{
    background:linear-gradient(135deg,#064e3b,#065f46);
    padding:12px;border-radius:12px;margin-bottom:14px;
    border:1px solid #10b981;box-shadow:0 4px 12px rgba(16,185,129,0.2);
  }
  .link-box .title{font-size:12px;color:#6ee7b7;font-weight:600;margin-bottom:6px}
  .link-row{
    font-family:'Courier New',monospace;font-size:11px;color:#d1fae5;
    background:rgba(0,0,0,0.3);padding:8px;border-radius:6px;
    margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;
  }
  .link-row span{word-break:break-all;flex:1}
  .copy-btn{
    background:#10b981;color:#fff;border:none;
    padding:4px 10px;border-radius:6px;
    font-size:10px;font-weight:600;cursor:pointer;white-space:nowrap;
  }
  .copy-btn:active{background:#059669}

  .table-wrap{
    background:linear-gradient(135deg,#0f172a,#1e293b);
    border-radius:12px;overflow:hidden;
    border:1px solid #334155;box-shadow:0 8px 24px rgba(0,0,0,0.4);
  }
  table{width:100%;border-collapse:collapse;font-size:11px}
  th{
    background:linear-gradient(135deg,#1e40af,#3b82f6);
    color:#fff;padding:8px 4px;font-weight:600;
    text-transform:uppercase;font-size:9px;letter-spacing:0.3px;
  }
  td{padding:8px 4px;text-align:center;border-bottom:1px solid #1e293b}
  tr:last-child td{border-bottom:none}
  tr:hover{background:rgba(59,130,246,0.08)}
  .tai{color:#22c55e;font-weight:700;text-shadow:0 0 8px rgba(34,197,94,0.4)}
  .xiu{color:#ef4444;font-weight:700;text-shadow:0 0 8px rgba(239,68,68,0.4)}
  .dung{color:#22c55e;font-weight:600}
  .sai{color:#ef4444;font-weight:600}
  .cho{color:#eab308;font-weight:600;animation:pulse 1.5s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
  .dice{font-family:'Courier New',monospace;font-weight:600;color:#fbbf24}
  .sum-badge{
    display:inline-block;padding:2px 6px;border-radius:4px;
    background:rgba(251,191,36,0.15);color:#fbbf24;font-weight:700;font-size:11px;
  }
  .session{font-family:'Courier New',monospace;font-size:10px;color:#94a3b8}
  .ti-le{font-size:10px;color:#a5b4fc}
  .low-badge{
    display:inline-block;font-size:8px;
    background:#7c2d12;color:#fdba74;
    padding:1px 4px;border-radius:3px;margin-left:2px;
  }
  .mau{font-size:9px;color:#64748b;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .footer{text-align:center;margin-top:14px;font-size:10px;color:#475569}
</style>
<script>
  setTimeout(()=>location.reload(), 12000);
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
    <h1>🎯 HOANG VIP ADAPTIVE v5</h1>
    <div class="subtitle">Bàn: ${game.toUpperCase()} • Deterministic Model</div>
  </div>

  <div class="stats-grid">
    <div class="stat-card"><div class="label">Tổng</div><div class="value blue">${db.stats.total}</div></div>
    <div class="stat-card"><div class="label">Thắng</div><div class="value green">${db.stats.wins}</div></div>
    <div class="stat-card"><div class="label">Thua</div><div class="value red">${db.stats.losses}</div></div>
    <div class="stat-card"><div class="label">Tỉ lệ</div><div class="value ${parseFloat(winRate) >= 50 ? 'green' : 'yellow'}">${winRate}%</div></div>
    <div class="stat-card"><div class="label">Model v</div><div class="value blue">${db.model.version || 1}</div></div>
    <div class="stat-card"><div class="label">Best Acc</div><div class="value green">${((db.model.bestAcc || 0) * 100).toFixed(1)}%</div></div>
  </div>

  <div class="link-box">
    <div class="title">🔗 Link dự đoán</div>
    <div class="link-row">
      <span>${baseUrl}/${game}</span>
      <button class="copy-btn" onclick="copyText('${baseUrl}/${game}', this)">Copy</button>
    </div>
    <div class="link-row">
      <span>${baseUrl}/api/link/${game}</span>
      <button class="copy-btn" onclick="copyText('${baseUrl}/api/link/${game}', this)">Copy</button>
    </div>
    <div class="link-row">
      <span>${baseUrl}/api/predict/${game}</span>
      <button class="copy-btn" onclick="copyText('${baseUrl}/api/predict/${game}', this)">Copy</button>
    </div>
    <div class="link-row">
      <span>${baseUrl}/api/history/all</span>
      <button class="copy-btn" onclick="copyText('${baseUrl}/api/history/all', this)">Copy</button>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Phiên</th><th>Xúc xắc</th><th>Tổng</th><th>KQ</th>
          <th>Phiên DĐ</th><th>Dự đoán</th><th>Tỉ lệ</th><th>Mẫu</th><th>TT</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(it => {
          const dice = (it.xucXac || []).join('-');
          const kq = it.ketQuaLabel || labelFromTX(it.ketQua) || '';
          const kqCls = it.ketQua === 'T' ? 'tai' : (it.ketQua === 'X' ? 'xiu' : '');
          const ddCls = it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu';
          const ttCls = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho');
          const tiLe = (it.TI_LE || '').replace(' (LOW)', '');
          const isLow = (it.TI_LE || '').includes('LOW');
          return `<tr>
            <td class="session">${it.phien}</td>
            <td class="dice">${dice}</td>
            <td><span class="sum-badge">${it.tong || ''}</span></td>
            <td class="${kqCls}">${kq}</td>
            <td class="session">${it.phienDuDoan}</td>
            <td class="${ddCls}">${it.DU_DOAN || ''}</td>
            <td class="ti-le">${tiLe}${isLow ? '<span class="low-badge">LOW</span>' : ''}</td>
            <td class="mau">${it.mauCau || ''}</td>
            <td class="${ttCls}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <div class="footer">Auto refresh 12s • HOANG VIP v5</div>
</body>
</html>`;
  res.send(html);
});

// ============ SERVER ============
const server = app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 HOANG VIP ADAPTIVE v5 - FULL FIX`);
  console.log(`========================================`);
  console.log(`Port: ${PORT} | Polling: ${POLL_INTERVAL_MS}ms | Max: ${MAX_HISTORY}`);
  console.log(`✅ FIX: Predict toàn Xỉu (bỏ debias shift)`);
  console.log(`✅ FIX: Sum>=11 Tài, Sum<=10 Xỉu (từ 3 xúc xắc)`);
  console.log(`✅ Blend 4 nguồn: 35% cal + 25% model + 20% pattern + 20% markov`);
  console.log(`✅ Floor weight 15% mỗi signal`);
  console.log(`✅ Check agreement 2/3`);
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
