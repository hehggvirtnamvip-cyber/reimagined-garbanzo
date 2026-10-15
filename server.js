/**
 * HOANG VIP WIN - Adaptive VIP++ single-file
 * - Upgraded: Markov, Entropy, Calibration, LR scheduler, gradient clipping, checkpointing, anomaly detection
 * - Endpoints: /api/predict/:game, /api/analyze/:game, /api/export/:game,
 *              /admin/patterns/:game, /admin/model/:game, /admin/reset-model/:game,
 *              /admin/backtest/:game, /admin/config (GET/POST), /health, UI /:game
 *
 * Quick start:
 * 1) Save as server.js
 * 2) npm init -y
 * 3) npm i express axios
 * 4) node server.js
 *
 * Environment variables (same as previous + new):
 * - CALIBRATION_LR (default 0.02)
 * - GRAD_CLIP (default 5.0)
 * - MARKOV_MAX_ORDER (default 3)
 * - CHECKPOINT_WINDOW (default 100)
 */
'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();

// ---------------- Config ----------------
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 300);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 8000);
const APIS = {
  md5: process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: process.env.API_TAIXIU || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};
const DB_DIR = process.env.DB_DIR || __dirname;
const DB_FILES = { md5: path.join(DB_DIR, 'db_md5.json'), taixiu: path.join(DB_DIR, 'db_taixiu.json') };
const BACKUP_FILES = { md5: path.join(DB_DIR, 'backup_db_md5.json'), taixiu: path.join(DB_DIR, 'backup_db_taixiu.json') };

let LR_LEARNING_RATE = Number(process.env.LR_LEARNING_RATE || 0.12);
const LR_REGULARIZATION = Number(process.env.LR_REGULARIZATION || 1e-4);
const PATTERN_MIN_SUPPORT = Number(process.env.PATTERN_MIN_SUPPORT || 2);
const PATTERN_MAX_LEN = Number(process.env.PATTERN_MAX_LEN || 10);
const PATTERN_TOP_N = Number(process.env.PATTERN_TOP_N || 24);
const PATTERN_DECAY_HALF_LIFE = Number(process.env.PATTERN_DECAY_HALF_LIFE || 200);
const CALIBRATION_LR = Number(process.env.CALIBRATION_LR || 0.02);
const GRAD_CLIP = Number(process.env.GRAD_CLIP || 5.0);
const MARKOV_MAX_ORDER = Number(process.env.MARKOV_MAX_ORDER || 3);
const CHECKPOINT_WINDOW = Number(process.env.CHECKPOINT_WINDOW || 100);

// ---------------- Utilities ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`[WARN] safeReadJson failed for ${filePath}:`, e && e.message);
    return fallback;
  }
}
function safeAtomicWrite(filePath, data) {
  try {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.error(`[ERR] safeAtomicWrite failed for ${filePath}:`, e && e.message);
  }
}

// per-game write lock
const writeLocks = { md5: false, taixiu: false };

// ---------------- Persistence ----------------
function defaultDB() {
  return {
    history: [],
    stats: { total: 0, wins: 0, losses: 0, currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0 },
    timeStats: { Sang: { total: 0, wins: 0 }, Chieu: { total: 0, wins: 0 }, Toi: { total: 0, wins: 0 }, Dem: { total: 0, wins: 0 } },
    lastProcessedSession: null,
    model: { weights: null, bias: 0, version: 1, createdAt: new Date().toISOString(), iter: 0 },
    calibration: { a: 1.0, b: 0.0, iter: 0 }, // calibrator: sigmoid(a * logit + b)
    patterns: { lastExtractedAt: null, patterns: [] },
    checkpoints: [] // snapshots {at, version, accuracy}
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
  if (writeLocks[game]) {
    console.warn(`[WARN] concurrent save attempt for ${game} - skipped`);
    return;
  }
  writeLocks[game] = true;
  try {
    safeAtomicWrite(DB_FILES[game], db);
    safeAtomicWrite(BACKUP_FILES[game], db);
  } finally {
    writeLocks[game] = false;
  }
}

// ---------------- Helpers ----------------
function getCurrentTimeSlot(date = new Date()) {
  const h = date.getHours();
  if (h >= 6 && h < 12) return 'Sang';
  if (h >= 12 && h < 18) return 'Chieu';
  if (h >= 18 && h < 24) return 'Toi';
  return 'Dem';
}
function resultFromItem(item) {
  if (item.BetSide !== undefined) return Number(item.BetSide) === 1 ? 'T' : 'X';
  const sum = item.DiceSum !== undefined ? Number(item.DiceSum) : ((Number(item.FirstDice) || 0) + (Number(item.SecondDice) || 0) + (Number(item.ThirdDice) || 0));
  return sum >= 11 ? 'T' : 'X';
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function entropyFromProbs(p) { // p: [pT,pX]
  const eps = 1e-12;
  const H = - (p[0] * Math.log(p[0] + eps) + p[1] * Math.log(p[1] + eps));
  return H;
}

// ---------------- Pattern Miner (same as before) ----------------
function extractPatternsWithStats(sequence, minSupport = PATTERN_MIN_SUPPORT, maxLen = PATTERN_MAX_LEN, topN = PATTERN_TOP_N) {
  const n = sequence.length;
  if (n < 2) return [];
  const freq = Object.create(null);
  for (let len = 1; len <= Math.min(maxLen, n - 1); len++) {
    for (let i = 0; i + len < n; i++) {
      const pat = sequence.slice(i, i + len).join('');
      const next = sequence[i + len];
      let meta = freq[pat];
      if (!meta) meta = { count: 0, nextCounts: { T: 0, X: 0 }, lastIndex: -1, indices: [] };
      meta.count++;
      meta.nextCounts[next] = (meta.nextCounts[next] || 0) + 1;
      meta.lastIndex = i;
      if (meta.indices.length < 50) meta.indices.push(i);
      freq[pat] = meta;
    }
  }
  const baseT = sequence.filter(s => s === 'T').length / (n || 1);
  const baseX = 1 - baseT;
  const patterns = [];
  for (const pat in freq) {
    const m = freq[pat];
    if (m.count < minSupport) continue;
    const pT = (m.nextCounts.T + 1) / (m.count + 2);
    const pX = (m.nextCounts.X + 1) / (m.count + 2);
    const oddsT = Math.log((pT + 1e-9) / (baseT + 1e-9));
    const oddsX = Math.log((pX + 1e-9) / (baseX + 1e-9));
    const divergence = Math.max(Math.abs(oddsT), Math.abs(oddsX));
    const strength = divergence * Math.log(1 + m.count);
    const recencyBoost = 1 + (m.lastIndex / Math.max(1, n - 1));
    const rawScore = strength * recencyBoost;
    patterns.push({
      pattern: pat,
      count: m.count,
      pT: Number(pT.toFixed(4)),
      pX: Number(pX.toFixed(4)),
      oddsT: Number(oddsT.toFixed(4)),
      oddsX: Number(oddsX.toFixed(4)),
      lastIndex: m.lastIndex,
      indicesSample: m.indices.slice(-8),
      rawScore
    });
  }
  patterns.sort((a, b) => b.rawScore - a.rawScore);
  return patterns.slice(0, topN);
}
function mergeAndDecayPatterns(db, newPatterns, sequenceLength) {
  const existing = (db.patterns && db.patterns.patterns) ? db.patterns.patterns : [];
  const map = Object.create(null);
  const halfLife = PATTERN_DECAY_HALF_LIFE;
  for (const p of existing) {
    const age = Math.max(0, (sequenceLength - (p.lastIndex || 0)));
    const decayFactor = Math.pow(0.5, age / Math.max(1, halfLife));
    map[p.pattern] = {
      pattern: p.pattern,
      score: (p.score || p.rawScore || 0) * decayFactor,
      count: p.count || 0,
      lastIndex: p.lastIndex || -1,
      pT: p.pT || 0,
      pX: p.pX || 0
    };
  }
  for (const np of newPatterns) {
    const ex = map[np.pattern];
    if (ex) {
      ex.score = (ex.score || 0) + np.rawScore;
      ex.count = (ex.count || 0) + np.count;
      ex.lastIndex = Math.max(ex.lastIndex || -1, np.lastIndex || -1);
      ex.pT = np.pT; ex.pX = np.pX;
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
  return merged.slice(0, Math.max(PATTERN_TOP_N * 2, 64));
}

// ---------------- Markov Predictor ----------------
function buildMarkovModel(sequence, maxOrder = MARKOV_MAX_ORDER) {
  const n = sequence.length;
  const models = {};
  for (let order = 1; order <= maxOrder; order++) {
    const freq = Object.create(null); // ctx -> {T:count,X:count}
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
function markovPredictFromModels(models, sequence) {
  const maxOrder = Object.keys(models).length;
  for (let order = Math.min(maxOrder, sequence.length - 1); order >= 1; order--) {
    const ctx = sequence.slice(-order).join('');
    const freq = models[order][ctx];
    if (freq) {
      const pT = (freq.T + 1) / (freq.T + freq.X + 2);
      const pX = (freq.X + 1) / (freq.T + freq.X + 2);
      return { T: pT, X: pX, orderUsed: order, seen: freq.T + freq.X };
    }
  }
  return { T: 0.5, X: 0.5, orderUsed: 0, seen: 0 };
}

// ---------------- Feature engineering ----------------
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
  const alpha = 0.22;
  let s = 0;
  for (let i = 0; i < sequence.length; i++) {
    const v = sequence[i] === 'T' ? 1 : -1;
    s = alpha * v + (1 - alpha) * s;
  }
  f.push(s);
  const last = sequence[sequence.length - 1];
  let streak = 1;
  for (let i = sequence.length - 2; i >= 0; i--) {
    if (sequence[i] === last) streak++; else break;
  }
  f.push(Math.tanh(streak / 6));
  f.push(ngramContextDiff(sequence, 1));
  f.push(ngramContextDiff(sequence, 2));
  f.push(ngramContextDiff(sequence, 3));
  const slot = getCurrentTimeSlot();
  f.push(slot === 'Sang' ? 1 : 0);
  f.push(slot === 'Chieu' ? 1 : 0);
  f.push(slot === 'Toi' ? 1 : 0);
  f.push(slot === 'Dem' ? 1 : 0);
  return f;
}
function buildPatternFeatures(sequence, patterns, topN = PATTERN_TOP_N) {
  const tail = sequence.join('');
  const scores = [];
  for (let i = 0; i < topN; i++) {
    const p = patterns[i];
    if (!p) { scores.push(0); continue; }
    const pat = p.pattern;
    let occ = 0;
    let idx = tail.indexOf(pat, 0);
    while (idx !== -1) {
      occ++; idx = tail.indexOf(pat, idx + 1);
    }
    const endsWith = tail.endsWith(pat) ? 1 : 0;
    const sign = (p.pT >= p.pX) ? 1 : -1;
    const matchScore = sign * Math.abs(p.pT - p.pX) * Math.log(1 + occ) + endsWith * 0.6 * sign;
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

// ---------------- Online logistic regression (with scheduler & clipping) ----------------
function initModelIfNeeded(db, dim) {
  db.model = db.model || {};
  if (!db.model.weights || db.model.weights.length !== dim) {
    db.model.weights = Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.02);
    db.model.bias = db.model.bias || 0;
    db.model.iter = db.model.iter || 0;
    db.model.version = (db.model.version || 1);
    db.model.createdAt = db.model.createdAt || new Date().toISOString();
  }
}
function predictLogit(db, x) {
  initModelIfNeeded(db, x.length);
  let z = db.model.bias || 0;
  for (let i = 0; i < x.length; i++) z += (db.model.weights[i] || 0) * x[i];
  return z;
}
function predictProb(db, x) {
  const z = predictLogit(db, x);
  return { p: sigmoid(z), logit: z };
}
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
function sgdUpdate(db, x, labelT) {
  initModelIfNeeded(db, x.length);
  const z = predictLogit(db, x);
  const pred = sigmoid(z);
  const err = labelT - pred;
  db.model.iter = (db.model.iter || 0) + 1;
  const adapt = 1 / Math.sqrt(1 + db.model.iter / 1000);
  const lr = LR_LEARNING_RATE * adapt;
  // compute gradients
  const gradW = Array(x.length);
  for (let i = 0; i < x.length; i++) gradW[i] = -err * x[i] + LR_REGULARIZATION * (db.model.weights[i] || 0) * 0; // note sign flipped because we will subtract lr*grad
  // actually standard update: w += lr * (err * x - reg * w)
  // prepare for clipping by using delta = err * x - reg * w
  for (let i = 0; i < x.length; i++) gradW[i] = (err * x[i] - LR_REGULARIZATION * (db.model.weights[i] || 0));
  // clip
  clipGradients(gradW, GRAD_CLIP);
  // update
  for (let i = 0; i < x.length; i++) db.model.weights[i] += lr * gradW[i];
  db.model.bias += lr * err;
  // return stats
  const loss = -(labelT * Math.log(pred + 1e-12) + (1 - labelT) * Math.log(1 - pred + 1e-12));
  return { pred, err, loss, lr, iter: db.model.iter };
}

// ---------------- Calibration (Platt-style online) ----------------
function calibrateProb(db, logit) {
  // calibrated = sigmoid(a * logit + b)
  const a = db.calibration.a || 1.0;
  const b = db.calibration.b || 0.0;
  return sigmoid(a * logit + b);
}
function calibrationUpdate(db, logit, labelT) {
  // gradient descent on cross-entropy w.r.t a,b
  db.calibration = db.calibration || { a: 1.0, b: 0.0, iter: 0 };
  const a = db.calibration.a; const b = db.calibration.b;
  const pred = sigmoid(a * logit + b);
  const err = labelT - pred;
  db.calibration.iter = (db.calibration.iter || 0) + 1;
  const adapt = 1 / Math.sqrt(1 + db.calibration.iter / 500);
  const lr = CALIBRATION_LR * adapt;
  // grads: dL/da = -err * logit ; dL/db = -err
  let gradA = -err * logit;
  let gradB = -err;
  // clip grads modestly
  const maxg = 10;
  if (gradA > maxg) gradA = maxg; if (gradA < -maxg) gradA = -maxg;
  if (gradB > maxg) gradB = maxg; if (gradB < -maxg) gradB = -maxg;
  db.calibration.a = a - lr * gradA;
  db.calibration.b = b - lr * gradB;
  return { pred, err, a: db.calibration.a, b: db.calibration.b };
}

// ---------------- Ensemble & finalPredict (now with Markov & entropy) ----------------
function computePatternSignal(mergedPatterns) {
  const top = mergedPatterns.slice(0, 6);
  let acc = 0;
  for (const p of top) {
    const sign = (p.pT >= p.pX) ? 1 : -1;
    acc += sign * Math.abs(p.pT - p.pX) * Math.log(1 + (p.count || 0));
  }
  return sigmoid(acc);
}
function finalPredict(db, sequence) {
  const extracted = extractPatternsWithStats(sequence, PATTERN_MIN_SUPPORT, PATTERN_MAX_LEN, PATTERN_TOP_N);
  const merged = mergeAndDecayPatterns(db, extracted, sequence.length);
  db.patterns.patterns = merged;
  db.patterns.lastExtractedAt = new Date().toISOString();

  const fvInfo = buildFeatureVector(sequence, merged);
  const x = fvInfo.vector;

  // model prob + logit
  const logit = predictLogit(db, x);
  const pT_model = sigmoid(logit);

  // markov
  const models = buildMarkovModel(sequence, MARKOV_MAX_ORDER);
  const mk = markovPredictFromModels(models, sequence);
  const pT_markov = mk.T;

  // pattern
  const pT_pattern = computePatternSignal(merged);

  // combine; include markov as extra signal
  const alphaModel = 0.6, alphaPattern = 0.25, alphaMarkov = 0.15;
  const pT_raw = Math.max(1e-9, Math.min(1 - 1e-9, alphaModel * pT_model + alphaPattern * pT_pattern + alphaMarkov * pT_markov));
  // calibration
  const calibrated = calibrateProb(db, logit);
  // combine calibrated and raw adaptively
  const finalP = 0.7 * calibrated + 0.3 * pT_raw;
  const finalLogit = Math.log(finalP / (1 - finalP));
  const prediction = finalP >= 0.5 ? 'T' : 'X';
  const confidence = (Math.max(finalP, 1 - finalP) * 100).toFixed(1) + '%';
  const entropy = entropyFromProbs([finalP, 1 - finalP]);

  return {
    prediction, confidence, probs: { T: finalP.toFixed(4), X: (1 - finalP).toFixed(4) },
    meta: {
      modelProb: pT_model,
      calibratedProb: calibrated,
      patternProb: pT_pattern,
      markovProb: pT_markov,
      fvMeta: fvInfo.meta,
      logit,
      entropy,
      markovUsed: mk
    }
  };
}

// ---------------- Anomaly detection for API payload ----------------
function isAnomalousApiPayload(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return true;
  // simple heuristics: sessions monotonic increasing? Contains expected fields?
  // Check majority have SessionId or session
  let countHasSession = 0;
  for (let i = 0; i < Math.min(arr.length, 30); i++) {
    const it = arr[i];
    if (it && (it.SessionId || it.session || it.Phien || it.phien)) countHasSession++;
  }
  if (countHasSession < Math.max(1, Math.min(arr.length, 5))) return true;
  return false;
}

// ---------------- Fetch with retry ----------------
async function fetchWithRetry(url, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await axios.get(url, { timeout: API_TIMEOUT_MS });
      return r;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 200 + i * 150));
    }
  }
}

// ---------------- Checkpointing ----------------
function maybeCheckpointModel(db, game) {
  // compute simple moving average accuracy over last CHECKPOINT_WINDOW evaluations
  const hist = db.history.filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
  const tail = hist.slice(-CHECKPOINT_WINDOW);
  if (tail.length < Math.max(10, Math.floor(CHECKPOINT_WINDOW / 4))) return; // not enough data
  const correct = tail.filter(t => t.trangThai === 'ĐÚNG').length;
  const acc = correct / tail.length;
  const lastCheckpoint = db.checkpoints[db.checkpoints.length - 1];
  const prevAcc = lastCheckpoint ? lastCheckpoint.accuracy : 0;
  if (acc > prevAcc + 0.01) { // improve by at least 1%
    const snap = {
      at: new Date().toISOString(),
      version: (db.model.version || 1) + 1,
      accuracy: acc,
      model: { weights: db.model.weights, bias: db.model.bias }
    };
    db.checkpoints.push(snap);
    // bump model version
    db.model.version = snap.version;
    db.model.bestAccuracy = acc;
    // persist snapshot file
    const snapFile = path.join(DB_DIR, `model_snapshot_${game}_v${snap.version}.json`);
    try { safeAtomicWrite(snapFile, snap); } catch (e) { /* ignore */ }
  }
}

// ---------------- Backtest (simulate online learning on stored history) ----------------
function backtestOnHistory(db) {
  // clone model
  const modelClone = { weights: db.model.weights ? db.model.weights.slice() : null, bias: db.model.bias || 0, iter: 0 };
  const cloneDB = { model: modelClone, calibration: { a: 1, b: 0, iter: 0 } };
  let correct = 0, total = 0;
  for (const rec of db.history) {
    if (!rec.meta || !Array.isArray(rec.meta.featureVector)) continue;
    const fv = rec.meta.featureVector;
    // predict before update
    initModelIfNeeded(cloneDB, fv.length);
    const z = predictLogit(cloneDB, fv);
    const p = sigmoid(z);
    const pred = p >= 0.5 ? 'T' : 'X';
    if (rec.ketQua && (rec.ketQua === pred)) correct++;
    total++;
    // update model with actual if present
    if (rec.ketQua) {
      const label = rec.ketQua === 'T' ? 1 : 0;
      // update clone model using same sgdUpdate but adapt signatures
      // local sgd using same LR and reg
      cloneDB.model.iter = (cloneDB.model.iter || 0) + 1;
      const adapt = 1 / Math.sqrt(1 + cloneDB.model.iter / 1000);
      const lr = LR_LEARNING_RATE * adapt;
      initModelIfNeeded(cloneDB, fv.length);
      const predBefore = sigmoid(p);
      const err = label - predBefore;
      for (let i = 0; i < fv.length; i++) {
        // update
        cloneDB.model.weights[i] += lr * (err * fv[i] - LR_REGULARIZATION * (cloneDB.model.weights[i] || 0));
      }
      cloneDB.model.bias += lr * err;
      // update calibration too
      const calib = cloneDB.calibration;
      const predCal = sigmoid(calib.a * z + calib.b);
      const errCal = label - predCal;
      const lrCal = CALIBRATION_LR * (1 / Math.sqrt(1 + (calib.iter || 0) / 500));
      calib.a = calib.a - lrCal * (-errCal * z);
      calib.b = calib.b - lrCal * (-errCal);
      calib.iter = (calib.iter || 0) + 1;
    }
  }
  return { accuracy: total ? (correct / total) : 0, total, correct };
}

// ---------------- Main tick ----------------
async function processGameTick(game) {
  try {
    const api = APIS[game];
    if (!api) return;
    const resp = await fetchWithRetry(api, 2);
    const historyList = Array.isArray(resp.data) ? resp.data : (resp.data && (resp.data.data || resp.data.list) ? (resp.data.data || resp.data.list) : []);
    if (!Array.isArray(historyList) || historyList.length === 0) return;

    // anomaly guard
    if (isAnomalousApiPayload(historyList)) {
      console.warn(`[WARN] anomalous API payload for ${game}, skipping this tick.`);
      return;
    }

    const latest = historyList[historyList.length - 1];
    const currentSession = Number(latest.SessionId || latest.session || 0);
    if (!currentSession) return;

    const db = loadDatabase(game);
    if (db.lastProcessedSession === currentSession) return;

    const seq = historyList.slice(-MAX_HISTORY).map(resultFromItem);
    const analysis = finalPredict(db, seq);

    // evaluate last recorded
    const lastRecorded = db.history[db.history.length - 1];
    if (lastRecorded && Number(lastRecorded.phienDuDoan) === currentSession) {
      const actual = resultFromItem(latest);
      const wasCorrect = (lastRecorded.DU_DOAN === actual);
      lastRecorded.ketQua = actual;
      lastRecorded.trangThai = wasCorrect ? 'ĐÚNG' : 'SAI';
      // stats
      db.stats.total++;
      const slot = getCurrentTimeSlot();
      db.timeStats[slot] = db.timeStats[slot] || { total: 0, wins: 0 };
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
      // update model online using stored vector
      try {
        const storedFV = lastRecorded.meta && lastRecorded.meta.featureVector;
        if (Array.isArray(storedFV)) {
          const labelT = actual === 'T' ? 1 : 0;
          const up = sgdUpdate(db, storedFV, labelT);
          lastRecorded.meta.modelUpdate = { predProbBefore: up.pred, err: up.err, loss: up.loss, lr: up.lr, at: new Date().toISOString() };
          // calibration update using stored logit
          const storedLogit = lastRecorded.meta && lastRecorded.meta.logit;
          if (storedLogit !== undefined) calibrationUpdate(db, storedLogit, labelT);
        }
      } catch (e) {
        console.warn('[WARN] model update failed', e && e.message);
      }
    }

    // push new prediction entry
    const newEntry = {
      phien: currentSession,
      phienDuDoan: currentSession + 1,
      xucXac: [Number(latest.FirstDice || 0), Number(latest.SecondDice || 0), Number(latest.ThirdDice || 0)],
      ketQua: resultFromItem(latest),
      DU_DOAN: analysis.prediction,
      TI_LE: analysis.confidence,
      mauCau: (analysis.meta && analysis.meta.fvMeta && analysis.meta.fvMeta.topPatterns) ? analysis.meta.fvMeta.topPatterns.map(p => p.pattern).slice(0, 6).join('; ') : 'Auto',
      trangThai: 'ĐANG CHỜ',
      meta: {
        probs: analysis.probs,
        modelProb: analysis.meta.modelProb,
        calibratedProb: analysis.meta.calibratedProb || null,
        patternProb: analysis.meta.patternProb,
        markovProb: analysis.meta.markovProb,
        fvMeta: analysis.meta.fvMeta,
        featureVector: analysis.meta.featureVector,
        logit: analysis.meta.logit,
        entropy: analysis.meta.entropy,
        createdAt: new Date().toISOString()
      }
    };

    db.history.push(newEntry);
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);
    db.lastProcessedSession = currentSession;
    // checkpoint
    maybeCheckpointModel(db, game);
    saveDatabase(game, db);
  } catch (e) {
    console.error(`[ERR] processGameTick ${game}:`, e && e.message ? e.message : e);
  }
}

// ---------------- Polling ----------------
function startPolling() {
  async function tick() {
    await Promise.all(Object.keys(APIS).map(async g => {
      try { await processGameTick(g); } catch (_) { /* errors logged inside */ }
    }));
    const jitter = Math.floor(Math.random() * 1000);
    setTimeout(tick, POLL_INTERVAL_MS + jitter);
  }
  tick();
}

// ---------------- API Routes ----------------
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });
  try {
    const r = await fetchWithRetry(APIS[game]);
    const historyList = Array.isArray(r.data) ? r.data : (r.data && (r.data.data || r.data.list) ? (r.data.data || r.data.list) : []);
    if (!historyList || historyList.length === 0) return res.status(204).send();
    const seq = historyList.slice(-MAX_HISTORY).map(resultFromItem);
    const db = loadDatabase(game);
    const analysis = finalPredict(db, seq);
    saveDatabase(game, db); // persist patterns merge
    return res.json(analysis);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Fetch error' });
  }
});

app.get('/api/analyze/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });
  const db = loadDatabase(game);
  const latest = db.history[db.history.length - 1] || {};
  const winRate = db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) + '%' : '0%';
  return res.json({
    banChoi: game.toUpperCase(),
    heThong: 'HOANG VIP ADAPTIVE++',
    latest,
    thongKe: { ...db.stats, tiLeThang: winRate },
    model: { weightsCount: db.model && db.model.weights ? db.model.weights.length : 0, bias: db.model && db.model.bias, version: db.model.version },
    calibration: db.calibration,
    patternsSummary: db.patterns && db.patterns.patterns ? db.patterns.patterns.slice(0, PATTERN_TOP_N) : []
  });
});

app.get('/api/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Bàn chơi không hợp lệ.');
  const db = loadDatabase(game);
  let csv = 'Phiên,PhiênDựĐoán,DựĐoán,TỉLệ,MẫuCầu,KếtQuả,TrạngThái\n';
  for (const it of db.history) {
    csv += `${it.phien},${it.phienDuDoan},${it.DU_DOAN},${it.TI_LE},"${(it.mauCau || '').replace(/"/g, "'")}",${it.ketQua || ''},${it.trangThai}\n`;
  }
  res.header('Content-Type', 'text/csv');
  res.attachment(`lich_su_du_doan_${game}.csv`);
  return res.send(csv);
});

app.get('/admin/patterns/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });
  const db = loadDatabase(game);
  return res.json({ lastExtractedAt: db.patterns.lastExtractedAt, patterns: db.patterns.patterns.slice(0, 200) });
});

app.get('/admin/model/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });
  const db = loadDatabase(game);
  return res.json({ model: { weightsCount: db.model.weights ? db.model.weights.length : 0, bias: db.model.bias, version: db.model.version, iter: db.model.iter, createdAt: db.model.createdAt }, calibration: db.calibration, checkpoints: db.checkpoints.slice(-10) });
});

app.post('/admin/reset-model/:game', (req, res) => {
  const game = req.params.game;
  const db = loadDatabase(game);
  // reset model and calibration
  db.model = { weights: null, bias: 0, version: (db.model.version || 1) + 1, createdAt: new Date().toISOString(), iter: 0 };
  db.calibration = { a: 1.0, b: 0.0, iter: 0 };
  saveDatabase(game, db);
  return res.json({ ok: true, msg: 'Model reset' });
});

app.get('/admin/backtest/:game', (req, res) => {
  const game = req.params.game;
  const db = loadDatabase(game);
  const report = backtestOnHistory(db);
  return res.json({ report });
});

app.get('/admin/config', (req, res) => {
  return res.json({
    LR_LEARNING_RATE,
    LR_REGULARIZATION,
    PATTERN_MIN_SUPPORT,
    PATTERN_MAX_LEN,
    PATTERN_TOP_N,
    PATTERN_DECAY_HALF_LIFE,
    CALIBRATION_LR,
    GRAD_CLIP,
    MARKOV_MAX_ORDER,
    CHECKPOINT_WINDOW
  });
});

app.post('/admin/config', (req, res) => {
  const body = req.body || {};
  if (body.LR_LEARNING_RATE !== undefined) LR_LEARNING_RATE = Number(body.LR_LEARNING_RATE);
  // other params could be made mutable – do with caution
  return res.json({ ok: true, LR_LEARNING_RATE });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', pid: process.pid, platform: os.platform(), uptime: process.uptime() });
});

// UI (same as before with minor additions)
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Trang không tồn tại.');
  const db = loadDatabase(game);
  const winRate = db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) : 0;
  const entries = db.history.slice(-30).reverse();
  res.send(`
    <html><head><meta charset="utf-8"><title>HOANG VIP ADAPTIVE++ - ${game.toUpperCase()}</title>
    <style>body{font-family:Arial;background:#071024;color:#e6eef6;padding:18px} .box{background:#0f172a;padding:14px;border-radius:10px;margin-bottom:14px;border:1px solid #1e293b} table{width:100%;border-collapse:collapse} th,td{padding:8px;border:1px solid #283347;text-align:center} th{background:#0369a1;color:white}</style>
    <script>setTimeout(()=>{location.reload()}, 12000)</script>
    </head><body>
    <h1>HOANG VIP ADAPTIVE++ - BÀN: ${game.toUpperCase()}</h1>
    <div style="margin-bottom:12px">
      <a href="/api/predict/${game}" style="padding:8px 12px;background:#0284c7;color:white;border-radius:6px;text-decoration:none">Live Predict API</a>
      <a href="/api/analyze/${game}" style="padding:8px 12px;background:#10b981;color:white;border-radius:6px;text-decoration:none">Analyze API</a>
      <a href="/admin/patterns/${game}" style="padding:8px 12px;background:#7c3aed;color:white;border-radius:6px;text-decoration:none">Patterns</a>
      <a href="/admin/model/${game}" style="padding:8px 12px;background:#ef4444;color:white;border-radius:6px;text-decoration:none">Model</a>
    </div>
    <div class="box"><h3>📊 Tổng quan</h3><p>Tổng: <b>${db.stats.total}</b> | Thắng: <b style="color:#4ade80">${db.stats.wins}</b> | Thua: <b style="color:#fb7185">${db.stats.losses}</b> | Tỉ lệ: <b>${winRate}%</b></p></div>
    <div class="box"><h3>📜 Nhật ký</h3>
      <table><tr><th>Phiên</th><th>Dự đoán</th><th>Tỉ lệ</th><th>Mẫu</th><th>KQ</th><th>Trạng thái</th><th>Entropy</th></tr>
      ${entries.map(it => `<tr><td>${it.phienDuDoan}</td><td>${it.DU_DOAN}</td><td>${it.TI_LE}</td><td><small>${(it.mauCau||'')}</small></td><td>${it.ketQua||''}</td><td>${it.trangThai}</td><td>${it.meta && it.meta.entropy ? Number(it.meta.entropy).toFixed(3) : ''}</td></tr>`).join('')}
      </table>
    </div>
    </body></html>
  `);
});

// ---------------- Start ----------------
const server = app.listen(PORT, () => {
  console.log(`HOANG VIP ADAPTIVE++ running on port ${PORT}`);
  startPolling();
});

// graceful shutdown
function shutdown() {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('HTTP closed'); process.exit(0);
  });
  setTimeout(() => { console.error('Force exit'); process.exit(1); }, 8000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
