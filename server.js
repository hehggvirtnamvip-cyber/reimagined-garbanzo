'use strict';
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Cấu hình CORS cho phép Frontend gọi API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const APIS = {
  md5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

// =========================================================================
// CÁC HÀM TIỆN ÍCH TOÁN HỌC
// =========================================================================
function sigmoid(z) {
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  else { const e = Math.exp(z); return e / (1 + e); }
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

// =========================================================================
// MODULE 1-18: CÁC THUẬT TOÁN CƠ SỞ
// =========================================================================

// 1. STREAK (Bắt bệt)
function algoStreak(seq) {
  const n = seq.length;
  if (n < 4) return { code: null, conf: 0, reason: 'no_data' };
  const last = seq[n - 1];
  let len = 1;
  for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
  if (len >= 4 && len <= 14) return { code: last, conf: 0.75 + Math.min((len - 4) * 0.01, 0.10), reason: `BỆT${len}` };
  if (len >= 15) return { code: last === 'T' ? 'X' : 'T', conf: 0.65, reason: `BỆT${len}_GÃY` };
  return { code: null, conf: 0, reason: 'no_signal' };
}

// 2. CẦU (1-1, 2-2, 3-3)
function algoCau(seq) {
  const n = seq.length;
  if (n < 4) return { code: null, conf: 0, reason: 'no_data' };
  const last = seq[n - 1];
  
  let alt = 0;
  for (let i = n - 1; i >= 1; i--) { if (seq[i] !== seq[i - 1]) alt++; else break; }
  if (alt >= 5) return { code: last === 'T' ? 'X' : 'T', conf: Math.min(0.62 + (alt - 5) * 0.04, 0.80), reason: 'CẦU_1_1' };
  
  const p8 = seq.slice(-8).join('');
  if (p8 === 'TTXXTTXX') return { code: 'T', conf: 0.75, reason: 'CẦU_2_2' };
  if (p8 === 'XXTTXXTT') return { code: 'X', conf: 0.75, reason: 'CẦU_2_2' };
  
  const p6 = seq.slice(-6).join('');
  if (p6 === 'TTTXXX') return { code: 'T', conf: 0.72, reason: 'CẦU_3_3' };
  if (p6 === 'XXXTTT') return { code: 'X', conf: 0.72, reason: 'CẦU_3_3' };
  return { code: null, conf: 0, reason: 'no_signal' };
}

// 3. CẦU TÀI (Bắt đảo bệt Xỉu)
function algoCauTai(seq) {
  const n = seq.length;
  if (n < 6) return { code: null, conf: 0, reason: 'no_data' };
  const last = seq[n - 1];
  if (last === 'T' && seq[n-2] === 'X' && seq[n-3] === 'X' && seq[n-4] === 'X') return { code: 'T', conf: 0.68, reason: 'TÀI_SAU_BỆT_X' };
  
  let len = 1;
  for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
  if (last === 'X' && len >= 3 && len <= 5) return { code: 'T', conf: 0.58 + Math.min((len - 3) * 0.03, 0.08), reason: `ĐẢO_BỆT_X${len}` };
  return { code: null, conf: 0, reason: 'no_signal' };
}

// 4. CẦU XỈU (Bắt đảo bệt Tài)
function algoCauXiu(seq) {
  const n = seq.length;
  if (n < 6) return { code: null, conf: 0, reason: 'no_data' };
  const last = seq[n - 1];
  if (last === 'X' && seq[n-2] === 'T' && seq[n-3] === 'T' && seq[n-4] === 'T') return { code: 'X', conf: 0.68, reason: 'XỈU_SAU_BỆT_T' };
  
  let len = 1;
  for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
  if (last === 'T' && len >= 3 && len <= 5) return { code: 'X', conf: 0.58 + Math.min((len - 3) * 0.03, 0.08), reason: `ĐẢO_BỆT_T${len}` };
  return { code: null, conf: 0, reason: 'no_signal' };
}

// 5. MARKOV (Chuỗi Markov bậc 5)
function algoMarkov(seq) {
  const n = seq.length;
  if (n < 10) return { code: null, conf: 0, reason: 'no_data' };
  for (let order = 5; order >= 1; order--) {
    if (n <= order) continue;
    const ctx = seq.slice(-order).join('');
    let countT = 0, countX = 0;
    for (let i = 0; i <= n - order - 1; i++) {
      if (seq.slice(i, i + order).join('') === ctx) {
        if (seq[i + order] === 'T') countT++; else countX++;
      }
    }
    const total = countT + countX;
    if (total < 3) continue;
    const pT = (countT + 1.0) / (total + 2.0);
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.15) continue;
    return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.30, 0.75), reason: `MARKOV_O${order}` };
  }
  return { code: null, conf: 0, reason: 'no_signal' };
}

// 6. NGRAM (Mẫu 3-7 phiên)
function algoNgram(seq) {
  const n = seq.length;
  if (n < 30) return { code: null, conf: 0, reason: 'no_data' };
  for (let len = 7; len >= 3; len--) {
    if (n <= len) continue;
    const ctx = seq.slice(-len).join('');
    let countT = 0, countX = 0;
    for (let i = 0; i <= n - len - 1; i++) {
      if (seq.slice(i, i + len).join('') === ctx) {
        if (seq[i + len] === 'T') countT++; else countX++;
      }
    }
    const total = countT + countX;
    if (total < 3) continue;
    const pT = (countT + 1.0) / (total + 2.0);
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.20) continue;
    return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.35, 0.78), reason: `NGRAM_${len}` };
  }
  return { code: null, conf: 0, reason: 'no_signal' };
}

// 7. BAYESIAN (Xác suất có điều kiện)
function algoBayesian(seq) {
  const n = seq.length;
  if (n < 20) return { code: null, conf: 0, reason: 'no_data' };
  let cntT = 0;
  for (const s of seq) if (s === 'T') cntT++;
  const priorT = (cntT + 1) / (n + 2);
  const priorX = 1 - priorT;
  
  for (let len = 6; len >= 2; len--) {
    if (n < len) continue;
    const ctx = seq.slice(-len).join('');
    let countT = 0, countX = 0;
    for (let i = 0; i <= n - len - 1; i++) {
      if (seq.slice(i, i + len).join('') === ctx) {
        if (seq[i + len] === 'T') countT++; else countX++;
      }
    }
    const total = countT + countX;
    if (total < 4) continue;
    const pT = ((countT + 1) / (total + 2) * priorT) / (((countT + 1) / (total + 2) * priorT) + ((countX + 1) / (total + 2) * priorX));
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.15) continue;
    return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.40, 0.78), reason: `BAYES_${len}` };
  }
  return { code: null, conf: 0, reason: 'no_signal' };
}

// 8. TREND (Xu hướng 20 phiên)
function algoTrend(seq) {
  const n = seq.length;
  if (n < 20) return { code: null, conf: 0, reason: 'no_data' };
  const cntT = seq.slice(-20).filter(x => x === 'T').length;
  if (cntT >= 13) return { code: 'X', conf: 0.58, reason: 'TREND_X' };
  if (cntT <= 7) return { code: 'T', conf: 0.58, reason: 'TREND_T' };
  return { code: null, conf: 0, reason: 'no_signal' };
}

// 9. LSTM_SIM (Giả lập mạng LSTM bằng EWMA)
function algoLSTMSim(seq) {
  const n = seq.length;
  if (n < 20) return { code: null, conf: 0, reason: 'no_data' };
  const values = [];
  for (const a of [0.5, 0.3, 0.15, 0.07, 0.03]) {
    let s = 0;
    for (const x of seq) s = a * (x === 'T' ? 1 : -1) + (1 - a) * s;
    values.push(s);
  }
  const g1 = sigmoid(values[0] * 2 + values[1] * 1.5);
  const g2 = sigmoid(values[2] * 3);
  const g3 = sigmoid(values[3] * 4 + values[4] * 2);
  const output = (g1 * 0.4 + g2 * 0.3 + g3 * 0.3) * 2 - 1;
  const conf = Math.abs(output);
  if (conf < 0.15) return { code: null, conf: 0, reason: 'LSTM_LOW' };
  return { code: output >= 0 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.35, 0.78), reason: 'LSTM_SIM' };
}

// 10. ARIMA (Hồi quy tự động)
function algoARIMA(seq) {
  const n = seq.length;
  if (n < 30) return { code: null, conf: 0, reason: 'no_data' };
  const p = 5;
  const vals = seq.map(x => x === 'T' ? 1 : 0);
  const X = [], Y = [];
  for (let i = p; i < n; i++) { X.push(vals.slice(i - p, i)); Y.push(vals[i]); }
  if (X.length < 10) return { code: null, conf: 0, reason: 'ARIMA_NO_DATA' };
  
  const coef = new Array(p).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    const grad = new Array(p).fill(0);
    for (let k = 0; k < X.length; k++) {
      let pred = 0;
      for (let j = 0; j < p; j++) pred += coef[j] * X[k][j];
      const err = Y[k] - pred;
      for (let j = 0; j < p; j++) grad[j] += err * X[k][j];
    }
    for (let j = 0; j < p; j++) coef[j] += 0.01 * grad[j] / X.length;
  }
  
  let pred = 0;
  const lastP = vals.slice(-p);
  for (let j = 0; j < p; j++) pred += coef[j] * lastP[j];
  const conf = Math.abs(pred - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'ARIMA_LOW' };
  return { code: pred >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.30, 0.72), reason: 'ARIMA_P5' };
}

// 11. KALMAN (Bộ lọc Kalman)
function algoKalman(seq) {
  const n = seq.length;
  if (n < 20) return { code: null, conf: 0, reason: 'no_data' };
  let x = 0.5, P = 1.0;
  for (const v of seq.map(x => x === 'T' ? 1 : 0)) {
    const PPred = P + 0.01;
    const K = PPred / (PPred + 0.1);
    x = x + K * (v - x);
    P = (1 - K) * PPred;
  }
  const conf = Math.abs(x - 0.5) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'KALMAN_LOW' };
  return { code: x >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.35, 0.75), reason: 'KALMAN' };
}

// 12. RANDOM_FOREST (Rừng ngẫu nhiên giả lập)
function algoRandomForest(seq) {
  const n = seq.length;
  if (n < 20) return { code: null, conf: 0, reason: 'no_data' };
  let s = 0;
  for (const x of seq.slice(-20)) s = 0.15 * (x === 'T' ? 1 : -1) + 0.85 * s;
  const conf = Math.abs(s) * 2;
  if (conf < 0.15) return { code: null, conf: 0, reason: 'RF_LOW' };
  return { code: s >= 0 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.35, 0.75), reason: 'RF' };
}

// 13. GRADIENT_BOOST (Tăng cường gradient giả lập)
function algoGradientBoost(seq) {
  return algoRandomForest(seq);
}

// 14. CHAOS (Lý thuyết hỗn loạn)
function algoChaos(seq) {
  const n = seq.length;
  if (n < 30) return { code: null, conf: 0, reason: 'no_data' };
  const vals = seq.map(x => x === 'T' ? 0.9 : 0.1);
  let bestR = 3.9, bestErr = 1e9;
  for (let r = 3.5; r <= 4.0; r += 0.05) {
    let err = 0;
    for (let i = 1; i < vals.length; i++) err += Math.abs(r * vals[i - 1] * (1 - vals[i - 1]) - vals[i]);
    if (err < bestErr) { bestErr = err; bestR = r; }
  }
  const pred = bestR * vals[vals.length - 1] * (1 - vals[vals.length - 1]);
  const conf = Math.abs(pred - 0.5) * 2;
  if (conf < 0.20) return { code: null, conf: 0, reason: 'CHAOS_LOW' };
  return { code: pred >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + conf * 0.30, 0.72), reason: 'CHAOS' };
}

// 15. FOURIER (Phân tích tần số)
function algoFourier(seq) {
  const n = seq.length;
  if (n < 40) return { code: null, conf: 0, reason: 'no_data' };
  const N = Math.min(64, n);
  const vals = seq.slice(-N).map(x => x === 'T' ? 1 : -1);
  const freqs = [];
  for (let k = 1; k <= 8; k++) {
    let real = 0, imag = 0;
    for (let m = 0; m < N; m++) {
      const a = (2 * Math.PI * k * m) / N;
      real += vals[m] * Math.cos(a);
      imag -= vals[m] * Math.sin(a);
    }
    freqs.push({ k, mag: Math.sqrt(real * real + imag * imag) / N, phase: Math.atan2(imag, real) });
  }
  freqs.sort((a, b) => b.mag - a.mag);
  if (freqs[0].mag < 0.2) return { code: null, conf: 0, reason: 'FOURIER_LOW' };
  const pred = freqs[0].mag * 2 * Math.cos((2 * Math.PI * freqs[0].k * N) / N + freqs[0].phase);
  const conf = Math.min(Math.abs(pred), 0.75);
  if (conf < 0.15) return { code: null, conf: 0, reason: 'FOURIER_LOW2' };
  return { code: pred >= 0 ? 'T' : 'X', conf, reason: 'FOURIER' };
}

// 16. ENTROPY (Độ hỗn loạn Shannon)
function algoEntropy(seq) {
  const n = seq.length;
  if (n < 20) return { code: null, conf: 0, reason: 'no_data' };
  const pT = seq.slice(-20).filter(x => x === 'T').length / 20;
  const ent = -(pT * Math.log2(pT || 1e-9) + (1 - pT) * Math.log2((1 - pT) || 1e-9));
  if (ent < 0.75) return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.5 + (1 - ent) * 0.5, 0.72), reason: 'ENT_LOW' };
  if (ent > 0.95) return { code: seq[n - 1] === 'T' ? 'X' : 'T', conf: 0.55, reason: 'ENT_HIGH' };
  return { code: null, conf: 0, reason: 'no_signal' };
}

// 17. META_LEARNER (Học cách kết hợp)
function algoMetaLearner(seq, allResults) {
  let voteT = 0, voteX = 0;
  for (const name of Object.keys(allResults)) {
    const r = allResults[name];
    if (!r.code) continue;
    if (r.code === 'T') voteT += r.conf; else voteX += r.conf;
  }
  const total = voteT + voteX;
  if (total < 0.1) return { code: null, conf: 0, reason: 'META_NO_SIGNAL' };
  const pT = voteT / total;
  const conf = Math.abs(pT - 0.5) * 2;
  if (conf < 0.10) return { code: null, conf: 0, reason: 'META_TOO_CLOSE' };
  return { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.55 + conf * 0.30, 0.80), reason: 'META' };
}

// =========================================================================
// HÀM TỔNG HỢP CHÍNH
// =========================================================================
function runAllAlgorithms(seq) {
  const results = {
    STREAK: algoStreak(seq),
    CAU: algoCau(seq),
    CAU_TAI: algoCauTai(seq),
    CAU_XIU: algoCauXiu(seq),
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
  
  results.META_LEARNER = algoMetaLearner(seq, results);
  
  let voteT = 0, voteX = 0;
  for (const name of Object.keys(results)) {
    if (name === 'META_LEARNER') continue;
    const r = results[name];
    if (!r.code) continue;
    if (r.code === 'T') voteT += r.conf; else voteX += r.conf;
  }
  const total = voteT + voteX;
  if (total < 0.5) {
    results.ENSEMBLE = { code: null, conf: 0, reason: 'ENSEMBLE_NO_SIGNAL' };
  } else {
    const pT = voteT / total;
    const conf = Math.abs(pT - 0.5) * 2;
    if (conf < 0.10) results.ENSEMBLE = { code: null, conf: 0, reason: 'ENSEMBLE_TOO_CLOSE' };
    else results.ENSEMBLE = { code: pT >= 0.5 ? 'T' : 'X', conf: Math.min(0.55 + conf * 0.30, 0.82), reason: 'ENSEMBLE' };
  }
  
  return results;
}

// =========================================================================
// API ROUTE
// =========================================================================
app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });

  try {
    const r = await axios.get(APIS[game]);
    let list = Array.isArray(r.data) ? r.data : r.data.data;
    if (!list || !list.length) return res.status(204).send();

    if (Number(list[0].SessionId) > Number(list[list.length - 1].SessionId)) list.reverse();
    const latest = list[list.length - 1];
    const dice = [Number(latest.FirstDice)||0, Number(latest.SecondDice)||0, Number(latest.ThirdDice)||0];
    const sum = dice.reduce((a, b) => a + b, 0);

    const seqStr = list.map(item => {
      const s = (Number(item.FirstDice)||0) + (Number(item.SecondDice)||0) + (Number(item.ThirdDice)||0);
      return s >= 11 ? 'T' : 'X';
    }).join('');
    
    const seq = seqStr.split('');
    const algos = runAllAlgorithms(seq);
    const finalPred = algos.ENSEMBLE;

    res.json({
      success: true,
      phien: Number(latest.SessionId),
      xucXac: dice,
      tong: sum,
      duDoan: finalPred.code === 'T' ? 'Tài' : (finalPred.code === 'X' ? 'Xỉu' : 'CHỜ'),
      tiLe: finalPred.conf > 0 ? (finalPred.conf * 100).toFixed(1) + '%' : '0%',
      lyDo: finalPred.reason,
      chiTiet: algos
    });
  } catch (e) {
    res.status(500).json({ error: 'Server Error' });
  }
});

app.listen(PORT, () => console.log(`🚀 HOANG VIP v22 (Full 18 Algos) RUNNING ON PORT ${PORT}`));
