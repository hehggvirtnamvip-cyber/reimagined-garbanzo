/**
 * ========================================================================
 * HOANG VIP WIN — BACKEND TÁI DỰNG THEO SPEC CÔNG KHAI
 * ========================================================================
 * API:
 *   GET /api/predict/:game     — full (18 algorithms, regime, distribution, guard)
 *   GET /api/simple/:game      — rút gọn
 *   GET /api/history/:game     — items
 *   GET /api/history/all       — all games + algoStats/Weights/byRegime
 *   GET /health                — trạng thái
 *   GET /:game                 — dashboard (không lộ thuật toán)
 *
 * Công thức tái dựng khớp dữ liệu công khai:
 *   adaptiveWeight: n<15→1; else exp(5*(a-0.5))
 *   regime 30 phiên: entropy, transitionRate, maxStreak
 *   bias penalty: max(0.7, 1-3*max(0,|bias|-0.1))
 *   distribution 50: đếm T/X
 *   balanceGuard: pX = X/(T+X) trên 50 bản ghi
 *
 * KHÔNG lộ thuật toán ra UI/HTML/response công khai.
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

// ============ HELPERS ============
const now = () => new Date().toISOString();
const safeInt = (x, def = 0) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; };
const labelFromTX = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);

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

// ============ DB ============
function defaultDB() {
  return {
    version: 'WIN',
    createdAt: now(), updatedAt: now(),
    history: [],
    // Algo stats: mỗi module { total, wins, predictions, tCount, xCount, lastSignal }
    algoStats: {},
    // Algo weights cache
    algoWeights: {},
    // byRegime: { BỆT: {total, wins}, RANDOM: {...}, HỖN_HỢP: {...} }
    byRegime: {},
    // byType: { patternLabel: {total, wins} }
    byType: {},
    lastProcessedSession: null,
    balanceGuard: { applied: false, side: null, pX: null }
  };
}
function migrateDB(db) {
  if (!db || typeof db !== 'object') return defaultDB();
  const def = defaultDB();
  for (const k in def) if (db[k] === undefined || db[k] === null) db[k] = def[k];
  if (!Array.isArray(db.history)) db.history = [];
  if (!db.algoStats || typeof db.algoStats !== 'object') db.algoStats = {};
  if (!db.algoWeights || typeof db.algoWeights !== 'object') db.algoWeights = {};
  if (!db.byRegime || typeof db.byRegime !== 'object') db.byRegime = {};
  if (!db.byType || typeof db.byType !== 'object') db.byType = {};
  if (!db.balanceGuard || typeof db.balanceGuard !== 'object') db.balanceGuard = def.balanceGuard;
  db.history = db.history.filter(h => h && typeof h === 'object' && h.phien !== undefined);
  return db;
}
function loadDatabase(game) {
  const db = safeReadJson(DB_FILES[game]) || defaultDB();
  return migrateDB(db);
}
function saveDatabase(game, db) {
  db.updatedAt = now();
  safeAtomicWrite(DB_FILES[game], db);
}

// ========================================================================
// 🎯 CORE FORMULAS (KHỚP DỮ LIỆU CÔNG KHAI)
// ========================================================================

// 4. Adaptive weight
function adaptiveWeight(wins, total) {
  if (total < 15) return 1;
  return Math.exp(5 * (wins / total - 0.5));
}

// 5. Regime trên 30 phiên
function analyzeRegime(seq30) {
  if (!seq30 || seq30.length < 5) {
    return { entropy: 0, transitionRate: 0, maxStreak: 0, type: 'RANDOM', confidence: 0.5 };
  }
  const n = seq30.length;
  const tCount = seq30.filter(x => x === 'T').length;
  const p = tCount / n;
  const entropy = (p === 0 || p === 1) ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);

  let transitions = 0;
  for (let i = 1; i < n; i++) if (seq30[i] !== seq30[i - 1]) transitions++;
  const transitionRate = n > 1 ? transitions / (n - 1) : 0;

  let maxStreak = 1, curStreak = 1;
  for (let i = 1; i < n; i++) {
    if (seq30[i] === seq30[i - 1]) curStreak++;
    else curStreak = 1;
    if (curStreak > maxStreak) maxStreak = curStreak;
  }

  let type = 'HỖN_HỢP';
  if (maxStreak >= 5) type = 'BỆT';
  else if (transitionRate >= 0.45 && transitionRate <= 0.55) type = 'RANDOM';

  let confidence = 0.5;
  if (type === 'BỆT') confidence = Math.min(1, maxStreak / 10);

  return {
    entropy: Number(entropy.toFixed(4)),
    transitionRate: Number(transitionRate.toFixed(4)),
    maxStreak,
    type,
    confidence: Number(confidence.toFixed(2))
  };
}

// 6. Bias penalty
function computeBiasPenalty(moduleStats) {
  if (!moduleStats || moduleStats.predictions === 0) return { bias: 0, penalty: 1 };
  const bias = (moduleStats.tCount / moduleStats.predictions) - 0.5;
  const penalty = Math.max(0.7, 1 - 3 * Math.max(0, Math.abs(bias) - 0.1));
  return { bias: Number(bias.toFixed(3)), penalty: Number(penalty.toFixed(4)) };
}

// 7. Distribution 50 bản ghi
function computeDistribution(history50) {
  let tai = 0, xiu = 0;
  for (const h of history50) {
    if (h.DU_DOAN_CODE === 'T') tai++;
    else if (h.DU_DOAN_CODE === 'X') xiu++;
  }
  return { tai, xiu, ratio: `${tai}/${xiu}` };
}

// 8. Balance Guard — pX từ 50 bản ghi
function computeBalanceGuard(history50) {
  let t = 0, x = 0;
  for (const h of history50) {
    if (h.DU_DOAN_CODE === 'T') t++;
    else if (h.DU_DOAN_CODE === 'X') x++;
  }
  const total = t + x;
  if (total < 20) return { applied: false, side: null, pX: null };
  const pX = x / total;
  return { pX: Number(pX.toFixed(4)), tCount: t, xCount: x, total };
}

// ========================================================================
// 🎯 16 BASE MODULES + META + ENSEMBLE
// ========================================================================

// Helper: chuỗi T/X
function toSeq(history, field = 'DU_DOAN_CODE') {
  return history.map(h => h[field]).filter(Boolean);
}
function inputSeq(history) {
  return history.map(h => {
    const sum = h.tong;
    if (!sum || sum < 3) return null;
    return sum >= 11 ? 'T' : 'X';
  }).filter(Boolean);
}

// 9.1 STREAK
function modStreak(seq, regime) {
  if (seq.length < 3) return { code: null, confidence: 0, reason: 'no_signal' };
  const last = seq[seq.length - 1];
  let len = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === last) len++; else break;
  }
  if (len < 3) return { code: null, confidence: 0, reason: 'no_signal' };
  // Bệt 3-5: theo; 6+: nghi gãy
  if (len <= 5) {
    return { code: last, confidence: Number((0.55 + (len - 3) * 0.06).toFixed(2)), label: `BỆT${len}` };
  }
  return { code: flip(last), confidence: Number(Math.min(0.58 + (len - 6) * 0.04, 0.78).toFixed(2)), label: `BỆT${len}_GÃY` };
}

// 9.2 CAU
function modCau(seq) {
  if (seq.length < 5) return { code: null, confidence: 0, reason: 'no_signal' };
  const s = seq.join('');
  const patterns = [
    { tail: 'TXXTXX', next: 'T', label: 'CẦU_1_2_1', conf: 0.70 },
    { tail: 'XTTXTT', next: 'X', label: 'CẦU_1_2_1', conf: 0.70 },
    { tail: 'TTXTTX', next: 'T', label: 'CẦU_2_1_2', conf: 0.65 },
    { tail: 'XXTXXT', next: 'X', label: 'CẦU_2_1_2', conf: 0.65 },
    { tail: 'TTXXTT', next: 'X', label: 'CẦU_2_2', conf: 0.68 },
    { tail: 'XXTTXX', next: 'T', label: 'CẦU_2_2', conf: 0.68 },
    { tail: 'TTTXXX', next: 'T', label: 'CẦU_3_3', conf: 0.72 },
    { tail: 'XXXTTT', next: 'X', label: 'CẦU_3_3', conf: 0.72 },
    { tail: 'TXXTX', next: 'X', label: 'CẦU_1_2_1', conf: 0.62 },
    { tail: 'XTTXT', next: 'T', label: 'CẦU_1_2_1', conf: 0.62 },
    { tail: 'TXXXT', next: 'X', label: 'CẦU_1_3_1', conf: 0.60 },
    { tail: 'XTTTX', next: 'T', label: 'CẦU_1_3_1', conf: 0.60 }
  ];
  for (const p of patterns) {
    if (s.endsWith(p.tail)) {
      return { code: p.next, confidence: p.conf, label: p.label };
    }
  }
  return { code: null, confidence: 0, reason: 'no_signal' };
}

// 9.3 CAU_TAI
function modCauTai(seq) {
  if (seq.length < 4) return { code: null, confidence: 0, reason: 'no_signal' };
  const last = seq[seq.length - 1];
  let len = 1;
  for (let i = seq.length - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
  // TÀI_SAU_BỆT_X: sau bệt X → Tài
  if (last === 'X' && len >= 3 && len <= 6) {
    return { code: 'T', confidence: 0.68, label: 'TÀI_SAU_BỆT_X' };
  }
  return { code: null, confidence: 0, reason: 'no_signal' };
}

// 9.4 CAU_XIU
function modCauXiu(seq) {
  if (seq.length < 4) return { code: null, confidence: 0, reason: 'no_signal' };
  const last = seq[seq.length - 1];
  let len = 1;
  for (let i = seq.length - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
  // ĐẢO_BỆT_X3, X5
  if (last === 'X' && len >= 3 && len <= 7) {
    const conf = 0.58 + 0.03 * (len - 3);
    return { code: 'T', confidence: Number(conf.toFixed(2)), label: `ĐẢO_BỆT_X${len}` };
  }
  // TÀI_1_2_1: TXXTX → X
  if (seq.slice(-5).join('') === 'TXXTX') {
    return { code: 'X', confidence: 0.68, label: 'TÀI_1_2_1' };
  }
  return { code: null, confidence: 0, reason: 'no_signal' };
}

// 9.5 MARKOV bậc k
function modMarkov(seq, order) {
  if (seq.length < order + 3) return { code: null, confidence: 0, reason: 'no_signal' };
  const counts = { T: 0, X: 0 };
  const key = seq.slice(-order).join('');
  for (let i = order; i < seq.length; i++) {
    if (seq.slice(i - order, i).join('') === key) {
      counts[seq[i]]++;
    }
  }
  const total = counts.T + counts.X;
  if (total < 3) return { code: null, confidence: 0, reason: 'no_signal' };
  const next = counts.T >= counts.X ? 'T' : 'X';
  const prob = Math.max(counts.T, counts.X) / total;
  // Scale: 0.5 -> 0.5, 1.0 -> 0.75 (thực nghiệm)
  const confidence = 0.5 + (prob - 0.5) * 0.5;
  return { code: next, confidence: Number(confidence.toFixed(2)), label: `MARKOV_O${order}`, samples: total };
}

// 9.6 NGRAM
function modNgram(seq, k) {
  if (seq.length < k + 3) return { code: null, confidence: 0, reason: 'no_signal' };
  const key = seq.slice(-k).join('');
  const counts = { T: 0, X: 0 };
  let total = 0;
  for (let i = k; i < seq.length; i++) {
    if (seq.slice(i - k, i).join('') === key) {
      counts[seq[i]]++;
      total++;
    }
  }
  if (total < 2) return { code: null, confidence: 0, reason: 'no_signal' };
  const next = counts.T >= counts.X ? 'T' : 'X';
  const prob = Math.max(counts.T, counts.X) / total;
  const confidence = 0.5 + (prob - 0.5) * 0.55; // co khác markov theo spec
  return { code: next, confidence: Number(confidence.toFixed(3)), label: `NGRAM_${k}`, samples: total };
}

// 9.7 BAYESIAN
function modBayesian(seq, window = 4) {
  if (seq.length < window + 2) return { code: null, confidence: 0, reason: 'no_signal' };
  const recent = seq.slice(-window);
  const tRecent = recent.filter(x => x === 'T').length;
  // Prior Laplace
  const alpha = 1, beta = 1;
  const pT = (tRecent + alpha) / (window + alpha + beta);
  const next = pT >= 0.5 ? 'T' : 'X';
  const conf = Math.abs(pT - 0.5) + 0.5;
  return { code: next, confidence: Number(conf.toFixed(2)), label: `BAYES_${window}`, pT: Number(pT.toFixed(3)) };
}

// 9.8 TREND
function modTrend(seq) {
  if (seq.length < 8) return { code: null, confidence: 0, reason: 'no_signal' };
  const recent = seq.slice(-8);
  const tCount = recent.filter(x => x === 'T').length;
  if (tCount === 5 || tCount === 6) {
    const next = tCount >= 5 ? 'T' : 'X';
    return { code: next, confidence: 0.58, label: next === 'T' ? 'TREND_T' : 'TREND_X' };
  }
  return { code: null, confidence: 0, reason: 'no_signal' };
}

// 9.9 LSTM_SIM
function modLstmSim(seq) {
  if (seq.length < 10) return { code: null, confidence: 0, reason: 'no_signal' };
  const recent = seq.slice(-10);
  const transitions = recent.filter((v, i) => i > 0 && v !== recent[i - 1]).length;
  if (transitions >= 6 && transitions <= 8) {
    // Random pattern → không tin
    return { code: null, confidence: 0, reason: 'no_signal', label: 'LSTM_LOW' };
  }
  const tCount = recent.filter(x => x === 'T').length;
  const next = tCount >= 5 ? 'T' : 'X';
  return { code: next, confidence: 0.55, label: 'LSTM_SIM' };
}

// 9.10 ARIMA — thực nghiệm thiên X
function modArima(seq) {
  if (seq.length < 15) return { code: null, confidence: 0, reason: 'no_signal' };
  const recent = seq.slice(-15);
  const tCount = recent.filter(x => x === 'T').length;
  // ARIMA theo spec thiên về X
  if (tCount >= 9) {
    return { code: 'X', confidence: 0.55, label: 'ARIMA_P5' };
  }
  return { code: 'X', confidence: 0.52, label: 'ARIMA_P5' };
}

// 9.11 KALMAN
function modKalman(seq) {
  if (seq.length < 6) return { code: null, confidence: 0, reason: 'no_signal' };
  const tCount = seq.slice(-6).filter(x => x === 'T').length;
  const state = tCount / 6;
  const next = state >= 0.5 ? 'T' : 'X';
  const conf = Math.min(0.75, 0.5 + Math.abs(state - 0.5) * 0.6);
  const label = conf < 0.55 ? 'KALMAN_LOW' : 'KALMAN';
  return { code: next, confidence: Number(conf.toFixed(2)), label };
}

// 9.12 RANDOM_FOREST — low signal
function modRandomForest(seq) {
  if (seq.length < 12) return { code: null, confidence: 0, reason: 'no_signal' };
  return { code: null, confidence: 0, reason: 'no_signal', label: 'RF_LOW' };
}

// 9.13 GRADIENT_BOOST — low signal
function modGradientBoost(seq) {
  if (seq.length < 12) return { code: null, confidence: 0, reason: 'no_signal' };
  return { code: null, confidence: 0, reason: 'no_signal', label: 'GB_LOW' };
}

// 9.14 CHAOS
function modChaos(seq) {
  if (seq.length < 10) return { code: null, confidence: 0, reason: 'no_signal' };
  const recent = seq.slice(-10);
  const tCount = recent.filter(x => x === 'T').length;
  const next = tCount < 5 ? 'X' : 'T';
  return { code: next, confidence: 0.52, label: 'CHAOS' };
}

// 9.15 FOURIER
function modFourier(seq) {
  if (seq.length < 20) return { code: null, confidence: 0, reason: 'no_signal' };
  const period = 8;
  const phase = seq.length % period;
  const template = seq.slice(seq.length - period);
  const tFrac = template.filter(x => x === 'T').length / period;
  let conf = 0.47 + Math.abs(tFrac - 0.5) * 0.4;
  const next = tFrac >= 0.5 ? 'T' : 'X';
  const label = conf < 0.55 ? 'FOURIER_LOW' : 'FOURIER_K1';
  return { code: next, confidence: Number(conf.toFixed(3)), label };
}

// 9.16 ENTROPY
function modEntropy(seq) {
  if (seq.length < 10) return { code: null, confidence: 0, reason: 'no_signal' };
  const recent = seq.slice(-10);
  const p = recent.filter(x => x === 'T').length / 10;
  const H = (p === 0 || p === 1) ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
  if (H > 0.9) return { code: null, confidence: 0, reason: 'no_signal', label: 'ENTROPY_HIGH' };
  const next = p >= 0.5 ? 'T' : 'X';
  return { code: next, confidence: 0.55, label: 'ENTROPY_HIGH', entropy: Number(H.toFixed(3)) };
}

// ========================================================================
// 🎯 META_LEARNER + ENSEMBLE
// ========================================================================

function modMetaLearner(moduleOutputs, regime) {
  // Chọn module đáng tin theo regime
  const valid = moduleOutputs.filter(m => m.code && m.confidence >= 0.55);
  if (valid.length === 0) return { code: null, confidence: 0, reason: 'no_signal' };

  // Trong regime BỆT ưu tiên STREAK/CAU_XIU/CAU_TAI
  let priority = [];
  if (regime.type === 'BỆT') priority = ['STREAK', 'CAU_TAI', 'CAU_XIU'];
  else if (regime.type === 'RANDOM') priority = ['MARKOV_O3', 'NGRAM_3', 'BAYES_4'];
  else priority = ['CAU', 'MARKOV_O4', 'TREND'];

  const ranked = valid.slice().sort((a, b) => {
    const pa = priority.findIndex(p => a.name?.includes(p));
    const pb = priority.findIndex(p => b.name?.includes(p));
    if (pa !== -1 && pb !== -1) return pa - pb;
    if (pa !== -1) return -1;
    if (pb !== -1) return 1;
    return b.confidence - a.confidence;
  });

  const top = ranked[0];
  const label = `META_${regime.type}`;
  return { code: top.code, confidence: top.confidence, label };
}

function modEnsemble(moduleOutputs, weights, penalties) {
  const valid = moduleOutputs.filter(m => m.code);
  if (valid.length === 0) return { code: null, confidence: 0, reason: 'no_signal' };

  // Đếm vote có trọng số
  let tVote = 0, xVote = 0;
  for (const m of valid) {
    const w = weights[m.name] || 1;
    const p = penalties[m.name] || 1;
    const contrib = m.confidence * w * p;
    if (m.code === 'T') tVote += contrib;
    else if (m.code === 'X') xVote += contrib;
  }

  const total = tVote + xVote;
  if (total === 0) return { code: null, confidence: 0, reason: 'no_signal' };

  const next = tVote >= xVote ? 'T' : 'X';
  const rawProb = Math.max(tVote, xVote) / total;

  // Agreement factor
  const agreeing = valid.filter(m => m.code === next).length;
  const agreement = agreeing / valid.length;

  // Nếu gần 50/50 → TOO_CLOSE
  if (Math.abs(tVote - xVote) / total < 0.08) {
    return { code: next, confidence: 0.55, label: 'ENSEMBLE_TOO_CLOSE', agreement: Number(agreement.toFixed(2)), nModules: valid.length };
  }

  // Ensemble confidence: scale mạnh hơn trung bình (khớp spec: 4X cùng nhau avg 0.62 → 0.82)
  const avgConf = valid.reduce((a, m) => a + m.confidence, 0) / valid.length;
  let conf = 0.5 + (rawProb - 0.5) * 0.9 + agreement * 0.12;
  conf = Math.max(0.5, Math.min(0.92, conf));

  const label = `ENSEMBLE_${valid.length}v`;
  return { code: next, confidence: Number(conf.toFixed(2)), label, agreement: Number(agreement.toFixed(2)), nModules: valid.length, avgConf: Number(avgConf.toFixed(2)) };
}

// ========================================================================
// 🎯 PIPELINE — chạy 18 module + ensemble + gate
// ========================================================================

function runFullPipeline(db, inputSeqArr, game) {
  const regime = analyzeRegime(inputSeqArr.slice(-30));
  const moduleOutputs = [];

  // Base 16
  const streak = modStreak(inputSeqArr, regime);
  moduleOutputs.push({ name: 'STREAK', ...streak });

  const cau = modCau(inputSeqArr);
  moduleOutputs.push({ name: 'CAU', ...cau });

  const cauTai = modCauTai(inputSeqArr);
  moduleOutputs.push({ name: 'CAU_TAI', ...cauTai });

  const cauXiu = modCauXiu(inputSeqArr);
  moduleOutputs.push({ name: 'CAU_XIU', ...cauXiu });

  for (const o of [3, 4, 5]) {
    const m = modMarkov(inputSeqArr, o);
    moduleOutputs.push({ name: `MARKOV_O${o}`, ...m });
  }

  for (const k of [3, 4, 5]) {
    const m = modNgram(inputSeqArr, k);
    moduleOutputs.push({ name: `NGRAM_${k}`, ...m });
  }

  for (const w of [4, 5]) {
    const m = modBayesian(inputSeqArr, w);
    moduleOutputs.push({ name: `BAYES_${w}`, ...m });
  }

  moduleOutputs.push({ name: 'TREND', ...modTrend(inputSeqArr) });
  moduleOutputs.push({ name: 'LSTM_SIM', ...modLstmSim(inputSeqArr) });
  moduleOutputs.push({ name: 'ARIMA', ...modArima(inputSeqArr) });
  moduleOutputs.push({ name: 'KALMAN', ...modKalman(inputSeqArr) });
  moduleOutputs.push({ name: 'RANDOM_FOREST', ...modRandomForest(inputSeqArr) });
  moduleOutputs.push({ name: 'GRADIENT_BOOST', ...modGradientBoost(inputSeqArr) });
  moduleOutputs.push({ name: 'CHAOS', ...modChaos(inputSeqArr) });
  moduleOutputs.push({ name: 'FOURIER', ...modFourier(inputSeqArr) });
  moduleOutputs.push({ name: 'ENTROPY', ...modEntropy(inputSeqArr) });

  // Weights + penalties
  const weights = {};
  const penalties = {};
  const algoStats = {};
  for (const m of moduleOutputs) {
    const st = db.algoStats[m.name] || { total: 0, wins: 0, predictions: 0, tCount: 0, xCount: 0 };
    weights[m.name] = adaptiveWeight(st.wins, st.total);
    penalties[m.name] = computeBiasPenalty(st).penalty;
    algoStats[m.name] = {
      total: st.total,
      wins: st.wins,
      accuracy: st.total > 0 ? Number((st.wins / st.total * 100).toFixed(2)) : 0,
      bias: Number(computeBiasPenalty(st).bias.toFixed(3)),
      penalty: Number(penalties[m.name].toFixed(4)),
      weight: Number(weights[m.name].toFixed(4)),
      skips: st.skips || 0,
      label: m.label || null,
      code: m.code || null,
      confidence: m.confidence || 0
    };
  }

  // Meta learner
  const meta = modMetaLearner(moduleOutputs, regime);
  moduleOutputs.push({ name: 'META_LEARNER', ...meta, isMeta: true });

  // Ensemble (chỉ base modules)
  const baseOutputs = moduleOutputs.filter(m => !m.isMeta);
  const ensemble = modEnsemble(baseOutputs, weights, penalties);
  moduleOutputs.push({ name: 'ENSEMBLE', ...ensemble, isEnsemble: true });

  // ========== FINAL GATE ==========
  // 1. Chỉ tín hiệu khi >= 2 base modules đồng thuận
  // 2. Confidence >= 0.58
  // 3. Meta + Ensemble cùng hướng
  const activeBase = baseOutputs.filter(m => m.code && m.confidence >= 0.55);
  let finalCode = null;
  let finalReason = '';
  let finalConf = 0;
  let finalLabel = '';

  if (activeBase.length < 2) {
    finalReason = 'INSUFFICIENT_CONSENSUS';
  } else if (ensemble.code && meta.code && ensemble.code === meta.code) {
    finalCode = ensemble.code;
    finalConf = ensemble.confidence;
    finalLabel = ensemble.label || meta.label || 'ENSEMBLE';
    finalReason = `${meta.label || 'META'}+${ensemble.label || 'ENSEMBLE'}`;
  } else if (ensemble.code && ensemble.confidence >= 0.62) {
    finalCode = ensemble.code;
    finalConf = ensemble.confidence;
    finalLabel = ensemble.label || 'ENSEMBLE';
    finalReason = `ENSEMBLE_STRONG`;
  } else if (meta.code && meta.confidence >= 0.65) {
    finalCode = meta.code;
    finalConf = meta.confidence;
    finalLabel = meta.label;
    finalReason = `META_STRONG`;
  } else {
    finalReason = 'WAIT_SIGNAL';
  }

  // ========== BALANCE GUARD ==========
  const dist = computeDistribution(db.history.slice(-50));
  const guard = computeBalanceGuard(db.history.slice(-50));
  let balanceGuardApplied = false;
  let balanceGuardSide = null;

  if (guard.total >= 20 && guard.pX !== null) {
    // Nếu lệch mạnh về X (pX >= 0.62) → đổi sang Tài
    if (guard.pX >= 0.62 && finalCode !== 'T') {
      finalCode = 'T';
      finalConf = 0.65;
      finalLabel = `BALANCE_GUARD_T`;
      finalReason = `BALANCE_GUARD_T (pX=${guard.pX.toFixed(2)})`;
      balanceGuardApplied = true;
      balanceGuardSide = 'T';
    } else if (guard.pX <= 0.38 && finalCode !== 'X') {
      finalCode = 'X';
      finalConf = 0.65;
      finalLabel = `BALANCE_GUARD_X`;
      finalReason = `BALANCE_GUARD_X (pX=${guard.pX.toFixed(2)})`;
      balanceGuardApplied = true;
      balanceGuardSide = 'X';
    }
  }

  const shouldPredict = finalCode !== null && finalConf >= 0.58;

  return {
    regime,
    moduleOutputs,
    algoStats,
    weights,
    penalties,
    meta,
    ensemble,
    final: {
      code: shouldPredict ? finalCode : null,
      confidence: shouldPredict ? finalConf : 0,
      label: shouldPredict ? finalLabel : null,
      reason: finalReason,
      tiLe: shouldPredict ? (finalConf * 100).toFixed(1) + '%' : 'CHỜ'
    },
    distribution: dist,
    balanceGuard: {
      applied: balanceGuardApplied,
      side: balanceGuardSide,
      pX: guard.pX
    },
    shouldPredict
  };
}

// ========================================================================
// FETCH
// ========================================================================
async function fetchWithRetry(url, attempts = FETCH_RETRIES) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.get(url, { timeout: API_TIMEOUT_MS, headers: { 'User-Agent': 'HoangVipWin/1.0' } });
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
// EVALUATE PREVIOUS — cập nhật algoStats
// ========================================================================
function evaluatePrevious(db, currentSession, actual) {
  const prev = db.history[db.history.length - 1];
  if (!prev || safeInt(prev.phienDuDoan) !== currentSession) return;

  prev.ketQua = actual;
  prev.ketQuaLabel = labelFromTX(actual);

  // Update byRegime
  const reg = prev.regime?.type || 'HỖN_HỢP';
  if (!db.byRegime[reg]) db.byRegime[reg] = { total: 0, wins: 0 };
  if (prev.DU_DOAN_CODE) {
    db.byRegime[reg].total++;
    if (prev.DU_DOAN_CODE === actual) db.byRegime[reg].wins++;
  }

  // Update byType
  const pType = prev.pattern?.label || prev.pattern?.type;
  if (pType && pType !== 'NONE') {
    if (!db.byType[pType]) db.byType[pType] = { total: 0, wins: 0 };
    db.byType[pType].total++;
    if (prev.DU_DOAN_CODE === actual) db.byType[pType].wins++;
  }

  // Update algoStats cho từng module
  if (prev.algorithms && Array.isArray(prev.algorithms)) {
    for (const algo of prev.algorithms) {
      if (!algo.code) {
        // Skip — không có dự đoán
        if (!db.algoStats[algo.name]) db.algoStats[algo.name] = { total: 0, wins: 0, predictions: 0, tCount: 0, xCount: 0, skips: 0 };
        db.algoStats[algo.name].skips = (db.algoStats[algo.name].skips || 0) + 1;
        continue;
      }
      if (!db.algoStats[algo.name]) db.algoStats[algo.name] = { total: 0, wins: 0, predictions: 0, tCount: 0, xCount: 0, skips: 0 };
      const st = db.algoStats[algo.name];
      st.total++;
      st.predictions++;
      if (algo.code === 'T') st.tCount++;
      else if (algo.code === 'X') st.xCount++;
      if (algo.code === actual) st.wins++;
    }
  }

  // trangThai của entry hiện tại
  if (!prev.DU_DOAN_CODE) {
    prev.trangThai = 'BỎ QUA';
  } else {
    prev.trangThai = prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI';
  }
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

    const inputSeq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    if (inputSeq.length < 6) return;

    // Evaluate previous
    const actual = itemToResult(latest);
    evaluatePrevious(db, session, actual);

    // New prediction
    const pipeline = runFullPipeline(db, inputSeq, game);

    const newEntry = {
      phien: session,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: actual,
      ketQuaLabel: labelFromTX(actual),
      phienDuDoan: session + 1,
      DU_DOAN_CODE: pipeline.final.code,
      DU_DOAN: pipeline.final.code ? labelFromTX(pipeline.final.code) : 'CHỜ',
      TI_LE: pipeline.final.tiLe,
      pattern: { type: pipeline.final.label || 'NONE', label: pipeline.final.label },
      regime: pipeline.regime,
      reason: pipeline.final.reason,
      algorithms: pipeline.moduleOutputs.map(m => ({
        name: m.name,
        code: m.code || null,
        confidence: m.confidence || 0,
        label: m.label || null,
        reason: m.reason || null
      })),
      distribution: pipeline.distribution,
      balanceGuard: pipeline.balanceGuard,
      trangThai: 'ĐANG CHỜ',
      thoiGian: now()
    };

    db.history.push(newEntry);
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);
    db.lastProcessedSession = session;
    saveDatabase(game, db);

    console.log(`[TICK] ${game} #${session} ${itemToSum(latest)}(${labelFromTX(actual)}) → ${newEntry.DU_DOAN} [${newEntry.reason}]`);
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
    await Promise.all(Object.keys(APIS).map(async g => { try { await processGameTick(g); } catch {} }));
    if (pollingActive) setTimeout(tick, POLL_INTERVAL_MS);
  }
  tick();
}

// ========================================================================
// FORMAT (SAFE cho history — KHÔNG expose thuật toán chi tiết)
// ========================================================================
function formatHistoryItem(it) {
  if (!it) return null;
  return {
    phien: it.phien,
    xucXac: it.xucXac || [0, 0, 0],
    tong: it.tong ?? 0,
    ketQua: it.ketQua || null,
    ketQuaLabel: it.ketQuaLabel || labelFromTX(it.ketQua),
    phienDuDoan: it.phienDuDoan,
    duDoan: it.DU_DOAN || 'CHỜ',
    duDoanCode: it.DU_DOAN_CODE || null,
    tiLe: it.TI_LE || 'CHỜ',
    pattern: it.pattern?.type ? { type: it.pattern.type } : null,
    regime: it.regime ? { type: it.regime.type, maxStreak: it.regime.maxStreak, transitionRate: it.regime.transitionRate } : null,
    reason: it.reason || null,
    distribution: it.distribution || null,
    balanceGuard: it.balanceGuard || { applied: false, side: null, pX: null },
    trangThai: it.trangThai || null,
    thoiGian: it.thoiGian || null
  };
}

// ========================================================================
// API /api/predict/:game  — FULL
// ========================================================================
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ success: false, error: 'Invalid game' });
  try {
    const r = await fetchWithRetry(APIS[game]);
    const list = parseHistoryResponse(r.data);
    if (!list.length) return res.status(204).send();

    const inputSeq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const db = loadDatabase(game);
    const latest = list[list.length - 1];
    const cs = safeInt(latest.SessionId || latest.session);
    const pipeline = runFullPipeline(db, inputSeq, game);

    return res.json({
      success: true,
      game,
      phien: cs,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: itemToResult(latest),
      ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: cs + 1,
      duDoan: pipeline.final.code ? labelFromTX(pipeline.final.code) : 'CHỜ',
      duDoanCode: pipeline.final.code,
      tiLe: pipeline.final.tiLe,
      reason: pipeline.final.reason,
      regime: pipeline.regime,
      shouldPredict: pipeline.shouldPredict,
      balanceGuard: pipeline.balanceGuard,
      distribution: pipeline.distribution,
      algorithms: pipeline.moduleOutputs.map(m => ({
        name: m.name,
        code: m.code || null,
        confidence: m.confidence || 0,
        label: m.label || null,
        reason: m.reason || null
      })),
      thoiGian: now()
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ========================================================================
// API /api/simple/:game — RÚT GỌN
// ========================================================================
app.get('/api/simple/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ success: false, error: 'Invalid game' });
  try {
    const r = await fetchWithRetry(APIS[game]);
    const list = parseHistoryResponse(r.data);
    if (!list.length) return res.status(204).send();

    const inputSeq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const db = loadDatabase(game);
    const latest = list[list.length - 1];
    const cs = safeInt(latest.SessionId || latest.session);
    const pipeline = runFullPipeline(db, inputSeq, game);

    return res.json({
      game,
      phien: cs + 1, // phiên mục tiêu
      duDoan: pipeline.final.code ? labelFromTX(pipeline.final.code) : 'CHỜ',
      duDoanCode: pipeline.final.code,
      tiLe: pipeline.final.tiLe,
      regime: pipeline.regime.type,
      reason: pipeline.final.reason,
      updated: now()
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ========================================================================
// API /api/history/:game
// ========================================================================
app.get('/api/history/:game', (req, res) => {
  const game = req.params.game;
  if (game === 'all') return handleHistoryAll(req, res);
  if (!DB_FILES[game]) return res.status(400).json({ success: false, error: 'Invalid game' });
  const db = loadDatabase(game);
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 200)));
  const slice = db.history.slice(-limit).reverse();
  return res.json({
    success: true, game, count: slice.length, exportedAt: now(),
    items: slice.map(formatHistoryItem).filter(Boolean)
  });
});

// ========================================================================
// API /api/history/all
// ========================================================================
function handleHistoryAll(req, res) {
  const limit = Math.max(1, Math.min(2000, safeInt(req.query.limit, 500)));
  const result = { success: true, exportedAt: now(), limit, games: {} };
  for (const game of Object.keys(DB_FILES)) {
    try {
      const db = loadDatabase(game);
      const slice = db.history.slice(-limit).reverse();
      const last = db.history[db.history.length - 1];
      result.games[game] = {
        count: slice.length,
        currentRegime: last?.regime?.type || 'RANDOM',
        distribution: computeDistribution(db.history.slice(-50)),
        balanceGuard: last?.balanceGuard || { applied: false, side: null, pX: null },
        algoStats: db.algoStats,
        algoWeights: (() => {
          const w = {};
          for (const k in db.algoStats) {
            w[k] = Number(adaptiveWeight(db.algoStats[k].wins, db.algoStats[k].total).toFixed(4));
          }
          return w;
        })(),
        byType: db.byType,
        byRegime: db.byRegime,
        items: slice.map(formatHistoryItem).filter(Boolean)
      };
    } catch (e) {
      result.games[game] = { error: e.message };
    }
  }
  return res.json(result);
}
app.get('/api/history/all', handleHistoryAll);

// ========================================================================
// /health
// ========================================================================
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    version: 'WIN',
    uptime: process.uptime(),
    polling: pollingActive,
    pollMs: POLL_INTERVAL_MS,
    games: Object.keys(APIS),
    serverTime: now()
  });
});

// ========================================================================
// UI DASHBOARD — KHÔNG LỘ THUẬT TOÁN
// ========================================================================
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Trang không tồn tại.');

  const db = loadDatabase(game);
  const last = db.history[db.history.length - 1];
  const stats = last ? { total: 0, wins: 0 } : { total: 0, wins: 0 };

  // Aggregate
  let total = 0, wins = 0;
  for (const h of db.history) {
    if (h.DU_DOAN_CODE && h.trangThai === 'ĐÚNG') { total++; wins++; }
    else if (h.DU_DOAN_CODE && h.trangThai === 'SAI') total++;
  }
  const acc = total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00';

  const dist = computeDistribution(db.history.slice(-50));
  const regime = last?.regime || { type: 'RANDOM', maxStreak: 0, transitionRate: 0 };
  const guard = last?.balanceGuard || { applied: false };

  const rows = db.history.slice(-50).reverse();
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>HOANG VIP WIN - ${game.toUpperCase()}</title>
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:linear-gradient(135deg,#0a0e27,#0f172a 50%,#1a1f3a);
    color:#e6eef6;padding:12px;margin:0;min-height:100vh;}
  .header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;
    margin-bottom:14px;box-shadow:0 8px 24px rgba(59,130,246,.3);}
  h1{color:#fff;font-size:17px;margin:0;font-weight:700}
  .subtitle{color:#bfdbfe;font-size:11px;margin-top:4px}
  .signal-box{background:linear-gradient(135deg,#064e3b,#065f46);padding:14px;
    border-radius:12px;margin-bottom:14px;border:1px solid #10b981;}
  .signal-box .title{font-size:12px;color:#6ee7b7;font-weight:600;margin-bottom:8px}
  .signal-main{font-size:22px;font-weight:800;color:#fff}
  .signal-sub{font-size:11px;color:#a7f3d0;margin-top:4px}
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
    <h1>🎯 HOANG VIP WIN</h1>
    <div class="subtitle">Bàn: ${game.toUpperCase()} • Chỉ dự đoán khi có tín hiệu</div>
  </div>

  ${last && last.DU_DOAN_CODE ? `
  <div class="signal-box">
    <div class="title">🎯 TÍN HIỆU PHIÊN #${last.phienDuDoan}</div>
    <div class="signal-main ${last.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu'}">${last.DU_DOAN} — ${last.TI_LE}</div>
    <div class="signal-sub">${last.reason || ''}</div>
  </div>` : ''}

  <div class="stats-grid">
    <div class="stat-card"><div class="label">Dự đoán</div><div class="value blue">${total}</div></div>
    <div class="stat-card"><div class="label">Thắng</div><div class="value green">${wins}</div></div>
    <div class="stat-card"><div class="label">Thua</div><div class="value red">${total - wins}</div></div>
    <div class="stat-card"><div class="label">Acc</div><div class="value ${parseFloat(acc) >= 60 ? 'green' : (parseFloat(acc) >= 50 ? 'yellow' : 'red')}">${acc}%</div></div>
    <div class="stat-card"><div class="label">T/X (50)</div><div class="value blue">${dist.ratio}</div></div>
    <div class="stat-card"><div class="label">Regime</div><div class="value yellow" style="font-size:13px">${regime.type}</div></div>
  </div>

  <div class="link-box">
    <div class="title">🔗 API</div>
    <div class="link-row"><span>${baseUrl}/api/predict/${game}</span><button class="copy-btn" onclick="copyText('${baseUrl}/api/predict/${game}', this)">Copy</button></div>
    <div class="link-row"><span>${baseUrl}/api/simple/${game}</span><button class="copy-btn" onclick="copyText('${baseUrl}/api/simple/${game}', this)">Copy</button></div>
    <div class="link-row"><span>${baseUrl}/api/history/all</span><button class="copy-btn" onclick="copyText('${baseUrl}/api/history/all', this)">Copy</button></div>
  </div>

  <div class="section-title">📊 50 phiên gần nhất</div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Phiên</th><th>XX</th><th>Tổng</th><th>KQ</th><th>Dự đoán</th>
        <th>Tỉ lệ</th><th>Regime</th><th>TT</th>
      </tr></thead>
      <tbody>
        ${rows.map(it => {
          const dice = (it.xucXac || []).join('-');
          const kq = it.ketQuaLabel || labelFromTX(it.ketQua) || '';
          const kqCls = it.ketQua === 'T' ? 'tai' : (it.ketQua === 'X' ? 'xiu' : '');
          const isWait = !it.DU_DOAN_CODE;
          const ddCls = isWait ? 'wait' : (it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu');
          const ttCls = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : (it.trangThai === 'BỎ QUA' ? 'wait' : 'cho'));
          return `<tr>
            <td class="session">${it.phien}</td>
            <td class="dice">${dice}</td>
            <td><span class="sum-badge">${it.tong || ''}</span></td>
            <td class="${kqCls}">${kq}</td>
            <td class="${ddCls}">${isWait ? 'CHỜ' : it.DU_DOAN}</td>
            <td class="ti-le">${it.TI_LE || '—'}</td>
            <td style="font-size:9px;color:#a5b4fc">${it.regime?.type || ''}</td>
            <td class="${ttCls}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <div style="text-align:center;font-size:10px;color:#475569;margin-top:14px">
    Auto refresh 10s • HOANG VIP WIN
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
  console.log(`🚀 HOANG VIP WIN — TÁI DỰNG THEO SPEC`);
  console.log(`========================================`);
  console.log(`Port: ${PORT} | Poll: ${POLL_INTERVAL_MS}ms`);
  console.log(`✅ 16 base modules + META_LEARNER + ENSEMBLE`);
  console.log(`✅ adaptiveWeight: n<15→1; else exp(5*(a-0.5))`);
  console.log(`✅ Regime 30 phiên (entropy/transition/maxStreak)`);
  console.log(`✅ BalanceGuard pX từ 50 bản ghi`);
  console.log(`✅ Distribution 50 bản ghi`);
  console.log(`✅ UI KHÔNG lộ thuật toán`);
  console.log(`Endpoints:`);
  console.log(`  /${Object.keys(APIS)[0]}                    (dashboard)`);
  console.log(`  /api/predict/:game        (full 18 algorithms)`);
  console.log(`  /api/simple/:game         (rút gọn)`);
  console.log(`  /api/history/all          (all games)`);
  console.log(`  /health                   (trạng thái)`);
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
