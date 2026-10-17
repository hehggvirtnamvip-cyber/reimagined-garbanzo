/**
 * HOANG VIP CUEJC-VIP - advanced single-file server
 *
 * - Purpose: Deterministic, non-random "cầu" (pattern) detection for Tài/Xỉu dice game.
 * - Focus: many pattern detectors, vote combiner (deterministic), anti-bias, trend-breaker,
 *          per-game persistence, admin endpoints, force-tick, history export.
 * - Run: npm i express axios
 *        node server.js
 *
 * Notes:
 * - This is intentionally long and feature-rich. It's deterministic: no sampling/randomness.
 * - Tune thresholds in CONFIG section below.
 */

'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------- CONFIG ----------------------
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 1200);
const DB_DIR = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const APIS = {
  md5: process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: process.env.API_TX || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

// Deterministic combiner weights (not sampled)
const COMBINER_WEIGHTS = {
  pattern: 0.45,
  markov: 0.25,
  ewma: 0.15,
  heuristics: 0.15
};

// Anti-bias / trend breaker rules
const ANTI_BIAS = {
  maxConsecutivePredictions: 4,   // if tool predicted same side >= this and recent failures, act
  failureWindow: 6,               // recent window to check failures
  failureThreshold: 3,            // failures in window that trigger anti-bias
  flipOnFail: true,               // flip prediction if anti-bias triggers
  softenOnFail: false             // or soften confidence instead
};

// Pattern detection tuning
const PATTERN_MIN_SUPPORT = 2;
const PATTERN_MAX_LEN = 12;
const MARKOV_ORDER = 3;
const EWMA_ALPHA = 0.18;

// Persistence filenames
const DB_FILES = { md5: path.join(DB_DIR, 'db_md5.json'), taixiu: path.join(DB_DIR, 'db_taixiu.json') };
const BACKUPS = { md5: path.join(DB_DIR, 'db_md5.bak.json'), taixiu: path.join(DB_DIR, 'db_taixiu.bak.json') };

// ---------------------- UTILITIES ----------------------
function now() { return new Date().toISOString(); }
function safeRead(file, fallback = null) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function safeWrite(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { console.error('write error', file, e && e.message); }
}
function clamp(x, lo = 0.000001, hi = 0.999999) { return Math.min(Math.max(x, lo), hi); }
function label(code) { if (code === 'T') return 'Tài'; if (code === 'X') return 'Xỉu'; return null; }
function flip(code) { if (code === 'T') return 'X'; if (code === 'X') return 'T'; return null; }
function safeInt(x, def = NaN) { const n = Number(x); return Number.isFinite(n) ? n : def; }

// ---------------------- DB ----------------------
function defaultDB() {
  return {
    history: [],
    lastProcessed: null,
    patterns: { extractedAt: null, list: [] },
    markov: {},
    stats: { total: 0, wins: 0, losses: 0 },
    meta: { ewma: 0.5, regime: 'UNKNOWN', events: [] },
    settings: { antiBias: ANTI_BIAS }
  };
}
function loadDB(game) {
  const file = DB_FILES[game];
  const backup = BACKUPS[game];
  const base = safeRead(file);
  if (base) return base;
  const b = safeRead(backup);
  if (b) return b;
  const d = defaultDB();
  safeWrite(file, d);
  return d;
}
function saveDB(game, db) {
  safeWrite(DB_FILES[game], db);
  safeWrite(BACKUPS[game], db);
}

// ---------------------- PARSING UPSTREAM ----------------------
// Accepts arrays or object shapes and normalizes to array of { SessionId, FirstDice, SecondDice, ThirdDice, DiceSum, CreatedDate }
function normalizeUpstream(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.map(normalizeItem).filter(Boolean);
  if (typeof data === 'object') return [normalizeItem(data)].filter(Boolean);
  // if string: try to parse possible JSON array or newline JSON objects
  try {
    const parsed = JSON.parse(String(data));
    if (Array.isArray(parsed)) return parsed.map(normalizeItem).filter(Boolean);
    if (typeof parsed === 'object') return [normalizeItem(parsed)].filter(Boolean);
  } catch (e) {
    // fallback: extract {...} blocks
    const s = String(data);
    const re = /{[^}]*}/g;
    const out = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      try {
        const p = JSON.parse(m[0]);
        const n = normalizeItem(p);
        if (n) out.push(n);
      } catch (e) {}
    }
    return out;
  }
}
function normalizeItem(item) {
  if (!item) return null;
  const id = ('SessionId' in item) ? safeInt(item.SessionId) : (('session' in item) ? safeInt(item.session) : null);
  const f = ('FirstDice' in item) ? safeInt(item.FirstDice) : safeInt(item.First);
  const s = ('SecondDice' in item) ? safeInt(item.SecondDice) : safeInt(item.Second);
  const t = ('ThirdDice' in item) ? safeInt(item.ThirdDice) : safeInt(item.Third);
  const sum = (item.DiceSum !== undefined) ? safeInt(item.DiceSum) : ((Number.isFinite(f) && Number.isFinite(s) && Number.isFinite(t)) ? (f + s + t) : null);
  const created = item.CreatedDate || item.createdAt || item.created || null;
  return { SessionId: id, FirstDice: f, SecondDice: s, ThirdDice: t, DiceSum: sum, CreatedDate: created };
}
function itemResult(it) {
  if (!it) return null;
  const s = safeInt(it.DiceSum);
  if (!Number.isFinite(s)) return null;
  if (s >= 11) return 'T';
  return 'X';
}
function itemDice(it) { return [it.FirstDice || 0, it.SecondDice || 0, it.ThirdDice || 0]; }

// ---------------------- FEATURE BUILDERS ----------------------
function buildSequenceFromList(list) {
  return list.map(itemResult).filter(Boolean);
}
function buildSums(list) {
  return list.map(it => (Number.isFinite(it.DiceSum) ? it.DiceSum : null)).filter(s => Number.isFinite(s));
}
function ewma(prev, value, alpha = EWMA_ALPHA) {
  return alpha * value + (1 - alpha) * prev;
}

// ---------------------- RUN-LENGTH ENCODING ----------------------
function rle(seq) {
  if (!seq || seq.length === 0) return [];
  const res = [];
  let cur = seq[0], len = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === cur) len++; else { res.push({ ch: cur, len }); cur = seq[i]; len = 1; }
  }
  res.push({ ch: cur, len });
  return res;
}

// ---------------------- PATTERN DETECTORS (many) ----------------------
// Each detector receives (seq, sums, db) where seq is array of 'T'/'X', sums is numeric sums array
// Each returns null or { name, code: 'T'|'X', strength (0..1), info }
const PATTERN_DETECTORS = [];

/* Helper detectors for reuse */
function lastN(seq, n) { return seq.slice(-n); }
function tailString(seq, n) { return lastN(seq, n).join(''); }
function countInWindow(seq, n, ch) { return lastN(seq, n).filter(x => x === ch).length; }

/* 1) Persistent run detectors */
PATTERN_DETECTORS.push(function detector_persist(seq) {
  const r = rle(seq);
  if (!r.length) return null;
  const last = r[r.length - 1];
  if (last.len >= 3 && last.len <= 6) return { name: 'PERSIST_SMALL', code: last.ch, strength: 0.68, info: { len: last.len } };
  if (last.len >= 7 && last.len <= 10) return { name: 'PERSIST_MED', code: last.ch, strength: 0.75, info: { len: last.len } };
  if (last.len >= 11) return { name: 'PERSIST_LARGE', code: last.ch, strength: 0.86, info: { len: last.len } };
  return null;
});

/* 2) Anti-persistence (break) - flip when super long run (sudden flip expected) */
PATTERN_DETECTORS.push(function detector_anti_persist(seq) {
  const r = rle(seq);
  if (!r.length) return null;
  const last = r[r.length - 1];
  if (last.len >= 8 && last.len <= 12) return { name: 'ANTI_PERSIST', code: flip(last.ch), strength: 0.7, info: { len: last.len } };
  return null;
});

/* 3) Alternating detectors */
PATTERN_DETECTORS.push(function detector_alternate(seq) {
  const n = Math.min(10, seq.length);
  if (n < 6) return null;
  const tail = tailString(seq, n);
  // detect strict alternation like TXT X T X ...
  let alt = true;
  for (let i = 2; i < tail.length; i++) {
    if (tail[i] === tail[i - 2]) { alt = false; break; }
  }
  if (alt) return { name: 'ALTERNATE', code: flip(seq[seq.length - 1]), strength: 0.72, info: { tail } };
  return null;
});

/* 4) Repeat-block detectors (e.g., TTXXTTXX) */
PATTERN_DETECTORS.push(function detector_repeat_block(seq) {
  if (seq.length < 8) return null;
  for (let block = 2; block <= 5; block++) {
    const tailLen = block * 2;
    if (seq.length < tailLen) continue;
    const tail = seq.slice(-tailLen).join('');
    const a = tail.slice(0, block);
    const b = tail.slice(block);
    if (a === b) {
      // predict next is a[0] (repeat)
      return { name: `REPEAT_${block}`, code: a[0], strength: 0.7, info: { block, tail } };
    }
  }
  return null;
});

/* 5) N-gram Markov-like frequent next prediction */
PATTERN_DETECTORS.push(function detector_ngram(seq) {
  const maxN = 4;
  for (let n = Math.min(maxN, seq.length - 1); n >= 1; n--) {
    const context = seq.slice(-n).join('');
    // search occurrences
    let t = 0, x = 0;
    for (let i = 0; i + n < seq.length; i++) {
      if (seq.slice(i, i + n).join('') === context) {
        const next = seq[i + n];
        if (next === 'T') t++; else x++;
      }
    }
    const tot = t + x;
    if (tot >= 2) {
      const pT = (t + 1) / (tot + 2);
      const pX = (x + 1) / (tot + 2);
      const code = pT > pX ? 'T' : 'X';
      const strength = 0.55 + Math.abs(pT - pX) * 0.4;
      return { name: `NGRAM_${n}`, code, strength: clamp(strength), info: { context, t, x } };
    }
  }
  return null;
});

/* 6) Anti-ratio (if T extremely dominant recently, bet X) */
PATTERN_DETECTORS.push(function detector_anti_ratio(seq) {
  const n = Math.min(20, seq.length);
  if (n < 8) return null;
  const tcount = countInWindow(seq, n, 'T');
  const ratio = tcount / n;
  if (ratio >= 0.82) return { name: 'ANTI_RATIO_T', code: 'X', strength: 0.62, info: { ratio, n } };
  if (ratio <= 0.18) return { name: 'ANTI_RATIO_X', code: 'T', strength: 0.62, info: { ratio, n } };
  return null;
});

/* 7) Pattern-of-sums (e.g., repeated totals: many 11-12-13) */
PATTERN_DETECTORS.push(function detector_sum_pattern(sums) {
  if (!sums || sums.length < 6) return null;
  const tail = sums.slice(-6);
  const modeMap = {};
  for (const v of tail) modeMap[v] = (modeMap[v] || 0) + 1;
  const entries = Object.entries(modeMap).sort((a, b) => b[1] - a[1]);
  if (entries.length && entries[0][1] >= 3) {
    // if mode > threshold predict based on whether mode >=11 (T) else X
    const modeVal = Number(entries[0][0]);
    const code = modeVal >= 11 ? 'T' : 'X';
    return { name: 'SUM_MODE', code, strength: 0.6, info: { modeVal, count: entries[0][1] } };
  }
  return null;
});

/* 8) Complex motifs: detect 'TTTX' or 'XXXT' repeats */
PATTERN_DETECTORS.push(function detector_motif(seq) {
  if (seq.length < 8) return null;
  const tail8 = tailString(seq, 8);
  if (tail8 === 'TTTXTTTX') return { name: 'TTTX_REPEAT', code: 'T', strength: 0.78 };
  if (tail8 === 'XXXTXXXT') return { name: 'XXXT_REPEAT', code: 'X', strength: 0.78 };
  return null;
});

/* 9) Suffix frequency detector - last k pattern followed by a likely next */
PATTERN_DETECTORS.push(function detector_suffix_freq(seq) {
  const kmax = Math.min(7, seq.length - 1);
  for (let k = kmax; k >= 1; k--) {
    const ctx = seq.slice(-k).join('');
    let t = 0, x = 0;
    for (let i = 0; i + k < seq.length; i++) {
      if (seq.slice(i, i + k).join('') === ctx) {
        const next = seq[i + k];
        if (next === 'T') t++; else x++;
      }
    }
    if (t + x >= PATTERN_MIN_SUPPORT) {
      const code = t >= x ? 'T' : 'X';
      const strength = 0.55 + (Math.abs(t - x) / (t + x)) * 0.4;
      return { name: `SUFFIX_${k}`, code, strength: clamp(strength), info: { ctx, t, x } };
    }
  }
  return null;
});

/* Many more detectors can be appended here... for brevity we include many distinctive ones */

function runAllDetectors(seq, sums, db) {
  const votes = [];
  for (const det of PATTERN_DETECTORS) {
    try {
      const r = det(seq, sums, db);
      if (r && r.code) votes.push(r);
    } catch (e) {
      // ignore detector errors
    }
  }
  return votes;
}

// ---------------------- MARKOV BUILDER ----------------------
function buildMarkov(list, maxOrder = MARKOV_ORDER) {
  const seq = buildSequenceFromList(list);
  const models = {};
  for (let order = 1; order <= maxOrder; order++) {
    const freq = {};
    for (let i = 0; i + order < seq.length; i++) {
      const ctx = seq.slice(i, i + order).join('');
      const next = seq[i + order];
      freq[ctx] = freq[ctx] || { T: 0, X: 0 };
      freq[ctx][next]++;
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

// ---------------------- DETERMINISTIC COMBINER (VIP) ----------------------
function combineDeterministic(votes, markovRes, ewmaProb, heuristicsCode, db) {
  // votes: array of {name, code, strength}
  const score = { T: 0, X: 0, detail: [] };
  // pattern votes
  for (const v of votes) {
    const w = COMBINER_WEIGHTS.pattern * v.strength;
    score[v.code] += w;
    score.detail.push({ source: v.name, code: v.code, weight: w });
  }
  // markov
  if (markovRes && markovRes.code) {
    const w = COMBINER_WEIGHTS.markov * (Math.abs(markovRes.pT - 0.5) * 2 || 0.5);
    score[markovRes.code] += w;
    score.detail.push({ source: `MARKOV@${markovRes.order}`, code: markovRes.code, weight: w });
  }
  // ewma
  const ewmaCode = ewmaProb >= 0.5 ? 'T' : 'X';
  const wE = COMBINER_WEIGHTS.ewma * Math.abs(ewmaProb - 0.5) * 2;
  score[ewmaCode] += wE;
  score.detail.push({ source: 'EWMA', code: ewmaCode, weight: wE });

  // heuristics (anti-ratio, etc.)
  if (heuristicsCode) {
    const wH = COMBINER_WEIGHTS.heuristics * 0.6;
    score[heuristicsCode] += wH;
    score.detail.push({ source: 'HEUR', code: heuristicsCode, weight: wH });
  }

  // finalize
  const pTscore = score.T, pXscore = score.X;
  const pT = pTscore / Math.max(1, (pTscore + pXscore));
  const code = pT >= 0.5 ? 'T' : 'X';
  // strength scaled deterministically
  const strength = clamp(0.45 + Math.abs(pT - 0.5) * 1.1, 0.35, 0.98);
  return { code, pT, strength, detail: score.detail };
}

// ---------------------- ANTI-BIAS & TREND HANDLER ----------------------
function antiBiasAndTrend(result, seq, db) {
  // result: { code, pT, strength, detail }
  // db: database
  const settings = db.settings && db.settings.antiBias ? db.settings.antiBias : ANTI_BIAS;

  // compute recent predictions & actual fails
  const recentHist = db.history.slice(-Math.max(12, settings.failureWindow));
  const recentPreds = recentHist.map(h => h.DU_DOAN_CODE).filter(Boolean);
  const recentResults = recentHist.map(h => (h.ketQua ? (h.ketQua === h.DU_DOAN_CODE ? 'WIN' : 'LOSE') : null)).filter(Boolean);

  // consecutive predictions same
  let consPred = 0;
  if (recentPreds.length) {
    const last = recentPreds[recentPreds.length - 1];
    for (let i = recentPreds.length - 1; i >= 0; i--) {
      if (recentPreds[i] === last) consPred++; else break;
    }
  }
  // failures in window
  const failures = recentResults.filter(r => r === 'LOSE').length;

  // if tool predicted same side many times and failing often: anti-bias
  if (consPred >= settings.maxConsecutivePredictions && failures >= settings.failureThreshold) {
    if (settings.flipOnFail) {
      result.code = flip(result.code);
      result.strength = Math.max(0.45, result.strength * 0.78);
      result.detail.push({ source: 'ANTI_BIAS', action: 'flip', consPred, failures });
      result.meta = { antiBias: 'flipped' };
      return result;
    } else if (settings.softenOnFail) {
      result.strength = Math.max(0.35, result.strength * 0.7);
      result.detail.push({ source: 'ANTI_BIAS', action: 'soften', consPred, failures });
      result.meta = { antiBias: 'softened' };
      return result;
    }
  }

  // Trend-breaker: if actual sequence has large run (>=6), prefer its direction
  const r = rle(seq);
  if (r.length) {
    const last = r[r.length - 1];
    if (last.len >= 6 && result.code !== last.ch) {
      result.code = last.ch;
      result.strength = Math.min(0.95, 0.62 + last.len * 0.04);
      result.detail.push({ source: 'TREND_BREAKER', run: last.len });
      result.meta = { trendBreaker: true };
      return result;
    }
  }

  return result;
}

// ---------------------- ENGINE ----------------------
function engine(list, db) {
  // list: upstream normalized list
  const seq = buildSequenceFromList(list);
  const sums = buildSums(list);
  if (seq.length < 6) return { code: null, reason: 'not-enough-data' };

  // ewma update
  db.meta.ewma = ewma(db.meta.ewma || 0.5, seq[seq.length - 1] === 'T' ? 1 : 0);

  // pattern detectors
  const votes = runAllDetectors(seq, sums, db);

  // build markov
  const markovModels = buildMarkov(list, MARKOV_ORDER);
  const markovRes = markovPredict(markovModels, seq);

  // heuristics code (anti-ratio)
  const heurCode = (() => {
    const window = Math.min(20, seq.length);
    const tcount = seq.slice(-window).filter(x => x === 'T').length;
    const ratio = tcount / window;
    if (ratio >= 0.82) return 'X';
    if (ratio <= 0.18) return 'T';
    return null;
  })();

  // combine deterministic
  let comb = combineDeterministic(votes, markovRes, db.meta.ewma, heurCode, db);

  // apply anti-bias/trend
  comb = antiBiasAndTrend(comb, seq, db);

  // final output fields
  return {
    code: comb.code,
    strength: comb.strength,
    tiLe: (comb.strength * 100).toFixed(1) + '%',
    detail: comb.detail,
    regime: detectRegime(seq),
    votes: votes
  };
}

// ---------------------- REGIME DETECTION ----------------------
function detectRegime(seq) {
  if (!seq || seq.length < 6) return 'COLD';
  const tail = seq.slice(-30);
  const r = rle(tail);
  const last = r[r.length - 1];
  if (last && last.len >= 6) return 'PERSIST';
  // alternation
  let alt = true;
  for (let i = tail.length - 1; i >= 2; i--) {
    if (tail[i] === tail[i - 2]) { alt = false; break; }
  }
  if (alt) return 'ALTERNATE';
  const tRatio = tail.filter(x => x === 'T').length / tail.length;
  if (tRatio > 0.65) return 'TREND_T';
  if (tRatio < 0.35) return 'TREND_X';
  return 'CHAOS';
}

// ---------------------- PROCESSING LOOP ----------------------
const axiosInst = axios.create({ timeout: 8000 });

async function fetchUpstream(game) {
  const url = APIS[game];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axiosInst.get(url);
      const arr = res.data && (res.data.data || res.data.list) ? (res.data.data || res.data.list) : res.data;
      const norm = normalizeUpstream(arr);
      // ensure chronological: ascending SessionId
      norm.sort((a, b) => (Number(a.SessionId || 0) - Number(b.SessionId || 0)));
      return norm;
    } catch (e) {
      await new Promise(r => setTimeout(r, 300 + attempt * 200));
    }
  }
  return [];
}

async function processGameOnce(game) {
  const list = await fetchUpstream(game);
  if (!list || !list.length) return;
  const latest = list[list.length - 1];
  const session = safeInt(latest.SessionId);
  const db = loadDB(game);
  if (db.lastProcessed === session) return; // already handled

  // finalize previous pending record if applicable
  const prev = db.history.length ? db.history[db.history.length - 1] : null;
  if (prev && prev.phienDuDoan && prev.phienDuDoan === session) {
    const actual = itemResult(latest);
    prev.ketQua = actual;
    prev.ketQuaLabel = label(actual);
    prev.trangThai = (!prev.DU_DOAN_CODE) ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
    // update stats
    db.stats.total = (db.stats.total || 0) + 1;
    if (prev.trangThai === 'ĐÚNG') db.stats.wins = (db.stats.wins || 0) + 1;
    else db.stats.losses = (db.stats.losses || 0) + 1;
    // update pattern stats info
    if (prev.patternName) {
      db.patterns = db.patterns || {};
      db.patterns._map = db.patterns._map || {};
      db.patterns._map[prev.patternName] = db.patterns._map[prev.patternName] || { correct: 0, total: 0 };
      db.patterns._map[prev.patternName].total++;
      if (prev.trangThai === 'ĐÚNG') db.patterns._map[prev.patternName].correct++;
    }
    saveDB(game, db);
  }

  // run engine on current list
  const out = engine(list, db);
  // create entry deterministic
  const entry = {
    phien: session,
    xucXac: itemDice(latest),
    tong: latest.DiceSum,
    ketQua: itemResult(latest),
    ketQuaLabel: label(itemResult(latest)),
    phienDuDoan: session + 1,
    DU_DOAN_CODE: out.code,
    DU_DOAN: out.code ? label(out.code) : null,
    TI_LE: out.tiLe,
    patternName: out.detail && out.detail.map(d => d.source).join('+'),
    regime: out.regime,
    trangThai: 'ĐANG CHỜ',
    meta: { createdAt: now(), votes: out.votes || [], combDetail: out.detail || [] }
  };

  db.history.push(entry);
  if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);
  db.lastProcessed = session;
  db.meta.events = db.meta.events || [];
  db.meta.events.push({ at: now(), type: 'predict', session, code: out.code, tiLe: out.tiLe });
  saveDB(game, db);
}

// loop
setInterval(() => { processGameOnce('md5').catch(e => console.error(e)); processGameOnce('taixiu').catch(e => console.error(e)); }, POLL_INTERVAL_MS);

// ---------------------- ROUTES ----------------------
app.get('/', (req, res) => {
  res.send(`<div style="font-family:system-ui,Arial;padding:18px">
    <h2>HOANG VIP CUEJC-VIP</h2>
    <ul>
      <li><a href="/api/predict/md5">/api/predict/md5</a></li>
      <li><a href="/api/predict/taixiu">/api/predict/taixiu</a></li>
      <li><a href="/api/history/md5?limit=50">/api/history/md5</a></li>
      <li><a href="/api/history/taixiu?limit=50">/api/history/taixiu</a></li>
    </ul></div>`);
});

// analyze arbitrary sequence
app.get('/api/analyze', (req, res) => {
  const seqStr = String(req.query.seq || '').toUpperCase().replace(/[^TX]/g, '');
  if (seqStr.length < 4) return res.status(400).json({ success: false, error: 'seq >=4 required' });
  const seq = seqStr.split('');
  const db = loadDB('md5');
  const outVotes = runAllDetectors(seq, [], db);
  const markovRes = { code: null, pT: 0.5, order: 0 }; // no markov for synthetic seq
  const comb = combineDeterministic(outVotes, markovRes, 0.5, null, db);
  const final = antiBiasAndTrend(comb, seq, db);
  res.json({ success: true, seq: seqStr, votes: outVotes, combined: final });
});

// on-demand predict (force compute once and return latest entry)
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!['md5', 'taixiu'].includes(game)) return res.status(400).json({ success: false, error: 'invalid game' });
  try {
    await processGameOnce(game);
    const db = loadDB(game);
    const latest = db.history.length ? db.history[db.history.length - 1] : null;
    if (!latest) return res.status(204).json({ success: false, error: 'no history yet' });
    return res.json({ success: true, game, entry: latest });
  } catch (e) { console.error(e); return res.status(500).json({ success: false, error: e && e.message }); }
});

app.get('/api/simple/:game', (req, res) => {
  const game = req.params.game;
  if (!['md5', 'taixiu'].includes(game)) return res.status(400).json({ success: false, error: 'invalid game' });
  const db = loadDB(game);
  const latest = db.history.length ? db.history[db.history.length - 1] : null;
  if (!latest) return res.status(204).send();
  res.json({
    phien: latest.phien,
    tong: latest.tong,
    ketQua: latest.ketQua,
    phienDuDoan: latest.phienDuDoan,
    duDoan: latest.DU_DOAN,
    tiLe: latest.TI_LE
  });
});

app.get('/api/history/:game', (req, res) => {
  const game = req.params.game;
  if (!['md5', 'taixiu'].includes(game)) return res.status(400).json({ success: false, error: 'invalid game' });
  const db = loadDB(game);
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
  res.json({ success: true, game, count: db.history.length, items: db.history.slice(-limit).reverse() });
});

// admin force tick
app.post('/admin/force-tick/:game', async (req, res) => {
  const game = req.params.game;
  if (!['md5', 'taixiu'].includes(game)) return res.status(400).json({ success: false, error: 'invalid game' });
  try {
    await processGameOnce(game);
    return res.json({ success: true, msg: 'tick executed' });
  } catch (e) { return res.status(500).json({ success: false, error: e && e.message }); }
});

// admin: view patterns & detectors
app.get('/admin/patterns/:game', (req, res) => {
  const game = req.params.game;
  if (!['md5', 'taixiu'].includes(game)) return res.status(400).json({ success: false, error: 'invalid game' });
  const db = loadDB(game);
  res.json({ success: true, patternsCount: PATTERN_DETECTORS.length, recentPatterns: db.patterns.list, patternMap: db.patterns._map || {} });
});

// admin: stats
app.get('/admin/stats/:game', (req, res) => {
  const game = req.params.game;
  const db = loadDB(game);
  const m = db.meta || {};
  const winRate = db.stats.total ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) + '%' : 'N/A';
  res.json({ success: true, stats: db.stats, meta: m, winRate });
});

// admin: losing chains detect
app.get('/admin/losing-chains/:game', (req, res) => {
  const game = req.params.game;
  const window = Number(req.query.window) || 100;
  const db = loadDB(game);
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
  res.json({ success: true, window, chains });
});

// admin: set anti-bias settings
app.post('/admin/bias/:game', (req, res) => {
  const game = req.params.game;
  const body = req.body || {};
  const db = loadDB(game);
  db.settings = db.settings || {};
  db.settings.antiBias = db.settings.antiBias || {};
  for (const k of ['maxConsecutivePredictions', 'failureWindow', 'failureThreshold', 'flipOnFail', 'softenOnFail']) {
    if (body[k] !== undefined) db.settings.antiBias[k] = body[k];
  }
  saveDB(game, db);
  res.json({ success: true, settings: db.settings.antiBias });
});

// ---------------------- START ----------------------
app.listen(PORT, () => {
  console.log(`HOANG VIP CUEJC-VIP server started on port ${PORT} — deterministic pattern engine active`);
});
