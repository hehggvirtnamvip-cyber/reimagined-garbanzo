'use strict';

// ============================================================
// server.js — v12: ADAPTIVE FEATURE BANDIT + ADAM OPTIMIZER
// Node.js >= 18 | express + axios
// Không bỏ qua phiên, không random, tự phục hồi khi cầu đổi.
// ============================================================

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const DB_DIR  = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;
const MAX_HISTORY = 2000;
const MAX_NGRAM_ENTRIES = 10000;

if (!fs.existsSync(DB_DIR)) {
    try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {}
}

// ============================================================
// 0. HELPERS
// ============================================================
const label = c => (c === 'T' ? 'Tài' : c === 'X' ? 'Xỉu' : null);
const flip = c => (c === 'T' ? 'X' : c === 'X' ? 'T' : null);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const safeInt = (x, def = 0) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; };
const sigmoid = x => 1 / (1 + Math.exp(-x));
const nowIso = () => new Date().toISOString();

const getDice = item => [safeInt(item?.FirstDice), safeInt(item?.SecondDice), safeInt(item?.ThirdDice)];
const getSum = item => {
    const s = getDice(item).reduce((a, b) => a + b, 0);
    return (s >= 3 && s <= 18) ? s : safeInt(item?.DiceSum);
};
const getResult = item => {
    const s = getSum(item);
    return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null;
};

// ============================================================
// 0b. DATABASE (State & Bandit Memory)
// ============================================================
function defaultDB() {
    return {
        version: 12,
        createdAt: nowIso(),
        lastProcessedSession: null,
        history: [],
        meta: {
            totalPred: 0, totalWin: 0, totalLose: 0,
            winStreak: 0, loseStreak: 0,
            recent50: []
        },
        ngrams: { 1:{}, 2:{}, 3:{}, 4:{}, 5:{}, 6:{}, 7:{}, 8:{} },
        // ADAM Optimizer State
        adam: {
            t: 0, lr: 0.05, beta1: 0.9, beta2: 0.999, eps: 1e-8,
            m: {}, v: {}, weights: {
                bet: 1.0, alt: 1.0, block: 1.0, cycle: 1.0,
                ngram: 1.0, sumTrend: 1.0, boundary: 1.0,
                entropy: 1.0, markov: 1.0, regime: 1.0
            }
        },
        // UCB1 Bandit for Features (Track success rate per feature)
        bandit: {
            bet: { win: 1, total: 2 },
            alt: { win: 1, total: 2 },
            block: { win: 1, total: 2 },
            cycle: { win: 1, total: 2 },
            ngram: { win: 1, total: 2 },
            sumTrend: { win: 1, total: 2 },
            boundary: { win: 1, total: 2 },
            entropy: { win: 1, total: 2 },
            markov: { win: 1, total: 2 },
            regime: { win: 1, total: 2 }
        },
        kalman: { x: 0.5, p: 1.0, q: 0.01, r: 0.10 },
        calibration: { scale: 1.0, samples: 0 },
        regime: { current: 'MIXED', entropyRecent: 0 }
    };
}

function readDB(game) {
    const p = path.join(DB_DIR, `db_${game}.json`);
    try {
        if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            const def = defaultDB();
            return {
                ...def, ...raw,
                meta: { ...def.meta, ...(raw.meta || {}) },
                adam: { ...def.adam, ...(raw.adam || {}) },
                bandit: { ...def.bandit, ...(raw.bandit || {}) },
                kalman: { ...def.kalman, ...(raw.kalman || {}) },
                calibration: { ...def.calibration, ...(raw.calibration || {}) },
                ngrams: { ...def.ngrams, ...(raw.ngrams || {}) },
                regime: { ...def.regime, ...(raw.regime || {}) }
            };
        }
    } catch (e) { console.error(`[readDB ${game}] ${e.message}`); }
    return defaultDB();
}
function saveDB(game, db) {
    const p = path.join(DB_DIR, `db_${game}.json`);
    try { fs.writeFileSync(p, JSON.stringify(db, null, 2)); }
    catch (e) { console.error(`[saveDB ${game}] ${e.message}`); }
}

// ============================================================
// 1. ABSTRACTION
// ============================================================
function computeRLE(seq) {
    const out = [];
    if (!seq.length) return out;
    let cur = seq[0], len = 1;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === cur) len++;
        else { out.push({ ch: cur, len }); cur = seq[i]; len = 1; }
    }
    out.push({ ch: cur, len });
    return out;
}
function computeBlockStats(rleArr) {
    if (!rleArr.length) return { mean: 1, std: 0, max: 1, entropy: 0 };
    const lens = rleArr.map(b => b.len);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const counts = {};
    lens.forEach(l => (counts[l] = (counts[l] || 0) + 1));
    let entropy = 0;
    for (const k in counts) { const p = counts[k] / lens.length; entropy -= p * Math.log2(p); }
    return { mean, std: Math.sqrt(variance), max: Math.max(...lens), entropy };
}
function currentStreak(seq) {
    if (!seq.length) return 0;
    const last = seq[seq.length - 1];
    let c = 0;
    for (let i = seq.length - 1; i >= 0; i--) { if (seq[i] === last) c++; else break; }
    return c;
}
function currentAlternation(seq) {
    if (seq.length < 2) return 0;
    let c = 0;
    for (let i = seq.length - 1; i >= 1; i--) { if (seq[i] !== seq[i - 1]) c++; else break; }
    return c;
}

// ============================================================
// 2. DEEP N-GRAM MEMORY
// ============================================================
function updateDeepMemory(db, seq) {
    if (seq.length < 2) return;
    const actual = seq[seq.length - 1];
    for (let n = 1; n <= 8; n++) {
        if (seq.length <= n) continue;
        const key = seq.slice(-(n + 1), -1).join('');
        if (!db.ngrams[n]) db.ngrams[n] = {};
        if (!db.ngrams[n][key]) db.ngrams[n][key] = { T: 0, X: 0 };
        db.ngrams[n][key][actual] += 1;
        if (Object.keys(db.ngrams[n]).length > MAX_NGRAM_ENTRIES) {
            const keys = Object.keys(db.ngrams[n]);
            for (let i = 0; i < 100; i++) delete db.ngrams[n][keys[i]];
        }
    }
}
function queryBestNGram(db, seq, minSamples = 4) {
    for (let len = 8; len >= 2; len--) {
        if (seq.length < len) continue;
        const key = seq.slice(-len).join('');
        const mem = db.ngrams[len] && db.ngrams[len][key];
        if (mem && (mem.T + mem.X) >= minSamples) {
            const total = mem.T + mem.X;
            const probT = mem.T / total;
            return { len, probT, total, confidence: Math.abs(probT - 0.5) * 2, code: probT >= 0.5 ? 'T' : 'X' };
        }
    }
    return null;
}

// ============================================================
// 3. FEATURE EXTRACTORS
// ============================================================
function detectRegime(bStats) {
    const e = bStats.entropy;
    let current = 'MIXED';
    if (e < 1.2) current = 'TREND';
    else if (e > 2.0) current = 'CHOP';
    return { current, entropyRecent: e, at: nowIso() };
}

function extractFeatures(seq, sums, db) {
    const features = [];
    if (seq.length < 5) return { features, bStats: computeBlockStats([]) };

    const rleArr = computeRLE(seq);
    const bStats = computeBlockStats(rleArr);
    const n = seq.length;
    const last = seq[n - 1];

    const streak = currentStreak(seq);
    if (streak >= 3) {
        let code = last, conf = clamp(0.5 + (streak - 2) * 0.05, 0.5, 0.9);
        if (streak >= 9) { code = flip(code); conf = 0.85; }
        features.push({ name: 'bet', code, conf, tag: `Streak(${streak})` });
    }

    const alt = currentAlternation(seq);
    if (alt >= 3) {
        features.push({ name: 'alt', code: flip(last), conf: clamp(0.5 + alt * 0.05, 0.5, 0.85), tag: `Alt(${alt})` });
    }

    if (rleArr.length >= 3) {
        const [a, b, c] = rleArr.slice(-3);
        if (a.len === b.len && b.len === c.len)
            features.push({ name: 'block', code: flip(last), conf: 0.7, tag: `Block(${a.len})` });
    }

    if (n >= 8) {
        for (const cycleLen of [4, 5, 6]) {
            if (n >= cycleLen * 2 && seq.slice(-cycleLen * 2, -cycleLen).join('') === seq.slice(-cycleLen).join('')) {
                features.push({ name: 'cycle', code: seq[n - cycleLen], conf: 0.75, tag: `Cycle(${cycleLen})` });
                break;
            }
        }
    }

    if (sums && sums.length >= 5) {
        const recent5 = sums.slice(-5).reduce((a, b) => a + b, 0) / 5;
        if (recent5 >= 13) features.push({ name: 'sumTrend', code: 'X', conf: 0.65, tag: 'SumHigh' });
        else if (recent5 <= 8) features.push({ name: 'sumTrend', code: 'T', conf: 0.65, tag: 'SumLow' });
    }

    if (sums && sums.length >= 3) {
        const near = sums.slice(-3).filter(s => s === 10 || s === 11).length;
        if (near >= 2) features.push({ name: 'boundary', code: flip(last), conf: 0.6, tag: `Bound(${near})` });
    }

    if (bStats.entropy < 1.2 && rleArr.length > 4)
        features.push({ name: 'entropy', code: rleArr[rleArr.length - 1].ch, conf: 0.6, tag: `LowEntropy` });

    if (n >= 8) {
        const key = seq.slice(-3).join('');
        let t = 0, x = 0;
        for (let i = 3; i < n; i++) {
            if (seq.slice(i - 3, i).join('') === key) { if (seq[i] === 'T') t++; else x++; }
        }
        if (t + x >= 4) features.push({ name: 'markov', code: t > x ? 'T' : 'X', conf: clamp(Math.max(t, x) / (t + x), 0.5, 0.85), tag: `Markov3` });
    }

    const ng = queryBestNGram(db, seq, 4);
    if (ng && ng.confidence > 0.10) {
        features.push({ name: 'ngram', code: ng.code, conf: clamp(0.5 + ng.confidence * 0.4, 0.5, 0.9), tag: `NGram-${ng.len}` });
    }

    const regime = detectRegime(bStats);
    db.regime = regime;
    if (regime.current === 'TREND' && streak >= 3) features.push({ name: 'regime', code: last, conf: 0.62, tag: `Regime-TREND` });
    else if (regime.current === 'CHOP' && alt >= 2) features.push({ name: 'regime', code: flip(last), conf: 0.62, tag: `Regime-CHOP` });

    return { features, bStats, rleArr };
}

// ============================================================
// 4. KALMAN FILTER (Smoothing Confidence)
// ============================================================
function kalmanUpdate(state, measurement) {
    const q = state.q ?? 0.01, r = state.r ?? 0.10;
    let x = state.x ?? 0.5, p = state.p ?? 1.0;
    p = p + q;
    const k = p / (p + r);
    x = x + k * (measurement - x);
    p = (1 - k) * p;
    return { x, p, q, r };
}

// ============================================================
// 5. UCB1 FEATURE BANDIT (Dynamic Selection)
// ============================================================
function getUCB1Weight(db, featureName) {
    const arm = db.bandit[featureName] || { win: 1, total: 2 };
    const totalPulls = Object.values(db.bandit).reduce((a, b) => a + b.total, 0);
    
    if (arm.total === 0) return 3.0; // Force exploration
    
    const mean = arm.win / arm.total;
    const exploration = Math.sqrt(2 * Math.log(totalPulls) / arm.total);
    const ucb = mean + exploration;
    
    // Chuyển UCB thành trọng số: UCB ~1.0 là trung bình, >1.0 là tốt, <1.0 là dở
    // Giới hạn trong khoảng [0.1, 3.0]
    return clamp(ucb * 1.5, 0.1, 3.0);
}

// ============================================================
// 6. ADAM OPTIMIZER (For continuous features)
// ============================================================
function applyAdam(db, featureName, gradient) {
    const a = db.adam;
    a.t++;
    
    const w = a.weights[featureName] ?? 1.0;
    const m_prev = a.m[featureName] ?? 0;
    const v_prev = a.v[featureName] ?? 0;
    
    // Cập nhật moment
    a.m[featureName] = a.beta1 * m_prev + (1 - a.beta1) * gradient;
    a.v[featureName] = a.beta2 * v_prev + (1 - a.beta2) * (gradient ** 2);
    
    const m_hat = a.m[featureName] / (1 - Math.pow(a.beta1, a.t));
    const v_hat = a.v[featureName] / (1 - Math.pow(a.beta2, a.t));
    
    // Update weight
    a.weights[featureName] = clamp(w - a.lr * m_hat / (Math.sqrt(v_hat) + a.eps), 0.1, 3.0);
}

// ============================================================
// 7. FUSION (Bayesian + Bandit Weights)
// ============================================================
function bayesianFusion(features, db) {
    let logOddsT = 0;
    const breakdown = [];
    
    for (const f of features) {
        // Lấy trọng số từ cả Bandit và Adam
        const banditW = getUCB1Weight(db, f.name);
        const adamW = db.adam.weights[f.name] ?? 1.0;
        const combinedW = banditW * 0.6 + adamW * 0.4; // Ensemble
        
        const effectiveW = (f.conf - 0.5) * 2 * combinedW;
        if (f.code === 'T') logOddsT += effectiveW;
        else logOddsT -= effectiveW;
        
        breakdown.push({ name: f.name, tag: f.tag, code: f.code, conf: f.conf, w: combinedW });
    }
    
    return { probT: sigmoid(logOddsT), breakdown };
}

// ============================================================
// 8. LEARNING (Update Weights After Resolution)
// ============================================================
function learnFromResult(db, breakdown, predictedCode, actualCode) {
    const correct = predictedCode === actualCode;
    
    // 1. Cập nhật Adam (Gradient)
    for (const b of breakdown) {
        const featureCorrect = b.code === actualCode;
        const gradient = featureCorrect ? -1.0 : 1.0; // Loss surface
        applyAdam(db, b.name, gradient);
    }
    
    // 2. Cập nhật Bandit (Win Rate)
    for (const b of breakdown) {
        const arm = db.bandit[b.name] || { win: 1, total: 2 };
        arm.total++;
        if (b.code === actualCode) arm.win++;
        
        // Decay: Nếu tổng số mẫu quá lớn, giảm bớt để phản ứng nhanh hơn với thay đổi
        if (arm.total > 50) {
            arm.win *= 0.95;
            arm.total *= 0.95;
        }
        db.bandit[b.name] = arm;
    }
}

// ============================================================
// 9. EXECUTION ENGINE
// ============================================================
function makeDecision(db, seq, sums) {
    const { features, bStats } = extractFeatures(seq, sums, db);
    let { probT, breakdown } = bayesianFusion(features, db);

    const confRaw = Math.abs(probT - 0.5) * 2;
    db.kalman = kalmanUpdate(db.kalman, confRaw);
    const smoothedConf = clamp(db.kalman.x, 0.50, 0.95);

    probT = clamp(0.5 + (probT - 0.5) * db.calibration.scale, 0.01, 0.99);
    let finalCode = probT >= 0.5 ? 'T' : 'X';
    let finalReason = breakdown.slice(0, 3).map(b => b.tag).join('+') || 'Base-Rate';

    if (breakdown.length === 0) {
        const last10 = seq.slice(-10);
        const tCount = last10.filter(x => x === 'T').length;
        finalCode = tCount >= 5 ? 'X' : 'T';
        probT = finalCode === 'T' ? 0.55 : 0.45;
        finalReason = `Mean-Revert(${tCount}T/${last10.length - tCount}X)`;
    }

    return { code: finalCode, probT, strength: smoothedConf, label: finalReason, breakdown, regime: db.regime.current };
}

function runEngine(seq, sums, db) {
    if (!seq || seq.length < 5) return { code: 'T', probT: 0.5, strength: 0.5, label: 'Boot', breakdown: [], regime: 'MIXED', tiLe: '50.0%' };
    const d = makeDecision(db, seq, sums);
    return { code: d.code, probT: d.probT, strength: d.strength, label: d.label, breakdown: d.breakdown, regime: d.regime, tiLe: (d.strength * 100).toFixed(1) + '%' };
}

// ============================================================
// 10. FETCH & LOOP
// ============================================================
async function fetchApi(url) {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await axios.get(url, { timeout: 8000 });
            let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
            if (!Array.isArray(arr)) return [];
            if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
            return arr;
        } catch (e) {
            if (i === 2) { console.error(`[fetchApi] ${e.message}`); return []; }
            await new Promise(r => setTimeout(r, 500));
        }
    }
    return [];
}

async function processGame(game) {
    const url = game === 'md5' ? API_MD5 : API_TX;
    const list = await fetchApi(url);
    if (!list || !list.length) return;

    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    if (!session) return;

    const db = readDB(game);
    if (db.lastProcessedSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    if (seq.length < 5) return;

    // 1. Chấm điểm phiên trước
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);
        const correct = prev.DU_DOAN_CODE === actual;
        prev.trangThai = correct ? 'ĐÚNG' : 'SAI';
        
        db.meta.totalPred = (db.meta.totalPred || 0) + 1;
        if (correct) db.meta.totalWin = (db.meta.totalWin || 0) + 1;
        
        // Học từ kết quả
        if (prev.breakdown && prev.breakdown.length > 0) {
            learnFromResult(db, prev.breakdown, prev.DU_DOAN_CODE, actual);
        }
    }

    // 2. Học N-Gram
    updateDeepMemory(db, seq);

    // 3. Dự đoán phiên tới
    const pred = runEngine(seq, sums, db);

    db.history.push({
        phien: session, xucXac: getDice(latest), tong: getSum(latest),
        ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1, DU_DOAN_CODE: pred.code, DU_DOAN: label(pred.code),
        TI_LE: pred.tiLe, PROB_RAW: pred.probT, patternName: pred.label,
        regime: pred.regime, breakdown: pred.breakdown, trangThai: 'ĐANG CHỜ', at: nowIso()
    });

    if (db.history.length > MAX_HISTORY) db.history.shift();
    db.lastProcessedSession = session;
    saveDB(game, db);
}

setInterval(() => {
    processGame('md5').catch(() => {});
    processGame('taixiu').catch(() => {});
}, TICK_MS);

// ============================================================
// ROUTES & UI
// ============================================================
app.get('/', (req, res) => res.send(`<h2>Server v12 UCB1+Adam Online</h2><a href="/api/stats/taixiu">Stats</a> | <a href="/taixiu">UI</a>`));

app.get('/api/stats/:game', (req, res) => {
    const db = readDB(req.params.game);
    const m = db.meta || {};
    const wr = m.totalPred ? (m.totalWin / m.totalPred * 100).toFixed(2) + '%' : 'N/A';
    res.json({ winRate: wr, weights: db.adam.weights, bandit: db.bandit, kalman: db.kalman });
});

app.get('/api/predict/:game', (req, res) => {
    const db = readDB(req.params.game);
    if (!db.history.length) return res.json({ message: 'Chưa có' });
    const l = db.history[db.history.length - 1];
    res.json({ phien: l.phien, duDoan: l.DU_DOAN, code: l.DU_DOAN_CODE, tiLe: l.TI_LE, pattern: l.patternName });
});

app.get('/:game', (req, res) => {
    const game = req.params.game;
    const db = readDB(game);
    const rows = db.history.slice(-50).reverse();
    const m = db.meta || {};
    const wr = m.totalPred ? (m.totalWin / m.totalPred * 100).toFixed(1) : '0.0';

    const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>v12</title>
<style>body{font-family:sans-serif;background:#0a0e27;color:#fff;padding:12px}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px}
th{background:#1e3a8a;padding:8px}td{padding:8px;text-align:center;border-bottom:1px solid #333}
.tai{color:#22c55e}.xiu{color:#ef4444}.dung{color:#22c55e}.sai{color:#ef4444}</style>
<script>setTimeout(()=>location.reload(),10000)</script></head><body>
<h2>🎯 WIN v12 - ${game.toUpperCase()} (${wr}%)</h2>
<table><thead><tr><th>Phiên</th><th>Dự Đoán</th><th>Tỉ Lệ</th><th>Kết Quả</th><th>TT</th></tr></thead><tbody>
${rows.map(it => `<tr><td>${it.phienDuDoan}</td>
<td class="${it.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu'}">${it.DU_DOAN}</td>
<td>${it.TI_LE}</td><td>${it.ketQuaLabel || ''}</td>
<td class="${it.trangThai === 'ĐÚNG' ? 'dung' : 'sai'}">${it.trangThai}</td></tr>`).join('')}
</tbody></table></body></html>`;
    res.send(html);
});

app.listen(PORT, () => console.log(`🚀 v12 UCB1+Adam running on ${PORT}`));
