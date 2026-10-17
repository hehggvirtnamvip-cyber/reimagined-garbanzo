/**
 * server.js — FULL FIX (deterministic algorithm upgraded, preserves /md5 & /taixiu)
 *
 * - Replaces only the internal algorithm (deterministic, many pattern detectors).
 * - Preserves routes: /md5, /taixiu, /api/*, admin endpoints.
 * - Single-file: save as server.js, run with Node.js (>=18).
 *
 * Install:
 *   npm install express axios
 * Run:
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

// Simple CORS for convenience
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ================= CONFIG ================= */
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 800);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 8000);

const API_MD5 = process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX = process.env.API_TX || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';

const DB_DIR = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_FILES = {
  md5: path.join(DB_DIR, 'db_md5.json'),
  taixiu: path.join(DB_DIR, 'db_taixiu.json')
};
const BACKUP_FILES = {
  md5: path.join(DB_DIR, 'db_md5.bak.json'),
  taixiu: path.join(DB_DIR, 'db_taixiu.bak.json')
};

/* ================= HELPERS ================= */
function now() { return new Date().toISOString(); }
function safeReadJson(file, fallback = null) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function safeWriteJson(file, obj) {
  try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8'); fs.renameSync(tmp, file); } catch (e) { console.error('write error', file, e && e.message); }
}
function clamp(x, lo = 1e-6, hi = 1 - 1e-6) { return Math.min(Math.max(x, lo), hi); }
function safeInt(x, def = NaN) { const n = Number(x); return Number.isFinite(n) ? n : def; }
function labelFromCode(c) { if (c === 'T') return 'Tài'; if (c === 'X') return 'Xỉu'; return null; }
function flip(c) { if (c === 'T') return 'X'; if (c === 'X') return 'T'; return null; }

/* ================= PERSISTENCE ================= */
function defaultDB() {
  return {
    history: [],
    lastProcessedSession: null,
    stats: { total: 0, wins: 0, losses: 0 },
    meta: { events: [], ewma: 0.5 },
    patterns: { list: [], _map: {} },
    settings: {
      antiBias: {
        maxConsecutivePredictions: 4,
        failureWindow: 6,
        failureThreshold: 3,
        flipOnFail: true,
        softenOnFail: false
      }
    }
  };
}
function loadDatabase(game) {
  const f = DB_FILES[game];
  const b = BACKUP_FILES[game];
  const base = safeReadJson(f);
  if (base) return base;
  const restore = safeReadJson(b);
  if (restore) return restore;
  const d = defaultDB();
  safeWriteJson(f, d);
  return d;
}
function saveDatabase(game, db) {
  safeWriteJson(DB_FILES[game], db);
  safeWriteJson(BACKUP_FILES[game], db);
}

/* ================= UPSTREAM PARSE ================= */
function normalizeUpstream(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normalizeItem).filter(Boolean);
  if (typeof raw === 'object') return [normalizeItem(raw)].filter(Boolean);
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) return parsed.map(normalizeItem).filter(Boolean);
    if (typeof parsed === 'object') return [normalizeItem(parsed)].filter(Boolean);
  } catch (e) {
    const s = String(raw);
    const re = /{[^}]*}/g;
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      try {
        const p = JSON.parse(m[0]);
        const n = normalizeItem(p);
        if (n) out.push(n);
      } catch (err) {}
    }
    return out;
  }
}
function normalizeItem(it) {
  if (!it) return null;
  const id = ('SessionId' in it) ? safeInt(it.SessionId) : (('session' in it) ? safeInt(it.session) : null);
  const f = ('FirstDice' in it) ? safeInt(it.FirstDice) : safeInt(it.First);
  const s = ('SecondDice' in it) ? safeInt(it.SecondDice) : safeInt(it.Second);
  const t = ('ThirdDice' in it) ? safeInt(it.ThirdDice) : safeInt(it.Third);
  const sum = (it.DiceSum !== undefined) ? safeInt(it.DiceSum) : ((Number.isFinite(f) && Number.isFinite(s) && Number.isFinite(t)) ? (f + s + t) : null);
  const cd = it.CreatedDate || it.createdAt || it.created || null;
  return { SessionId: id, FirstDice: f, SecondDice: s, ThirdDice: t, DiceSum: sum, CreatedDate: cd };
}
function itemResult(it) {
  if (!it) return null;
  const s = safeInt(it.DiceSum, NaN);
  if (!Number.isFinite(s)) {
    const a = safeInt(it.FirstDice, 0), b = safeInt(it.SecondDice, 0), c = safeInt(it.ThirdDice, 0);
    const sum = a + b + c;
    if (sum >= 3 && sum <= 18) return sum >= 11 ? 'T' : 'X';
    return null;
  }
  return s >= 11 ? 'T' : 'X';
}

/* ================= SMALL HELPERS FOR ALGORITHM ================= */
function rle(seq) {
  if (!seq || seq.length === 0) return [];
  const out = []; let cur = seq[0], len = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === cur) len++; else { out.push({ ch: cur, len }); cur = seq[i]; len = 1; }
  }
  out.push({ ch: cur, len }); return out;
}
function lastN(seq, n) { return seq.slice(-n); }
function tailString(seq, n) { return lastN(seq, n).join(''); }
function countInWindow(seq, n, ch) { return lastN(seq, n).filter(x => x === ch).length; }
function ewma(prev, value, alpha = 0.18) { return alpha * value + (1 - alpha) * prev; }

/* ================= DETERMINISTIC ALGORITHM MODULE ================= */
const ALG = (function buildAlg() {
  const CONFIG = {
    EWMA_ALPHA: 0.18,
    PATTERN_MIN_SUPPORT: 2,
    MARKOV_ORDER: 3,
    COMBINER_WEIGHTS: { pattern: 0.45, markov: 0.25, ewma: 0.15, heuristics: 0.15 },
    ANTI_BIAS: { maxConsecutivePredictions: 4, failureWindow: 6, failureThreshold: 3, flipOnFail: true, softenOnFail: false }
  };

  const DETECTORS = [];

  // Persist run detector
  DETECTORS.push((seq) => {
    const r = rle(seq); if (!r.length) return null;
    const last = r[r.length - 1];
    if (last.len >= 3 && last.len <= 6) return { name: 'PERSIST_3_6', code: last.ch, strength: 0.68, info: { len: last.len } };
    if (last.len >= 7 && last.len <= 10) return { name: 'PERSIST_7_10', code: last.ch, strength: 0.76, info: { len: last.len } };
    if (last.len >= 11) return { name: 'PERSIST_11', code: last.ch, strength: 0.88, info: { len: last.len } };
    return null;
  });

  // Anti-persist (flip)
  DETECTORS.push((seq) => {
    const r = rle(seq); if (!r.length) return null;
    const last = r[r.length - 1];
    if (last.len >= 8 && last.len <= 12) return { name: 'ANTI_PERSIST_8_12', code: flip(last.ch), strength: 0.70, info: { len: last.len } };
    if (last.len >= 13) return { name: 'ANTI_PERSIST_13', code: flip(last.ch), strength: 0.83, info: { len: last.len } };
    return null;
  });

  // Alternation
  DETECTORS.push((seq) => {
    const n = Math.min(12, seq.length); if (n < 6) return null;
    const tail = lastN(seq, n); let alt = true;
    for (let i = 2; i < tail.length; i++) if (tail[i] === tail[i - 2]) { alt = false; break; }
    if (alt) return { name: 'ALTERNATE', code: flip(seq[seq.length - 1]), strength: 0.72, info: { n } };
    return null;
  });

  // Repeat block
  DETECTORS.push((seq) => {
    if (seq.length < 8) return null;
    for (let block = 2; block <= 5; block++) {
      const tail = seq.slice(-block * 2); if (tail.length < block * 2) continue;
      const a = tail.slice(0, block).join(''), b = tail.slice(block).join('');
      if (a === b) return { name: `REPEAT_${block}`, code: a[0], strength: 0.70, info: { block } };
    }
    return null;
  });

  // N-gram
  DETECTORS.push((seq) => {
    const maxN = Math.min(4, seq.length - 1);
    for (let n = maxN; n >= 1; n--) {
      const ctx = seq.slice(-n).join('');
      let t = 0, x = 0;
      for (let i = 0; i + n < seq.length; i++) {
        if (seq.slice(i, i + n).join('') === ctx) {
          const nx = seq[i + n]; if (nx === 'T') t++; else x++;
        }
      }
      const tot = t + x;
      if (tot >= 2) {
        const pT = (t + 1) / (tot + 2), pX = (x + 1) / (tot + 2);
        const code = pT >= pX ? 'T' : 'X';
        const strength = 0.55 + Math.abs(pT - pX) * 0.4;
        return { name: `NGRAM_${n}`, code, strength: clamp(strength), info: { ctx, t, x } };
      }
    }
    return null;
  });

  // Anti-ratio
  DETECTORS.push((seq) => {
    const n = Math.min(20, seq.length);
    if (n < 8) return null;
    const tcount = countInWindow(seq, n, 'T');
    const ratio = tcount / n;
    if (ratio >= 0.82) return { name: 'ANTI_RATIO_T', code: 'X', strength: 0.62, info: { ratio, n } };
    if (ratio <= 0.18) return { name: 'ANTI_RATIO_X', code: 'T', strength: 0.62, info: { ratio, n } };
    return null;
  });

  // Motif
  DETECTORS.push((seq) => {
    if (seq.length < 8) return null;
    const tail8 = tailString(seq, 8);
    if (tail8 === 'TTTXTTTX') return { name: 'TTTX_REPEAT', code: 'T', strength: 0.78 };
    if (tail8 === 'XXXTXXXT') return { name: 'XXXT_REPEAT', code: 'X', strength: 0.78 };
    return null;
  });

  // Suffix frequency
  DETECTORS.push((seq) => {
    const kmax = Math.min(7, seq.length - 1);
    for (let k = kmax; k >= 1; k--) {
      const ctx = seq.slice(-k).join('');
      let t = 0, x = 0;
      for (let i = 0; i + k < seq.length; i++) {
        if (seq.slice(i, i + k).join('') === ctx) {
          const nx = seq[i + k]; if (nx === 'T') t++; else x++;
        }
      }
      if (t + x >= CONFIG.PATTERN_MIN_SUPPORT) {
        const code = t >= x ? 'T' : 'X';
        const strength = 0.55 + (Math.abs(t - x) / (t + x)) * 0.4;
        return { name: `SUFFIX_${k}`, code, strength: clamp(strength), info: { ctx, t, x } };
      }
    }
    return null;
  });

  function buildMarkov(list, maxOrder = CONFIG.MARKOV_ORDER) {
    const seq = list.map(itemResult).filter(Boolean);
    const models = {};
    for (let order = 1; order <= maxOrder; order++) {
      const freq = {};
      for (let i = 0; i + order < seq.length; i++) {
        const ctx = seq.slice(i, i + order).join('');
        const nx = seq[i + order];
        freq[ctx] = freq[ctx] || { T: 0, X: 0 };
        freq[ctx][nx]++;
      }
      models[order] = freq;
    }
    return models;
  }
  function markovPredict(models, seq) {
    for (let order = Math.min(Object.keys(models).length, seq.length); order >= 1; order--) {
      const ctx = seq.slice(-order).join('');
      const m = models[order][ctx];
      if (m) {
        const t = m.T + 1, x = m.X + 1;
        const pT = t / (t + x), pX = x / (t + x);
        return { code: pT >= pX ? 'T' : 'X', pT, pX, order };
      }
    }
    return { code: null, pT: 0.5, pX: 0.5, order: 0 };
  }

  function combineDeterministic(votes, markovRes, ewmaProb, heurCode) {
    const weights = CONFIG.COMBINER_WEIGHTS;
    let scoreT = 0, scoreX = 0, detail = [];
    for (const v of votes) {
      const w = weights.pattern * (v.strength || 0.6);
      if (v.code === 'T') scoreT += w; else scoreX += w;
      detail.push({ source: v.name, code: v.code, weight: +w.toFixed(3) });
    }
    if (markovRes && markovRes.code) {
      const w = weights.markov * (Math.abs(markovRes.pT - 0.5) * 2 || 0.5);
      if (markovRes.code === 'T') scoreT += w; else scoreX += w;
      detail.push({ source: `MARKOV@${markovRes.order}`, code: markovRes.code, weight: +w.toFixed(3) });
    }
    const ewmaCode = ewmaProb >= 0.5 ? 'T' : 'X';
    const wE = weights.ewma * Math.abs(ewmaProb - 0.5) * 2;
    if (ewmaCode === 'T') scoreT += wE; else scoreX += wE;
    detail.push({ source: 'EWMA', code: ewmaCode, weight: +wE.toFixed(3) });
    if (heurCode) {
      const wH = weights.heuristics * 0.6;
      if (heurCode === 'T') scoreT += wH; else scoreX += wH;
      detail.push({ source: 'HEUR', code: heurCode, weight: +wH.toFixed(3) });
    }
    const pT = scoreT / Math.max(1, (scoreT + scoreX));
    const code = pT >= 0.5 ? 'T' : 'X';
    const strength = clamp(0.45 + Math.abs(pT - 0.5) * 1.1, 0.35, 0.98);
    return { code, pT, strength, detail };
  }

  function antiBiasAndTrend(result, seq, db) {
    const s = db && db.settings && db.settings.antiBias ? db.settings.antiBias : CONFIG.ANTI_BIAS;
    const recent = (db.history || []).slice(-Math.max(12, s.failureWindow));
    const recentPreds = recent.map(h => h.DU_DOAN_CODE).filter(Boolean);
    const recentResults = recent.map(h => (h.ketQua && h.DU_DOAN_CODE) ? (h.ketQua === h.DU_DOAN_CODE ? 'WIN' : 'LOSE') : null).filter(Boolean);
    let consPred = 0;
    if (recentPreds.length) {
      const last = recentPreds[recentPreds.length - 1];
      for (let i = recentPreds.length - 1; i >= 0; i--) { if (recentPreds[i] === last) consPred++; else break; }
    }
    const failures = recentResults.filter(x => x === 'LOSE').length;
    if (consPred >= s.maxConsecutivePredictions && failures >= s.failureThreshold) {
      if (s.flipOnFail) {
        result.code = flip(result.code);
        result.strength = Math.max(0.45, result.strength * 0.78);
        result.detail.push({ source: 'ANTI_BIAS', action: 'flip', consPred, failures });
        result.meta = { antiBias: 'flipped' };
        return result;
      } else if (s.softenOnFail) {
        result.strength = Math.max(0.35, result.strength * 0.7);
        result.detail.push({ source: 'ANTI_BIAS', action: 'soften', consPred, failures });
        result.meta = { antiBias: 'softened' };
        return result;
      }
    }
    const rr = rle(seq);
    if (rr.length) {
      const last = rr[rr.length - 1];
      if (last.len >= 6 && last.ch !== result.code) {
        result.code = last.ch;
        result.strength = Math.min(0.95, 0.62 + last.len * 0.04);
        result.detail.push({ source: 'TREND_BREAKER', run: last.len });
        result.meta = { trendBreaker: true };
        return result;
      }
    }
    return result;
  }

  function predict(list, db) {
    const seq = list.map(itemResult).filter(Boolean);
    if (seq.length < 6) return { code: null, strength: 0, tiLe: 'CHỜ', detail: [], regime: 'COLD', votes: [] };
    db.meta = db.meta || {}; db.meta.ewma = db.meta.ewma === undefined ? 0.5 : db.meta.ewma;
    db.meta.ewma = ewma(db.meta.ewma, seq[seq.length - 1] === 'T' ? 1 : 0, CONFIG.EWMA_ALPHA);
    const votes = [];
    for (const det of DETECTORS) {
      try { const r = det(seq); if (r && r.code) votes.push(r); } catch (e) {}
    }
    const markovModels = buildMarkov(list, CONFIG.MARKOV_ORDER);
    const markovRes = markovPredict(markovModels, seq);
    const heur = (() => {
      const window = Math.min(20, seq.length);
      const tcount = countInWindow(seq, window, 'T');
      const ratio = tcount / window;
      if (ratio >= 0.82) return 'X';
      if (ratio <= 0.18) return 'T';
      return null;
    })();
    let comb = combineDeterministic(votes, markovRes, db.meta.ewma, heur);
    comb = antiBiasAndTrend(comb, seq, db);
    const regime = (function () {
      try {
        if (seq.length < 6) return 'COLD';
        const r = rle(seq); const last = r[r.length - 1];
        if (last && last.len >= 6) return 'PERSIST';
        let alt = true;
        for (let i = 2; i < Math.min(12, seq.length); i++) { if (seq[seq.length - i] === seq[seq.length - i - 2]) { alt = false; break; } }
        if (alt) return 'ALTERNATE';
        const tRatio = seq.slice(-30).filter(x => x === 'T').length / Math.min(30, seq.length);
        if (tRatio > 0.65) return 'TREND_T';
        if (tRatio < 0.35) return 'TREND_X';
        return 'CHAOS';
      } catch (e) { return 'COLD'; }
    })();
    const out = {
      code: comb.code,
      strength: comb.strength,
      tiLe: (comb.strength * 100).toFixed(1) + '%',
      detail: comb.detail,
      regime,
      votes
    };
    try {
      db.meta = db.meta || {}; db.meta.events = db.meta.events || [];
      db.meta.events.push({ at: now(), type: 'predict', code: out.code, tiLe: out.tiLe, regime });
      if (db.meta.events.length > 400) db.meta.events.shift();
    } catch (e) {}
    return out;
  }

  return { predict };
})();

/* ================= FETCH WITH RETRY ================= */
const axiosInst = axios.create({ timeout: API_TIMEOUT_MS });
async function fetchWithRetry(url, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try { return await axiosInst.get(url); } catch (e) { if (i === attempts - 1) throw e; await new Promise(r => setTimeout(r, 200 + i * 200)); }
  }
}

/* ================= PROCESSING (uses ALG.predict) ================= */
async function processGameTick(game) {
  try {
    const api = (game === 'md5') ? API_MD5 : API_TX;
    const resp = await fetchWithRetry(api, 2);
    const raw = Array.isArray(resp.data) ? resp.data : (resp.data && (resp.data.data || resp.data.list) ? (resp.data.data || resp.data.list) : resp.data);
    const list = normalizeUpstream(raw);
    if (!list || !list.length) return;
    // ensure ascending by SessionId
    list.sort((a, b) => (Number(a.SessionId || 0) - Number(b.SessionId || 0)));
    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId, null);
    if (!session) return;
    const db = loadDatabase(game);
    if (db.lastProcessedSession === session) return;

    // finalize previous if pending
    const lastRecorded = db.history.length ? db.history[db.history.length - 1] : null;
    if (lastRecorded && safeInt(lastRecorded.phienDuDoan) === session) {
      const actual = itemResult(latest);
      lastRecorded.ketQua = actual;
      lastRecorded.ketQuaLabel = labelFromCode(actual);
      lastRecorded.trangThai = !lastRecorded.DU_DOAN_CODE ? 'BỎ QUA' : (lastRecorded.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
      db.stats.total = (db.stats.total || 0) + 1;
      if (lastRecorded.trangThai === 'ĐÚNG') db.stats.wins = (db.stats.wins || 0) + 1; else db.stats.losses = (db.stats.losses || 0) + 1;
      if (lastRecorded.patternName) {
        db.patterns = db.patterns || {}; db.patterns._map = db.patterns._map || {};
        db.patterns._map[lastRecorded.patternName] = db.patterns._map[lastRecorded.patternName] || { correct: 0, total: 0 };
        db.patterns._map[lastRecorded.patternName].total++;
        if (lastRecorded.trangThai === 'ĐÚNG') db.patterns._map[lastRecorded.patternName].correct++;
      }
      saveDatabase(game, db);
    }

    // call upgraded algorithm
    const algOut = ALG.predict(list, db);

    const entry = {
      phien: session,
      xucXac: [safeInt(latest.FirstDice, 0), safeInt(latest.SecondDice, 0), safeInt(latest.ThirdDice, 0)],
      tong: safeInt(latest.DiceSum, null),
      ketQua: itemResult(latest),
      ketQuaLabel: labelFromCode(itemResult(latest)),
      phienDuDoan: session + 1,
      DU_DOAN_CODE: algOut.code,
      DU_DOAN: algOut.code ? labelFromCode(algOut.code) : 'CHỜ',
      TI_LE: algOut.tiLe,
      patternName: (algOut.detail || []).map(d => d.source).slice(0, 3).join('; ') || (algOut.votes && algOut.votes.map(v => v.name).slice(0, 3).join('; ')) || '',
      regime: algOut.regime,
      trangThai: 'ĐANG CHỜ',
      meta: { createdAt: now(), votes: algOut.votes || [], comb: algOut.detail || [] }
    };

    db.history.push(entry);
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);
    db.lastProcessedSession = session;
    db.meta.events = db.meta.events || []; db.meta.events.push({ at: now(), type: 'predict', session, code: algOut.code, tiLe: algOut.tiLe });
    if (db.meta.events.length > 400) db.meta.events.shift();
    saveDatabase(game, db);

    console.log(`[${game}] session ${session} -> pred=${algOut.code} ${algOut.tiLe}`);
  } catch (err) {
    console.error('processGameTick error', err && err.message ? err.message : err);
  }
}

/* ================= POLLING ================= */
function startPolling() {
  async function loop() {
    try {
      await Promise.all(['md5', 'taixiu'].map(g => processGameTick(g)));
    } catch (_) {}
    setTimeout(loop, POLL_INTERVAL_MS + Math.floor(Math.random() * 1000));
  }
  loop();
}

/* ================= ROUTES (preserve /md5 and /taixiu) ================= */

// Keep /md5 and /taixiu as quick access to JSON prediction (calls processGameTick then returns simple JSON)
app.get('/md5', async (req, res) => {
  try { await processGameTick('md5'); } catch (_) {}
  const db = loadDatabase('md5');
  const latest = db.history.length ? db.history[db.history.length - 1] : null;
  if (!latest) return res.status(204).send();
  return res.json({
    phien: latest.phien,
    tong: latest.tong,
    ketQua: latest.ketQua,
    phienDuDoan: latest.phienDuDoan,
    duDoan: latest.DU_DOAN,
    tiLe: latest.TI_LE
  });
});
app.get('/taixiu', async (req, res) => {
  try { await processGameTick('taixiu'); } catch (_) {}
  const db = loadDatabase('taixiu');
  const latest = db.history.length ? db.history[db.history.length - 1] : null;
  if (!latest) return res.status(204).send();
  return res.json({
    phien: latest.phien,
    tong: latest.tong,
    ketQua: latest.ketQua,
    phienDuDoan: latest.phienDuDoan,
    duDoan: latest.DU_DOAN,
    tiLe: latest.TI_LE
  });
});

// Root / UI pointer
app.get('/', (req, res) => {
  res.send(`<div style="font-family:system-ui,Arial;padding:16px">
    <h3>HOANG VIP - Deterministic Algorithm (Upgraded)</h3>
    <ul>
      <li><a href="/md5">/md5</a></li>
      <li><a href="/taixiu">/taixiu</a></li>
      <li><a href="/api/predict/md5">/api/predict/md5</a></li>
      <li><a href="/api/history/md5?limit=50">/api/history/md5</a></li>
    </ul>
  </div>`);
});

// analyze arbitrary sequence
app.get('/api/analyze', (req, res) => {
  const seqStr = String(req.query.seq || '').toUpperCase().replace(/[^TX]/g, '');
  if (seqStr.length < 4) return res.status(400).json({ success: false, error: 'seq >= 4 required' });
  const seq = seqStr.split('');
  const dummy = seq.map((c, i) => ({ SessionId: i + 1, DiceSum: c === 'T' ? 11 : 6, FirstDice: 1, SecondDice: 1, ThirdDice: c === 'T' ? 9 : 4 }));
  const db = loadDatabase('md5');
  const out = ALG.predict(dummy, db);
  res.json({ success: true, seq: seqStr, prediction: out });
});

// on-demand predict
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!['md5', 'taixiu'].includes(game)) return res.status(400).json({ success: false, error: 'Invalid game' });
  try { await processGameTick(game); const db = loadDatabase(game); const latest = db.history.length ? db.history[db.history.length - 1] : null; if (!latest) return res.status(204).json({ success: false, error: 'No history' }); return res.json({ success: true, game, entry: latest }); } catch (e) { return res.status(500).json({ success: false, error: e && e.message }); }
});

// simple JSON API
app.get('/api/simple/:game', async (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  let latest = db.history.length ? db.history[db.history.length - 1] : null;
  if (!latest) {
    try { await processGameTick(game); } catch (_) {}
    const db2 = loadDatabase(game); latest = db2.history.length ? db2.history[db2.history.length - 1] : null;
    if (!latest) return res.status(204).send();
  }
  res.json({
    phien: latest.phien || null,
    tong: latest.tong || null,
    ketQua: latest.ketQua || null,
    phienDuDoan: latest.phienDuDoan || null,
    duDoan: latest.DU_DOAN || null,
    tiLe: latest.TI_LE || null
  });
});

// history export
app.get('/api/history/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 200));
  res.json({ success: true, game, count: db.history.length, items: db.history.slice(-limit).reverse() });
});

// admin: force tick
app.post('/admin/force-tick/:game', async (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ success: false, error: 'Invalid game' });
  try { await processGameTick(game); return res.json({ success: true, msg: 'Tick executed' }); } catch (e) { return res.status(500).json({ success: false, error: e && e.message }); }
});

// admin stats
app.get('/admin/stats/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ success: false, error: 'Invalid game' });
  const db = loadDatabase(game);
  const total = db.stats.total || 0;
  const wr = total ? ((db.stats.wins || 0) / total * 100).toFixed(2) + '%' : 'N/A';
  res.json({ success: true, stats: db.stats, meta: db.meta || {}, winRate: wr });
});

// admin: configure anti-bias
app.post('/admin/bias/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ success: false, error: 'Invalid game' });
  const body = req.body || {};
  const db = loadDatabase(game);
  db.settings = db.settings || {};
  db.settings.antiBias = db.settings.antiBias || {};
  for (const key of ['maxConsecutivePredictions', 'failureWindow', 'failureThreshold', 'flipOnFail', 'softenOnFail']) {
    if (body[key] !== undefined) db.settings.antiBias[key] = body[key];
  }
  saveDatabase(game, db);
  res.json({ success: true, settings: db.settings.antiBias });
});

// admin: losing chains
app.get('/admin/losing-chains/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ success: false, error: 'Invalid game' });
  const db = loadDatabase(game);
  const window = Number(req.query.window) || 100;
  const hist = db.history.slice(-window).map(h => h.ketQua).filter(Boolean);
  const chains = [];
  if (hist.length) {
    let cur = hist[0], len = 1;
    for (let i = 1; i < hist.length; i++) {
      if (hist[i] === cur) len++; else { chains.push({ code: cur, len }); cur = hist[i]; len = 1; }
    }
    chains.push({ code: cur, len });
  }
  chains.sort((a, b) => b.len - a.len);
  res.json({ success: true, chains });
});

/* ================= START ================= */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} — deterministic algorithm active`);
  startPolling();
});
