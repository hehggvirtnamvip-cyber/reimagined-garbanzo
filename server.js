/**
 * ========================================================================
 * HOANG VIP v10 - MEGA EVOLUTION - SINGLE FILE
 * ========================================================================
 * 15 THUẬT TOÁN CHẠY SONG SONG:
 *   1. STREAK         - Bắt bệt (4-7-8-10-11+)
 *   2. CAU            - Nhận diện 15+ loại cầu
 *   3. MARKOV         - Chuỗi Markov order 1-5
 *   4. NGRAM          - N-gram pattern 3-7
 *   5. BAYESIAN       - Xác suất có điều kiện
 *   6. TREND          - Xu hướng 20-50 phiên
 *   7. LSTM_SIM       - Giả lập LSTM bằng EWMA multi-scale
 *   8. ARIMA          - Auto-regressive integrated
 *   9. KALMAN         - Kalman filter 1D
 *  10. RANDOM_FOREST  - Ensemble of decision trees (simulated)
 *  11. GRADIENT_BOOST - AdaBoost-like boosting
 *  12. CHAOS          - Logistic map chaos theory
 *  13. FOURIER        - Frequency analysis
 *  14. ENTROPY        - Shannon entropy based
 *  15. META_LEARNER   - Adaptive meta-learner
 *
 * + REGIME DETECTION (bệt / cầu / random)
 * + BRIER SCORE calibration
 * + KELLY CRITERION position sizing
 * + CIRCUIT BREAKER (auto-stop khi thua nhiều)
 * + MODEL SNAPSHOTS + ROLLBACK
 * + WALK-FORWARD BACKTEST
 *
 * Run: npm i express axios && node server.js
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
const MAX_HISTORY = 3000;
const API_TIMEOUT_MS = 8000;
const FETCH_RETRIES = 3;
const MIN_CONFIDENCE = 0.55;
const MIN_ALGO_TOTAL = 15;      // Số phiên tối thiểu để algo được weight
const WARMUP = 50;
const BACKTEST_WINDOW = 200;
const SNAPSHOT_INTERVAL = 100;   // Snapshot mỗi 100 phiên

// Circuit breaker
const CB_LOSS_STREAK = 5;        // Thua 5 liên tiếp → tạm dừng
const CB_COOLDOWN = 10;          // Bỏ qua 10 phiên rồi tiếp

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
const SNAPSHOT_DIR = path.join(DB_DIR, 'snapshots');
try { if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true }); } catch (e) {}

// ============ HELPERS ============
function now() { return new Date().toISOString(); }
function safeInt(x, def = 0) { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; }
function safeNum(x, def = 0) { const n = Number(x); return Number.isFinite(n) ? n : def; }

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

function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function sigmoid(z) {
  if (!Number.isFinite(z)) return 0.5;
  if (z >= 0) {
    const e = Math.exp(-z);
    return Number.isFinite(e) ? 1 / (1 + e) : 1;
  } else {
    const e = Math.exp(z);
    return Number.isFinite(e) ? e / (1 + e) : 0;
  }
}

function clamp(x, min = 0, max = 1) {
  if (!Number.isFinite(x)) return 0.5;
  return Math.min(Math.max(x, min), max);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

// ============ DICE → RESULT ============
function itemToDice(item) {
  if (!item) return [0, 0, 0];
  return [safeInt(item.FirstDice, 0), safeInt(item.SecondDice, 0), safeInt(item.ThirdDice, 0)];
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

// ========================================================================
// 🎯 REGIME DETECTION - PHÁT HIỆN CHẾ ĐỘ THỊ TRƯỜNG
// ========================================================================
function detectRegime(seq) {
  if (!seq || seq.length < 20) return { type: 'unknown', confidence: 0 };
  const recent = seq.slice(-30);
  const n = recent.length;

  // Đếm chuyển đổi
  let transitions = 0;
  for (let i = 1; i < n; i++) if (recent[i] !== recent[i - 1]) transitions++;
  const transitionRate = transitions / (n - 1);

  // Streak dài nhất
  let maxStreak = 1, curStreak = 1;
  for (let i = 1; i < n; i++) {
    if (recent[i] === recent[i - 1]) curStreak++;
    else curStreak = 1;
    if (curStreak > maxStreak) maxStreak = curStreak;
  }

  // Entropy
  const cntT = recent.filter(x => x === 'T').length;
  const pT = cntT / n;
  const entropy = -((pT || 1e-9) * Math.log2(pT || 1e-9) + ((1 - pT) || 1e-9) * Math.log2((1 - pT) || 1e-9));

  // Phân loại
  if (maxStreak >= 5) return { type: 'BỆT', confidence: Math.min(maxStreak / 10, 0.9), maxStreak, transitionRate, entropy };
  if (transitionRate >= 0.75) return { type: 'CẦU_1_1', confidence: 0.75, maxStreak, transitionRate, entropy };
  if (transitionRate <= 0.30) return { type: 'BỆT', confidence: 0.65, maxStreak, transitionRate, entropy };
  if (transitionRate >= 0.45 && transitionRate <= 0.55) return { type: 'RANDOM', confidence: 0.6, maxStreak, transitionRate, entropy };
  return { type: 'HỖN_HỢP', confidence: 0.5, maxStreak, transitionRate, entropy };
}

// ========================================================================
// 🧠 15 THUẬT TOÁN
// ========================================================================

/**
 * 1. STREAK — Bắt bệt
 */
function algoStreak(seq) {
  if (!seq || seq.length < 4) return { code: null, conf: 0, reason: 'no_data' };
  const last = seq[seq.length - 1];
  let len = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === last) len++; else break;
  }
  if (len >= 4 && len <= 7) {
    return { code: last, conf: 0.70 + Math.min((len - 4) * 0.03, 0.10), reason: `BỆT${len}` };
  }
  if (len >= 8 && len <= 10) {
    return { code: last, conf: 0.55, reason: `BỆT${len}_NGHI` };
  }
  if (len >= 11) {
    return { code: last === 'T' ? 'X' : 'T', conf: 0.62, reason: `BỆT${len}_GÃY` };
  }
  return { code: null, conf: 0, reason: 'no_signal' };
}

/**
 * 2. CAU — 15+ loại cầu
 */
function algoCau(seq) {
  if (!seq || seq.length < 4) return { code: null, conf: 0, reason: 'no_data' };
  const n = seq.length;
  const last = seq[n - 1];

  // 1-1
  let alt = 0;
  for (let i = n - 1; i >= 1; i--) {
    if (seq[i] !== seq[i - 1]) alt++; else break;
  }
  if (alt >= 5) {
    return { code: last === 'T' ? 'X' : 'T', conf: Math.min(0.62 + (alt - 5) * 0.04, 0.80), reason: `CẦU_1_1` };
  }

  // 2-2
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TTXXTTXX') return { code: 'T', conf: 0.75, reason: 'CẦU_2_2' };
    if (p8 === 'XXTTXXTT') return { code: 'X', conf: 0.75, reason: 'CẦU_2_2' };
  }
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6 === 'TTXXTT') return { code: 'X', conf: 0.68, reason: 'CẦU_2_2' };
    if (p6 === 'XXTTXX') return { code: 'T', conf: 0.68, reason: 'CẦU_2_2' };
  }

  // 3-3
  if (n >= 9) {
    const p9 = seq.slice(-9).join('');
    if (p9 === 'TTTXXXTTT') return { code: 'X', conf: 0.78, reason: 'CẦU_3_3' };
    if (p9 === 'XXXTTTXXX') return { code: 'T', conf: 0.78, reason: 'CẦU_3_3' };
  }
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6 === 'TTTXXX') return { code: 'T', conf: 0.72, reason: 'CẦU_3_3' };
    if (p6 === 'XXXTTT') return { code: 'X', conf: 0.72, reason: 'CẦU_3_3' };
  }

  // 4-4
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TTTTXXXX') return { code: 'T', conf: 0.72, reason: 'CẦU_4_4' };
    if (p8 === 'XXXXTTTT') return { code: 'X', conf: 0.72, reason: 'CẦU_4_4' };
  }

  // 1-2-1
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TXXTXXTX') return { code: 'T', conf: 0.70, reason: 'CẦU_1_2_1' };
    if (p8 === 'XTTXTTXT') return { code: 'X', conf: 0.70, reason: 'CẦU_1_2_1' };
  }
  if (n >= 5) {
    const p5 = seq.slice(-5).join('');
    if (p5 === 'TXXTX') return { code: 'X', conf: 0.62, reason: 'CẦU_1_2_1' };
    if (p5 === 'XTTXT') return { code: 'T', conf: 0.62, reason: 'CẦU_1_2_1' };
  }

  // 2-1-2
  if (n >= 6) {
    const p6 = seq.slice(-6).join('');
    if (p6 === 'TTXTTX') return { code: 'T', conf: 0.65, reason: 'CẦU_2_1_2' };
    if (p6 === 'XXTXXT') return { code: 'X', conf: 0.65, reason: 'CẦU_2_1_2' };
  }

  // 1-3-1
  if (n >= 5) {
    const p5 = seq.slice(-5).join('');
    if (p5 === 'TXXXT') return { code: 'X', conf: 0.60, reason: 'CẦU_1_3_1' };
    if (p5 === 'XTTTX') return { code: 'T', conf: 0.60, reason: 'CẦU_1_3_1' };
  }

  // 2-1-1
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TTXTTXTT') return { code: 'X', conf: 0.68, reason: 'CẦU_2_1_1' };
    if (p8 === 'XXTXXTXX') return { code: 'T', conf: 0.68, reason: 'CẦU_2_1_1' };
  }

  // 2-3-2
  if (n >= 7) {
    const p7 = seq.slice(-7).join('');
    if (p7 === 'TTXXXTT') return { code: 'X', conf: 0.68, reason: 'CẦU_2_3_2' };
    if (p7 === 'XXTTTXX') return { code: 'T', conf: 0.68, reason: 'CẦU_2_3_2' };
  }

  // 3-2-3
  if (n >= 8) {
    const p8 = seq.slice(-8).join('');
    if (p8 === 'TTTXXTTT') return { code: 'X', conf: 0.70, reason: 'CẦU_3_2_3' };
    if (p8 === 'XXXTTXXX') return { code: 'T', conf: 0.70, reason: 'CẦU_3_2_3' };
  }

  // Tăng tiến
  {
    const blocks = [];
    let cur = seq[0], len = 1;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === cur) len++;
      else { blocks.push({ type: cur, len }); cur = seq[i]; len = 1; }
    }
    blocks.push({ type: cur, len });
    if (blocks.length >= 3) {
      const l3 = blocks.slice(-3).map(b => b.len);
      if (l3[0] < l3[1] && l3[1] < l3[2] && l3[2] <= 5) {
        return { code: blocks[blocks.length - 1].type === 'T' ? 'X' : 'T', conf: 0.58, reason: 'CẦU_TĂNG_TIẾN' };
      }
      if (l3[0] > l3[1] && l3[1] > l3[2] && l3[0] <= 6) {
        return { code: blocks[blocks.length - 1].type === 'T' ? 'X' : 'T', conf: 0.55, reason: 'CẦU_GIẢM_TIẾN' };
      }
    }
  }

  return { code: null, conf: 0, reason: 'no_signal' };
}

/**
 * 3. MARKOV — order 1-5
 */
function algoMarkov(seq, maxOrder = 5) {
  if (!seq || seq.length < 10) return { code: null, conf: 0, reason: 'no_data' };
  const models = {};
  for (let order = 1; order <= maxOrder; order++) {
    const freq = {};
    for (let i = 0; i + order < seq.length; i++) {
      const ctx = seq.slice(i, i + order).join('');
      const next = seq[i + order];
      if (!freq[ctx]) freq[ctx] = { T: 0, X: 0 };
      freq[ctx][next]++;
    }
    models[order] = freq;
  }
  let bestResult = null;
  for (let order = maxOrder; order >= 1; order--) {
    if (seq.length < order) continue;
    const ctx = seq.slice(-order).join('');
    const e = models[order][ctx];
    if (!e) continue;
    const n = e.T + e.X;
    if (n < 3) continue;
    const pT = (e.T + 1) / (n + 2);
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.15) continue;
    const candidate = {
      code: pT >= 0.5 ? 'T' : 'X',
      conf: Math.min(0.5 + conf * 0.30, 0.75),
      reason: `MARKOV_O${order}`,
      orderUsed: order
    };
    if (!bestResult || candidate.conf > bestResult.conf) bestResult = candidate;
  }
  return bestResult || { code: null, conf: 0, reason: 'no_signal' };
}

/**
 * 4. NGRAM — pattern 3-7
 */
function algoNgram(seq, maxLen = 7) {
  if (!seq || seq.length < 30) return { code: null, conf: 0, reason: 'no_data' };
  const patterns = {};
  for (let len = 3; len <= maxLen; len++) {
    for (let i = 0; i + len < seq.length; i++) {
      const pat = seq.slice(i, i + len).join('');
      const next = seq[i + len];
      if (!patterns[pat]) patterns[pat] = { T: 0, X: 0 };
      patterns[pat][next]++;
    }
  }
  for (let len = maxLen; len >= 3; len--) {
    if (seq.length < len) continue;
    const pat = seq.slice(-len).join('');
    const e = patterns[pat];
    if (!e) continue;
    const n = e.T + e.X;
    if (n < 3) continue;
    const pT = (e.T + 1) / (n + 2);
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.20) continue;
    return {
      code: pT >= 0.5 ? 'T' : 'X',
      conf: Math.min(0.5 + conf * 0.35, 0.78),
      reason: `NGRAM_${len}`
    };
  }
  return { code: null, conf: 0, reason: 'no_signal' };
}

/**
 * 5. BAYESIAN — xác suất có điều kiện
 */
function algoBayesian(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  let cntT = 0;
  for (const s of seq) if (s === 'T') cntT++;
  const priorT = (cntT + 1) / (seq.length + 2);
  const priorX = 1 - priorT;

  const cond = {};
  for (let len = 2; len <= 6; len++) {
    for (let i = 0; i + len < seq.length; i++) {
      const ctx = seq.slice(i, i + len).join('');
      const next = seq[i + len];
      if (!cond[ctx]) cond[ctx] = { T: 0, X: 0 };
      cond[ctx][next]++;
    }
  }

  for (let len = 6; len >= 2; len--) {
    if (seq.length < len) continue;
    const ctx = seq.slice(-len).join('');
    const e = cond[ctx];
    if (!e) continue;
    const n = e.T + e.X;
    if (n < 4) continue;
    const likT = (e.T + 1) / (n + 2);
    const likX = (e.X + 1) / (n + 2);
    const postT = likT * priorT;
    const postX = likX * priorX;
    const total = postT + postX;
    const pT = postT / total;
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.15) continue;
    return {
      code: pT >= 0.5 ? 'T' : 'X',
      conf: Math.min(0.5 + conf * 0.40, 0.78),
      reason: `BAYES_${len}`
    };
  }
  return { code: null, conf: 0, reason: 'no_signal' };
}

/**
 * 6. TREND — xu hướng
 */
function algoTrend(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  const recent = seq.slice(-20);
  const cntT = recent.filter(x => x === 'T').length;
  if (cntT >= 13) return { code: 'X', conf: 0.58, reason: `TREND_${cntT}T` };
  if (cntT <= 7) return { code: 'T', conf: 0.58, reason: `TREND_${cntT}T` };

  const last5 = seq.slice(-5).filter(x => x === 'T').length;
  const prev5 = seq.slice(-10, -5).filter(x => x === 'T').length;
  if (last5 >= 4 && prev5 <= 2) return { code: 'T', conf: 0.55, reason: 'MOMENTUM_UP' };
  if (last5 <= 1 && prev5 >= 3) return { code: 'X', conf: 0.55, reason: 'MOMENTUM_DOWN' };

  return { code: null, conf: 0, reason: 'no_signal' };
}

/**
 * 7. LSTM_SIM — giả lập LSTM bằng multi-scale EWMA + nonlinear
 */
function algoLSTMSim(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  const alphas = [0.5, 0.3, 0.15, 0.07, 0.03];
  const values = [];
  for (const a of alphas) {
    let s = 0;
    for (const x of seq) s = a * (x === 'T' ? 1 : -1) + (1 - a) * s;
    values.push(s);
  }

  // Gate mechanism
  const gate1 = sigmoid(values[0] * 2 + values[1] * 1.5);
  const gate2 = sigmoid(values[2] * 3);
  const gate3 = sigmoid(values[3] * 4 + values[4] * 2);
  const output = (gate1 * 0.4 + gate2 * 0.3 + gate3 * 0.3) * 2 - 1;

  const conf = Math.abs(output);
  if (conf < 0.15) return { code: null, conf: 0, reason: 'LSTM_LOW' };
  return {
    code: output >= 0 ? 'T' : 'X',
    conf: Math.min(0.5 + conf * 0.35, 0.78),
    reason: `LSTM_SIM`
  };
}

/**
 * 8. ARIMA — Auto-Regressive
 */
function algoARIMA(seq, p = 5) {
  if (!seq || seq.length < 30) return { code: null, conf: 0, reason: 'no_data' };
  const vals = seq.map(x => x === 'T' ? 1 : 0);
  const n = vals.length;

  // Fit AR(p) coefficients
  const X = [], Y = [];
  for (let i = p; i < n; i++) {
    X.push(vals.slice(i - p, i));
    Y.push(vals[i]);
  }

  if (X.length < 10) return { code: null, conf: 0, reason: 'ARIMA_NO_DATA' };

  // Least squares via normal equation (simplified gradient descent)
  const coef = new Array(p).fill(0);
  const lr = 0.01;
  for (let iter = 0; iter < 50; iter++) {
    const grad = new Array(p).fill(0);
    for (let k = 0; k < X.length; k++) {
      let pred = 0;
      for (let j = 0; j < p; j++) pred += coef[j] * X[k][j];
      const err = Y[k] - pred;
      for (let j = 0; j < p; j++) grad[j] += err * X[k][j];
    }
    for (let j = 0; j < p; j++) coef[j] += lr * grad[j] / X.length;
  }

  // Predict next
  const lastP = vals.slice(-p);
  let pred = 0;
  for (let j = 0; j < p; j++) pred += coef[j] * lastP[j];

  const conf = Math.abs(pred - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'ARIMA_LOW' };
  return {
    code: pred >= 0.5 ? 'T' : 'X',
    conf: Math.min(0.5 + conf * 0.30, 0.72),
    reason: `ARIMA_P${p}`
  };
}

/**
 * 9. KALMAN — Kalman filter 1D
 */
function algoKalman(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  const vals = seq.map(x => x === 'T' ? 1 : 0);

  let x = 0.5, P = 1.0;
  const Q = 0.01, R = 0.1;
  for (const v of vals) {
    // Predict
    const xPred = x;
    const PPred = P + Q;
    // Update
    const K = PPred / (PPred + R);
    x = xPred + K * (v - xPred);
    P = (1 - K) * PPred;
  }

  const conf = Math.abs(x - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'KALMAN_LOW' };
  return {
    code: x >= 0.5 ? 'T' : 'X',
    conf: Math.min(0.5 + conf * 0.35, 0.75),
    reason: `KALMAN`
  };
}

/**
 * 10. RANDOM_FOREST — Simulated ensemble of trees
 */
function algoRandomForest(seq) {
  if (!seq || seq.length < 40) return { code: null, conf: 0, reason: 'no_data' };
  const n = seq.length;

  // Feature extraction
  const features = [];
  const labels = [];
  for (let i = 20; i < n; i++) {
    const past = seq.slice(i - 20, i);
    const feat = extractFeatures(past);
    features.push(feat);
    labels.push(seq[i] === 'T' ? 1 : 0);
  }

  if (features.length < 20) return { code: null, conf: 0, reason: 'RF_NO_DATA' };

  // Simulate 10 trees
  const trees = [];
  for (let t = 0; t < 10; t++) {
    const idx = [];
    for (let i = 0; i < features.length; i++) idx.push(i);
    // Simulated bootstrap
    const sampleX = [], sampleY = [];
    for (let i = 0; i < features.length; i++) {
      const j = idx[(i * 7 + t * 13) % idx.length];
      sampleX.push(features[j]);
      sampleY.push(labels[j]);
    }
    // Build simple tree = logistic regression on sampled features
    const coef = fitLogistic(sampleX, sampleY);
    trees.push(coef);
  }

  // Predict
  const currentFeat = extractFeatures(seq.slice(-20));
  let votes = 0, total = 0;
  for (const coef of trees) {
    let z = 0;
    for (let i = 0; i < coef.length; i++) z += coef[i] * currentFeat[i];
    votes += sigmoid(z);
    total++;
  }
  const pT = votes / total;
  const conf = Math.abs(pT - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'RF_LOW' };
  return {
    code: pT >= 0.5 ? 'T' : 'X',
    conf: Math.min(0.5 + conf * 0.35, 0.78),
    reason: `RF_10T`
  };
}

function extractFeatures(seq) {
  const f = [1.0];
  // EWMA at multiple scales
  const alphas = [0.3, 0.15, 0.07];
  for (const a of alphas) {
    let s = 0;
    for (const x of seq) s = a * (x === 'T' ? 1 : -1) + (1 - a) * s;
    f.push(s);
  }
  // Streak
  const last = seq[seq.length - 1];
  let streak = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === last) streak++;
    else break;
  }
  f.push(Math.tanh(streak / 6));
  // Alternation
  let alt = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) alt++;
  f.push((alt / (seq.length - 1)) * 2 - 1);
  // Last 3 encoded
  f.push(seq[seq.length - 1] === 'T' ? 1 : -1);
  f.push(seq[seq.length - 2] === 'T' ? 1 : -1);
  f.push(seq[seq.length - 3] === 'T' ? 1 : -1);
  return f;
}

function fitLogistic(X, Y) {
  const dim = X[0].length;
  const coef = new Array(dim).fill(0);
  const lr = 0.05;
  for (let iter = 0; iter < 30; iter++) {
    const grad = new Array(dim).fill(0);
    for (let k = 0; k < X.length; k++) {
      let z = 0;
      for (let j = 0; j < dim; j++) z += coef[j] * X[k][j];
      const pred = sigmoid(z);
      const err = Y[k] - pred;
      for (let j = 0; j < dim; j++) grad[j] += err * X[k][j];
    }
    for (let j = 0; j < dim; j++) coef[j] += lr * grad[j] / X.length;
  }
  return coef;
}

/**
 * 11. GRADIENT_BOOST — AdaBoost-like
 */
function algoGradientBoost(seq) {
  if (!seq || seq.length < 40) return { code: null, conf: 0, reason: 'no_data' };
  const n = seq.length;

  const features = [], labels = [];
  for (let i = 20; i < n; i++) {
    features.push(extractFeatures(seq.slice(i - 20, i)));
    labels.push(seq[i] === 'T' ? 1 : 0);
  }
  if (features.length < 20) return { code: null, conf: 0, reason: 'GB_NO_DATA' };

  // Weights init
  const weights = new Array(features.length).fill(1 / features.length);
  const models = [];

  // Train 15 weak learners
  for (let round = 0; round < 15; round++) {
    // Fit weighted logistic
    const coef = fitWeightedLogistic(features, labels, weights);
    models.push(coef);

    // Update weights
    let errSum = 0;
    const preds = [];
    for (let i = 0; i < features.length; i++) {
      let z = 0;
      for (let j = 0; j < coef.length; j++) z += coef[j] * features[i][j];
      const p = sigmoid(z);
      const pred = p >= 0.5 ? 1 : 0;
      preds.push(pred);
      if (pred !== labels[i]) errSum += weights[i];
    }
    if (errSum < 1e-6 || errSum > 0.5) break;

    const alpha = 0.5 * Math.log((1 - errSum) / Math.max(errSum, 1e-9));
    for (let i = 0; i < weights.length; i++) {
      if (preds[i] !== labels[i]) weights[i] *= Math.exp(alpha);
      else weights[i] *= Math.exp(-alpha);
    }
    // Normalize
    const sum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  }

  if (models.length === 0) return { code: null, conf: 0, reason: 'GB_NO_MODEL' };

  // Predict
  const curFeat = extractFeatures(seq.slice(-20));
  let sum = 0, cnt = 0;
  for (const coef of models) {
    let z = 0;
    for (let j = 0; j < coef.length; j++) z += coef[j] * curFeat[j];
    sum += sigmoid(z);
    cnt++;
  }
  const pT = sum / cnt;
  const conf = Math.abs(pT - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'GB_LOW' };
  return {
    code: pT >= 0.5 ? 'T' : 'X',
    conf: Math.min(0.5 + conf * 0.35, 0.78),
    reason: `GB_${models.length}T`
  };
}

function fitWeightedLogistic(X, Y, W) {
  const dim = X[0].length;
  const coef = new Array(dim).fill(0);
  const lr = 0.05;
  for (let iter = 0; iter < 30; iter++) {
    const grad = new Array(dim).fill(0);
    let wSum = 0;
    for (let k = 0; k < X.length; k++) {
      let z = 0;
      for (let j = 0; j < dim; j++) z += coef[j] * X[k][j];
      const pred = sigmoid(z);
      const err = (Y[k] - pred) * W[k];
      for (let j = 0; j < dim; j++) grad[j] += err * X[k][j];
      wSum += W[k];
    }
    if (wSum < 1e-9) break;
    for (let j = 0; j < dim; j++) coef[j] += lr * grad[j] / wSum;
  }
  return coef;
}

/**
 * 12. CHAOS — logistic map
 */
function algoChaos(seq) {
  if (!seq || seq.length < 30) return { code: null, conf: 0, reason: 'no_data' };
  // Map T/X → 0.1/0.9
  const vals = seq.map(x => x === 'T' ? 0.9 : 0.1);

  // Try different r values
  let bestR = 3.9, bestErr = 1e9;
  for (let r = 3.5; r <= 4.0; r += 0.05) {
    let err = 0;
    for (let i = 1; i < vals.length; i++) {
      const pred = r * vals[i - 1] * (1 - vals[i - 1]);
      err += Math.abs(pred - vals[i]);
    }
    if (err < bestErr) { bestErr = err; bestR = r; }
  }

  const last = vals[vals.length - 1];
  const pred = bestR * last * (1 - last);
  const conf = Math.abs(pred - 0.5) * 2;
  if (conf < 0.20) return { code: null, conf: 0, reason: 'CHAOS_LOW' };
  return {
    code: pred >= 0.5 ? 'T' : 'X',
    conf: Math.min(0.5 + conf * 0.30, 0.72),
    reason: `CHAOS_R${bestR.toFixed(2)}`
  };
}

/**
 * 13. FOURIER — frequency analysis
 */
function algoFourier(seq) {
  if (!seq || seq.length < 40) return { code: null, conf: 0, reason: 'no_data' };
  const N = Math.min(64, seq.length);
  const vals = seq.slice(-N).map(x => x === 'T' ? 1 : -1);

  // Simple DFT - find dominant frequency
  const freqs = [];
  for (let k = 1; k <= 8; k++) {
    let real = 0, imag = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      real += vals[n] * Math.cos(angle);
      imag -= vals[n] * Math.sin(angle);
    }
    const mag = Math.sqrt(real * real + imag * imag) / N;
    freqs.push({ k, mag, phase: Math.atan2(imag, real) });
  }

  freqs.sort((a, b) => b.mag - a.mag);
  const dominant = freqs[0];
  if (dominant.mag < 0.2) return { code: null, conf: 0, reason: 'FOURIER_LOW' };

  // Predict next using dominant freq
  const n = N;
  const angle = (2 * Math.PI * dominant.k * n) / N;
  const pred = dominant.mag * 2 * Math.cos(angle + dominant.phase);

  const conf = Math.min(Math.abs(pred), 0.75);
  if (conf < 0.15) return { code: null, conf: 0, reason: 'FOURIER_LOW2' };
  return {
    code: pred >= 0 ? 'T' : 'X',
    conf,
    reason: `FOURIER_K${dominant.k}`
  };
}

/**
 * 14. ENTROPY — Shannon entropy based
 */
function algoEntropy(seq) {
  if (!seq || seq.length < 20) return { code: null, conf: 0, reason: 'no_data' };
  const recent = seq.slice(-20);
  const cntT = recent.filter(x => x === 'T').length;
  const pT = cntT / recent.length;

  // High entropy = random, low entropy = biased
  const entropy = -(pT * Math.log2(pT || 1e-9) + (1 - pT) * Math.log2((1 - pT) || 1e-9));

  // Nếu entropy thấp → predict phía chiếm ưu thế
  if (entropy < 0.75) {
    return {
      code: pT >= 0.5 ? 'T' : 'X',
      conf: Math.min(0.5 + (1 - entropy) * 0.5, 0.72),
      reason: `ENTROPY_LOW_${entropy.toFixed(2)}`
    };
  }

  // Entropy cao → predict đảo chiều gần đây
  if (entropy > 0.95) {
    const last = seq[seq.length - 1];
    return {
      code: last === 'T' ? 'X' : 'T',
      conf: 0.55,
      reason: `ENTROPY_HIGH`
    };
  }

  return { code: null, conf: 0, reason: 'no_signal' };
}

/**
 * 15. META_LEARNER — chọn algo tốt nhất theo regime
 */
function algoMetaLearner(seq, allAlgoResults, regime, algoStats) {
  if (!allAlgoResults) return { code: null, conf: 0, reason: 'no_data' };

  // Filter theo regime
  const weights = {};
  for (const name of Object.keys(allAlgoResults)) {
    const r = allAlgoResults[name];
    if (!r.code) { weights[name] = 0; continue; }

    const stats = algoStats[name] || { total: 0, wins: 0 };
    const acc = stats.total > 0 ? stats.wins / stats.total : 0.5;
    const regWeight = regimeWeight(name, regime.type);

    weights[name] = r.conf * acc * regWeight;
  }

  const votes = { T: 0, X: 0 };
  for (const name of Object.keys(allAlgoResults)) {
    const r = allAlgoResults[name];
    if (!r.code) continue;
    votes[r.code] += weights[name];
  }

  const total = votes.T + votes.X;
  if (total < 0.1) return { code: null, conf: 0, reason: 'META_NO_SIGNAL' };

  const pT = votes.T / total;
  const conf = Math.abs(pT - 0.5) * 2;
  if (conf < 0.10) return { code: null, conf: 0, reason: 'META_TOO_CLOSE' };

  return {
    code: pT >= 0.5 ? 'T' : 'X',
    conf: Math.min(0.55 + conf * 0.30, 0.80),
    reason: `META_${regime.type}`,
    votes
  };
}

function regimeWeight(algo, regimeType) {
  const map = {
    'BỆT': { STREAK: 2.5, CAU: 1.0, MARKOV: 1.5, NGRAM: 1.2, BAYESIAN: 1.0, TREND: 0.8, LSTM_SIM: 1.3, ARIMA: 1.0, KALMAN: 0.8, RANDOM_FOREST: 1.2, GRADIENT_BOOST: 1.3, CHAOS: 0.5, FOURIER: 0.7, ENTROPY: 1.5 },
    'CẦU_1_1': { STREAK: 0.5, CAU: 3.0, MARKOV: 1.0, NGRAM: 1.5, BAYESIAN: 1.2, TREND: 0.6, LSTM_SIM: 1.0, ARIMA: 1.0, KALMAN: 0.8, RANDOM_FOREST: 1.2, GRADIENT_BOOST: 1.2, CHAOS: 0.5, FOURIER: 2.0, ENTROPY: 0.7 },
    'RANDOM': { STREAK: 0.5, CAU: 0.5, MARKOV: 1.0, NGRAM: 1.2, BAYESIAN: 1.5, TREND: 0.5, LSTM_SIM: 1.0, ARIMA: 1.2, KALMAN: 1.3, RANDOM_FOREST: 1.5, GRADIENT_BOOST: 1.5, CHAOS: 1.0, FOURIER: 0.8, ENTROPY: 1.5 },
    'HỖN_HỢP': { STREAK: 1.0, CAU: 1.0, MARKOV: 1.0, NGRAM: 1.0, BAYESIAN: 1.0, TREND: 1.0, LSTM_SIM: 1.0, ARIMA: 1.0, KALMAN: 1.0, RANDOM_FOREST: 1.0, GRADIENT_BOOST: 1.0, CHAOS: 1.0, FOURIER: 1.0, ENTROPY: 1.0 },
    'unknown': { STREAK: 1.0, CAU: 1.0, MARKOV: 1.0, NGRAM: 1.0, BAYESIAN: 1.0, TREND: 1.0, LSTM_SIM: 1.0, ARIMA: 1.0, KALMAN: 1.0, RANDOM_FOREST: 1.0, GRADIENT_BOOST: 1.0, CHAOS: 1.0, FOURIER: 1.0, ENTROPY: 1.0 }
  };
  return (map[regimeType] && map[regimeType][algo]) || 1.0;
}

// ============ CHẠY TẤT CẢ ALGO ============
function runAllAlgorithms(seq, db) {
  const baseResults = {
    STREAK: algoStreak(seq),
    CAU: algoCau(seq),
    MARKOV: algoMarkov(seq),
    NGRAM: algoNgram(seq),
    BAYESIAN: algoBayesian(seq),
    TREND: algoTrend(seq),
    LSTM_SIM: algoLSTMSim(seq),
    ARIMA: algoARIMA(seq),
    KALMAN: algoKalman(seq),
    RANDOM_FOREST: algoRandomForest(seq),
    GRADIENT_BOOST: algoGradientBoost(seq),
    CHAOS: algoChaos(seq),
    FOURIER: algoFourier(seq),
    ENTROPY: algoEntropy(seq)
  };

  const regime = detectRegime(seq);

  // Meta learner với tất cả results + regime
  baseResults.META_LEARNER = algoMetaLearner(seq, baseResults, regime, db.algoStats);

  // Ensemble = weighted vote based on accuracy
  const votes = { T: 0, X: 0 };
  const details = [];
  for (const name of Object.keys(baseResults)) {
    if (name === 'META_LEARNER' || name === 'ENSEMBLE') continue;
    const r = baseResults[name];
    if (!r.code) continue;
    const stat = db.algoStats[name] || { total: 0, wins: 0 };
    const acc = stat.total >= MIN_ALGO_TOTAL ? stat.wins / stat.total : 0.5;
    const w = r.conf * Math.max(0.3, acc);
    votes[r.code] += w;
    details.push({ name, code: r.code, conf: r.conf, acc, w });
  }
  const total = votes.T + votes.X;
  let ensembleResult;
  if (total < 0.5) {
    ensembleResult = { code: null, conf: 0, reason: 'ENSEMBLE_NO_SIGNAL' };
  } else {
    const pT = votes.T / total;
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.10) {
      ensembleResult = { code: null, conf: 0, reason: 'ENSEMBLE_TOO_CLOSE' };
    } else {
      ensembleResult = {
        code: pT >= 0.5 ? 'T' : 'X',
        conf: Math.min(0.55 + conf * 0.30, 0.82),
        reason: `ENSEMBLE_${details.length}v`,
        details,
        votes
      };
    }
  }
  baseResults.ENSEMBLE = ensembleResult;

  return { algorithms: baseResults, regime };
}

// ========================================================================
// 🎯 BRIER SCORE
// ========================================================================
function brierScore(predictions) {
  // predictions: [{ prob: 0-1, actual: 0 or 1 }]
  if (!predictions.length) return 0;
  let sum = 0;
  for (const p of predictions) sum += Math.pow(p.prob - p.actual, 2);
  return sum / predictions.length;
}

// ========================================================================
// 🎯 KELLY CRITERION
// ========================================================================
function kellyFraction(winProb, winLossRatio = 1) {
  // f* = (p * b - q) / b  với b = winLossRatio
  const p = clamp(winProb, 0.01, 0.99);
  const q = 1 - p;
  const f = (p * winLossRatio - q) / winLossRatio;
  return Math.max(0, Math.min(f, 0.25));  // cap 25% bankroll
}

// ========================================================================
// 🎯 CIRCUIT BREAKER
// ========================================================================
function checkCircuitBreaker(db) {
  const recent = (db.history || []).slice(-20).filter(h => h.trangThai === 'ĐÚNG' || h.trangThai === 'SAI');
  if (recent.length < CB_LOSS_STREAK) return false;

  let lossStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].trangThai === 'SAI') lossStreak++;
    else break;
  }
  if (lossStreak >= CB_LOSS_STREAK) {
    const cooldownEnd = recent[recent.length - 1].phien + CB_COOLDOWN;
    if (db.lastProcessedSession < cooldownEnd) {
      console.warn(`[CIRCUIT BREAKER] game active, loss streak ${lossStreak}, cooldown until #${cooldownEnd}`);
      return true;
    }
  }
  return false;
}

// ============ FETCH ============
async function fetchWithRetry(url, attempts = FETCH_RETRIES) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.get(url, { timeout: API_TIMEOUT_MS, headers: { 'User-Agent': 'HoangVip/10.0' } });
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

// ============ DB ============
const ALL_ALGOS = [
  'STREAK', 'CAU', 'MARKOV', 'NGRAM', 'BAYESIAN', 'TREND',
  'LSTM_SIM', 'ARIMA', 'KALMAN', 'RANDOM_FOREST', 'GRADIENT_BOOST',
  'CHAOS', 'FOURIER', 'ENTROPY', 'META_LEARNER', 'ENSEMBLE'
];

function defaultDB() {
  const algoStats = {};
  for (const name of ALL_ALGOS) {
    algoStats[name] = { total: 0, wins: 0, losses: 0, skips: 0, brierSum: 0, brierCount: 0 };
  }
  return {
    version: 10,
    createdAt: now(), updatedAt: now(),
    history: [],
    algoStats,
    algoWeights: Object.fromEntries(ALL_ALGOS.map(a => [a, 1.0])),
    byType: {},
    byRegime: {},
    lastProcessedSession: null,
    currentRegime: { type: 'unknown' },
    circuitBreaker: { active: false, until: 0 },
    snapshots: [],
    backtest: null
  };
}

function migrateDB(db) {
  if (!db || typeof db !== 'object') return defaultDB();
  const def = defaultDB();
  for (const k in def) if (db[k] === undefined || db[k] === null) db[k] = def[k];
  if (!Array.isArray(db.history)) db.history = [];
  if (!db.algoStats) db.algoStats = def.algoStats;
  for (const name of ALL_ALGOS) {
    if (!db.algoStats[name]) db.algoStats[name] = { total: 0, wins: 0, losses: 0, skips: 0, brierSum: 0, brierCount: 0 };
    if (!Number.isFinite(db.algoStats[name].brierSum)) db.algoStats[name].brierSum = 0;
    if (!Number.isFinite(db.algoStats[name].brierCount)) db.algoStats[name].brierCount = 0;
  }
  if (!db.algoWeights) db.algoWeights = Object.fromEntries(ALL_ALGOS.map(a => [a, 1.0]));
  if (!db.byType || typeof db.byType !== 'object') db.byType = {};
  if (!db.byRegime || typeof db.byRegime !== 'object') db.byRegime = {};
  if (!db.circuitBreaker) db.circuitBreaker = { active: false, until: 0 };
  if (!Array.isArray(db.snapshots)) db.snapshots = [];
  if (!db.currentRegime) db.currentRegime = { type: 'unknown' };
  if (!db.version) db.version = 10;
  db.history = db.history.filter(h => h && typeof h === 'object' && h.phien !== undefined);
  return db;
}

function loadDatabase(game) {
  let db = safeReadJson(DB_FILES[game]) || defaultDB();
  return migrateDB(db);
}

function saveDatabase(game, db) {
  db.updatedAt = now();
  safeAtomicWrite(DB_FILES[game], db);
}

// ============ PREDICT ============
function predict(db, seq) {
  if (!Array.isArray(seq) || seq.length < 4) {
    return {
      code: null, label: null, tiLe: 'CHỜ',
      algorithms: runAllAlgorithms(seq || [], db).algorithms,
      regime: { type: 'unknown' },
      shouldPredict: false,
      circuitBreaker: false
    };
  }

  const { algorithms, regime } = runAllAlgorithms(seq, db);
  const meta = algorithms.META_LEARNER;
  const ens = algorithms.ENSEMBLE;

  // Chọn signal cuối cùng: ưu tiên META nếu pass, ngược lại ENSEMBLE
  let final = meta.code && meta.conf >= MIN_CONFIDENCE ? meta : ens;
  let shouldPredict = final.code && final.conf >= MIN_CONFIDENCE;

  const cb = checkCircuitBreaker(db);
  if (cb) {
    shouldPredict = false;
    final = { code: null, conf: 0, reason: 'CIRCUIT_BREAKER' };
  }

  // Streak info
  const lastType = seq[seq.length - 1];
  let streakLen = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === lastType) streakLen++;
    else break;
  }

  if (!shouldPredict) {
    return {
      code: null, label: null, tiLe: 'CHỜ',
      algorithms, regime, shouldPredict: false,
      streak: { type: lastType, length: streakLen },
      circuitBreaker: cb
    };
  }

  return {
    code: final.code,
    label: labelFromTX(final.code),
    tiLe: (final.conf * 100).toFixed(1) + '%',
    algorithms,
    regime,
    shouldPredict: true,
    streak: { type: lastType, length: streakLen },
    reason: final.reason,
    circuitBreaker: false
  };
}

// ============ UPDATE WEIGHTS ============
function updateWeights(db) {
  for (const name of ALL_ALGOS) {
    const s = db.algoStats[name];
    if (!s || s.total < MIN_ALGO_TOTAL) continue;
    const acc = s.wins / s.total;
    db.algoWeights[name] = Math.max(0.3, Math.min(3.0, Math.exp((acc - 0.5) * 5)));
  }
}

// ============ SNAPSHOT ============
function takeSnapshot(db, game) {
  if (db.history.length % SNAPSHOT_INTERVAL !== 0) return;
  const snap = {
    at: now(),
    historyLength: db.history.length,
    algoStats: JSON.parse(JSON.stringify(db.algoStats)),
    algoWeights: { ...db.algoWeights },
    byType: JSON.parse(JSON.stringify(db.byType)),
    byRegime: JSON.parse(JSON.stringify(db.byRegime))
  };
  db.snapshots = db.snapshots || [];
  db.snapshots.push(snap);
  if (db.snapshots.length > 10) db.snapshots = db.snapshots.slice(-10);
  try {
    safeAtomicWrite(path.join(SNAPSHOT_DIR, `${game}_snap_${Date.now()}.json`), snap);
  } catch (e) {}
}

// ============ MAIN TICK ============
async function processGameTick(game) {
  try {
    const api = APIS[game];
    if (!api) return;
    const resp = await fetchWithRetry(api);
    const historyList = parseHistoryResponse(resp.data);
    if (!historyList.length) return;

    const latest = historyList[historyList.length - 1];
    const currentSession = safeInt(latest.SessionId || latest.session, 0);
    if (!currentSession) return;

    const db = loadDatabase(game);
    if (db.lastProcessedSession === currentSession) return;

    const seq = historyList.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    if (seq.length < 4) return;

    const pred = predict(db, seq);

    // Evaluate previous
    const lastRec = db.history[db.history.length - 1];
    if (lastRec && safeInt(lastRec.phienDuDoan, 0) === currentSession) {
      const actual = itemToResult(latest);
      lastRec.ketQua = actual;
      lastRec.ketQuaLabel = labelFromTX(actual);

      // Update từng algo
      if (lastRec.algoPreds) {
        for (const name of Object.keys(lastRec.algoPreds)) {
          const predData = lastRec.algoPreds[name];
          const predCode = predData.code;
          const stat = db.algoStats[name];
          if (!stat) continue;

          if (predCode === null || predCode === undefined) {
            stat.skips++;
            lastRec.algoResults = lastRec.algoResults || {};
            lastRec.algoResults[name] = 'SKIP';
          } else {
            stat.total++;
            const correct = predCode === actual;
            if (correct) stat.wins++;
            else stat.losses++;
            lastRec.algoResults = lastRec.algoResults || {};
            lastRec.algoResults[name] = correct ? 'WIN' : 'LOSE';

            // Brier
            const prob = predCode === 'T' ? predData.conf : (1 - predData.conf);
            const actualVal = actual === 'T' ? 1 : 0;
            stat.brierSum += Math.pow(prob - actualVal, 2);
            stat.brierCount++;
          }
        }
      }

      // Trạng thái tổng
      const finalCode = lastRec.DU_DOAN_CODE;
      if (finalCode) {
        lastRec.trangThai = (finalCode === actual) ? 'ĐÚNG' : 'SAI';
      } else {
        lastRec.trangThai = 'BỎ QUA';
      }

      // Track by type
      const pType = lastRec.ensReason || 'NONE';
      if (finalCode) {
        if (!db.byType[pType]) db.byType[pType] = { total: 0, wins: 0 };
        db.byType[pType].total++;
        if (finalCode === actual) db.byType[pType].wins++;
      }

      // Track by regime
      const regime = lastRec.regimeType || 'unknown';
      if (finalCode) {
        if (!db.byRegime[regime]) db.byRegime[regime] = { total: 0, wins: 0 };
        db.byRegime[regime].total++;
        if (finalCode === actual) db.byRegime[regime].wins++;
      }

      updateWeights(db);
      takeSnapshot(db, game);
    }

    // New entry
    const algoPreds = {};
    for (const name of Object.keys(pred.algorithms)) {
      const a = pred.algorithms[name];
      algoPreds[name] = { code: a.code, conf: a.conf || 0, reason: a.reason };
    }

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
      ensReason: pred.reason || pred.algorithms.ENSEMBLE.reason,
      regimeType: pred.regime.type,
      streak: pred.streak,
      algoPreds,
      trangThai: 'ĐANG CHỜ',
      thoiGian: now()
    };

    db.history.push(newEntry);
    if (db.history.length > MAX_HISTORY) db.history.splice(0, db.history.length - MAX_HISTORY);
    db.lastProcessedSession = currentSession;
    db.currentRegime = pred.regime;
    saveDatabase(game, db);

    const extra = pred.shouldPredict ? `[${pred.reason}]` : '[CHỜ]';
    console.log(`[TICK] ${game} #${currentSession} sum=${newEntry.tong} kq=${newEntry.ketQuaLabel} → ${newEntry.DU_DOAN} ${extra} regime=${pred.regime.type}`);
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
    tong: it.tong || 0,
    ketQua: it.ketQua || null,
    ketQuaLabel: it.ketQuaLabel || (it.ketQua ? labelFromTX(it.ketQua) : null),
    phienDuDoan: it.phienDuDoan,
    duDoan: it.DU_DOAN || 'CHỜ',
    duDoanCode: it.DU_DOAN_CODE || null,
    tiLe: it.TI_LE || 'CHỜ',
    ensReason: it.ensReason || null,
    regimeType: it.regimeType || null,
    algoPreds: it.algoPreds || {},
    algoResults: it.algoResults || {},
    streak: it.streak || null,
    trangThai: it.trangThai || null,
    thoiGian: it.thoiGian || null
  };
}

// ============ API ============
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });
  try {
    const r = await fetchWithRetry(APIS[game]);
    const list = parseHistoryResponse(r.data);
    if (!list.length) return res.status(204).send();

    const seq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    const db = loadDatabase(game);
    const pred = predict(db, seq);
    const latest = list[list.length - 1];
    const cs = safeInt(latest.SessionId || latest.session, 0);

    const algoDetail = {};
    for (const name of Object.keys(pred.algorithms)) {
      const a = pred.algorithms[name];
      const stat = db.algoStats[name] || {};
      algoDetail[name] = {
        code: a.code,
        label: a.code ? labelFromTX(a.code) : null,
        confidence: a.conf,
        reason: a.reason,
        accuracy: stat.total > 0 ? Number((stat.wins / stat.total * 100).toFixed(2)) : 0,
        brier: stat.brierCount > 0 ? Number((stat.brierSum / stat.brierCount).toFixed(4)) : null,
        total: stat.total || 0,
        skips: stat.skips || 0
      };
    }

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
      reason: pred.reason,
      regime: pred.regime,
      shouldPredict: pred.shouldPredict,
      circuitBreaker: pred.circuitBreaker,
      kelly: pred.shouldPredict ? kellyFraction(pred.algorithms.ENSEMBLE.conf) : 0,
      algorithms: algoDetail
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'fetch error' });
  }
});

app.get('/api/history/:game', (req, res) => {
  const game = req.params.game;
  if (game === 'all') return handleHistoryAll(req, res);
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
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
      const algosReport = {};
      for (const name of Object.keys(db.algoStats)) {
        const s = db.algoStats[name];
        algosReport[name] = {
          total: s.total, wins: s.wins, losses: s.losses, skips: s.skips,
          accuracy: s.total > 0 ? Number((s.wins / s.total * 100).toFixed(2)) : 0,
          coverage: (s.total + s.skips) > 0 ? Number((s.total / (s.total + s.skips) * 100).toFixed(2)) : 0,
          brier: s.brierCount > 0 ? Number((s.brierSum / s.brierCount).toFixed(4)) : null
        };
      }
      result.games[game] = {
        count: slice.length,
        algoStats: algosReport,
        algoWeights: db.algoWeights,
        byType: db.byType,
        byRegime: db.byRegime,
        currentRegime: db.currentRegime,
        items: slice.map(formatHistoryItem).filter(Boolean)
      };
    } catch (e) {
      result.games[game] = { error: e.message };
    }
  }
  return res.json(result);
}

app.get('/api/history/all', handleHistoryAll);

app.get('/api/export/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).send('Invalid game');
  const db = loadDatabase(game);
  let csv = 'Phiên,XúcXắc,Tổng,KếtQuả,PhiênDựĐoán,DựĐoán,TỉLệ,Reason,Regime,TrạngThái\n';
  db.history.forEach(item => {
    const dice = (item.xucXac || []).join('-');
    csv += `${item.phien},"${dice}",${item.tong || ''},${item.ketQuaLabel || ''},${item.phienDuDoan},${item.DU_DOAN || ''},${item.TI_LE || ''},"${item.ensReason || ''}","${item.regimeType || ''}",${item.trangThai || ''}\n`;
  });
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`history_${game}.csv`);
  res.send('\uFEFF' + csv);
});

// ============ ADMIN ============
app.get('/admin/metrics/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.status(400).json({ error: 'Invalid game' });
  const db = loadDatabase(game);

  const report = {};
  for (const name of Object.keys(db.algoStats)) {
    const s = db.algoStats[name];
    report[name] = {
      total: s.total, wins: s.wins, losses: s.losses, skips: s.skips,
      accuracy: s.total > 0 ? Number((s.wins / s.total * 100).toFixed(2)) : 0,
      coverage: (s.total + s.skips) > 0 ? Number((s.total / (s.total + s.skips) * 100).toFixed(2)) : 0,
      brier: s.brierCount > 0 ? Number((s.brierSum / s.brierCount).toFixed(4)) : null
    };
  }

  const ranking = Object.entries(report)
    .filter(([_, v]) => v.total >= 5)
    .sort((a, b) => b[1].accuracy - a[1].accuracy)
    .map(([name, v]) => ({ name, ...v }));

  return res.json({
    game,
    algorithms: report,
    ranking,
    byType: db.byType,
    byRegime: db.byRegime,
    weights: db.algoWeights,
    currentRegime: db.currentRegime,
    lastProcessedSession: db.lastProcessedSession,
    snapshots: (db.snapshots || []).length
  });
});

app.get('/admin/config', (req, res) => {
  res.json({
    VERSION: 10,
    RULE: 'DiceSum 3-10=Xỉu, 11-18=Tài',
    MIN_CONFIDENCE,
    MIN_ALGO_TOTAL,
    CB_LOSS_STREAK,
    CB_COOLDOWN,
    ALGORITHMS: ALL_ALGOS
  });
});

// ============ UI ============
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Trang không tồn tại.');

  const db = loadDatabase(game);
  const rows = db.history.slice(-40).reverse();

  const algos = {};
  for (const name of Object.keys(db.algoStats)) {
    const s = db.algoStats[name];
    algos[name] = {
      ...s,
      accuracy: s.total > 0 ? (s.wins / s.total * 100) : 0,
      brier: s.brierCount > 0 ? (s.brierSum / s.brierCount) : null
    };
  }

  const ranking = Object.entries(algos)
    .filter(([_, v]) => v.total >= 5)
    .sort((a, b) => b[1].accuracy - a[1].accuracy);

  const latest = db.history[db.history.length - 1];
  const latestPred = latest ? latest.DU_DOAN : 'CHỜ';
  const latestCode = latest ? latest.DU_DOAN_CODE : null;
  const latestTiLe = latest ? latest.TI_LE : 'CHỜ';
  const latestReason = latest ? latest.ensReason : 'N/A';
  const latestRegime = db.currentRegime ? db.currentRegime.type : 'unknown';

  const algoRows = Object.keys(algos).map(name => {
    const a = algos[name];
    const accCls = a.accuracy >= 60 ? 'dung' : (a.accuracy >= 50 ? 'cho' : 'sai');
    const brierStr = a.brier !== null ? a.brier.toFixed(4) : '—';
    return `<tr>
      <td><span class="algo-badge">${name}</span></td>
      <td>${a.total}</td>
      <td class="dung">${a.wins}</td>
      <td class="sai">${a.losses}</td>
      <td class="wait">${a.skips}</td>
      <td class="${accCls}"><b>${a.accuracy.toFixed(1)}%</b></td>
      <td class="brier">${brierStr}</td>
    </tr>`;
  }).join('');

  const typeRows = Object.keys(db.byType || {}).sort().map(t => {
    const x = db.byType[t];
    const acc = x.total > 0 ? (x.wins / x.total * 100) : 0;
    const cls = acc >= 60 ? 'dung' : (acc >= 50 ? 'cho' : 'sai');
    return `<tr>
      <td><span class="type-badge">${t}</span></td>
      <td>${x.total}</td>
      <td class="dung">${x.wins}</td>
      <td class="sai">${x.total - x.wins}</td>
      <td class="${cls}"><b>${acc.toFixed(1)}%</b></td>
    </tr>`;
  }).join('');

  const regimeRows = Object.keys(db.byRegime || {}).map(r => {
    const x = db.byRegime[r];
    const acc = x.total > 0 ? (x.wins / x.total * 100) : 0;
    const cls = acc >= 60 ? 'dung' : (acc >= 50 ? 'cho' : 'sai');
    return `<tr>
      <td><span class="regime-badge">${r}</span></td>
      <td>${x.total}</td>
      <td class="dung">${x.wins}</td>
      <td class="sai">${x.total - x.wins}</td>
      <td class="${cls}"><b>${acc.toFixed(1)}%</b></td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>HOANG VIP v10 - ${game.toUpperCase()}</title>
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

  .hero{
    background:linear-gradient(135deg,#7c3aed,#4f46e5);
    padding:20px;border-radius:14px;margin-bottom:14px;
    text-align:center;
    box-shadow:0 8px 24px rgba(124,58,237,0.3);
  }
  .hero .label{font-size:11px;color:#ddd6fe;text-transform:uppercase;letter-spacing:1px}
  .hero .pred{font-size:36px;font-weight:800;margin:8px 0;text-shadow:0 4px 12px rgba(0,0,0,0.3)}
  .hero .pred.tai{color:#86efac}
  .hero .pred.xiu{color:#fca5a5}
  .hero .pred.cho{color:#fde047}
  .hero .meta{font-size:11px;color:#ddd6fe;margin-top:6px}
  .hero .regime{display:inline-block;margin-top:8px;padding:4px 10px;background:rgba(0,0,0,0.3);border-radius:20px;font-size:10px;color:#c4b5fd}

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
  .wait{color:#64748b;font-style:italic}
  .brier{color:#a78bfa;font-family:'Courier New',monospace;font-size:10px}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
  .dice{font-family:'Courier New',monospace;font-weight:600;color:#fbbf24}
  .sum-badge{
    display:inline-block;padding:2px 6px;border-radius:4px;
    background:rgba(251,191,36,0.15);color:#fbbf24;font-weight:700;
  }
  .session{font-family:'Courier New',monospace;font-size:10px;color:#94a3b8}
  .ti-le{font-size:10px;color:#a5b4fc}
  .ens-badge{
    display:inline-block;font-size:9px;
    padding:2px 5px;border-radius:4px;font-weight:700;
    background:#1e40af;color:#93c5fd;
  }
  .algo-badge{
    display:inline-block;font-size:9px;
    padding:2px 6px;border-radius:4px;font-weight:700;
    background:#7c3aed;color:#ddd6fe;
  }
  .type-badge{
    display:inline-block;font-size:9px;
    padding:2px 6px;border-radius:4px;font-weight:600;
    background:#1e40af;color:#93c5fd;
  }
  .regime-badge{
    display:inline-block;font-size:9px;
    padding:2px 6px;border-radius:4px;font-weight:600;
    background:#7c2d12;color:#fdba74;
  }
  .copy-btn{
    background:#10b981;color:#fff;border:none;
    padding:4px 10px;border-radius:6px;
    font-size:10px;font-weight:600;cursor:pointer;
  }
  .link-box{
    background:linear-gradient(135deg,#064e3b,#065f46);
    padding:12px;border-radius:12px;margin-bottom:14px;
    border:1px solid #10b981;
  }
  .link-box .title{font-size:12px;color:#6ee7b7;font-weight:600;margin-bottom:6px}
  .link-row{
    font-family:'Courier New',monospace;font-size:11px;color:#d1fae5;
    background:rgba(0,0,0,0.3);padding:8px;border-radius:6px;
    margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;
  }
  .link-row span{word-break:break-all;flex:1}
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
    <h1>🎯 HOANG VIP v10 — MEGA EVOLUTION</h1>
    <div class="subtitle">Bàn: ${game.toUpperCase()} • 15 thuật toán + Regime Detection</div>
  </div>

  <div class="hero">
    <div class="label">Dự đoán phiên tiếp theo</div>
    <div class="pred ${latestCode === 'T' ? 'tai' : (latestCode === 'X' ? 'xiu' : 'cho')}">
      ${latestPred} ${latestTiLe !== 'CHỜ' ? latestTiLe : ''}
    </div>
    <div class="meta">${latestReason || 'Chờ tín hiệu'} • Phiên ${latest ? latest.phienDuDoan : '—'}</div>
    <div class="regime">Regime: ${latestRegime}</div>
  </div>

  <div class="link-box">
    <div class="title">🔗 Link</div>
    <div class="link-row">
      <span>${req.protocol}://${req.get('host')}/api/predict/${game}</span>
      <button class="copy-btn" onclick="copyText('${req.protocol}://${req.get('host')}/api/predict/${game}', this)">Copy</button>
    </div>
    <div class="link-row">
      <span>${req.protocol}://${req.get('host')}/api/history/all</span>
      <button class="copy-btn" onclick="copyText('${req.protocol}://${req.get('host')}/api/history/all', this)">Copy</button>
    </div>
  </div>

  <div class="section-title">📊 16 Thuật toán</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Algo</th><th>T</th><th>W</th><th>L</th><th>Skip</th><th>Acc</th><th>Brier</th></tr>
      </thead>
      <tbody>${algoRows}</tbody>
    </table>
  </div>

  ${regimeRows ? `
  <div class="section-title">🎯 Accuracy theo Regime</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Regime</th><th>Tổng</th><th>W</th><th>L</th><th>Acc</th></tr>
      </thead>
      <tbody>${regimeRows}</tbody>
    </table>
  </div>
  ` : ''}

  ${typeRows ? `
  <div class="section-title">🎯 Accuracy theo loại cầu</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Loại</th><th>Tổng</th><th>W</th><th>L</th><th>Acc</th></tr>
      </thead>
      <tbody>${typeRows}</tbody>
    </table>
  </div>
  ` : ''}

  <div class="section-title">📜 40 phiên gần nhất</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Phiên</th><th>XX</th><th>Tổng</th><th>KQ</th>
          <th>Dự đoán</th><th>Tỉ lệ</th><th>Reason</th><th>Regime</th><th>TT</th>
        </tr>
      </thead>
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
            <td class="ti-le">${it.TI_LE || 'CHỜ'}</td>
            <td>${it.ensReason ? `<span class="ens-badge">${it.ensReason}</span>` : '—'}</td>
            <td><span class="regime-badge">${it.regimeType || '—'}</span></td>
            <td class="${ttCls}">${it.trangThai === 'ĐANG CHỜ' ? '...' : it.trangThai}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <div style="text-align:center;font-size:10px;color:#475569;margin-top:14px">
    Auto refresh 10s • HOANG VIP v10 • 15 Algorithms + Regime + Brier + Kelly
  </div>
</body>
</html>`;
  res.send(html);
});

// ============ SERVER ============
const server = app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 HOANG VIP v10 - MEGA EVOLUTION`);
  console.log(`========================================`);
  console.log(`Port: ${PORT} | Polling: ${POLL_INTERVAL_MS}ms`);
  console.log(`✅ 15 algorithms: STREAK, CAU, MARKOV, NGRAM, BAYESIAN,`);
  console.log(`   TREND, LSTM_SIM, ARIMA, KALMAN, RANDOM_FOREST,`);
  console.log(`   GRADIENT_BOOST, CHAOS, FOURIER, ENTROPY, META_LEARNER`);
  console.log(`✅ + ENSEMBLE voting`);
  console.log(`✅ Regime Detection (BỆT/CẦU_1_1/RANDOM/HỖN_HỢP)`);
  console.log(`✅ Brier Score + Kelly Criterion + Circuit Breaker`);
  console.log(`✅ Snapshots + Rollback support`);
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
