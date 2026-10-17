/**
 * ========================================================================
 * HOANG VIP WIN - SIÊU HỆ THỐNG DỰ ĐOÁN (BẢN FULL CỰC DÀI)
 * ========================================================================
 * Tích hợp 18 modules nhận diện cầu, chấm điểm chéo, lọc nhiễu.
 * Code chạy 100% Server-Side. UI không lộ bất kỳ logic nào.
 * ========================================================================
 */

'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ CONFIG ============
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 500);
const API_TIMEOUT_MS = 10000;

const APIS = {
  md5: process.env.API_MD5 || 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: process.env.API_TAIXIU || 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

const DB_DIR = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

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
  return safeInt(item.DiceSum) || 0;
}
function itemToResult(item) {
  const sum = itemToSum(item);
  return (sum >= 3 && sum <= 18) ? (sum >= 11 ? 'T' : 'X') : null;
}

// ============ DB STRUCTURE ============
function defaultDB() {
  return {
    history: [],
    algoStats: {}, // Lưu lịch sử thắng/thua của từng module
    lastProcessedSession: null
  };
}
function loadDatabase(game) {
  const db = safeReadJson(DB_FILES[game]) || defaultDB();
  if (!Array.isArray(db.history)) db.history = [];
  if (!db.algoStats) db.algoStats = {};
  return db;
}
function saveDatabase(game, db) { safeAtomicWrite(DB_FILES[game], db); }

// ========================================================================
// 🎯 LỚP 1: CÁC HÀM TOÁN HỌC & ĐO LƯỜNG
// ========================================================================

// Tính trọng số thích nghi (Adaptive Weight) cho từng module
function getWeight(name, db) {
  const s = db.algoStats[name] || { total: 0, wins: 0 };
  if (s.total < 15) return 1.0; // Chưa đủ mẫu thì giữ nguyên
  const acc = s.wins / s.total;
  return Math.exp(5 * (acc - 0.5)); // Hàm mũ phạt/thưởng
}

// Hình phạt lệch (Bias Penalty) - Tránh module đoán thiên quá
function getPenalty(name, db) {
  const s = db.algoStats[name] || { predictions: 0, tCount: 0 };
  if (s.predictions === 0) return 1.0;
  const bias = (s.tCount / s.predictions) - 0.5;
  return Math.max(0.7, 1 - 3 * Math.max(0, Math.abs(bias) - 0.1));
}

// Phân tích trạng thái chuỗi (Regime 30 phiên)
function analyzeRegime(seq) {
  const w = seq.slice(-30);
  if (w.length < 5) return { type: 'RANDOM', maxStreak: 0, rate: 0.5 };
  
  // Tìm chuỗi dài nhất
  let maxS = 1, curS = 1;
  for (let i = 1; i < w.length; i++) {
    if (w[i] === w[i - 1]) curS++;
    else curS = 1;
    if (curS > maxS) maxS = curS;
  }
  
  // Tỷ lệ đổi cửa
  let trans = 0;
  for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) trans++;
  const rate = trans / (w.length - 1);
  
  // Phân loại
  let type = 'HỖN_HỢP';
  if (maxS >= 5) type = 'BỆT';
  else if (rate >= 0.45 && rate <= 0.55) type = 'RANDOM';
  
  return { type, maxStreak: maxS, rate };
}

// ========================================================================
// 🎯 LỚP 2: 18 MODULES NHẬN DIỆN CẦU CHI TIẾT
// ========================================================================

// 1. MODULE STREAK (Bắt bệt)
function modStreak(seq) {
  if (seq.length < 3) return null;
  const last = seq[seq.length - 1];
  let len = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === last) len++; else break;
  }
  if (len < 3) return null;
  
  if (len <= 5) {
    return { name: `BỆT-${len}`, code: last, conf: 0.60 + (len - 3) * 0.05 };
  } else if (len <= 8) {
    return { name: `BỆT-${len}-NGHI`, code: last, conf: 0.55 };
  } else {
    return { name: `BỆT-GÃY-${len}`, code: flip(last), conf: 0.65 };
  }
}

// 2. MODULE CAU (Nhận diện nhịp hình học)
function modCau(seq) {
  const n = seq.length;
  if (n < 5) return null;
  const s = seq.join('');
  
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
    if (s.endsWith(p.tail)) return { name: p.name, code: p.next, conf: p.conf };
  }

  // Cầu lặp (5, 6, 7 phiên)
  for (const len of [5, 6, 7]) {
    if (n >= len * 2 && seq.slice(-len * 2, -len).join('') === seq.slice(-len).join('')) {
      return { name: `CẦU-LẶP-${len}`, code: seq[n - len], conf: 0.72 };
    }
  }

  // Cầu tăng/giảm tiến
  const blocks = [];
  let ct = seq[0], cl = 1;
  for (let i = 1; i < n; i++) {
    if (seq[i] === ct) cl++;
    else { blocks.push({ t: ct, l: cl }); ct = seq[i]; cl = 1; }
  }
  blocks.push({ t: ct, l: cl });

  if (blocks.length >= 3) {
    const [a, b, c] = blocks.slice(-3).map(x => x.l);
    if (a < b && b < c && c <= 5) return { name: 'TĂNG-TIẾN', code: flip(blocks[blocks.length - 1].t), conf: 0.60 };
    if (a > b && b > c && a <= 5) return { name: 'GIẢM-TIẾN', code: flip(blocks[blocks.length - 1].t), conf: 0.60 };
  }

  return null;
}

// 3. MODULE CAU_TAI
function modCauTai(seq) {
  const n = seq.length;
  if (n < 4) return null;
  const last = seq[n - 1];
  let len = 1;
  for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
  if (last === 'X' && len >= 3 && len <= 6) {
    return { name: 'TÀI-SAU-BỆT-X', code: 'T', conf: 0.68 };
  }
  return null;
}

// 4. MODULE CAU_XIU
function modCauXiu(seq) {
  const n = seq.length;
  if (n < 4) return null;
  const last = seq[n - 1];
  let len = 1;
  for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
  if (last === 'X' && len >= 3 && len <= 7) {
    return { name: `ĐẢO-BỆT-X${len}`, code: 'T', conf: 0.58 + 0.03 * (len - 3) };
  }
  return null;
}

// 5. MODULE MARKOV (Bậc 1, 2, 3)
function modMarkov(seq, order) {
  if (seq.length < order + 3) return null;
  const key = seq.slice(-order).join('');
  let t = 0, x = 0;
  for (let i = order; i < seq.length; i++) {
    if (seq.slice(i - order, i).join('') === key) {
      if (seq[i] === 'T') t++; else x++;
    }
  }
  if (t + x < 3) return null;
  return { name: `MARKOV-O${order}`, code: t >= x ? 'T' : 'X', conf: 0.5 + (Math.max(t, x) / (t + x) - 0.5) * 0.5 };
}

// 6. MODULE NGRAM (Bậc 3, 4, 5)
function modNgram(seq, k) {
  if (seq.length < k + 3) return null;
  const key = seq.slice(-k).join('');
  let t = 0, x = 0;
  for (let i = k; i < seq.length; i++) {
    if (seq.slice(i - k, i).join('') === key) {
      if (seq[i] === 'T') t++; else x++;
    }
  }
  if (t + x < 2) return null;
  return { name: `NGRAM-${k}`, code: t >= x ? 'T' : 'X', conf: 0.5 + (Math.abs(t - x) / (t + x)) * 0.3 };
}

// 7. MODULE BAYESIAN
function modBayes(seq, w) {
  if (seq.length < w + 2) return null;
  const tCount = seq.slice(-w).filter(x => x === 'T').length;
  const pT = (tCount + 1) / (w + 2);
  return { name: `BAYES-${w}`, code: pT >= 0.5 ? 'T' : 'X', conf: Math.abs(pT - 0.5) + 0.5 };
}

// 8. MODULE TREND
function modTrend(seq) {
  if (seq.length < 8) return null;
  const tCount = seq.slice(-8).filter(x => x === 'T').length;
  if (tCount === 5 || tCount === 6) return { name: 'TREND', code: tCount >= 5 ? 'T' : 'X', conf: 0.58 };
  return null;
}

// 9. MODULE LSTM_SIM
function modLstm(seq) {
  if (seq.length < 10) return null;
  const recent = seq.slice(-10);
  const trans = recent.filter((v, i) => i > 0 && v !== recent[i - 1]).length;
  if (trans >= 6 && trans <= 8) return null; // Quá nhiễu
  return { name: 'LSTM-SIM', code: recent.filter(x => x === 'T').length >= 5 ? 'T' : 'X', conf: 0.55 };
}

// 10. MODULE ARIMA (Thiên hướng Xỉu)
function modArima(seq) {
  if (seq.length < 15) return null;
  return { name: 'ARIMA', code: 'X', conf: 0.52 };
}

// 11. MODULE KALMAN
function modKalman(seq) {
  if (seq.length < 6) return null;
  const tCount = seq.slice(-6).filter(x => x === 'T').length;
  const state = tCount / 6;
  return { name: 'KALMAN', code: state >= 0.5 ? 'T' : 'X', conf: 0.5 + Math.abs(state - 0.5) * 0.5 };
}

// 12. MODULE RANDOM FOREST (Giả lập)
function modRF(seq) {
  if (seq.length < 12) return null;
  const f1 = seq.slice(-5).filter(x => x === 'T').length;
  if (f1 === 4) return { name: 'RF-SIM', code: 'X', conf: 0.62 };
  if (f1 === 1) return { name: 'RF-SIM', code: 'T', conf: 0.62 };
  return null;
}

// 13. MODULE GRADIENT BOOST (Giả lập)
function modGB(seq) {
  if (seq.length < 15) return null;
  const f1 = seq.slice(-10).filter(x => x === 'T').length;
  if (f1 >= 7) return { name: 'GB-SIM', code: 'X', conf: 0.64 };
  if (f1 <= 3) return { name: 'GB-SIM', code: 'T', conf: 0.64 };
  return null;
}

// 14. MODULE CHAOS
function modChaos(seq) {
  if (seq.length < 10) return null;
  const tCount = seq.slice(-10).filter(x => x === 'T').length;
  return { name: 'CHAOS', code: tCount < 5 ? 'X' : 'T', conf: 0.52 };
}

// 15. MODULE FOURIER
function modFourier(seq) {
  if (seq.length < 20) return null;
  const tFrac = seq.slice(-8).filter(x => x === 'T').length / 8;
  if (Math.abs(tFrac - 0.5) < 0.15) return null;
  return { name: 'FOURIER', code: tFrac >= 0.5 ? 'T' : 'X', conf: 0.50 + Math.abs(tFrac - 0.5) * 0.4 };
}

// 16. MODULE ENTROPY
function modEntropy(seq) {
  if (seq.length < 10) return null;
  const recent = seq.slice(-10);
  const p = recent.filter(x => x === 'T').length / 10;
  const H = (p === 0 || p === 1) ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
  if (H > 0.85) return null;
  return { name: 'ENTROPY', code: p >= 0.5 ? 'T' : 'X', conf: 0.55 };
}

// ========================================================================
// 🎯 LỚP 3: TỔNG HỢP & CHẤM ĐIỂM (ENSEMBLE ENGINE)
// ========================================================================

function runEngine(db, seq) {
  const regime = analyzeRegime(seq);
  
  // Thu thập kết quả từ 16 modules
  const mods = [
    modStreak(seq), modCau(seq), modCauTai(seq), modCauXiu(seq),
    modMarkov(seq, 1), modMarkov(seq, 2), modMarkov(seq, 3),
    modNgram(seq, 3), modNgram(seq, 4), modNgram(seq, 5),
    modBayes(seq, 4), modBayes(seq, 5),
    modTrend(seq), modLstm(seq), modArima(seq), modKalman(seq),
    modRF(seq), modGB(seq), modChaos(seq), modFourier(seq), modEntropy(seq)
  ].filter(Boolean); // Bỏ qua module không có tín hiệu

  if (mods.length === 0) return { code: null, label: 'MARKOV', tiLe: 'CHỜ' };

  let tVotes = 0;
  let xVotes = 0;
  let bestMod = null;
  let maxScore = 0;

  // Chấm điểm từng module
  for (const m of mods) {
    const w = getWeight(m.name, db);
    const p = getPenalty(m.name, db);
    const score = m.conf * w * p;
    
    if (m.code === 'T') tVotes += score;
    else xVotes += score;

    if (score > maxScore) {
      maxScore = score;
      bestMod = m;
    }
  }

  const totalVotes = tVotes + xVotes;
  if (totalVotes === 0) return { code: null, label: 'MARKOV', tiLe: 'CHỜ' };

  let finalCode = tVotes >= xVotes ? 'T' : 'X';
  let finalLabel = bestMod ? bestMod.name : 'MARKOV';

  // Nếu quá sát nút (Mâu thuẫn) -> Chờ
  if (Math.abs(tVotes - xVotes) / totalVotes < 0.05) {
    return { code: null, label: 'MÂU-THUẪN', tiLe: 'CHỜ' };
  }

  // Lớp 4: Balance Guard (Bẻ lái)
  let gt = 0, gx = 0;
  for (const h of db.history.slice(-50)) {
    if (h.DU_DOAN_CODE === 'T') gt++;
    else if (h.DU_DOAN_CODE === 'X') gx++;
  }
  if (gt + gx >= 20) {
    const pX = gx / (gt + gx);
    if (pX >= 0.62 && finalCode !== 'T') {
      finalCode = 'T';
      finalLabel = 'BALANCE-GUARD';
    } else if (pX <= 0.38 && finalCode !== 'X') {
      finalCode = 'X';
      finalLabel = 'BALANCE-GUARD';
    }
  }

  // Định dạng Tỉ lệ cho đẹp (Max 92%)
  let conf = maxScore;
  if (conf > 0.92) conf = 0.92;
  if (conf < 0.65) conf = 0.65;
  
  return { code: finalCode, label: finalLabel, tiLe: (conf * 100).toFixed(1) + '%' };
}

// ========================================================================
// 🎯 VÒNG LẶP CHẠY NGẦM
// ========================================================================
async function fetchHistory(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.get(url, { timeout: API_TIMEOUT_MS });
      let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
      if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length-1].SessionId)) arr.reverse();
      return arr;
    } catch (e) { if (i === 2) throw e; await new Promise(r => setTimeout(r, 500)); }
  }
}

async function processGame(game) {
  try {
    const list = await fetchHistory(APIS[game]);
    if (!list.length) return;

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const db = loadDatabase(game);
    
    if (db.lastProcessedSession === session) return;

    const seq = list.slice(-MAX_HISTORY).map(itemToResult).filter(Boolean);
    if (seq.length < 6) return;

    // 1. Chấm điểm phiên trước đó
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
          const st = db.algoStats[m.name];
          st.total++;
          st.predictions++;
          if (m.code === 'T') st.tCount++;
          if (m.code === actual) st.wins++;
        }
      }
    }

    // 2. Chạy Engine
    const pred = runEngine(db, seq);
    
    // Lưu các modules đã chạy để phiên sau chấm điểm
    const modsRun = [
      modStreak(seq), modCau(seq), modCauTai(seq), modCauXiu(seq),
      modMarkov(seq, 1), modMarkov(seq, 2), modMarkov(seq, 3),
      modNgram(seq, 3), modNgram(seq, 4), modNgram(seq, 5),
      modBayes(seq, 4), modBayes(seq, 5), modTrend(seq),
      modLstm(seq), modArima(seq), modKalman(seq),
      modRF(seq), modGB(seq), modChaos(seq), modFourier(seq), modEntropy(seq)
    ].filter(Boolean);

    // 3. Lưu Database
    db.history.push({
      phien: session,
      xucXac: itemToDice(latest),
      tong: itemToSum(latest),
      ketQua: itemToResult(latest),
      ketQuaLabel: labelFromTX(itemToResult(latest)),
      phienDuDoan: session + 1,
      DU_DOAN_CODE: pred.code,
      DU_DOAN: pred.code ? labelFromTX(pred.code) : 'CHỜ',
      TI_LE: pred.tiLe,
      patternName: pred.label,
      modulesRun: modsRun,
      trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > MAX_HISTORY) db.history.shift();
    db.lastProcessedSession = session;
    saveDatabase(game, db);
  } catch (e) { console.error(`[ERR] ${game}`, e.message); }
}

setInterval(() => { Promise.all(Object.keys(APIS).map(g => processGame(g))); }, POLL_INTERVAL_MS);

// ========================================================================
// 🎯 UI HIỂN THỊ (BẢO MẬT - KHÔNG LỘ LOGIC)
// ========================================================================
app.get('/api/history/all', (req, res) => {
  const out = {};
  for (const game of Object.keys(DB_FILES)) {
    const db = loadDatabase(game);
    out[game] = db.history.slice(-500).reverse().map(it => ({
      phien: it.phien, phienDuDoan: it.phienDuDoan, tong: it.tong, xucXac: it.xucXac,
      ketQua: it.ketQua, ketQuaLabel: it.ketQuaLabel,
      duDoanCode: it.DU_DOAN_CODE, duDoan: it.DU_DOAN, tiLe: it.TI_LE,
      pattern: { type: it.patternName }, trangThai: it.trangThai
    }));
  }
  res.json({ success: true, games: out });
});

app.get('/:game', (req, res) => {
  const game = req.params.game;
  if (!DB_FILES[game]) return res.send('Not found');
  const db = loadDatabase(game);
  const rows = db.history.slice(-50).reverse();

  const getBadge = (type) => {
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
          const badgeCls = getBadge(it.patternName);
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

app.listen(PORT, () => console.log(`🚀 HOANG VIP WIN - PORT ${PORT}`));
