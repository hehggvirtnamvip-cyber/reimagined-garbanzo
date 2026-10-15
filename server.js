// server.js
/**
 * HOANG VIP ADAPTIVE - ADVANCED single-file
 *
 * New features (compared to previous):
 * - Auto-expand pattern/features (daily or interval) with snapshot/rollback
 * - Meta-learning / auto-tune (backtest-driven) to adjust LR and ensemble eta
 * - Scheduler for periodic auto-expand / meta-tune
 * - Admin endpoints to control expansion, tuning, exploration
 * - metaEvents log in DB for auditing
 *
 * Usage:
 *  npm i express axios
 *  node server.js
 *
 * Notes:
 * - This file extends earlier single-file AI. It remains a single-file deploy for quick testing.
 * - For production, split into modules and persist to DB (SQLite).
 */

'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------- Config ----------------
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 400);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 8000);

// Auto-expansion / meta-tune config
const AUTO_EXPAND_INTERVAL_MS = Number(process.env.AUTO_EXPAND_INTERVAL_MS || 24 * 3600 * 1000); // default daily
const META_TUNE_WINDOW = Number(process.env.META_TUNE_WINDOW || 400); // how many records to evaluate for tuning
const META_TUNE_MIN_RECORDS = Number(process.env.META_TUNE_MIN_RECORDS || 80);
const META_TUNE_IMPROVEMENT_THRESHOLD = Number(process.env.META_TUNE_IMPROVEMENT_THRESHOLD || 0.005);

const APIS = {
  md5: process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: process.env.API_TAIXIU || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

const DB_DIR = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_FILES = { md5: path.join(DB_DIR, 'db_md5.json'), taixiu: path.join(DB_DIR, 'db_taixiu.json') };
const BACKUP_FILES = { md5: path.join(DB_DIR, 'backup_db_md5.json'), taixiu: path.join(DB_DIR, 'backup_db_taixiu.json') };

// Learning & algorithm params (tunable)
let LR_LEARNING_RATE = Number(process.env.LR_LEARNING_RATE || 0.11);
const LR_REGULARIZATION = Number(process.env.LR_REGULARIZATION || 1e-4);
let MARKOV_MAX_ORDER = Number(process.env.MARKOV_MAX_ORDER || 3);
let PATTERN_MAX_LEN = Number(process.env.PATTERN_MAX_LEN || 10);
let PATTERN_MIN_SUPPORT = Number(process.env.PATTERN_MIN_SUPPORT || 2);
let PATTERN_TOP_N = Number(process.env.PATTERN_TOP_N || 30);
const PATTERN_DECAY_HALF_LIFE = Number(process.env.PATTERN_DECAY_HALF_LIFE || 220);

let CALIBRATION_LR = Number(process.env.CALIBRATION_LR || 0.02);
let GRAD_CLIP = Number(process.env.GRAD_CLIP || 5.0);

let CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.78);
let ENTROPY_THRESHOLD = Number(process.env.ENTROPY_THRESHOLD || 0.65);
let ENSEMBLE_ETA = Number(process.env.ENSEMBLE_ETA || 0.08);

// ---------------- Helpers ----------------
function now() { return new Date().toISOString(); }
function labelFromTX(code) { if (code === 'T') return 'Tài'; if (code === 'X') return 'Xỉu'; return code; }
function safeReadJson(filePath, fallback = null) { try { if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return fallback; } }
function safeAtomicWrite(filePath, data) { try { const tmp = filePath + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8'); fs.renameSync(tmp, filePath); } catch (e) {} }
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function entropyFromProb(p) { const eps = 1e-12; return -(p * Math.log(p + eps) + (1 - p) * Math.log(1 - p + eps)); }
function clamp(x, min = 1e-6, max = 1 - 1e-6) { return Math.min(Math.max(x, min), max); }
function getCurrentTimeSlot(date = new Date()) { const h = date.getHours(); if (h >= 6 && h < 12) return 'Sang'; if (h >= 12 && h < 18) return 'Chieu'; if (h >= 18 && h < 24) return 'Toi'; return 'Dem'; }
function itemToResult(item) { if (!item) return null; if (item.BetSide !== undefined) return Number(item.BetSide) === 1 ? 'T' : 'X'; const sum = item.DiceSum !== undefined ? Number(item.DiceSum) : ((Number(item.FirstDice) || 0) + (Number(item.SecondDice) || 0) + (Number(item.ThirdDice) || 0)); return sum >= 11 ? 'T' : 'X'; }

// ---------------- DB ----------------
function defaultDB() {
  return {
    history: [],
    stats: { total: 0, wins: 0, losses: 0, currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0 },
    timeStats: { Sang: { total: 0, wins: 0 }, Chieu: { total: 0, wins: 0 }, Toi: { total: 0, wins: 0 }, Dem: { total: 0, wins: 0 } },
    lastProcessedSession: null,
    model: { weights: null, bias: 0, iter: 0, createdAt: now(), version: 1, bestAcc: 0 },
    calibration: { a: 1.0, b: 0.0, iter: 0 },
    patterns: { lastExtractedAt: null, list: [] },
    ensembleWeights: { model: 0.34, pattern: 0.33, markov: 0.33 },
    checkpoints: [],
    biasCorrections: [],
    metaEvents: [], // log of expansions/tunes
    policy: {
      autoExpand: true,
      expandIntervalMs: AUTO_EXPAND_INTERVAL_MS,
      exploration: { enabled: false, temperature: 1.0 },
      lastExpandAt: null,
      lastMetaTuneAt: null
    },
    _strictUnbiased: true
  };
}
function loadDatabase(game) {
  const file = DB_FILES[game];
  const backup = BACKUP_FILES[game];
  const base = safeReadJson(file);
  if (base) return base;
  const restored = safeReadJson(backup);
  if (restored) return restored;
  return defaultDB();
}
function saveDatabase(game, db) {
  safeAtomicWrite(DB_FILES[game], db);
  safeAtomicWrite(BACKUP_FILES[game], db);
}

// ---------------- Debias ----------------
function getRecentMeanPred(db, windowSize = 200) {
  const hist = (db.history || []).slice(-windowSize);
  if (!hist.length) return 0.5;
  let sum = 0, cnt = 0;
  for (const h of hist) {
    if (h && h.meta && h.meta.combinedProb !== undefined) { sum += Number(h.meta.combinedProb); cnt++; }
    else if (h && h.meta && h.meta.calibratedProb !== undefined) { sum += Number(h.meta.calibratedProb); cnt++; }
  }
  return cnt ? (sum / cnt) : 0.5;
}
function debiasProbability(db, p, windowSize = 200) {
  if (!db._strictUnbiased) return clamp(p);
  const mean = getRecentMeanPred(db, windowSize);
  const shift = mean - 0.5;
  return clamp(p - shift);
}

// ---------------- Pattern mining ----------------
function extractFrequentPatterns(sequence, minSupport = PATTERN_MIN_SUPPORT, maxLen = PATTERN_MAX_LEN, topN = PATTERN_TOP_N) {
  const n = sequence.length;
  if (n < 2) return [];
  const freq = Object.create(null);
  const maxL = Math.min(maxLen, n - 1);

  for (let i = 0; i + 1 < n; i++) {
    let pat = '';
    for (let l = 1; l <= maxL && i + l < n; l++) {
      pat += sequence[i + l - 1];
      const nxt = sequence[i + l];
      let meta = freq[pat];
      if (!meta) meta = { count: 0, t: 0, x: 0, lastIndex: -1, indices: [] };
      meta.count++;
      if (nxt === 'T') meta.t++; else meta.x++;
      meta.lastIndex = i;
      if (meta.indices.length < 64) meta.indices.push(i);
      freq[pat] = meta;
    }
  }

  const baseT = sequence.filter(s => s === 'T').length / (n || 1);
  const baseX = 1 - baseT;
  const patterns = [];

  for (const pat in freq) {
    const m = freq[pat];
    if (m.count < minSupport) continue;
    const pT = (m.t + 1) / (m.count + 2);
    const pX = (m.x + 1) / (m.count + 2);
    const oddsT = Math.log((pT + 1e-9) / (baseT + 1e-9));
    const oddsX = Math.log((pX + 1e-9) / (baseX + 1e-9));
    const divergence = Math.max(Math.abs(oddsT), Math.abs(oddsX));
    const strength = divergence * Math.log(1 + m.count);
    const recency = 1 + (m.lastIndex / Math.max(1, n - 1));
    const rawScore = strength * recency;
    patterns.push({ pattern: pat, count: m.count, pT: Number(pT.toFixed(4)), pX: Number(pX.toFixed(4)), lastIndex: m.lastIndex, rawScore });
  }

  patterns.sort((a, b) => b.rawScore - a.rawScore);
  return patterns.slice(0, topN);
}
function mergeAndDecayPatterns(dbPatterns, newPatterns, seqLen) {
  const map = Object.create(null);
  const halfLife = PATTERN_DECAY_HALF_LIFE;

  for (const p of (dbPatterns || [])) {
    const age = Math.max(0, seqLen - (p.lastIndex || 0));
    const decay = Math.pow(0.5, age / Math.max(1, halfLife));
    map[p.pattern] = { pattern: p.pattern, score: (p.score || p.rawScore || 0) * decay, count: p.count || 0, lastIndex: p.lastIndex || -1, pT: p.pT || 0, pX: p.pX || 0 };
  }

  for (const np of (newPatterns || [])) {
    const ex = map[np.pattern];
    if (ex) {
      ex.score = (ex.score || 0) + np.rawScore;
      ex.count = (ex.count || 0) + np.count;
      ex.lastIndex = Math.max(ex.lastIndex || -1, np.lastIndex || -1);
      ex.pT = np.pT; ex.pX = np.pX;
    } else {
      map[np.pattern] = { pattern: np.pattern, score: np.rawScore, count: np.count, lastIndex: np.lastIndex, pT: np.pT, pX: np.pX };
    }
  }

  const merged = Object.keys(map).map(k => map[k]);
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, Math.max(PATTERN_TOP_N * 2, 80));
}

// ---------------- Markov ----------------
function buildMarkov(sequence, maxOrder = MARKOV_MAX_ORDER) {
  const n = sequence.length;
  const models = {};
  for (let order = 1; order <= maxOrder; order++) {
    const freq = Object.create(null);
    for (let i = 0; i + order < n; i++) {
      const ctx = sequence.slice(i, i + order).join('');
      const nxt = sequence[i + order];
      if (!freq[ctx]) freq[ctx] = { T: 0, X: 0 };
      freq[ctx][nxt]++;
    }
    models[order] = freq;
  }
  return models;
}
function markovPredict(models, sequence) {
  const orders = Object.keys(models).map(Number).sort((a, b) => b - a);
  for (const order of orders) {
    if (sequence.length < order) continue;
    const ctx = sequence.slice(-order).join('');
    const e = models[order][ctx];
    if (e) {
      const pT = (e.T + 1) / (e.T + e.X + 2);
      const pX = (e.X + 1) / (e.T + e.X + 2);
      return { T: pT, X: pX, orderUsed: order };
    }
  }
  return { T: 0.5, X: 0.5, orderUsed: 0 };
}

// ---------------- Feature builder ----------------
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
  const f = [];
  f.push(1.0);
  const a1 = 0.2, a2 = 0.06, a3 = 0.02;
  let s1 = 0, s2 = 0, s3 = 0;
  for (let i = 0; i < sequence.length; i++) {
    const v = sequence[i] === 'T' ? 1 : -1;
    s1 = a1 * v + (1 - a1) * s1;
    s2 = a2 * v + (1 - a2) * s2;
    s3 = a3 * v + (1 - a3) * s3;
  }
  f.push(s1, s2, s3);
  const last = sequence[sequence.length - 1];
  let streak = 1;
  for (let i = sequence.length - 2; i >= 0; i--) {
    if (sequence[i] === last) streak++; else break;
  }
  f.push(Math.tanh(streak / 8));
  f.push(ngramContextDiff(sequence, 1));
  f.push(ngramContextDiff(sequence, 2));
  f.push(ngramContextDiff(sequence, 3));
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
    if (!p) { scores.push(0); continue; }
    const pat = p.pattern;
    let occ = 0;
    let idx = tail.indexOf(pat);
    while (idx !== -1) { occ++; idx = tail.indexOf(pat, idx + 1); }
    const endsWith = tail.endsWith(pat) ? 1 : 0;
    const sign = (p.pT >= p.pX) ? 1 : -1;
    const matchScore = sign * Math.abs((p.pT || 0) - (p.pX || 0)) * Math.log(1 + occ) + endsWith * 0.6 * sign;
    scores.push(matchScore);
  }
  const maxAbs = Math.max(...scores.map(Math.abs), 1e-9);
  return scores.map(s => s / maxAbs);
}
function buildFeatureVector(sequence, mergedPatterns) {
  const base = buildBaseFeatures(sequence);
  const pat = buildPatternFeatures(sequence, mergedPatterns, PATTERN_TOP_N);
  const vector = base.concat(pat);
  return { vector, meta: { baseLen: base.length, patternLen: pat.length, topPatterns: mergedPatterns.slice(0, PATTERN_TOP_N) } };
}

// ---------------- Online logistic ----------------
function initModelIfNeeded(db, dim) {
  db.model = db.model || {};
  if (!db.model.weights || db.model.weights.length !== dim) {
    db.model.weights = Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.02);
    db.model.bias = db.model.bias || 0;
    db.model.iter = db.model.iter || 0;
    db.model.version = db.model.version || 1;
    db.model.createdAt = db.model.createdAt || now();
  }
}
function predictLogit(db, x) {
  initModelIfNeeded(db, x.length);
  let z = db.model.bias || 0;
  for (let i = 0; i < x.length; i++) z += (db.model.weights[i] || 0) * x[i];
  return z;
}
function predictProb(db, x) { return sigmoid(predictLogit(db, x)); }
function clipGradients(gradW, clip = GRAD_CLIP) {
  let norm = 0;
  for (let i = 0; i < gradW.length; i++) norm += gradW[i] * gradW[i];
  norm = Math.sqrt(norm);
  if (norm > clip) {
    const scale = clip / norm;
    for (let i = 0; i < gradW.length; i++) gradW[i] *= scale;
  }
  return gradW;
}
function sgdUpdateModel(db, x, labelT) {
  initModelIfNeeded(db, x.length);
  const z = predictLogit(db, x);
  const pred = sigmoid(z);
  const err = labelT - pred;
  db.model.iter = (db.model.iter || 0) + 1;
  const adapt = 1 / Math.sqrt(1 + db.model.iter / 1000);
  const lr = LR_LEARNING_RATE * adapt;
  const grad = [];
  for (let i = 0; i < x.length; i++) grad[i] = err * x[i] - LR_REGULARIZATION * (db.model.weights[i] || 0);
  clipGradients(grad, GRAD_CLIP);
  for (let i = 0; i < x.length; i++) db.model.weights[i] += lr * grad[i];
  db.model.bias += lr * err;
  return { pred, err, loss: -(labelT * Math.log(pred + 1e-12) + (1 - labelT) * Math.log(1 - pred + 1e-12)), lr };
}

// ---------------- Calibration ----------------
function calibrate(db, logit) {
  const a = db.calibration.a || 1.0, b = db.calibration.b || 0.0;
  return sigmoid(a * logit + b);
}
function calibrationUpdate(db, logit, labelT) {
  db.calibration = db.calibration || { a: 1.0, b: 0.0, iter: 0 };
  const a = db.calibration.a || 1.0, b = db.calibration.b || 0.0;
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
  return { pred, err };
}

// ---------------- Ensemble & gating ----------------
function computePatternSignal(mergedPatterns) {
  const top = (mergedPatterns || []).slice(0, 6);
  let acc = 0;
  for (const p of top) {
    const sign = (p.pT >= p.pX) ? 1 : -1;
    acc += sign * Math.abs((p.pT || 0) - (p.pX || 0)) * Math.log(1 + (p.count || 0));
  }
  return sigmoid(acc);
}
function combineSignals(db, modelProb, patternProb, markovProb) {
  const w = db.ensembleWeights || { model: 0.34, pattern: 0.33, markov: 0.33 };
  const raw = (w.model * modelProb) + (w.pattern * patternProb) + (w.markov * markovProb);
  return { p: Math.min(Math.max(raw, 1e-6), 1 - 1e-6), weights: w };
}
function updateEnsembleWeights(db, losses) {
  const eta = ENSEMBLE_ETA;
  const w = db.ensembleWeights || { model: 0.34, pattern: 0.33, markov: 0.33 };
  const keys = ['model', 'pattern', 'markov'];
  let total = 0;
  for (const k of keys) {
    const li = Math.max(0, losses[k] || 0);
    w[k] = (w[k] || 1e-6) * Math.exp(-eta * li);
    total += w[k];
  }
  if (total <= 0) { w.model = 0.34; w.pattern = 0.33; w.markov = 0.33; } else for (const k of keys) w[k] /= total;
  db.ensembleWeights = w;
  return w;
}
function gatingDecision(calibratedProb, entropy, comps) {
  const final = calibratedProb >= 0.5 ? 'T' : 'X';
  let agree = 0;
  if ((comps.modelProb >= 0.5 ? 'T' : 'X') === final) agree++;
  if ((comps.patternProb >= 0.5 ? 'T' : 'X') === final) agree++;
  if ((comps.markovProb >= 0.5 ? 'T' : 'X') === final) agree++;
  if (calibratedProb < CONFIDENCE_THRESHOLD) return { pass: false, reason: 'low_confidence' };
  if (entropy > ENTROPY_THRESHOLD) return { pass: false, reason: 'high_entropy' };
  if (agree < 2) return { pass: false, reason: 'low_agreement' };
  return { pass: true, reason: 'ok', agree };
}

// ---------------- Bias guard ----------------
function detectAndCorrectBias(db, game) {
  try {
    const LOOK = 60;
    const EXTREME = 0.90;
    const recent = (db.history || []).slice(-LOOK);
    if (!recent || recent.length < 10) return;
    let cntT = 0, cntX = 0;
    for (const r of recent) {
      if (!r || !r.DU_DOAN_CODE) continue;
      if (r.DU_DOAN_CODE === 'T') cntT++; else if (r.DU_DOAN_CODE === 'X') cntX++;
    }
    const total = cntT + cntX;
    if (total < 8) return;
    const pT = cntT / total, pX = cntX / total;
    if (pT > EXTREME || pX > EXTREME) {
      console.warn(`[BIAS DETECT] game=${game} pT=${pT.toFixed(3)} pX=${pX.toFixed(3)} => correcting`);
      db.ensembleWeights = { model: 0.34, pattern: 0.33, markov: 0.33 };
      if (db.model && Array.isArray(db.model.weights)) for (let i = 0; i < db.model.weights.length; i++) db.model.weights[i] *= 0.35;
      if (typeof db.model.bias === 'number') db.model.bias *= 0.35;
      db.calibration = { a: 1.0, b: 0.0, iter: 0 };
      db.biasCorrections = db.biasCorrections || [];
      db.biasCorrections.push({ at: now(), pT: Number(pT.toFixed(4)), pX: Number(pX.toFixed(4)) });
      db._prevLR = db._prevLR || LR_LEARNING_RATE;
      LR_LEARNING_RATE = Math.max(0.02, LR_LEARNING_RATE * 0.5);
    }
  } catch (err) {}
}

// ---------------- Snapshot helpers ----------------
function writeSnapshot(game, prefix = 'snapshot') {
  try {
    const db = loadDatabase(game);
    const fname = path.join(DB_DIR, `${prefix}_${game}_${(new Date()).toISOString().replace(/[:.]/g,'-')}.json`);
    safeAtomicWrite(fname, db);
    return fname;
  } catch (e) { return null; }
}

// ---------------- Auto-expand features ----------------
function autoExpandFeatures(db, game) {
  // Expand pattern top N and max length gradually if history large
  try {
    const histLen = (db.history || []).length;
    if (histLen < 200) return { changed: false, reason: 'not_enough_history' };

    const beforeTopN = PATTERN_TOP_N;
    const beforeMaxLen = PATTERN_MAX_LEN;

    // Expand rules: for every 500 new records, increase topN by 4 and maxLen by 1, cap to safe limits
    const increments = Math.floor(histLen / 500);
    const newTopN = Math.min(120, 10 + increments * 4); // min 10
    const newMaxLen = Math.min(16, 4 + increments);

    // Persist changes in DB.meta so effects are tracked per DB but the global constants also used as defaults
    db.patternConfig = db.patternConfig || {};
    db.patternConfig.topN = newTopN;
    db.patternConfig.maxLen = newMaxLen;
    db.patternConfig.updatedAt = now();

    // record event
    db.metaEvents = db.metaEvents || [];
    db.metaEvents.push({ at: now(), type: 'auto_expand', histLen, newTopN, newMaxLen });

    // return what changed
    return { changed: true, before: { topN: beforeTopN, maxLen: beforeMaxLen }, after: { topN: newTopN, maxLen: newMaxLen } };
  } catch (e) {
    return { changed: false, reason: e && e.message };
  }
}

// ---------------- Meta-tune (backtest-driven) ----------------
function evaluateWindow(db, windowSize = META_TUNE_WINDOW) {
  const hist = (db.history || []).filter(h => h.meta && Array.isArray(h.meta.featureVector)).slice(-windowSize);
  if (hist.length < META_TUNE_MIN_RECORDS) return null;
  // simple backtest score: accuracy on this window using current model (simulated online training)
  let simulated = { weights: db.model.weights ? db.model.weights.slice() : null, bias: db.model.bias || 0 };
  let correct = 0, total = 0;
  for (const rec of hist) {
    const fv = rec.meta.featureVector;
    if (!fv) continue;
    // compute logit with simulated weights
    if (!simulated.weights || simulated.weights.length !== fv.length) simulated.weights = Array(fv.length).fill(0);
    let z = simulated.weights.reduce((s, w, i) => s + w * fv[i], simulated.bias || 0);
    const p = sigmoid(z);
    const pred = p >= 0.5 ? 'T' : 'X';
    if (rec.ketQua && rec.ketQua === pred) correct++;
    total++;
    // online update simulated model after observing rec
    const label = rec.ketQua === 'T' ? 1 : 0;
    const err = label - p;
    const lr = LR_LEARNING_RATE * 0.5; // smaller LR for simulation
    for (let i = 0; i < fv.length; i++) simulated.weights[i] += lr * (err * fv[i] - LR_REGULARIZATION * simulated.weights[i]);
    simulated.bias += lr * err;
  }
  return { accuracy: total ? (correct / total) : 0, total };
}

function metaTune(db, game) {
  // Run backtest on recent window, try small adjustments and accept if improves
  try {
    const baseEval = evaluateWindow(db, META_TUNE_WINDOW);
    if (!baseEval) return { ok: false, reason: 'not_enough_records' };
    const baseAcc = baseEval.accuracy;

    // Try candidate adjustments (small grid)
    const candidates = [
      { LR: LR_LEARNING_RATE * 1.2, ETA: ENSEMBLE_ETA * 1.2 },
      { LR: LR_LEARNING_RATE * 0.8, ETA: ENSEMBLE_ETA * 0.8 },
      { LR: LR_LEARNING_RATE * 1.4, ETA: ENSEMBLE_ETA },
      { LR: Math.max(0.01, LR_LEARNING_RATE * 0.6), ETA: ENSEMBLE_ETA * 1.4 }
    ];

    let best = { acc: baseAcc, LR: LR_LEARNING_RATE, ETA: ENSEMBLE_ETA, accepted: false };

    for (const c of candidates) {
      // temporarily apply
      const prevLR = LR_LEARNING_RATE;
      const prevETA = ENSEMBLE_ETA;
      LR_LEARNING_RATE = c.LR;
      ENSEMBLE_ETA = c.ETA;

      const evalRes = evaluateWindow(db, META_TUNE_WINDOW);
      const acc = evalRes ? evalRes.accuracy : 0;

      // restore to baseline for now (we'll accept later)
      LR_LEARNING_RATE = prevLR;
      ENSEMBLE_ETA = prevETA;

      if (acc > best.acc + META_TUNE_IMPROVEMENT_THRESHOLD) {
        best = { acc, LR: c.LR, ETA: c.ETA, accepted: true };
      }
    }

    // If improvement found, accept and record event, and snapshot
    if (best.accepted) {
      const snapshot = writeSnapshot(game, 'pre_meta_tune');
      const oldLR = LR_LEARNING_RATE, oldETA = ENSEMBLE_ETA;
      LR_LEARNING_RATE = best.LR;
      ENSEMBLE_ETA = best.ETA;
      db.metaEvents = db.metaEvents || [];
      db.metaEvents.push({ at: now(), type: 'meta_tune', before: { LR: oldLR, ETA: oldETA, acc: baseAcc }, after: { LR: best.LR, ETA: best.ETA, acc: best.acc }, snapshot });
      db.policy.lastMetaTuneAt = now();
      saveDatabase(game, db);
      return { ok: true, applied: { LR: best.LR, ETA: best.ETA }, beforeAcc: baseAcc, afterAcc: best.acc, snapshot };
    }
    // else record that tune ran but no improvement
    db.metaEvents = db.metaEvents || [];
    db.metaEvents.push({ at: now(), type: 'meta_tune', note: 'no_improvement', acc: baseAcc });
    db.policy.lastMetaTuneAt = now();
    saveDatabase(game, db);
    return { ok: false, reason: 'no_improvement', baseAcc };
  } catch (e) {
    return { ok: false, reason: e && e.message };
  }
}

// ----------------- Fetch with retry ----------------
async function fetchWithRetry(url, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try { return await axios.get(url, { timeout: API_TIMEOUT_MS }); }
    catch (e) { if (i === attempts - 1) throw e; await new Promise(r => setTimeout(r, 200 + i * 150)); }
  }
}

// ----------------- Main tick (unchanged core) ----------------
async function processGameTick(game) {
  try {
    const api = APIS[game];
    if (!api) return;
    const resp = await fetchWithRetry(api, 2);
    const historyList = Array.isArray(resp.data) ? resp.data : (resp.data && (resp.data.data || resp.data.list) ? (resp.data.data || resp.data.list) : []);
    if (!Array.isArray(historyList) || historyList.length === 0) return;

    const latest = historyList[historyList.length - 1];
    const currentSession = Number(latest.SessionId || latest.session || 0);
    if (!currentSession) return;

    const db = loadDatabase(game);
    if (db.lastProcessedSession === currentSession) return;

    // sequence
    const seq = historyList.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);

    // patterns (use db.patternConfig if present)
    const minSupport = (db.patternConfig && db.patternConfig.minSupport) || PATTERN_MIN_SUPPORT;
    const topN = (db.patternConfig && db.patternConfig.topN) || PATTERN_TOP_N;
    const maxLen = (db.patternConfig && db.patternConfig.maxLen) || PATTERN_MAX_LEN;
    const newPatterns = extractFrequentPatterns(seq, minSupport, maxLen, topN);
    const merged = mergeAndDecayPatterns(db.patterns.list || [], newPatterns, seq.length);
    db.patterns.list = merged;
    db.patterns.lastExtractedAt = now();

    // features & model
    const fvInfo = buildFeatureVector(seq, merged);
    const x = fvInfo.vector;
    initModelIfNeeded(db, x.length);
    const logit = predictLogit(db, x);
    const pModel = sigmoid(logit);

    const mm = buildMarkov(seq, MARKOV_MAX_ORDER);
    const mk = markovPredict(mm, seq);
    const pMarkov = mk.T;

    const pPattern = computePatternSignal(merged);
    const combined = combineSignals(db, pModel, pPattern, pMarkov);
    const calibrated = calibrate(db, logit);

    let finalP = Math.min(Math.max(0.000001, 0.9 * calibrated + 0.1 * combined.p), 0.999999);
    finalP = debiasProbability(db, finalP, 200);

    const entropy = entropyFromProb(finalP);
    const comps = { modelProb: pModel, patternProb: pPattern, markovProb: pMarkov };
    const gate = gatingDecision(finalP, entropy, comps);

    // evaluate previous entry if pending
    const lastRecorded = db.history[db.history.length - 1];
    if (lastRecorded && Number(lastRecorded.phienDuDoan) === currentSession) {
      const actual = itemToResult(latest);
      const lastCode = lastRecorded.DU_DOAN_CODE || ((lastRecorded.DU_DOAN === 'Tài') ? 'T' : (lastRecorded.DU_DOAN === 'Xỉu' ? 'X' : null));
      const wasCorrect = (lastCode === actual);
      lastRecorded.ketQua = actual;
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
        const absLoss = Math.abs(db.stats.currentStreak);
        if (absLoss > db.stats.maxLossStreak) db.stats.maxLossStreak = absLoss;
      }

      try {
        const storedFV = lastRecorded.meta && Array.isArray(lastRecorded.meta.featureVector) ? lastRecorded.meta.featureVector : null;
        const storedLogit = lastRecorded.meta && lastRecorded.meta.logit !== undefined ? lastRecorded.meta.logit : null;
        if (storedFV) {
          const labelT = actual === 'T' ? 1 : 0;
          const upd = sgdUpdateModel(db, storedFV, labelT);
          lastRecorded.meta.modelUpdate = { err: upd.err, loss: upd.loss, lr: upd.lr, at: now() };
          if (storedLogit !== undefined) calibrationUpdate(db, storedLogit, labelT);
          const compLosses = {
            model: Math.abs((storedLogit !== undefined ? sigmoid(storedLogit) : 0.5) - labelT),
            pattern: Math.abs((lastRecorded.meta && lastRecorded.meta.components && lastRecorded.meta.components.patternProb) || pPattern - labelT),
            markov: Math.abs((lastRecorded.meta && lastRecorded.meta.components && lastRecorded.meta.components.markovProb) || pMarkov - labelT)
          };
          updateEnsembleWeights(db, compLosses);
        }
      } catch (e) {}
    }

    // prediction (always output)
    const predictionCode = finalP >= 0.5 ? 'T' : 'X';
    const predictionLabel = labelFromTX(predictionCode);

    const newEntry = {
      phien: currentSession,
      phienDuDoan: currentSession + 1,
      xucXac: [Number(latest.FirstDice || 0), Number(latest.SecondDice || 0), Number(latest.ThirdDice || 0)],
      ketQua: itemToResult(latest),
      DU_DOAN_CODE: predictionCode,
      DU_DOAN: predictionLabel,
      TI_LE: `${(Math.max(finalP, 1 - finalP) * 100).toFixed(1)}%${!gate.pass ? ' (LOW)' : ''}`,
      mauCau: (fvInfo.meta && fvInfo.meta.topPatterns) ? fvInfo.meta.topPatterns.map(p => p.pattern).slice(0, 6).join('; ') : 'Auto',
      trangThai: 'ĐANG CHỜ',
      meta: {
        featureVector: x,
        logit,
        calibratedProb: Number(calibrated.toFixed(4)),
        combinedProb: Number(finalP.toFixed(4)),
        rawModelProb: Number(pModel.toFixed(4)),
        patternProb: Number(pPattern.toFixed(4)),
        markovProb: Number(pMarkov.toFixed(4)),
        entropy: Number(entropy.toFixed(6)),
        components: comps,
        gate,
        createdAt: now()
      }
    };

    db.history.push(newEntry);
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);

    db.lastProcessedSession = currentSession;

    // detect bias and auto-correct
    detectAndCorrectBias(db, game);

    // periodic checkpoint and save
    maybeCheckpoint(db, game);
    saveDatabase(game, db);

  } catch (e) {
    console.error('[ERR processGameTick]', e && e.message ? e.message : e);
  }
}

// ---------------- Polling ----------------
function startPolling() {
  async function tick() {
    await Promise.all(Object.keys(APIS).map(async g => { try { await processGameTick(g); } catch (_) {} }));
    const jitter = Math.floor(Math.random() * 1000);
    setTimeout(tick, POLL_INTERVAL_MS + jitter);
  }
  tick();
}

// ---------------- Scheduler: auto-expand & meta-tune ----------------
let schedulerHandle = null;
function startScheduler() {
  // Run immediate, then schedule
  runScheduledJobs();
  schedulerHandle = setInterval(runScheduledJobs, AUTO_EXPAND_INTERVAL_MS);
}
async function runScheduledJobs() {
  try {
    for (const game of Object.keys(DB_FILES)) {
      const db = loadDatabase(game);
      if (!db.policy) db.policy = { autoExpand: true, exploration: { enabled: false, temperature: 1.0 } };

      // Auto-expand
      if (db.policy.autoExpand) {
        const before = writeSnapshot(game, 'pre_expand');
        const res = autoExpandFeatures(db, game);
        if (res && res.changed) {
          db.policy.lastExpandAt = now();
          db.metaEvents = db.metaEvents || [];
          db.metaEvents.push({ at: now(), type: 'scheduled_expand', res });
          saveDatabase(game, db);
          console.log(`[SCHED] expanded patterns for ${game}:`, res);
        }
      }

      // Meta-tune: run if enough records
      const tuneRes = metaTune(db, game);
      if (tuneRes && (tuneRes.ok || tuneRes.reason === 'no_improvement')) {
        console.log(`[SCHED] meta-tune result for ${game}:`, tuneRes);
      }
    }
  } catch (e) {
    console.warn('[SCHED] runScheduledJobs error', e && e.message);
  }
}

// ---------------- Routes (existing + admin new) ----------------

// Simple JSON endpoint requested: { phien, tong, ketQua, phienDuDoan, duDoan, tiLe }
app.get('/api/simple/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const latest = (db.history && db.history.length) ? db.history[db.history.length - 1] : null;
  if (!latest) return res.status(204).send();
  return res.json({
    phien: latest.phien || null,
    tong: db.stats ? (db.stats.total || 0) : 0,
    ketQua: latest.ketQua || null,
    phienDuDoan: latest.phienDuDoan || null,
    duDoan: latest.DU_DOAN || null,
    tiLe: latest.TI_LE || null
  });
});

// Detailed predict (unchanged)
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });
  try {
    const r = await fetchWithRetry(APIS[game], 2);
    const list = Array.isArray(r.data) ? r.data : (r.data && (r.data.data || r.data.list) ? (r.data.data || r.data.list) : []);
    if (!Array.isArray(list) || !list.length) return res.status(204).send();
    const seq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const db = loadDatabase(game);
    const newPatterns = extractFrequentPatterns(seq);
    const merged = mergeAndDecayPatterns(db.patterns.list || [], newPatterns, seq.length);
    const fvInfo = buildFeatureVector(seq, merged);
    initModelIfNeeded(db, fvInfo.vector.length);
    const logit = predictLogit(db, fvInfo.vector);
    const pModel = sigmoid(logit);
    const mm = buildMarkov(seq, MARKOV_MAX_ORDER);
    const mk = markovPredict(mm, seq);
    const pMarkov = mk.T;
    const pPattern = computePatternSignal(merged);
    const combined = combineSignals(db, pModel, pPattern, pMarkov);
    const calibrated = calibrate(db, logit);
    let finalP = Math.min(Math.max(0.000001, 0.9 * calibrated + 0.1 * combined.p), 0.999999);
    finalP = debiasProbability(db, finalP, 200);
    const entropy = entropyFromProb(finalP);
    const gate = gatingDecision(finalP, entropy, { modelProb: pModel, patternProb: pPattern, markovProb: pMarkov });
    const predCode = finalP >= 0.5 ? 'T' : 'X';
    const predLabel = labelFromTX(predCode);
    return res.json({
      predictionCode: predCode,
      prediction: predLabel,
      finalP: Number(finalP.toFixed(4)),
      calibrated: Number(calibrated.toFixed(4)),
      modelProb: Number(pModel.toFixed(4)),
      patternProb: Number(pPattern.toFixed(4)),
      markovProb: Number(pMarkov.toFixed(4)),
      entropy: Number(entropy.toFixed(6)),
      gate,
      topPatterns: merged.slice(0, 12)
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'fetch error' });
  }
});

// analyze/export/admin routes (mostly unchanged)
app.get('/api/analyze/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const latest = db.history[db.history.length - 1] || {};
  const winRate = db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) : '0.00';
  return res.json({
    game: game.toUpperCase(),
    latest,
    stats: db.stats,
    winRate: `${winRate}%`,
    model: { weightsCount: db.model.weights ? db.model.weights.length : 0, bias: db.model.bias, version: db.model.version, bestAcc: db.model.bestAcc || 0 },
    calibration: db.calibration,
    weights: db.ensembleWeights,
    patterns: db.patterns.list ? db.patterns.list.slice(0, 60) : [],
    biasCorrections: db.biasCorrections || [],
    metaEvents: db.metaEvents || [],
    policy: db.policy || {}
  });
});

app.get('/api/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Invalid game.');
  const db = loadDatabase(game);
  let csv = 'Phiên,PhiênDựĐoán,DựĐoán,TỉLệ,MẫuCầu,KếtQuả,TrạngThái\n';
  db.history.forEach(item => {
    csv += `${item.phien},${item.phienDuDoan},${item.DU_DOAN},${item.TI_LE},"${(item.mauCau || '').replace(/"/g, '\'')}",${item.ketQua || ''},${item.trangThai}\n`;
  });
  res.header('Content-Type', 'text/csv');
  res.attachment(`lich_su_${game}.csv`);
  res.send(csv);
});

// New admin endpoints: auto-expand control, meta-tune trigger, view policy
app.post('/admin/autoexpand/:game', (req, res) => {
  const game = req.params.game;
  const enable = req.body && (req.body.enable === true || req.body.enable === 'true');
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  db.policy = db.policy || {};
  db.policy.autoExpand = !!enable;
  db.metaEvents = db.metaEvents || [];
  db.metaEvents.push({ at: now(), type: 'autoexpand_toggle', enable: !!enable });
  saveDatabase(game, db);
  return res.json({ ok: true, autoExpand: db.policy.autoExpand });
});

app.post('/admin/meta-tune/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const result = metaTune(db, game);
  return res.json(result);
});

app.get('/admin/policy/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  return res.json({ policy: db.policy || {}, metaEvents: db.metaEvents || [] });
});

// exploration endpoint (optional): sampling temperature control
app.post('/admin/explore/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const body = req.body || {};
  db.policy = db.policy || {};
  db.policy.exploration = db.policy.exploration || { enabled: false, temperature: 1.0 };
  if (body.enable !== undefined) db.policy.exploration.enabled = !!body.enable;
  if (body.temperature !== undefined) db.policy.exploration.temperature = Number(body.temperature) || 1.0;
  db.metaEvents = db.metaEvents || [];
  db.metaEvents.push({ at: now(), type: 'explore_set', exploration: db.policy.exploration });
  saveDatabase(game, db);
  return res.json({ ok: true, exploration: db.policy.exploration });
});

// other admin routes left as before
app.get('/admin/patterns/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  return res.json({ lastExtractedAt: db.patterns.lastExtractedAt, patterns: db.patterns.list.slice(0, 200) });
});
app.get('/admin/model/:game', (req, res) => {
  const game = req.params.game; if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game); return res.json({ model: db.model, calibration: db.calibration, weights: db.ensembleWeights, checkpoints: db.checkpoints.slice(-10), biasCorrections: db.biasCorrections || [], metaEvents: db.metaEvents || [] });
});
app.post('/admin/reset-model/:game', (req, res) => {
  const game = req.params.game; const db = loadDatabase(game);
  db.model = { weights: null, bias: 0, iter: 0, version: (db.model.version || 1) + 1, createdAt: now(), bestAcc: db.model.bestAcc || 0 };
  db.calibration = { a: 1.0, b: 0.0, iter: 0 }; db.ensembleWeights = { model: 0.34, pattern: 0.33, markov: 0.33 };
  db.metaEvents = db.metaEvents || []; db.metaEvents.push({ at: now(), type: 'reset_model' });
  saveDatabase(game, db);
  return res.json({ ok: true, msg: 'Model reset' });
});
app.get('/admin/backtest/:game', (req, res) => { const game = req.params.game; const db = loadDatabase(game); const report = backtest(db); return res.json({ ok: true, report }); });
app.get('/admin/metrics/:game', (req, res) => { const game = req.params.game; const db = loadDatabase(game); const tail = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI').slice(-200); const acc = tail.length ? (tail.filter(h => h.trangThai === 'ĐÚNG').length / tail.length) : 0; return res.json({ rollingCount: tail.length, rollingAccuracy: acc, totalEvaluations: db.stats.total, globalAccuracy: db.stats.total ? (db.stats.wins / db.stats.total) : 0, biasCorrections: db.biasCorrections ? db.biasCorrections.length : 0 }); });
app.get('/admin/config', (req, res) => { res.json({ LR_LEARNING_RATE, LR_REGULARIZATION, MARKOV_MAX_ORDER, PATTERN_MAX_LEN, PATTERN_MIN_SUPPORT, PATTERN_TOP_N, PATTERN_DECAY_HALF_LIFE, CALIBRATION_LR, GRAD_CLIP, CONFIDENCE_THRESHOLD, ENTROPY_THRESHOLD, ENSEMBLE_ETA }); });
app.post('/admin/config', (req, res) => { const body = req.body || {}; if (body.LR_LEARNING_RATE !== undefined) LR_LEARNING_RATE = Number(body.LR_LEARNING_RATE); if (body.PATTERN_TOP_N !== undefined) PATTERN_TOP_N = Number(body.PATTERN_TOP_N); if (body.PATTERN_MAX_LEN !== undefined) PATTERN_MAX_LEN = Number(body.PATTERN_MAX_LEN); if (body.CONFIDENCE_THRESHOLD !== undefined) CONFIDENCE_THRESHOLD = Number(body.CONFIDENCE_THRESHOLD); if (body.ENTROPY_THRESHOLD !== undefined) ENTROPY_THRESHOLD = Number(body.ENTROPY_THRESHOLD); return res.json({ ok: true, LR_LEARNING_RATE, PATTERN_TOP_N, PATTERN_MAX_LEN, CONFIDENCE_THRESHOLD, ENTROPY_THRESHOLD }); });

// Simple UI (unchanged)
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Trang không tồn tại.');
  const db = loadDatabase(game);
  const winRate = db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) : '0.00';
  const rows = db.history.slice(-30).reverse();
  const html = `
    <html>
      <head>
        <meta charset="utf-8">
        <title>HOANG VIP ADAPTIVE - ${game.toUpperCase()}</title>
        <style>body{font-family:Arial;background:#071024;color:#e6eef6;padding:18px}.box{background:#0f172a;padding:14px;border-radius:10px;margin-bottom:14px;border:1px solid #1e293b}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #283347;text-align:center}th{background:#0369a1;color:white}</style>
        <script>setTimeout(()=>location.reload(),12000)</script>
      </head>
      <body>
        <h1>HOANG VIP ADAPTIVE - BÀN: ${game.toUpperCase()}</h1>
        <div class="box">Tổng: ${db.stats.total} | Thắng: ${db.stats.wins} | Thua: ${db.stats.losses} | Tỉ lệ: ${winRate}%</div>
        <div class="box">
          <table>
            <tr><th>Phiên</th><th>Dự đoán</th><th>Tỉ lệ</th><th>Mẫu</th><th>KQ</th><th>Trạng thái</th></tr>
            ${rows.map(it => `<tr><td>${it.phienDuDoan}</td><td><b>${it.DU_DOAN || ''}</b></td><td>${it.TI_LE}</td><td><small>${(it.mauCau||'')}</small></td><td>${it.ketQua||''}</td><td>${it.trangThai}</td></tr>`).join('')}
          </table>
        </div>
      </body>
    </html>
  `;
  res.send(html);
});

// ---------------- Start services ----------------
const server = app.listen(PORT, () => {
  console.log(`HOANG VIP ADAPTIVE (advanced) running on port ${PORT}`);
  startPolling();
  startScheduler();
});

process.on('SIGINT', () => {
  if (schedulerHandle) clearInterval(schedulerHandle);
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  if (schedulerHandle) clearInterval(schedulerHandle);
  server.close(() => process.exit(0));
});
