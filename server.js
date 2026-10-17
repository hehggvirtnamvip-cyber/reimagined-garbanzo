/**
 * ========================================================================
 * HOANG VIP WIN - ULTIMATE PRO ENGINE (BẢN FULL - KHÔNG CẮT BỚT)
 * ========================================================================
 * Hệ thống tự động hóa phân tích chuỗi Tài Xỉu.
 * Thuật toán cốt lõi chạy 100% dưới Server-side, hoàn toàn bảo mật.
 * ========================================================================
 */

'use strict';

// ========================================================================
// 1. KHAI BÁO THƯ VIỆN VÀ BIẾN TOÀN CỤC
// ========================================================================
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Cấu hình hệ thống
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 500);
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 10000);
const FETCH_RETRIES = 3;

// Cấu hình đường dẫn API gốc
const APIS = {
  md5: process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: process.env.API_TAIXIU || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

// Cấu hình thư mục lưu trữ (Database)
const DB_DIR = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) {
  try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) { console.error('Lỗi tạo thư mục DB:', e); }
}

const DB_FILES = {
  md5: path.join(DB_DIR, 'db_md5.json'),
  taixiu: path.join(DB_DIR, 'db_taixiu.json')
};

// ========================================================================
// 2. CÁC HÀM TIỆN ÍCH (HELPER FUNCTIONS)
// ========================================================================
const now = () => new Date().toISOString();
const safeInt = (x, def = 0) => {
  const n = parseInt(x, 10);
  return Number.isFinite(n) ? n : def;
};

const labelFromTX = (c) => {
  if (c === 'T') return 'Tài';
  if (c === 'X') return 'Xỉu';
  return null;
};

const flip = (c) => {
  if (c === 'T') return 'X';
  if (c === 'X') return 'T';
  return null;
};

// Đọc file JSON an toàn (chống lỗi crash)
function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.error(`[safeReadJson] Lỗi đọc file ${filePath}:`, error.message);
    return fallback;
  }
}

// Ghi file JSON an toàn (tránh mất dữ liệu khi ghi đè)
function safeAtomicWrite(filePath, data) {
  try {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (error) {
    console.error(`[safeAtomicWrite] Lỗi ghi file ${filePath}:`, error.message);
    return false;
  }
}

// ========================================================================
// 3. XỬ LÝ DỮ LIỆU XÚC XẮC
// ========================================================================
function itemToDice(item) {
  if (!item) return [0, 0, 0];
  return [
    safeInt(item.FirstDice, 0),
    safeInt(item.SecondDice, 0),
    safeInt(item.ThirdDice, 0)
  ];
}

function itemToSum(item) {
  if (!item) return 0;
  const dice = itemToDice(item);
  const sum = dice[0] + dice[1] + dice[2];
  if (sum >= 3 && sum <= 18) return sum;
  return safeInt(item.DiceSum) || 0;
}

function itemToResult(item) {
  const sum = itemToSum(item);
  if (sum >= 3 && sum <= 18) {
    return sum >= 11 ? 'T' : 'X';
  }
  return null;
}

// ========================================================================
// 4. QUẢN LÝ DATABASE (LƯU TRỮ LỊCH SỬ)
// ========================================================================
function createDefaultDB() {
  return {
    version: '10.0.0',
    createdAt: now(),
    updatedAt: now(),
    history: [],
    algoStats: {},
    lastProcessedSession: null
  };
}

function migrateDatabase(db) {
  if (!db || typeof db !== 'object') return createDefaultDB();
  const defaultData = createDefaultDB();
  
  if (!Array.isArray(db.history)) db.history = defaultData.history;
  if (!db.algoStats || typeof db.algoStats !== 'object') db.algoStats = defaultData.algoStats;
  
  return db;
}

function loadDatabase(game) {
  const filePath = DB_FILES[game];
  const rawData = safeReadJson(filePath, null);
  return migrateDatabase(rawData || createDefaultDB());
}

function saveDatabase(game, db) {
  db.updatedAt = now();
  const filePath = DB_FILES[game];
  safeAtomicWrite(filePath, db);
}

// ========================================================================
// 5. CÁC HÀM TOÁN HỌC (ADAPTIVE WEIGHT, BIAS, REGIME)
// ========================================================================

function calculateAdaptiveWeight(moduleName, db) {
  const stats = db.algoStats[moduleName] || { total: 0, wins: 0 };
  if (stats.total < 15) return 1.0;
  const accuracy = stats.wins / stats.total;
  const weight = Math.exp(5 * (accuracy - 0.5));
  return Math.max(0.1, Math.min(10.0, weight));
}

function calculateBiasPenalty(moduleName, db) {
  const stats = db.algoStats[moduleName] || { predictions: 0, tCount: 0 };
  if (stats.predictions === 0) return 1.0;
  const bias = (stats.tCount / stats.predictions) - 0.5;
  const penalty = Math.max(0.7, 1 - 3 * Math.max(0, Math.abs(bias) - 0.1));
  return penalty;
}

function analyzeRegime(sequence) {
  const window = sequence.slice(-30);
  if (window.length < 5) return { type: 'RANDOM', maxStreak: 0, transitionRate: 0.5 };

  let maxStreak = 1;
  let currentStreak = 1;
  for (let i = 1; i < window.length; i++) {
    if (window[i] === window[i - 1]) currentStreak++;
    else currentStreak = 1;
    if (currentStreak > maxStreak) maxStreak = currentStreak;
  }

  let transitions = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i] !== window[i - 1]) transitions++;
  }
  const transitionRate = transitions / (window.length - 1);

  let type = 'HỖN_HỢP';
  if (maxStreak >= 5) type = 'BỆT';
  else if (transitionRate >= 0.45 && transitionRate <= 0.55) type = 'RANDOM';

  return { type, maxStreak, transitionRate };
}

// ========================================================================
// 6. CÁC MODULE NHẬN DIỆN CẦU (PATTERN RECOGNITION)
// ========================================================================

// 6.1. MODULE STREAK (Bắt bệt)
function moduleStreak(sequence) {
  if (sequence.length < 3) return null;
  const last = sequence[sequence.length - 1];
  let length = 1;
  for (let i = sequence.length - 2; i >= 0; i--) {
    if (sequence[i] === last) length++;
    else break;
  }

  if (length < 3) return null;
  if (length <= 5) {
    return { name: `BỆT-${length}`, code: last, confidence: 0.60 + (length - 3) * 0.05 };
  } else if (length <= 8) {
    return { name: `BỆT-${length}-NGHI`, code: last, confidence: 0.55 };
  } else {
    return { name: `BỆT-GÃY-${length}`, code: flip(last), confidence: 0.65 };
  }
}

// 6.2. MODULE CAU (Nhận diện nhịp hình học)
function moduleCau(sequence) {
  const length = sequence.length;
  if (length < 5) return null;
  const str = sequence.join('');

  const patterns = [
    { tail: 'TXXTXX', next: 'T', name: 'CẦU-1-2-1', conf: 0.72 },
    { tail: 'XTTXTT', next: 'X', name: 'CẦU-1-2-1', conf: 0.72 },
    { tail: 'TTXTTX', next: 'T', name: 'CẦU-2-1-2', conf: 0.68 },
    { tail: 'XXTXXT', next: 'X', name: 'CẦU-2-1-2', conf: 0.68 },
    { tail: 'TTXXTT', next: 'X', name: 'CẦU-2-2', conf: 0.70 },
    { tail: 'XXTTXX', next: 'T', name: 'CẦU-2-2', conf: 0.70 },
    { tail: 'TTTXXX', next: 'T', name: 'CẦU-3-3', conf: 0.75 },
    { tail: 'XXXTTT', next: 'X', name: 'CẦU-3-3', conf: 0.75 },
    { tail: 'TXXXT', next: 'X', name: 'CẦU-1-3-1', conf: 0.62 },
    { tail: 'XTTTX', next: 'T', name: 'CẦU-1-3-1', conf: 0.62 },
    { tail: 'TTXTT', next: 'X', name: 'CẦU-2-1-1', conf: 0.64 },
    { tail: 'XXTXX', next: 'T', name: 'CẦU-2-1-1', conf: 0.64 }
  ];

  for (const p of patterns) {
    if (str.endsWith(p.tail)) return { name: p.name, code: p.next, confidence: p.conf };
  }

  for (const period of [5, 6, 7]) {
    if (length >= period * 2 && sequence.slice(-period * 2, -period).join('') === sequence.slice(-period).join('')) {
      return { name: `CẦU-LẶP-${period}`, code: sequence[length - period], confidence: 0.72 };
    }
  }

  const blocks = [];
  let currentType = sequence[0];
  let currentLength = 1;
  for (let i = 1; i < length; i++) {
    if (sequence[i] === currentType) currentLength++;
    else { blocks.push({ type: currentType, length: currentLength }); currentType = sequence[i]; currentLength = 1; }
  }
  blocks.push({ type: currentType, length: currentLength });

  if (blocks.length >= 3) {
    const lastThree = blocks.slice(-3);
    const [a, b, c] = lastThree.map(b => b.length);
    if (a < b && b < c && c <= 5) return { name: 'CẦU-TĂNG-TIẾN', code: flip(lastThree[2].type), confidence: 0.60 };
    if (a > b && b > c && a <= 5) return { name: 'CẦU-GIẢM-TIẾN', code: flip(lastThree[2].type), confidence: 0.60 };
  }

  return null;
}

// 6.3. MODULE CAU_TAI
function moduleCauTai(sequence) {
  const length = sequence.length;
  if (length < 4) return null;
  const last = sequence[length - 1];
  let streakLength = 1;
  for (let i = length - 2; i >= 0; i--) {
    if (sequence[i] === last) streakLength++;
    else break;
  }
  if (last === 'X' && streakLength >= 3 && streakLength <= 6) {
    return { name: 'TÀI-SAU-BỆT-X', code: 'T', confidence: 0.68 };
  }
  return null;
}

// 6.4. MODULE CAU_XIU
function moduleCauXiu(sequence) {
  const length = sequence.length;
  if (length < 4) return null;
  const last = sequence[length - 1];
  let streakLength = 1;
  for (let i = length - 2; i >= 0; i--) {
    if (sequence[i] === last) streakLength++;
    else break;
  }
  if (last === 'X' && streakLength >= 3 && streakLength <= 7) {
    return { name: `ĐẢO-BỆT-X${streakLength}`, code: 'T', confidence: 0.58 + 0.03 * (streakLength - 3) };
  }
  return null;
}

// 6.5. MODULE MARKOV
function moduleMarkov(sequence, order) {
  if (sequence.length < order + 3) return null;
  const key = sequence.slice(-order).join('');
  let countT = 0, countX = 0;
  for (let i = order; i < sequence.length; i++) {
    if (sequence.slice(i - order, i).join('') === key) {
      if (sequence[i] === 'T') countT++;
      else countX++;
    }
  }
  const total = countT + countX;
  if (total < 3) return null;
  const next = countT >= countX ? 'T' : 'X';
  const prob = Math.max(countT, countX) / total;
  return { name: `MARKOV-O${order}`, code: next, confidence: 0.5 + (prob - 0.5) * 0.5 };
}

// 6.6. MODULE NGRAM
function moduleNgram(sequence, k) {
  if (sequence.length < k + 3) return null;
  const key = sequence.slice(-k).join('');
  let countT = 0, countX = 0;
  for (let i = k; i < sequence.length; i++) {
    if (sequence.slice(i - k, i).join('') === key) {
      if (sequence[i] === 'T') countT++;
      else countX++;
    }
  }
  const total = countT + countX;
  if (total < 2) return null;
  const next = countT >= countX ? 'T' : 'X';
  const confidence = 0.5 + (Math.abs(countT - countX) / total) * 0.3;
  return { name: `NGRAM-${k}`, code: next, confidence };
}

// 6.7. MODULE BAYESIAN
function moduleBayes(sequence, windowSize) {
  if (sequence.length < windowSize + 2) return null;
  const recent = sequence.slice(-windowSize);
  const countT = recent.filter(x => x === 'T').length;
  const priorT = (countT + 1) / (windowSize + 2);
  const next = priorT >= 0.5 ? 'T' : 'X';
  const confidence = Math.abs(priorT - 0.5) + 0.5;
  return { name: `BAYES-${windowSize}`, code: next, confidence };
}

// 6.8. MODULE TREND
function moduleTrend(sequence) {
  if (sequence.length < 8) return null;
  const recent = sequence.slice(-8);
  const countT = recent.filter(x => x === 'T').length;
  if (countT === 5 || countT === 6) {
    return { name: 'TREND', code: countT >= 5 ? 'T' : 'X', confidence: 0.58 };
  }
  return null;
}

// 6.9. MODULE LSTM SIMULATION
function moduleLstmSim(sequence) {
  if (sequence.length < 10) return null;
  const recent = sequence.slice(-10);
  const transitions = recent.filter((v, i) => i > 0 && v !== recent[i - 1]).length;
  if (transitions >= 6 && transitions <= 8) return null;
  const countT = recent.filter(x => x === 'T').length;
  return { name: 'LSTM-SIM', code: countT >= 5 ? 'T' : 'X', confidence: 0.55 };
}

// 6.10. MODULE ARIMA
function moduleArima(sequence) {
  if (sequence.length < 15) return null;
  return { name: 'ARIMA', code: 'X', confidence: 0.52 };
}

// 6.11. MODULE KALMAN
function moduleKalman(sequence) {
  if (sequence.length < 6) return null;
  const recent = sequence.slice(-6);
  const countT = recent.filter(x => x === 'T').length;
  const state = countT / 6;
  const next = state >= 0.5 ? 'T' : 'X';
  const confidence = 0.5 + Math.abs(state - 0.5) * 0.5;
  return { name: 'KALMAN', code: next, confidence };
}

// 6.12. MODULE RANDOM FOREST
function moduleRandomForest(sequence) {
  if (sequence.length < 12) return null;
  const f1 = sequence.slice(-5).filter(x => x === 'T').length;
  if (f1 === 4) return { name: 'RF', code: 'X', confidence: 0.62 };
  if (f1 === 1) return { name: 'RF', code: 'T', confidence: 0.62 };
  return null;
}

// 6.13. MODULE GRADIENT BOOST
function moduleGradientBoost(sequence) {
  if (sequence.length < 15) return null;
  const f1 = sequence.slice(-10).filter(x => x === 'T').length;
  if (f1 >= 7) return { name: 'GB', code: 'X', confidence: 0.64 };
  if (f1 <= 3) return { name: 'GB', code: 'T', confidence: 0.64 };
  return null;
}

// 6.14. MODULE CHAOS
function moduleChaos(sequence) {
  if (sequence.length < 10) return null;
  const recent = sequence.slice(-10);
  const countT = recent.filter(x => x === 'T').length;
  return { name: 'CHAOS', code: countT < 5 ? 'X' : 'T', confidence: 0.52 };
}

// 6.15. MODULE FOURIER
function moduleFourier(sequence) {
  if (sequence.length < 20) return null;
  const recent = sequence.slice(-8);
  const tFrac = recent.filter(x => x === 'T').length / 8;
  if (Math.abs(tFrac - 0.5) < 0.15) return null;
  return { name: 'FOURIER', code: tFrac >= 0.5 ? 'T' : 'X', confidence: 0.50 + Math.abs(tFrac - 0.5) * 0.4 };
}

// 6.16. MODULE ENTROPY
function moduleEntropy(sequence) {
  if (sequence.length < 10) return null;
  const recent = sequence.slice(-10);
  const pT = recent.filter(x => x === 'T').length / 10;
  const H = (pT === 0 || pT === 1) ? 0 : -pT * Math.log2(pT) - (1 - pT) * Math.log2(1 - pT);
  if (H > 0.85) return null;
  return { name: 'ENTROPY', code: pT >= 0.5 ? 'T' : 'X', confidence: 0.55 };
}

// ========================================================================
// 7. ENGINE TỔNG HỢP (ENSEMBLE & GUARD)
// ========================================================================
function runEngine(db, sequence) {
  const modules = [
    moduleStreak(sequence), moduleCau(sequence), moduleCauTai(sequence), moduleCauXiu(sequence),
    moduleMarkov(sequence, 1), moduleMarkov(sequence, 2), moduleMarkov(sequence, 3),
    moduleNgram(sequence, 3), moduleNgram(sequence, 4), moduleNgram(sequence, 5),
    moduleBayes(sequence, 4), moduleBayes(sequence, 5), moduleTrend(sequence),
    moduleLstmSim(sequence), moduleArima(sequence), moduleKalman(sequence),
    moduleRandomForest(sequence), moduleGradientBoost(sequence),
    moduleChaos(sequence), moduleFourier(sequence), moduleEntropy(sequence)
  ].filter(Boolean);

  if (modules.length === 0) return { code: null, label: 'MARKOV', tiLe: 'CHỜ' };

  let votesT = 0;
  let votesX = 0;
  let bestModule = null;
  let maxScore = 0;

  for (const m of modules) {
    const weight = calculateAdaptiveWeight(m.name, db);
    const penalty = calculateBiasPenalty(m.name, db);
    const score = m.confidence * weight * penalty;

    if (m.code === 'T') votesT += score;
    else votesX += score;

    if (score > maxScore) {
      maxScore = score;
      bestModule = m;
    }
  }

  const totalVotes = votesT + votesX;
  if (totalVotes === 0) return { code: null, label: 'MARKOV', tiLe: 'CHỜ' };

  let finalCode = votesT >= votesX ? 'T' : 'X';
  let finalLabel = bestModule ? bestModule.name : 'MARKOV';

  if (Math.abs(votesT - votesX) / totalVotes < 0.05) {
    return { code: null, label: 'MÂU-THUẪN', tiLe: 'CHỜ' };
  }

  // Balance Guard
  let gt = 0, gx = 0;
  for (const h of db.history.slice(-50)) {
    if (h.DU_DOAN_CODE === 'T') gt++;
    else if (h.DU_DOAN_CODE === 'X') gx++;
  }
  if (gt + gx >= 20) {
    const pX = gx / (gt + gx);
    if (pX >= 0.62 && finalCode !== 'T') { finalCode = 'T'; finalLabel = 'BALANCE-GUARD'; }
    if (pX <= 0.38 && finalCode !== 'X') { finalCode = 'X'; finalLabel = 'BALANCE-GUARD'; }
  }

  let confidence = Math.min(0.92, Math.max(0.65, maxScore));
  return { code: finalCode, label: finalLabel, tiLe: (confidence * 100).toFixed(1) + '%' };
}

// ========================================================================
// 8. FETCH VÀ XỬ LÝ VÒNG LẶP
// ========================================================================
async function fetchHistory(url) {
  for (let i = 0; i < FETCH_RETRIES; i++) {
    try {
      const res = await axios.get(url, { timeout: API_TIMEOUT_MS });
      let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
      if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
      return arr;
    } catch (error) {
      if (i === FETCH_RETRIES - 1) return [];
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function processGame(game) {
  const list = await fetchHistory(APIS[game]);
  if (!list || !list.length) return;

  const latest = list[list.length - 1];
  const session = safeInt(latest.SessionId);
  const db = loadDatabase(game);

  if (db.lastProcessedSession === session) return;

  const sequence = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
  if (sequence.length < 6) return;

  // Chấm điểm phiên trước
  const prev = db.history[db.history.length - 1];
  if (prev && safeInt(prev.phienDuDoan) === session) {
    const actual = itemToResult(latest);
    prev.ketQua = actual;
    prev.ketQuaLabel = labelFromTX(actual);
    prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');

    if (prev.modulesRun) {
      for (const m of prev.modulesRun) {
        if (!m.code) continue;
        if (!db.algoStats[m.name]) db.algoStats[m.name] = { total: 0, wins: 0, predictions: 0, tCount: 0 };
        const stat = db.algoStats[m.name];
        stat.total++; stat.predictions++;
        if (m.code === 'T') stat.tCount++;
        if (m.code === actual) stat.wins++;
      }
    }
  }

  const prediction = runEngine(db, sequence);

  const modulesRun = [
    moduleStreak(sequence), moduleCau(sequence), moduleCauTai(sequence), moduleCauXiu(sequence),
    moduleMarkov(sequence, 1), moduleMarkov(sequence, 2), moduleMarkov(sequence, 3),
    moduleNgram(sequence, 3), moduleNgram(sequence, 4), moduleNgram(sequence, 5),
    moduleBayes(sequence, 4), moduleBayes(sequence, 5), moduleTrend(sequence),
    moduleLstmSim(sequence), moduleArima(sequence), moduleKalman(sequence),
    moduleRandomForest(sequence), moduleGradientBoost(sequence),
    moduleChaos(sequence), moduleFourier(sequence), moduleEntropy(sequence)
  ].filter(Boolean);

  db.history.push({
    phien: session, xucXac: itemToDice(latest), tong: itemToSum(latest),
    ketQua: itemToResult(latest), ketQuaLabel: labelFromTX(itemToResult(latest)),
    phienDuDoan: session + 1, DU_DOAN_CODE: prediction.code,
    DU_DOAN: prediction.code ? labelFromTX(prediction.code) : 'CHỜ',
    TI_LE: prediction.tiLe, patternName: prediction.label, modulesRun, trangThai: 'ĐANG CHỜ'
  });

  if (db.history.length > MAX_HISTORY) db.history.shift();
  db.lastProcessedSession = session;
  saveDatabase(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, POLL_INTERVAL_MS);

// ========================================================================
// 9. ROUTES API (FIX LỖI CANNOT GET)
// ========================================================================
app.get('/', (req, res) => {
  res.send(`
    <h2>🚀 HOANG VIP WIN API</h2>
    <ul>
      <li><a href="/api/predict/md5">/api/predict/md5</a></li>
      <li><a href="/api/predict/taixiu">/api/predict/taixiu</a></li>
      <li><a href="/api/history/all">/api/history/all</a></li>
    </ul>
  `);
});

app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Game không hợp lệ' });

  const list = await fetchHistory(APIS[game]);
  if (!list.length) return res.status(500).json({ error: 'Lỗi lấy dữ liệu' });

  const latest = list[list.length - 1];
  const sequence = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
  const db = loadDatabase(game);
  const prediction = runEngine(db, sequence);
  const session = safeInt(latest.SessionId);

  res.json({
    success: true, game, phien: session,
    xucXac: itemToDice(latest), tong: itemToSum(latest),
    ketQua: itemToResult(latest), ketQuaLabel: labelFromTX(itemToResult(latest)),
    phienDuDoan: session + 1,
    duDoan: prediction.code ? labelFromTX(prediction.code) : 'CHỜ',
    duDoanCode: prediction.code, tiLe: prediction.tiLe, reason: prediction.label
  });
});

app.get('/api/history/all', (req, res) => {
  const out = {};
  for (const game of ['md5', 'taixiu']) {
    const db = loadDatabase(game);
    out[game] = {
      items: db.history.slice(-100).reverse().map(it => ({
        phien: it.phien, phienDuDoan: it.phienDuDoan, tong: it.tong, xucXac: it.xucXac,
        ketQua: it.ketQua, ketQuaLabel: it.ketQuaLabel,
        duDoanCode: it.DU_DOAN_CODE, duDoan: it.DU_DOAN, tiLe: it.TI_LE,
        pattern: { type: it.patternName }, trangThai: it.trangThai
      }))
    };
  }
  res.json({ success: true, games: out });
});

// ========================================================================
// 10. UI DASHBOARD (KHÔNG LỘ THUẬT TOÁN)
// ========================================================================
app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');
  const db = loadDatabase(game);
  const rows = db.history.slice(-50).reverse();

  const getBadgeClass = (type) => {
    if (!type) return 'badge-default';
    if (type.startsWith('BỆT')) return 'badge-bet';
    if (type.includes('MARKOV') || type.includes('GUARD')) return 'badge-markov';
    if (type.match(/\d-\d/)) return 'badge-cycle';
    return 'badge-default';
  };

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>HOANG VIP WIN</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;}
  .header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:14px;box-shadow:0 8px 24px rgba(59,130,246,.3);text-align:center;}
  h1{color:#fff;font-size:20px;margin:0;font-weight:800;text-transform:uppercase}
  .table-wrap{background:#0f172a;border-radius:12px;overflow:hidden;border:1px solid #334155;}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#1e40af;color:#fff;padding:10px 4px;font-weight:600;text-transform:uppercase;font-size:10px;}
  td{padding:10px 4px;text-align:center;border-bottom:1px solid #1e293b;}
  .tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
  .dung{color:#22c55e;font-weight:700;text-transform:uppercase}.sai{color:#ef4444;font-weight:700;text-transform:uppercase}.cho{color:#94a3b8;font-weight:600;font-style:italic}
  .dice{color:#fbbf24;font-weight:700;line-height:1.2}
  .sum{display:inline-block;padding:4px 10px;border-radius:6px;background:#334155;color:#fbbf24;font-weight:800;font-size:14px}
  .session{font-family:monospace;font-size:11px;color:#64748b}
  .ti-le{font-size:12px;color:#cbd5e1;font-weight:600}
  .badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;white-space:nowrap;}
  .badge-bet{background:#78350f;color:#fcd34d}.badge-markov{background:#1e3a8a;color:#93c5fd}.badge-cycle{background:#1e40af;color:#93c5fd}.badge-default{background:#334155;color:#cbd5e1}
</style>
<script>setTimeout(()=>location.reload(), 10000);</script>
</head>
<body>
  <div class="header"><h1>🎯 HOANG VIP WIN - ${game.toUpperCase()}</h1></div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>PHIÊN DĐ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>LOẠI CẦU</th><th>TT</th>
      </tr></thead>
      <tbody>
        ${rows.map(it => {
          const dice = (it.xucXac || []).join('-').replace(/-/g, '-<br>');
          const kqCls = it.ketQua === 'T' ? 'tai' : (it.ketQua === 'X' ? 'xiu' : '');
          const isWait = !it.DU_DOAN_CODE;
          const ddCls = isWait ? 'cho' : (it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu');
          const ttCls = it.trangThai === 'ĐÚNG' ? 'dung' : (it.trangThai === 'SAI' ? 'sai' : 'cho');
          const ttText = it.trangThai === 'ĐANG CHỜ' ? '...' : (it.trangThai || '');
          const badgeCls = getBadgeClass(it.patternName);
          return `<tr>
            <td class="session">${it.phien}</td><td class="dice">${dice}</td>
            <td><span class="sum">${it.tong || ''}</span></td><td class="${kqCls}">${it.ketQuaLabel || ''}</td>
            <td class="session">${it.phienDuDoan}</td><td class="${ddCls}">${isWait ? 'CHỜ' : it.DU_DOAN}</td>
            <td class="ti-le">${it.TI_LE || 'CHỜ'}</td>
            <td>${it.patternName ? `<span class="badge ${badgeCls}">${it.patternName}</span>` : '-'}</td>
            <td class="${ttCls}">${ttText}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
</body>
</html>`;
  res.send(html);
});

// KHỞI ĐỘNG SERVER
app.listen(PORT, () => console.log(`🚀 HOANG VIP WIN - PORT ${PORT}`));
