'use strict';

// ============================================================
// server.js — v11 DEEP ADAPTIVE ENSEMBLE
// Node.js >= 18 | express + axios
// 14 layers | no random | no skip | online learning
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
// LAYER 0 — UTILITIES
// ============================================================
const label  = c => (c === 'T' ? 'Tài' : c === 'X' ? 'Xỉu' : null);
const flip   = c => (c === 'T' ? 'X' : c === 'X' ? 'T' : null);
const clamp  = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const safeInt = (x, def = 0) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; };
const sigmoid = x => 1 / (1 + Math.exp(-x));
const logit   = p => Math.log(p / (1 - p));

const nowIso = () => new Date().toISOString();

const getDice = item => [
    safeInt(item?.FirstDice),
    safeInt(item?.SecondDice),
    safeInt(item?.ThirdDice)
];
const getSum = item => {
    const s = getDice(item).reduce((a, b) => a + b, 0);
    return (s >= 3 && s <= 18) ? s : safeInt(item?.DiceSum);
};
const getResult = item => {
    const s = getSum(item);
    return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null;
};

// ============================================================
// LAYER 0b — PERSISTENCE & SCHEMA
// ============================================================
function defaultDB() {
    return {
        version: 11,
        createdAt: nowIso(),
        lastProcessedSession: null,
        history: [],
        meta: {
            totalPred: 0,
            totalWin: 0,
            totalLose: 0,
            winStreak: 0,
            loseStreak: 0,
            maxWinStreak: 0,
            maxLoseStreak: 0,
            recent50: [],          // { session, correct }
            adaptiveLR: 0.03
        },
        ngrams: { 1:{}, 2:{}, 3:{}, 4:{}, 5:{}, 6:{}, 7:{}, 8:{} },
        weights: {
            bet: 1.0, alt: 1.0, block: 1.0, cycle: 1.0,
            ngram: 1.0, sumTrend: 1.0, boundary: 1.0,
            entropy: 1.0, markov: 1.0, regime: 1.0
        },
        kalman: { x: 0.5, p: 1.0, q: 0.01, r: 0.10 },
        calibration: { scale: 1.0, samples: 0 },
        contexts: {},              // L10
        regime: { current: 'MIXED', entropyRecent: 0 }
    };
}

function readDB(game) {
    const p = path.join(DB_DIR, `db_${game}.json`);
    try {
        if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            const def = defaultDB();
            // Merge an toàn — đảm bảo field mới luôn tồn tại
            return {
                ...def,
                ...raw,
                meta:       { ...def.meta, ...(raw.meta || {}) },
                weights:    { ...def.weights, ...(raw.weights || {}) },
                kalman:     { ...def.kalman, ...(raw.kalman || {}) },
                calibration:{ ...def.calibration, ...(raw.calibration || {}) },
                ngrams:     { ...def.ngrams, ...(raw.ngrams || {}) },
                regime:     { ...def.regime, ...(raw.regime || {}) }
            };
        }
    } catch (e) {
        console.error(`[readDB ${game}] ${e.message}`);
    }
    return defaultDB();
}

function saveDB(game, db) {
    const p = path.join(DB_DIR, `db_${game}.json`);
    try {
        fs.writeFileSync(p, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error(`[saveDB ${game}] ${e.message}`);
    }
}

// ============================================================
// LAYER 1 — SEQUENCE ABSTRACTION (RLE + BlockStats + Entropy)
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
    if (!rleArr.length) return { mean: 1, std: 0, max: 1, entropy: 0, distinct: 0 };
    const lens = rleArr.map(b => b.len);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const counts = {};
    lens.forEach(l => (counts[l] = (counts[l] || 0) + 1));
    let entropy = 0;
    for (const k in counts) {
        const p = counts[k] / lens.length;
        entropy -= p * Math.log2(p);
    }
    return {
        mean,
        std: Math.sqrt(variance),
        max: Math.max(...lens),
        entropy,
        distinct: Object.keys(counts).length
    };
}

// Đếm streak hiện tại (cùng màu cuối)
function currentStreak(seq) {
    if (!seq.length) return 0;
    const last = seq[seq.length - 1];
    let c = 0;
    for (let i = seq.length - 1; i >= 0; i--) {
        if (seq[i] === last) c++;
        else break;
    }
    return c;
}

// Đếm số lần đảo liên tiếp
function currentAlternation(seq) {
    if (seq.length < 2) return 0;
    let c = 0;
    for (let i = seq.length - 1; i >= 1; i--) {
        if (seq[i] !== seq[i - 1]) c++;
        else break;
    }
    return c;
}

// ============================================================
// LAYER 2 — DEEP N-GRAM MEMORY
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

        // Pruning: giữ bộ nhớ gọn
        const size = Object.keys(db.ngrams[n]).length;
        if (size > MAX_NGRAM_ENTRIES) {
            const keys = Object.keys(db.ngrams[n]);
            const toDelete = size - MAX_NGRAM_ENTRIES + 100;
            for (let i = 0; i < toDelete; i++) delete db.ngrams[n][keys[i]];
        }
    }
}

// Truy vấn N-Gram tốt nhất (bậc cao nhất có đủ mẫu)
function queryBestNGram(db, seq, minSamples = 4) {
    for (let len = 8; len >= 2; len--) {
        if (seq.length < len) continue;
        const key = seq.slice(-len).join('');
        const mem = db.ngrams[len] && db.ngrams[len][key];
        if (mem && (mem.T + mem.X) >= minSamples) {
            const total = mem.T + mem.X;
            const probT = mem.T / total;
            return {
                len,
                probT,
                total,
                confidence: Math.abs(probT - 0.5) * 2,
                code: probT >= 0.5 ? 'T' : 'X'
            };
        }
    }
    return null;
}

// ============================================================
// LAYER 3 — FEATURE EXTRACTORS
// ============================================================
function extractFeatures(seq, sums, db) {
    const features = [];
    if (seq.length < 5) return { features, bStats: computeBlockStats([]), rleArr: [] };

    const rleArr = computeRLE(seq);
    const bStats = computeBlockStats(rleArr);
    const n = seq.length;
    const last = seq[n - 1];

    // F1: Bệt (Streak)
    const streak = currentStreak(seq);
    if (streak >= 3) {
        let code = last;
        let conf = clamp(0.5 + (streak - 2) * 0.05, 0.5, 0.9);
        if (streak >= 9) {
            code = flip(code);
            conf = 0.85;
        }
        features.push({ name: 'bet', code, conf, tag: `Streak(${streak})` });
    }

    // F2: Đảo 1-1
    const alt = currentAlternation(seq);
    if (alt >= 3) {
        features.push({
            name: 'alt',
            code: flip(last),
            conf: clamp(0.5 + alt * 0.05, 0.5, 0.85),
            tag: `Alt(${alt})`
        });
    }

    // F3: Block Repetition (a.len == b.len == c.len)
    if (rleArr.length >= 3) {
        const [a, b, c] = rleArr.slice(-3);
        if (a.len === b.len && b.len === c.len) {
            features.push({ name: 'block', code: flip(last), conf: 0.7, tag: `Block(${a.len}-${b.len}-${c.len})` });
        }
    }

    // F4: Cycle Pattern (4,5,6)
    if (n >= 8) {
        for (const cycleLen of [4, 5, 6]) {
            if (n >= cycleLen * 2 &&
                seq.slice(-cycleLen * 2, -cycleLen).join('') === seq.slice(-cycleLen).join('')) {
                features.push({
                    name: 'cycle',
                    code: seq[n - cycleLen],
                    conf: 0.75,
                    tag: `Cycle(${cycleLen})`
                });
                break;
            }
        }
    }

    // F5: Sum Trend
    if (sums && sums.length >= 5) {
        const recent5 = sums.slice(-5).reduce((a, b) => a + b, 0) / 5;
        if (recent5 >= 13) features.push({ name: 'sumTrend', code: 'X', conf: 0.65, tag: 'SumHigh' });
        else if (recent5 <= 8) features.push({ name: 'sumTrend', code: 'T', conf: 0.65, tag: 'SumLow' });
    }

    // F6: Boundary (10/11 gần đây)
    if (sums && sums.length >= 3) {
        const near = sums.slice(-3).filter(s => s === 10 || s === 11).length;
        if (near >= 2) {
            features.push({
                name: 'boundary',
                code: flip(last),
                conf: 0.6,
                tag: `Bound(${near})`
            });
        }
    }

    // F7: Low Entropy (predictable)
    if (bStats.entropy < 1.2 && rleArr.length > 4) {
        features.push({
            name: 'entropy',
            code: rleArr[rleArr.length - 1].ch,
            conf: 0.6,
            tag: `LowEntropy(${bStats.entropy.toFixed(2)})`
        });
    }

    // F8: Markov bậc 3
    if (n >= 8) {
        const key = seq.slice(-3).join('');
        let t = 0, x = 0;
        for (let i = 3; i < n; i++) {
            if (seq.slice(i - 3, i).join('') === key) {
                if (seq[i] === 'T') t++;
                else x++;
            }
        }
        if (t + x >= 4) {
            features.push({
                name: 'markov',
                code: t > x ? 'T' : 'X',
                conf: clamp(Math.max(t, x) / (t + x), 0.5, 0.85),
                tag: `Markov3(${t}/${x})`
            });
        }
    }

    // F9: N-Gram Deep
    const ng = queryBestNGram(db, seq, 4);
    if (ng && ng.confidence > 0.10) {
        features.push({
            name: 'ngram',
            code: ng.code,
            conf: clamp(0.5 + ng.confidence * 0.4, 0.5, 0.9),
            tag: `NGram-${ng.len}(${ng.total})`
        });
    }

    // F10: Regime-based (L11)
    const regime = detectRegime(bStats, seq);
    db.regime = regime;
    if (regime.current === 'TREND' && streak >= 3) {
        features.push({
            name: 'regime',
            code: last,
            conf: 0.62,
            tag: `Regime-TREND(${streak})`
        });
    } else if (regime.current === 'CHOP' && alt >= 2) {
        features.push({
            name: 'regime',
            code: flip(last),
            conf: 0.62,
            tag: `Regime-CHOP(${alt})`
        });
    }

    return { features, bStats, rleArr };
}

// ============================================================
// LAYER 11 — REGIME DETECTOR
// ============================================================
function detectRegime(bStats, seq) {
    const e = bStats.entropy;
    let current = 'MIXED';
    if (e < 1.2) current = 'TREND';
    else if (e > 2.0) current = 'CHOP';
    return { current, entropyRecent: e, at: nowIso() };
}

// ============================================================
// LAYER 4 — KALMAN FILTER
// ============================================================
function kalmanUpdate(state, measurement) {
    const q = state.q ?? 0.01;
    const r = state.r ?? 0.10;
    let x = state.x ?? 0.5;
    let p = state.p ?? 1.0;

    // Predict
    p = p + q;

    // Update
    const k = p / (p + r);
    x = x + k * (measurement - x);
    p = (1 - k) * p;

    return { x, p, q, r };
}

// ============================================================
// LAYER 5 — BAYESIAN FUSION
// ============================================================
function bayesianFusion(features, weights) {
    let logOddsT = 0;
    const breakdown = [];

    for (const f of features) {
        const w = weights[f.name] ?? 1.0;
        const effectiveW = (f.conf - 0.5) * 2 * w;
        if (f.code === 'T') logOddsT += effectiveW;
        else logOddsT -= effectiveW;

        breakdown.push({
            name: f.name,
            tag: f.tag,
            code: f.code,
            conf: f.conf,
            w,
            effect: effectiveW
        });
    }

    const probT = sigmoid(logOddsT);
    return { probT, breakdown, logOddsT };
}

// ============================================================
// LAYER 12 — CALIBRATION
// ============================================================
function calibrate(db, probRaw) {
    const scale = clamp(db.calibration.scale ?? 1.0, 0.5, 1.2);
    const p = 0.5 + (probRaw - 0.5) * scale;
    return clamp(p, 0.01, 0.99);
}

function updateCalibration(db, probRaw, correct, predictedCode, actualCode) {
    // Nếu model tự tin cao mà sai → giảm scale
    // Nếu model tự tin cao mà đúng → tăng scale
    const confidence = Math.abs(probRaw - 0.5) * 2; // 0..1
    if (confidence < 0.3) return; // không học từ phiên mờ nhạt

    const lr = 0.02;
    if (correct) db.calibration.scale += lr * confidence;
    else         db.calibration.scale -= lr * confidence;

    db.calibration.scale = clamp(db.calibration.scale, 0.5, 1.2);
    db.calibration.samples = (db.calibration.samples || 0) + 1;
}

// ============================================================
// LAYER 6 — ONLINE GRADIENT DESCENT
// ============================================================
function updateWeights(db, breakdown, predictedCode, actualCode) {
    const lr = clamp(db.meta.adaptiveLR ?? 0.03, 0.01, 0.08);

    for (const b of breakdown) {
        const key = b.name;
        if (!(key in db.weights)) db.weights[key] = 1.0;

        const featureCorrect = b.code === actualCode;
        const delta = featureCorrect ? lr : -lr;

        db.weights[key] = clamp(db.weights[key] + delta, 0.1, 3.0);
    }

    // Cập nhật adaptive LR: nếu thua nhiều → tăng LR để thích nghi nhanh
    const m = db.meta;
    if (m.totalPred >= 5) {
        const wr = m.totalWin / m.totalPred;
        if (wr < 0.45) m.adaptiveLR = clamp((m.adaptiveLR || 0.03) + 0.002, 0.01, 0.08);
        else if (wr > 0.60) m.adaptiveLR = clamp((m.adaptiveLR || 0.03) - 0.002, 0.01, 0.08);
    }
}

// ============================================================
// LAYER 7 — DECISION MAKER
// ============================================================
function makeDecision(db, seq, sums) {
    const { features, bStats, rleArr } = extractFeatures(seq, sums, db);

    let { probT, breakdown, logOddsT } = bayesianFusion(features, db.weights);

    // Kalman smoothing cho confidence
    const confRaw = Math.abs(probT - 0.5) * 2;
    db.kalman = kalmanUpdate(db.kalman, confRaw);
    const smoothedConf = clamp(db.kalman.x, 0.50, 0.95);

    // Calibration
    probT = calibrate(db, probT);

    // Fallback khi không có feature
    let finalReason = breakdown.slice(0, 3).map(b => b.tag).join(' + ') || 'Base-Rate';
    let finalCode = probT >= 0.5 ? 'T' : 'X';

    if (breakdown.length === 0) {
        const last10 = seq.slice(-10);
        const tCount = last10.filter(x => x === 'T').length;
        finalCode = tCount >= 5 ? 'X' : 'T';
        probT = finalCode === 'T' ? 0.55 : 0.45;
        finalReason = `Mean-Revert(${tCount}T/${last10.length - tCount}X)`;
    }

    return {
        code: finalCode,
        probT,
        probRaw: probT,
        strength: smoothedConf,
        label: finalReason,
        breakdown,
        bStats,
        rleLen: rleArr.length,
        regime: db.regime.current
    };
}

// ============================================================
// LAYER 8 — EXECUTION ENGINE
// ============================================================
function runEngine(seq, sums, db) {
    if (!seq || seq.length < 5) {
        return {
            code: 'T', probT: 0.5, strength: 0.5,
            label: 'Boot', breakdown: [], tiLe: '50.0%'
        };
    }
    const d = makeDecision(db, seq, sums);
    return {
        code: d.code,
        probT: d.probT,
        strength: d.strength,
        label: d.label,
        breakdown: d.breakdown,
        regime: d.regime,
        tiLe: (d.strength * 100).toFixed(1) + '%'
    };
}

// ============================================================
// LAYER 13 — FETCH & PROCESS LOOP
// ============================================================
async function fetchApi(url) {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await axios.get(url, { timeout: 8000 });
            let arr =
                res.data?.data?.list ||
                res.data?.list ||
                res.data?.data ||
                (Array.isArray(res.data) ? res.data : []);
            if (!Array.isArray(arr)) return [];
            if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) {
                arr.reverse();
            }
            return arr;
        } catch (e) {
            if (i === 2) {
                console.error(`[fetchApi] fail: ${e.message}`);
                return [];
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }
    return [];
}

function pushMetaResult(meta, correct) {
    meta.totalPred = (meta.totalPred || 0) + 1;
    if (correct) {
        meta.totalWin = (meta.totalWin || 0) + 1;
        meta.winStreak = (meta.winStreak || 0) + 1;
        meta.loseStreak = 0;
        meta.maxWinStreak = Math.max(meta.maxWinStreak || 0, meta.winStreak);
    } else {
        meta.totalLose = (meta.totalLose || 0) + 1;
        meta.loseStreak = (meta.loseStreak || 0) + 1;
        meta.winStreak = 0;
        meta.maxLoseStreak = Math.max(meta.maxLoseStreak || 0, meta.loseStreak);
    }
    meta.recent50.push(correct ? 1 : 0);
    while (meta.recent50.length > 50) meta.recent50.shift();
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

    const seq  = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    if (seq.length < 5) return;

    // ---- (1) Chấm điểm phiên trước ----
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);
        const correct = prev.DU_DOAN_CODE === actual;
        prev.trangThai = correct ? 'ĐÚNG' : 'SAI';

        // Cập nhật meta
        pushMetaResult(db.meta, correct);

        // Gradient Descent
        if (prev.breakdown && prev.breakdown.length > 0) {
            updateWeights(db, prev.breakdown, prev.DU_DOAN_CODE, actual);
        }

        // Calibration update
        if (typeof prev.PROB_RAW === 'number') {
            updateCalibration(db, prev.PROB_RAW, correct, prev.DU_DOAN_CODE, actual);
        }
    }

    // ---- (2) Cập nhật bộ nhớ sâu ----
    updateDeepMemory(db, seq);

    // ---- (3) Dự đoán phiên tiếp ----
    const pred = runEngine(seq, sums, db);

    db.history.push({
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code,
        DU_DOAN: label(pred.code),
        TI_LE: pred.tiLe,
        PROB_RAW: pred.probT,
        STRENGTH: pred.strength,
        patternName: pred.label,
        regime: pred.regime,
        breakdown: pred.breakdown,
        trangThai: 'ĐANG CHỜ',
        at: nowIso()
    });

    if (db.history.length > MAX_HISTORY) db.history.shift();
    db.lastProcessedSession = session;
    saveDB(game, db);
}

// Timer chính
setInterval(() => {
    processGame('md5').catch(e => console.error('[md5]', e.message));
    processGame('taixiu').catch(e => console.error('[taixiu]', e.message));
}, TICK_MS);

// ============================================================
// ROUTES — HOME
// ============================================================
app.get('/', (req, res) => {
    res.send(`<div style="font-family:sans-serif;padding:20px;background:#0a0e27;color:#e6eef6;min-height:100vh">
        <h2 style="color:#22c55e;">🚀 BACKEND v11 — DEEP ADAPTIVE ENSEMBLE (14 LAYERS)</h2>
        <p>No random. No skip. Online Gradient Descent. Kalman Smoothing. Regime Detector.</p>
        <ul>
            <li><a style="color:#93c5fd" href="/api/stats/taixiu">/api/stats/taixiu — Weights, Kalman, Calibration</a></li>
            <li><a style="color:#93c5fd" href="/api/stats/md5">/api/stats/md5</a></li>
            <li><a style="color:#93c5fd" href="/api/predict/taixiu">/api/predict/taixiu — Raw prediction</a></li>
            <li><a style="color:#93c5fd" href="/taixiu">/taixiu — UI</a></li>
            <li><a style="color:#93c5fd" href="/md5">/md5 — UI</a></li>
        </ul>
    </div>`);
});

// ============================================================
// ROUTES — STATS
// ============================================================
app.get('/api/stats
