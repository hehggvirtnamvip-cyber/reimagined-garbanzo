/**
 * server.js — FULL FIX
 *
 * - Robust upstream parsing (array / text / newline JSON objects)
 * - Force-tick endpoint: POST /admin/force-tick/:game
 * - Always write DU_DOAN (code + label)
 * - /api/predict returns prediction immediately (ignores gate blocking output)
 * - /api/simple returns latest; if none, triggers immediate tick
 * - Logging improvements
 *
 * Run:
 *   npm i express axios
 *   node server.js
 */

'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------- Config ---------
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

// thresholds tuned to reduce LOW labels
let CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD || 0.55);
let ENTROPY_THRESHOLD = Number(process.env.ENTROPY_THRESHOLD || 0.95);

// learning defaults (keep conservative)
let LR_LEARNING_RATE = Number(process.env.LR_LEARNING_RATE || 0.11);
const LR_REGULARIZATION = Number(process.env.LR_REGULARIZATION || 1e-4);
const ENSEMBLE_ETA = Number(process.env.ENSEMBLE_ETA || 0.08);

const MARKOV_MAX_ORDER = Number(process.env.MARKOV_MAX_ORDER || 3);
const PATTERN_TOP_N = Number(process.env.PATTERN_TOP_N || 30);
const PATTERN_MIN_SUPPORT = Number(process.env.PATTERN_MIN_SUPPORT || 2);
const PATTERN_MAX_LEN = Number(process.env.PATTERN_MAX_LEN || 10);

const CALIBRATION_LR = Number(process.env.CALIBRATION_LR || 0.02);
const GRAD_CLIP = Number(process.env.GRAD_CLIP || 5.0);

// --------- Helpers ---------
function now() { return new Date().toISOString(); }
function safeReadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('safeReadJson error', file, e.message);
    return fallback;
  }
}
function safeWriteJson(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('safeWriteJson error', file, e.message);
  }
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function entropyFromProb(p) {
  const eps = 1e-12;
  return -(p * Math.log(p + eps) + (1 - p) * Math.log(1 - p + eps));
}
function labelFromCode(code) {
  if (code === 'T') return 'Tài';
  if (code === 'X') return 'Xỉu';
  return code;
}
function clamp(x, a = 1e-6, b = 1 - 1e-6) { return Math.min(Math.max(x, a), b); }

// --------- DB ---------
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

// --------- Robust upstream parsing ---------
// Accepts response.data (could be array, object, string containing array or newline JSON objects)
function parseUpstreamData(raw) {
  if (!raw) return [];
  // If already array
  if (Array.isArray(raw)) return raw;
  // If object
  if (typeof raw === 'object') return [raw];

  // raw is string -> try JSON.parse
  if (typeof raw === 'string') {
    const s = raw.trim();
    // try parse as JSON array/object
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j;
      if (typeof j === 'object') return [j];
    } catch (e) {
      // not a single json; attempt to extract {...} objects via regex
      const objs = [];
      // match sequences like {"SessionId":...}
      const re = /{[^}]*}/g;
      let m;
      while ((m = re.exec(s)) !== null) {
        try {
          const candidate = m[0];
          const parsed = JSON.parse(candidate);
          objs.push(parsed);
        } catch (err) {
          // skip malformed segment
        }
      }
      // If found items, return them
      if (objs.length) return objs;

      // As last resort, split by newlines and try parse each line
      const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const p = JSON.parse(line);
          if (p) objs.push(p);
        } catch (err) {
          // try to trim trailing commas
          const trimmed = line.replace(/,$/, '');
          try { const p2 = JSON.parse(trimmed); if (p2) objs.push(p2); } catch (_) {}
        }
      }
      if (objs.length) return objs;
    }
  }
  return [];
}

// --------- Minimal feature & model (kept simple but stable) ---------
function itemToResult(item) {
  if (!item) return null;
  if (item.BetSide !== undefined) return Number(item.BetSide) === 1 ? 'T' : 'X';
  // compute sum from dice fields if present
  const first = Number(item.FirstDice || item.First || item.first || 0);
  const second = Number(item.SecondDice || item.Second || item.second || 0);
  const third = Number(item.ThirdDice || item.Third || item.third || 0);
  const diceSum = Number(item.DiceSum || item.DiceSum === 0 ? item.DiceSum : (first + second + third));
  const sum = Number(diceSum || (first + second + third));
  return sum >= 11 ? 'T' : 'X';
}

// Very small feature builder (keeps model stable)
function buildSimpleFV(sequence) {
  // returns feature vector: [bias, last1, last2, ewma_short]
  const f = [];
  f.push(1.0);
  const n = sequence.length;
  const last1 = n >= 1 ? (sequence[n - 1] === 'T' ? 1 : 0) : 0;
  const last2 = n >= 2 ? (sequence[n - 2] === 'T' ? 1 : 0) : 0;
  f.push(last1, last2);
  // ewma over last 20
  let alpha = 0.2, ewma = 0;
  const tail = sequence.slice(-20);
  for (const s of tail) {
    const v = s === 'T' ? 1 : 0;
    ewma = alpha * v + (1 - alpha) * ewma;
  }
  f.push(ewma);
  return f;
}

function initModel(db, dim) {
  db.model = db.model || {};
  if (!db.model.weights || db.model.weights.length !== dim) {
    db.model.weights = Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.02);
    db.model.bias = db.model.bias || 0;
    db.model.iter = db.model.iter || 0;
  }
}
function predictLogit(db, fv) {
  initModel(db, fv.length);
  let z = db.model.bias || 0;
  for (let i = 0; i < fv.length; i++) z += (db.model.weights[i] || 0) * fv[i];
  return z;
}
function sgdUpdate(db, fv, label) {
  initModel(db, fv.length);
  const z = predictLogit(db, fv);
  const p = sigmoid(z);
  const err = label - p;
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

// ensemble combine (simple average weighted)
function combineProbs(db, modelP, patternP = 0.5, markovP = 0.5) {
  const w = db.ensembleWeights || { model: 0.5, pattern: 0.25, markov: 0.25 };
  const raw = (w.model * modelP) + (w.pattern * patternP) + (w.markov * markovP);
  return clamp(raw);
}

// --------- Core tick logic with robust parse ---------
const axiosInstance = axios.create({ timeout: API_TIMEOUT_MS });

async function processGameTick(game) {
  try {
    const api = APIS[game];
    if (!api) {
      console.warn('No API for game', game);
      return;
    }

    const resp = await axiosInstance.get(api);
    const parsed = parseUpstreamData(resp.data);

    if (!parsed || parsed.length === 0) {
      console.warn(`[${game}] upstream returned no parsable records`);
      return;
    }

    // Ensure these parsed items are ordered oldest->newest if possible.
    // We'll use the array as given; upstream seems to return chronological list.
    const db = loadDB(game);

    // determine latest session id from upstream
    const lastItem = parsed[parsed.length - 1];
    const sessionId = Number(lastItem.SessionId || lastItem.session || 0);
    if (!sessionId) {
      console.warn(`[${game}] couldn't determine session id from upstream item`);
    }

    // If already processed, skip
    if (db.lastProcessedSession && sessionId && Number(db.lastProcessedSession) === sessionId) {
      // nothing new
      return;
    }

    // Build sequence from parsed (last MAX_HISTORY results)
    const seq = parsed.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);

    // Build feature vector
    const fv = buildSimpleFV(seq);
    const dbLocal = db;

    // Model predict
    initModel(dbLocal, fv.length);
    const logit = predictLogit(dbLocal, fv);
    const modelP = sigmoid(logit);

    // Very small markov: use last two items
    let markovP = 0.5;
    if (seq.length >= 2) {
      const last = seq.slice(-2).join('');
      // quick simple counts in parsed history
      let t = 0, total = 0;
      for (let i = 0; i + 2 < seq.length; i++) {
        if (seq.slice(i, i + 2).join('') === last) {
          total++;
          if (seq[i + 2] === 'T') t++;
        }
      }
      if (total > 0) markovP = (t + 1) / (total + 2);
    }

    // pattern signal: simple frequent last-3 pattern check
    let patternP = 0.5;
    if (seq.length >= 3) {
      const tail = seq.slice(-3).join('');
      let t = 0, total = 0;
      for (let i = 0; i + 3 < seq.length; i++) {
        if (seq.slice(i, i + 3).join('') === tail) {
          total++;
          if (seq[i + 3] === 'T') t++;
        }
      }
      if (total > 0) patternP = (t + 1) / (total + 2);
    }

    // combine
    const combinedRaw = combineProbs(dbLocal, modelP, patternP, markovP);

    // calibrate (very simple)
    const calibrated = clamp(0.9 * combinedRaw + 0.1 * modelP);

    // final prob
    let finalP = calibrated;
    const entropy = entropyFromProb(finalP);

    // gating decision (kept for metadata but will not block output)
    const gatePass = (calibrated >= CONFIDENCE_THRESHOLD && entropy <= ENTROPY_THRESHOLD);

    const predictionCode = finalP >= 0.5 ? 'T' : 'X';
    const predictionLabel = labelFromCode(predictionCode);

    // Create entry and ALWAYS write DU_DOAN
    const newEntry = {
      phien: sessionId || (dbLocal.history.length ? (dbLocal.history[dbLocal.history.length - 1].phien + 1) : null),
      phienDuDoan: (sessionId ? sessionId + 1 : null),
      xucXac: [
        Number(lastItem.FirstDice || lastItem.First || lastItem.first || 0),
        Number(lastItem.SecondDice || lastItem.Second || lastItem.second || 0),
        Number(lastItem.ThirdDice || lastItem.Third || lastItem.third || 0)
      ],
      ketQua: itemToResult(lastItem),
      DU_DOAN_CODE: predictionCode,
      DU_DOAN: predictionLabel,
      TI_LE: `${(Math.max(finalP, 1 - finalP) * 100).toFixed(1)}%${!gatePass ? ' (LOW)' : ''}`,
      mauCau: '', // optional pattern summary
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

    // Save previous entry's result if it exists and matches session (i.e., fill ketQua/trangThai)
    const lastRecorded = dbLocal.history[dbLocal.history.length - 1];
    if (lastRecorded && lastRecorded.phienDuDoan && lastRecorded.phienDuDoan === newEntry.phien) {
      // fill final result for lastRecorded using lastItem (we have actual result)
      const actual = newEntry.ketQua;
      const lastCode = lastRecorded.DU_DOAN_CODE || (lastRecorded.DU_DOAN === 'Tài' ? 'T' : (lastRecorded.DU_DOAN === 'Xỉu' ? 'X' : null));
      const wasCorrect = lastCode === actual;
      lastRecorded.ketQua = actual;
      lastRecorded.trangThai = wasCorrect ? 'ĐÚNG' : 'SAI';

      // update stats
      dbLocal.stats.total = (dbLocal.stats.total || 0) + 1;
      if (wasCorrect) dbLocal.stats.wins = (dbLocal.stats.wins || 0) + 1;
      else dbLocal.stats.losses = (dbLocal.stats.losses || 0) + 1;

      // online update model using lastRecorded.meta.featureVector if present
      try {
        if (lastRecorded.meta && Array.isArray(lastRecorded.meta.featureVector)) {
          const storedFV = lastRecorded.meta.featureVector;
          const labelT = actual === 'T' ? 1 : 0;
          sgdUpdate(dbLocal, storedFV, labelT);
        }
      } catch (e) {
        console.warn('model update error', e.message);
      }
    }

    // attach current feature vector for future update
    newEntry.meta.featureVector = fv;
    dbLocal.history.push(newEntry);
    if (dbLocal.history.length > MAX_HISTORY) dbLocal.history.splice(0, dbLocal.history.length - MAX_HISTORY);

    dbLocal.lastProcessedSession = sessionId || dbLocal.lastProcessedSession;
    dbLocal.metaEvents = dbLocal.metaEvents || [];
    dbLocal.metaEvents.push({ at: now(), type: 'tick', sessionId, prediction: predictionCode, gatePass });

    saveDB(game, dbLocal);

    console.log(`[${game}] tick processed session=${sessionId} pred=${predictionCode} p=${(finalP).toFixed(4)} gate=${gatePass}`);
    return;
  } catch (err) {
    console.error('processGameTick error', err && err.message ? err.message : err);
    throw err;
  }
}

// --------- Polling ---------
function startPolling() {
  async function loop() {
    try {
      await Promise.all(Object.keys(APIS).map(async (g) => {
        try { await processGameTick(g); } catch (e) { /* individual errors logged */ }
      }));
    } catch (e) {
      console.error('poll loop error', e && e.message);
    } finally {
      setTimeout(loop, POLL_INTERVAL_MS + Math.floor(Math.random() * 1000));
    }
  }
  loop();
}

// --------- Routes ---------
// Simple JSON endpoint required format: { phien, tong, ketQua, phienDuDoan, duDoan, tiLe }
app.get('/api/simple/:game', async (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDB(game);
  const latest = db.history && db.history.length ? db.history[db.history.length - 1] : null;
  if (!latest) {
    // try immediate tick to populate
    try {
      await processGameTick(game);
    } catch (_) { /* ignore */ }
  }
  const db2 = loadDB(game);
  const latest2 = db2.history && db2.history.length ? db2.history[db2.history.length - 1] : null;
  if (!latest2) return res.status(204).send();
  return res.json({
    phien: latest2.phien || null,
    tong: db2.stats ? (db2.stats.total || 0) : 0,
    ketQua: latest2.ketQua || null,
    phienDuDoan: latest2.phienDuDoan || null,
    duDoan: latest2.DU_DOAN || null,
    tiLe: latest2.TI_LE || null
  });
});

// Detailed predict (computes on-demand, returns prediction even if gate fails)
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });
  try {
    // call processGameTick once to compute latest
    await processGameTick(game);
    // return latest summary
    const db = loadDB(game);
    const latest = db.history && db.history.length ? db.history[db.history.length - 1] : null;
    if (!latest) return res.status(204).send();
    // return prediction fields + internals
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

// export history JSON
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

// admin: force tick immediate
app.post('/admin/force-tick/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });
  try {
    await processGameTick(game);
    return res.json({ ok: true, msg: 'tick executed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : 'tick error' });
  }
});

// admin: view db (safe)
app.get('/admin/db/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDB(game);
  // don't return full model weights by default to reduce payload; will include meta
  return res.json({
    stats: db.stats,
    lastProcessedSession: db.lastProcessedSession,
    historyCount: (db.history || []).length,
    patternsCount: (db.patterns && db.patterns.list) ? db.patterns.list.length : 0,
    metaEvents: db.metaEvents || []
  });
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

// admin: set thresholds/config quickly
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

// UI root minimal
app.get('/', (req, res) => {
  res.send('Server running. Use /api/simple/:game or /api/predict/:game');
});

// start server and polling
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startPolling();
});

process.on('SIGINT', () => {
  console.log('Shutting down');
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received');
  server.close(() => process.exit(0));
});
