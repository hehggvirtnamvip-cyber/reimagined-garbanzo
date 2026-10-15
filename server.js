/**
 * server.js — FULL FIX (robust parsing, force-tick, redirects, APIs)
 *
 * Usage:
 *  npm i express axios
 *  node server.js
 *
 * Endpoints:
 *  GET  /md5 -> redirect to /api/simple/md5
 *  GET  /taixiu -> redirect to /api/simple/taixiu
 *  GET  /api/simple/:game  -> { phien, tong, ketQua, phienDuDoan, duDoan, tiLe }
 *  GET  /api/predict/:game -> detailed prediction & meta (computes on-demand)
 *  GET  /api/history/:game -> JSON history
 *  POST /admin/force-tick/:game -> force one tick now
 *  POST /admin/reset-model/:game -> reset model
 *  POST /admin/config/:game -> quick config
 *  GET  /admin/db/:game -> db summary
 *
 * The file is single-file, persistent via JSON in same dir.
 */

'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Config ----------
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 600);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 8000);

const APIS = {
  md5: process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: process.env.API_TAIXIU || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

const DB_DIR = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_FILES = { md5: path.join(DB_DIR, 'db_md5.json'), taixiu: path.join(DB_DIR, 'db_taixiu.json') };
const BACKUP_FILES = { md5: path.join(DB_DIR, 'backup_db_md5.json'), taixiu: path.join(DB_DIR, 'backup_db_taixiu.json') };

// thresholds tuned to be permissive by default
let CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.55);
let ENTROPY_THRESHOLD = Number(process.env.ENTROPY_THRESHOLD || 0.95);

// learning defaults (conservative)
let LR_LEARNING_RATE = Number(process.env.LR_LEARNING_RATE || 0.11);
const LR_REGULARIZATION = Number(process.env.LR_REGULARIZATION || 1e-4);
let ENSEMBLE_ETA = Number(process.env.ENSEMBLE_ETA || 0.08);

const MARKOV_MAX_ORDER = Number(process.env.MARKOV_MAX_ORDER || 3);
const PATTERN_TOP_N = Number(process.env.PATTERN_TOP_N || 30);
const PATTERN_MIN_SUPPORT = Number(process.env.PATTERN_MIN_SUPPORT || 2);
const PATTERN_MAX_LEN = Number(process.env.PATTERN_MAX_LEN || 10);

const CALIBRATION_LR = Number(process.env.CALIBRATION_LR || 0.02);
const GRAD_CLIP = Number(process.env.GRAD_CLIP || 5.0);

// ---------- Helpers ----------
function now() { return new Date().toISOString(); }
function safeReadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('safeReadJson error', file, e && e.message);
    return fallback;
  }
}
function safeWriteJson(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('safeWriteJson error', file, e && e.message);
  }
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function entropyFromProb(p) {
  const eps = 1e-12;
  return -(p * Math.log(p + eps) + (1 - p) * Math.log(1 - p + eps));
}
function clamp(x, a = 1e-6, b = 1 - 1e-6) { return Math.min(Math.max(x, a), b); }
function labelFromCode(c) { if (c === 'T') return 'Tài'; if (c === 'X') return 'Xỉu'; return c; }

// ---------- DB ----------
function defaultDB() {
  return {
    history: [],
    stats: { total: 0, wins: 0, losses: 0 },
    lastProcessedSession: null,
    model: { weights: null, bias: 0, iter: 0, version: 1 },
    calibration: { a: 1.0, b: 0.0, iter: 0 },
    patterns: { list: [], lastExtractedAt: null },
    ensembleWeights: { model: 0.34, pattern: 0.33, markov: 0.33 },
    metaEvents: []
  };
}
function loadDB(game) {
  const file = DB_FILES[game];
  const backup = BACKUP_FILES[game];
  const x = safeReadJson(file);
  if (x) return x;
  const b = safeReadJson(backup);
  if (b) return b;
  const d = defaultDB();
  safeWriteJson(file, d);
  return d;
}
function saveDB(game, db) {
  safeWriteJson(DB_FILES[game], db);
  safeWriteJson(BACKUP_FILES[game], db);
}

// ---------- Robust parsing of upstream ----------
function parseUpstreamData(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return [raw];

  if (typeof raw === 'string') {
    const s = raw.trim();
    // try parse as JSON array/object
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j;
      if (typeof j === 'object') return [j];
    } catch (e) {
      // fallback: extract {...} occurrences
      const objs = [];
      const re = /{[^}]*}/g;
      let m;
      while ((m = re.exec(s)) !== null) {
        try {
          const parsed = JSON.parse(m[0]);
          objs.push(parsed);
        } catch (err) {
          // skip
        }
      }
      if (objs.length) return objs;

      // final fallback: split by lines and parse each
      const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const p = JSON.parse(line);
          if (p) objs.push(p);
        } catch (_) {
          const t = line.replace(/,$/, '');
          try {
            const p2 = JSON.parse(t);
            if (p2) objs.push(p2);
          } catch (_) {}
        }
      }
      if (objs.length) return objs;
    }
  }
  return [];
}

// ---------- Minimal feature/model ----------
function itemToResult(item) {
  if (!item) return null;
  if (item.BetSide !== undefined) return Number(item.BetSide) === 1 ? 'T' : 'X';
  const first = Number(item.FirstDice || item.First || item.first || 0);
  const second = Number(item.SecondDice || item.Second || item.second || 0);
  const third = Number(item.ThirdDice || item.Third || item.third || 0);
  const providedSum = (item.DiceSum !== undefined) ? Number(item.DiceSum) : null;
  const sum = providedSum !== null ? providedSum : (first + second + third);
  return sum >= 11 ? 'T' : 'X';
}

function buildSimpleFV(sequence) {
  const f = [];
  f.push(1.0);
  const n = sequence.length;
  f.push(n >= 1 ? (sequence[n - 1] === 'T' ? 1 : 0) : 0);
  f.push(n >= 2 ? (sequence[n - 2] === 'T' ? 1 : 0) : 0);
  let ewma = 0;
  const alpha = 0.2;
  const tail = sequence.slice(-20);
  for (const s of tail) {
    ewma = alpha * (s === 'T' ? 1 : 0) + (1 - alpha) * ewma;
  }
  f.push(ewma);
  return f;
}

function initModelIfNeeded(db, dim) {
  db.model = db.model || {};
  if (!db.model.weights || db.model.weights.length !== dim) {
    db.model.weights = Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.02);
    db.model.bias = db.model.bias || 0;
    db.model.iter = db.model.iter || 0;
  }
}
function predictLogit(db, fv) {
  initModelIfNeeded(db, fv.length);
  let z = db.model.bias || 0;
  for (let i = 0; i < fv.length; i++) z += (db.model.weights[i] || 0) * fv[i];
  return z;
}
function sgdUpdate(db, fv, labelT) {
  initModelIfNeeded(db, fv.length);
  const z = predictLogit(db, fv);
  const p = sigmoid(z);
  const err = labelT - p;
  db.model.iter = (db.model.iter || 0) + 1;
  const adapt = 1 / Math.sqrt(1 + db.model.iter / 1000);
  const lr = LR_LEARNING_RATE * adapt;
  for (let i = 0; i < fv.length; i++) {
    const g = err * fv[i] - LR_REGULARIZATION * (db.model.weights[i] || 0);
    db.model.weights[i] += lr * g;
  }
  db.model.bias += lr * err;
  return { p, err };
}

function combineProbs(db, modelP, patternP = 0.5, markovP = 0.5) {
  const w = db.ensembleWeights || { model: 0.5, pattern: 0.25, markov: 0.25 };
  const raw = (w.model * modelP) + (w.pattern * patternP) + (w.markov * markovP);
  return clamp(raw);
}

// ---------- Core tick ----------
const axiosInstance = axios.create({ timeout: API_TIMEOUT_MS });

async function processGameTick(game) {
  try {
    const api = APIS[game];
    if (!api) return;

    const resp = await axiosInstance.get(api);
    const parsed = parseUpstreamData(resp.data);
    if (!parsed || parsed.length === 0) {
      console.warn(`[${game}] upstream returned no parsable records`);
      return;
    }

    const db = loadDB(game);

    const lastItem = parsed[parsed.length - 1];
    const sessionId = Number(lastItem.SessionId || lastItem.session || 0) || null;

    if (sessionId && db.lastProcessedSession && Number(db.lastProcessedSession) === sessionId) {
      // nothing new
      return;
    }

    const seq = parsed.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const fv = buildSimpleFV(seq);

    initModelIfNeeded(db, fv.length);
    const logit = predictLogit(db, fv);
    const modelP = sigmoid(logit);

    // simple markov & pattern signals
    let markovP = 0.5;
    if (seq.length >= 2) {
      const last2 = seq.slice(-2).join('');
      let t = 0, tot = 0;
      for (let i = 0; i + 2 < seq.length; i++) {
        if (seq.slice(i, i + 2).join('') === last2) {
          tot++;
          if (seq[i + 2] === 'T') t++;
        }
      }
      if (tot > 0) markovP = (t + 1) / (tot + 2);
    }

    let patternP = 0.5;
    if (seq.length >= 3) {
      const tail3 = seq.slice(-3).join('');
      let t = 0, tot = 0;
      for (let i = 0; i + 3 < seq.length; i++) {
        if (seq.slice(i, i + 3).join('') === tail3) {
          tot++;
          if (seq[i + 3] === 'T') t++;
        }
      }
      if (tot > 0) patternP = (t + 1) / (tot + 2);
    }

    const combinedRaw = combineProbs(db, modelP, patternP, markovP);
    const calibrated = clamp(0.9 * combinedRaw + 0.1 * modelP);
    const finalP = calibrated;
    const entropy = entropyFromProb(finalP);
    const gatePass = (calibrated >= CONFIDENCE_THRESHOLD && entropy <= ENTROPY_THRESHOLD);

    const predictionCode = finalP >= 0.5 ? 'T' : 'X';
    const predictionLabel = labelFromCode(predictionCode);

    const newEntry = {
      phien: sessionId || (db.history.length ? (db.history[db.history.length - 1].phien + 1) : null),
      phienDuDoan: sessionId ? sessionId + 1 : null,
      xucXac: [
        Number(lastItem.FirstDice || lastItem.First || lastItem.first || 0),
        Number(lastItem.SecondDice || lastItem.Second || lastItem.second || 0),
        Number(lastItem.ThirdDice || lastItem.Third || lastItem.third || 0)
      ],
      ketQua: itemToResult(lastItem),
      DU_DOAN_CODE: predictionCode,
      DU_DOAN: predictionLabel,
      TI_LE: `${(Math.max(finalP, 1 - finalP) * 100).toFixed(1)}%${!gatePass ? ' (LOW)' : ''}`,
      mauCau: '',
      trangThai: 'ĐANG CHỜ',
      meta: {
        sourceCount: parsed.length,
        modelP: Number(modelP.toFixed(4)),
        patternP: Number(patternP.toFixed(4)),
        markovP: Number(markovP.toFixed(4)),
        combinedProb: Number(finalP.toFixed(4)),
        calibrated: Number(calibrated.toFixed(4)),
        entropy: Number(entropy.toFixed(6)),
        gatePass,
        createdAt: now()
      }
    };

    // fill previous pending entry if exists
    const lastRecorded = db.history[db.history.length - 1];
    if (lastRecorded && lastRecorded.phienDuDoan && lastRecorded.phienDuDoan === newEntry.phien) {
      const actual = newEntry.ketQua;
      const lastCode = lastRecorded.DU_DOAN_CODE || (lastRecorded.DU_DOAN === 'Tài' ? 'T' : (lastRecorded.DU_DOAN === 'Xỉu' ? 'X' : null));
      const wasCorrect = lastCode === actual;
      lastRecorded.ketQua = actual;
      lastRecorded.trangThai = wasCorrect ? 'ĐÚNG' : 'SAI';
      db.stats.total = (db.stats.total || 0) + 1;
      if (wasCorrect) db.stats.wins = (db.stats.wins || 0) + 1;
      else db.stats.losses = (db.stats.losses || 0) + 1;

      // update model on stored fv if present
      try {
        if (lastRecorded.meta && Array.isArray(lastRecorded.meta.featureVector)) {
          const storedFV = lastRecorded.meta.featureVector;
          const labelT = actual === 'T' ? 1 : 0;
          sgdUpdate(db, storedFV, labelT);
        }
      } catch (e) {
        console.warn('model update error', e && e.message);
      }
    }

    newEntry.meta.featureVector = fv;
    db.history.push(newEntry);
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);

    db.lastProcessedSession = sessionId || db.lastProcessedSession;
    db.metaEvents = db.metaEvents || [];
    db.metaEvents.push({ at: now(), type: 'tick', sessionId, prediction: predictionCode, gatePass });

    saveDB(game, db);

    console.log(`[${game}] tick session=${sessionId} pred=${predictionCode} p=${finalP.toFixed(4)} gate=${gatePass}`);
  } catch (err) {
    console.error('processGameTick error', err && err.message ? err.message : err);
    throw err;
  }
}

// ---------- Polling ----------
function startPolling() {
  async function loop() {
    try {
      await Promise.all(Object.keys(APIS).map(async (g) => {
        try { await processGameTick(g); } catch (e) { /* logged */ }
      }));
    } catch (e) {
      console.error('poll loop error', e && e.message);
    } finally {
      setTimeout(loop, POLL_INTERVAL_MS + Math.floor(Math.random() * 1000));
    }
  }
  loop();
}

// ---------- Routes ----------

// Redirects for quick access: /md5 and /taixiu go to simple JSON API
app.get('/md5', (req, res) => res.redirect('/api/simple/md5'));
app.get('/taixiu', (req, res) => res.redirect('/api/simple/taixiu'));

// health root
app.get('/', (req, res) => res.send('OK — server running. Use /api/simple/:game or /api/predict/:game'));

// Simple JSON as requested
app.get('/api/simple/:game', async (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  let db = loadDB(game);
  let latest = db.history && db.history.length ? db.history[db.history.length - 1] : null;
  if (!latest) {
    // try to fetch immediately
    try { await processGameTick(game); } catch (_) {}
    db = loadDB(game);
    latest = db.history && db.history.length ? db.history[db.history.length - 1] : null;
  }
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

// Predict endpoint computes on demand and returns recent prediction + meta
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });
  try {
    await processGameTick(game);
    const db = loadDB(game);
    const latest = db.history && db.history.length ? db.history[db.history.length - 1] : null;
    if (!latest) return res.status(204).send();
    return res.json({
      predictionCode: latest.DU_DOAN_CODE,
      prediction: latest.DU_DOAN,
      tiLe: latest.TI_LE,
      meta: latest.meta || {}
    });
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : 'predict error' });
  }
});

// history export
app.get('/api/history/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDB(game);
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 200));
  const items = (db.history || []).slice(-limit).reverse().map(it => ({
    phien: it.phien,
    phienDuDoan: it.phienDuDoan,
    xucXac: it.xucXac || [],
    ketQua: it.ketQua,
    duDoan: it.DU_DOAN,
    tiLe: it.TI_LE,
    createdAt: it.meta && it.meta.createdAt
  }));
  return res.json({ game, count: items.length, items });
});

// admin: force tick
app.post('/admin/force-tick/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });
  try {
    await processGameTick(game);
    return res.json({ ok: true, msg: `tick executed for ${game}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : 'tick error' });
  }
});

// admin: reset model
app.post('/admin/reset-model/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDB(game);
  db.model = { weights: null, bias: 0, iter: 0, version: (db.model.version || 1) + 1 };
  db.calibration = { a: 1.0, b: 0.0, iter: 0 };
  db.ensembleWeights = { model: 0.34, pattern: 0.33, markov: 0.33 };
  db.metaEvents = db.metaEvents || [];
  db.metaEvents.push({ at: now(), type: 'reset-model' });
  saveDB(game, db);
  return res.json({ ok: true });
});

// admin: set config quick
app.post('/admin/config/:game', (req, res) => {
  const game = req.params.game;
  const body = req.body || {};
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  if (body.confidence !== undefined) CONFIDENCE_THRESHOLD = Number(body.confidence);
  if (body.entropy !== undefined) ENTROPY_THRESHOLD = Number(body.entropy);
  if (body.lr !== undefined) LR_LEARNING_RATE = Number(body.lr);
  const db = loadDB(game);
  db.metaEvents = db.metaEvents || [];
  db.metaEvents.push({ at: now(), type: 'config-update', body: { confidence: CONFIDENCE_THRESHOLD, entropy: ENTROPY_THRESHOLD, lr: LR_LEARNING_RATE } });
  saveDB(game, db);
  return res.json({ ok: true, confidence: CONFIDENCE_THRESHOLD, entropy: ENTROPY_THRESHOLD, lr: LR_LEARNING_RATE });
});

// admin: db summary
app.get('/admin/db/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDB(game);
  return res.json({
    stats: db.stats,
    lastProcessedSession: db.lastProcessedSession,
    historyCount: (db.history || []).length,
    patternsCount: (db.patterns && db.patterns.list) ? db.patterns.list.length : 0,
    metaEvents: db.metaEvents || []
  });
});

// ---------- Start ----------
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startPolling();
});

process.on('SIGINT', () => {
  console.log('SIGINT received — shutting down');
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});
