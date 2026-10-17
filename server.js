'use strict';

// language: JavaScript (Node.js >= 18), file: server.js
// *regime-switch engine: 6 regime detectors (PERSIST / ANTI-PERSIST / ALTERNATE / BLOCK / CHAOS / TREND)
// *bayesian-weighted ensemble with online learning per regime
// *target: chuỗi thực ảnh (đảo liên tục) + bệt dài + block + composite*

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
const API_TX = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const DB_DIR = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {} }

// ============================================================
// HELPERS
// ============================================================
const label = c => c === 'T' ? 'Tài' : (c === 'X' ? 'Xỉu' : null);
const flip = c => c === 'T' ? 'X' : (c === 'X' ? 'T' : null);
const safeInt = (x, def = 0) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; };

function readDB(g) {
    const p = path.join(DB_DIR, `db_${g}.json`);
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
    return {
        history: [],
        lastProcessedSession: null,
        // Bayesian priors: regime -> { correct, total }
        regimeStats: {},
        // Pattern-level tracking
        patternStats: {},
        // Sliding window memory of last 200 predictions
        mem: [],
        meta: { totalPred: 0, totalWin: 0, recent50: [] }
    };
}
function saveDB(g, db) {
    const p = path.join(DB_DIR, `db_${g}.json`);
    try { fs.writeFileSync(p, JSON.stringify(db, null, 2)); } catch (e) {}
}

const getDice = item => [safeInt(item?.FirstDice), safeInt(item?.SecondDice), safeInt(item?.ThirdDice)];
function getSum(item) {
    const s = getDice(item).reduce((a, b) => a + b, 0);
    return (s >= 3 && s <= 18) ? s : safeInt(item?.DiceSum);
}
function getResult(item) {
    const s = getSum(item);
    return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null;
}

// ============================================================
// RUN-LENGTH + STATISTICAL HELPERS
// ============================================================
function rle(seq) {
    const out = []; let cur = seq[0], len = 1;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === cur) len++;
        else { out.push({ ch: cur, len }); cur = seq[i]; len = 1; }
    }
    if (cur) out.push({ ch: cur, len });
    return out;
}

// entropy của chuỗi nhị phân
function binaryEntropy(arr) {
    if (!arr.length) return 0;
    const p = arr.filter(x => x === 'T').length / arr.length;
    if (p === 0 || p === 1) return 0;
    return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

// run lengths distribution — mean/std của block
function blockStats(seq) {
    const r = rle(seq);
    if (r.length < 2) return { mean: 1, std: 0, max: 1, count: r.length };
    const lens = r.map(b => b.len);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    return { mean, std: Math.sqrt(variance), max: Math.max(...lens), count: lens.length };
}

// ============================================================
// REGIME DETECTION — 6 regimes
// Mỗi regime quyết định CÁCH predict, không phải predict cái gì
// ============================================================
function detectRegime(seq) {
    if (!seq || seq.length < 8) return { name: 'COLD', confidence: 0.5 };
    const n = seq.length;
    const win = seq.slice(-Math.min(30, n));
    const bs = blockStats(win);
    const ent = binaryEntropy(win);
    const r = rle(win);

    // 1. PERSIST — bệt dài đang chạy
    const last = win[win.length - 1];
    let streak = 1;
    for (let i = win.length - 2; i >= 0; i--) { if (win[i] === last) streak++; else break; }
    if (streak >= 4) {
        return { name: 'PERSIST', confidence: Math.min(0.95, 0.6 + (streak - 3) * 0.08), streak, last };
    }

    // 2. ANTI-PERSIST — đảo liên tục sau 1-3 phiên (như ảnh)
    //    Metric: mean block length thấp + entropy trung bình
    if (bs.mean <= 2.2 && r.length >= 6) {
        // check ratio of 1-length blocks
        const shortBlocks = r.filter(b => b.len === 1).length;
        const ratio = shortBlocks / r.length;
        if (ratio >= 0.45) {
            return { name: 'ANTI-PERSIST', confidence: Math.min(0.90, 0.5 + ratio * 0.5), meanBlk: bs.mean, shortRatio: ratio };
        }
    }

    // 3. ALTERNATE — 1-1 thuần (T X T X T X)
    let altRun = 0;
    for (let i = win.length - 1; i >= 1; i--) { if (win[i] !== win[i - 1]) altRun++; else break; }
    if (altRun >= 4) {
        return { name: 'ALTERNATE', confidence: Math.min(0.92, 0.5 + altRun * 0.06), altRun };
    }

    // 4. BLOCK — block đều đặn (3-3, 4-4, 2-2)
    if (r.length >= 3) {
        const last3 = r.slice(-3).map(b => b.len);
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
            return { name: 'BLOCK', confidence: 0.80, blockSize: last3[0], color: r[r.length - 1].ch };
        }
    }

    // 5. TREND — phân phối lệch mạnh về 1 phía
    const tRatio = win.filter(x => x === 'T').length / win.length;
    if (tRatio >= 0.65 || tRatio <= 0.35) {
        return { name: 'TREND', confidence: 0.65, tRatio };
    }

    // 6. CHAOS — không có pattern rõ
    return { name: 'CHAOS', confidence: 0.40, entropy: ent, meanBlk: bs.mean };
}

// ============================================================
// PREDICTOR PER REGIME
// Mỗi regime có chiến thuật dự đoán riêng
// ============================================================
function predictByRegime(regime, seq) {
    const n = seq.length;
    const last = seq[n - 1];

    switch (regime.name) {
        case 'PERSIST': {
            // Bệt đang chạy: theo nếu <= 6, gãy nếu 7-9, chắc gãy nếu >= 10
            const s = regime.streak;
            if (s <= 6) return { code: last, weight: 1.5 + (s - 4) * 0.1, name: `PERSIST-THEO-${s}` };
            if (s <= 9) return { code: last, weight: 1.0, name: `PERSIST-RỦI-${s}` };
            return { code: flip(last), weight: 1.7, name: `PERSIST-GÃY-${s}` };
        }
        case 'ANTI-PERSIST': {
            // Đảo liên tục: 50% đảo tiếp, nhưng block 2-3 xen kẽ
            // Dùng transition matrix window cuối để xác định
            const win = seq.slice(-15);
            let tt = 0, tx = 0, xt = 0, xx = 0;
            for (let i = 1; i < win.length; i++) {
                const a = win[i - 1], b = win[i];
                if (a === 'T' && b === 'T') tt++;
                else if (a === 'T' && b === 'X') tx++;
                else if (a === 'X' && b === 'T') xt++;
                else xx++;
            }
            // P(next | last)
            let pSame, pFlip;
            if (last === 'T') { pSame = tt / (tt + tx || 1); pFlip = 1 - pSame; }
            else { pSame = xx / (xx + xt || 1); pFlip = 1 - pSame; }
            // Anti-persist → ưu tiên đảo nếu recent cho thấy flip rate cao
            const code = pFlip > pSame ? flip(last) : last;
            return { code, weight: 1.2 + Math.abs(pFlip - pSame) * 0.8, name: `ANTIPERSIST-${code === last ? 'THEO' : 'ĐẢO'}` };
        }
        case 'ALTERNATE': {
            // 1-1 đảo → flip
            return { code: flip(last), weight: 1.4, name: `ALT-${regime.altRun}` };
        }
        case 'BLOCK': {
            // Block đều: nếu vừa hết block → flip; đang giữa block → theo
            const r = rle(seq);
            const lastBlk = r[r.length - 1];
            if (lastBlk.len < regime.blockSize) {
                // đang giữa block → theo
                return { code: last, weight: 1.3, name: `BLOCK-THEO-${regime.blockSize}` };
            }
            // vừa hết block → flip
            return { code: flip(last), weight: 1.4, name: `BLOCK-FLIP-${regime.blockSize}` };
        }
        case 'TREND': {
            // Trend: theo trend
            const code = regime.tRatio >= 0.65 ? 'T' : 'X';
            return { code, weight: 1.0, name: `TREND-${code}` };
        }
        case 'CHAOS':
        default: {
            // Không có pattern → dùng markov bậc 3-4 làm fallback
            for (const order of [3, 4]) {
                if (seq.length < order + 5) continue;
                const key = seq.slice(-order).join('');
                let t = 0, x = 0;
                for (let i = order; i < seq.length; i++) {
                    if (seq.slice(i - order, i).join('') === key) {
                        if (seq[i] === 'T') t++; else x++;
                    }
                }
                if (t + x >= 3) {
                    const code = t > x ? 'T' : 'X';
                    const conf = Math.max(t, x) / (t + x);
                    return { code, weight: 0.7 + conf * 0.5, name: `CHAOS-MARKOV-${order}` };
                }
            }
            // cuối cùng: anti-ratio
            const tRatio = seq.slice(-15).filter(x => x === 'T').length / Math.min(15, seq.length);
            const code = tRatio > 0.5 ? 'X' : 'T';
            return { code, weight: 0.6, name: `CHAOS-ANTI-RATIO` };
        }
    }
}

// ============================================================
// STRUCTURAL DETECTORS — vẫn dùng để boost khi regime không đủ
// (giữ các pattern mạnh từ v3)
// ============================================================
function structuralDetectors(seq, sums) {
    const votes = [];
    const n = seq.length;

    // Block-3-repeat
    if (n >= 8) {
        const r = rle(seq);
        if (r.length >= 4) {
            const last4 = r.slice(-4);
            if (last4.every(b => b.len === 3)) {
                votes.push({ name: `BLK3-CYCLE`, code: flip(last4[3].ch), weight: 1.5 });
            }
        }
    }

    // Composite grammar
    if (n >= 8) {
        const r = rle(seq);
        for (const k of [2, 3]) {
            if (r.length < k * 2) continue;
            const grpA = r.slice(-k * 2, -k);
            const grpB = r.slice(-k);
            let match = true;
            for (let i = 0; i < k; i++) {
                if (grpA[i].ch !== grpB[i].ch || grpA[i].len !== grpB[i].len) { match = false; break; }
            }
            if (match) {
                votes.push({ name: `COMPOSITE-${k}`, code: grpA[0].ch, weight: 1.4 + k * 0.1 });
                break;
            }
        }
    }

    // TTTX-repeat
    const s = seq.join('');
    if (s.endsWith('TTTXTTTX') || s.endsWith('TTTXTTTXTTT')) votes.push({ name: 'TTTX-REPEAT', code: 'T', weight: 1.55 });
    if (s.endsWith('XXXTXXXT') || s.endsWith('XXXTXXXTXXX')) votes.push({ name: 'XXXT-REPEAT', code: 'X', weight: 1.55 });

    // Sum cluster
    if (sums && sums.length >= 6) {
        const last6 = sums.slice(-6);
        const avg = last6.reduce((a, b) => a + b, 0) / 6;
        if (avg >= 13.5) votes.push({ name: 'SUM-HIGH', code: 'X', weight: 0.9 });
        if (avg <= 7.5) votes.push({ name: 'SUM-LOW', code: 'T', weight: 0.9 });
    }

    return votes;
}

// ============================================================
// BAYESIAN COMBINE — p(T) từ nhiều nguồn
// ============================================================
function bayesianCombine(regimePred, structuralVotes, db, regime) {
    // prior từ regime history
    const rs = db.regimeStats[regime.name] || { correct: 0, total: 0 };
    const regimePrior = rs.total >= 5 ? (rs.correct / rs.total) : 0.5;

    // Convert predictions thành p(T)
    // regimePred: code ∈ {T,X} weight w → p = w / (w + (1-w))  ... dùng softmax
    let logOddsT = 0;

    const addVote = (code, weight, name) => {
        // p(code=T) = weight / (1 + weight) nếu code=T, ngược lại 1/(1+weight)
        // Dùng logit
        const w = Math.max(0.1, weight);
        if (code === 'T') logOddsT += Math.log(w);
        else logOddsT -= Math.log(w);
    };

    // Base prior 0
    // Regime predictor
    addVote(regimePred.code, regimePred.weight * (0.8 + regimePrior * 0.4), regimePred.name);

    // Structural votes
    for (const v of structuralVotes) {
        const ps = db.patternStats[v.name] || { win: 0, total: 0 };
        const wr = ps.total >= 3 ? ps.win / ps.total : 0.5;
        const adapted = v.weight * (0.6 + wr * 0.8);
        addVote(v.code, adapted, v.name);
    }

    const pT = 1 / (1 + Math.exp(-logOddsT));
    const code = pT >= 0.5 ? 'T' : 'X';
    const strength = Math.abs(pT - 0.5) * 2;

    return {
        code,
        strength: Math.max(0.5, Math.min(0.95, 0.5 + strength * 0.45)),
        pT,
        regimeName: regime.name,
        regimeConf: regime.confidence
    };
}

// ============================================================
// META — invert khi regime đang thua
// ============================================================
function metaAdjust(pred, db, regimeName) {
    // Kiểm tra 15 phiên gần — nếu regime hiện tại đang thua nặng → invert hoặc giảm conf
    const rs = db.regimeStats[regimeName];
    if (rs && rs.total >= 10) {
        const wr = rs.correct / rs.total;
        if (wr < 0.35) {
            return { ...pred, code: flip(pred.code), strength: 0.55, meta: `INVERT-${regimeName}-${(wr*100).toFixed(0)}%` };
        }
        if (wr > 0.72) {
            return { ...pred, strength: Math.min(0.95, pred.strength + 0.08), meta: `BOOST-${regimeName}-${(wr*100).toFixed(0)}%` };
        }
    }
    return pred;
}

// ============================================================
// FULL PIPELINE
// ============================================================
function runEngine(seq, sums, db) {
    if (!seq || seq.length < 6) {
        return { code: null, label: 'CHỜ', tiLe: 'CHỜ', detail: [], regime: 'COLD' };
    }

    const regime = detectRegime(seq);
    const regimePred = predictByRegime(regime, seq);
    const structural = structuralDetectors(seq, sums);
    const combined = bayesianCombine(regimePred, structural, db, regime);
    const final = metaAdjust(combined, db, regime.name);

    return {
        code: final.code,
        label: final.meta || `${regime.name}:${regimePred.name}`,
        tiLe: (final.strength * 100).toFixed(1) + '%',
        detail: [
            { regime: regime.name, regimeConf: regime.confidence, regimePred: regimePred.name, regimeW: regimePred.weight },
            ...structural
        ],
        regime: regime.name,
        strength: final.strength,
        pT: final.pT
    };
}

// ============================================================
// UPDATE STATS khi có kết quả
// ============================================================
function updateStats(db, pred, actual) {
    if (!pred || !pred.code) return;
    const correct = pred.code === actual;

    if (!db.meta) db.meta = { totalPred: 0, totalWin: 0, recent50: [] };
    db.meta.totalPred = (db.meta.totalPred || 0) + 1;
    if (correct) db.meta.totalWin = (db.meta.totalWin || 0) + 1;
    db.meta.recent50.push({ pred: pred.code, actual, correct, regime: pred.regime });
    if (db.meta.recent50.length > 50) db.meta.recent50.shift();

    // regime stats
    const rName = pred.regime || 'CHAOS';
    if (!db.regimeStats[rName]) db.regimeStats[rName] = { correct: 0, total: 0 };
    db.regimeStats[rName].total++;
    if (correct) db.regimeStats[rName].correct++;

    // pattern stats
    const pName = pred.label || 'UNKNOWN';
    if (!db.patternStats) db.patternStats = {};
    const ps = db.patternStats[pName] || { win: 0, total: 0 };
    ps.total++;
    if (correct) ps.win++;
    if (ps.total > 50) { ps.win *= 0.95; ps.total *= 0.95; ps.win = Math.round(ps.win); ps.total = Math.round(ps.total); }
    db.patternStats[pName] = ps;
}

// ============================================================
// FETCH + PROCESS LOOP
// ============================================================
async function fetchApi(url) {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await axios.get(url, { timeout: 8000 });
            let arr = res.data?.data?.list || res.data?.list || res.data?.data || (Array.isArray(res.data) ? res.data : []);
            if (arr.length >= 2 && Number(arr[0].SessionId) > Number(arr[arr.length - 1].SessionId)) arr.reverse();
            return arr;
        } catch (e) {
            if (i === 2) return [];
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

async function processGame(game) {
    const url = game === 'md5' ? API_MD5 : API_TX;
    const list = await fetchApi(url);
    if (!list || !list.length) return;
    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const db = readDB(game);
    if (db.lastProcessedSession === session) return;

    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    if (seq.length < 6) return;

    // chấm phiên trước
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);
        prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (prev.DU_DOAN_CODE === actual ? 'ĐÚNG' : 'SAI');
        updateStats(db, { code: prev.DU_DOAN_CODE, label: prev.patternName, regime: prev.regime }, actual);
    }

    const pred = runEngine(seq, sums, db);

    db.history.push({
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code,
        DU_DOAN: pred.code ? label(pred.code) : 'CHỜ',
        TI_LE: pred.tiLe,
        patternName: pred.label,
        regime: pred.regime,
        detail: pred.detail,
        trangThai: 'ĐANG CHỜ'
    });

    if (db.history.length > 500) db.history.shift();
    db.lastProcessedSession = session;
    saveDB(game, db);
}

setInterval(() => { processGame('md5'); processGame('taixiu'); }, 5000);

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => {
    res.send(`<div style="font-family:sans-serif;padding:20px">
        <h2 style="color:green;">🚀 BACKEND v4 — REGIME BAYESIAN</h2>
        <ul>
            <li><a href="/api/predict/md5">/api/predict/md5</a></li>
            <li><a href="/api/predict/taixiu">/api/predict/taixiu</a></li>
            <li><a href="/api/history/all">/api/history/all</a></li>
            <li><a href="/api/stats/md5">/api/stats/md5</a></li>
            <li><a href="/api/stats/taixiu">/api/stats/taixiu</a></li>
            <li><a href="/api/analyze?seq=TTTXTTTXTTT">/api/analyze</a></li>
            <li><a href="/api/regime?seq=TXTXTXXTXT">/api/regime — xem regime hiện tại</a></li>
        </ul>
    </div>`);
});

app.get('/api/analyze', (req, res) => {
    const seqStr = String(req.query.seq || '').toUpperCase().replace(/[^TX]/g, '');
    if (seqStr.length < 4) return res.status(400).json({ success: false, error: 'seq >= 4 ký tự' });
    const seq = seqStr.split('');
    const db = readDB('md5');
    const pred = runEngine(seq, [], db);
    res.json({ success: true, seq: seqStr, prediction: pred });
});

app.get('/api/regime', (req, res) => {
    const seqStr = String(req.query.seq || '').toUpperCase().replace(/[^TX]/g, '');
    if (seqStr.length < 4) return res.status(400).json({ success: false, error: 'seq >= 4 ký tự' });
    const seq = seqStr.split('');
    const regime = detectRegime(seq);
    const bs = blockStats(seq);
    res.json({ success: true, seq: seqStr, regime, blockStats: bs, entropy: binaryEntropy(seq) });
});

app.get('/api/predict/:game', async (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false, error: 'Game không hợp lệ' });
    const url = game === 'md5' ? API_MD5 : API_TX;
    const list = await fetchApi(url);
    if (!list || !list.length) return res.status(500).json({ success: false, error: 'Không lấy được dữ liệu' });
    const latest = list[list.length - 1];
    const session = safeInt(latest.SessionId);
    const seq = list.map(getResult).filter(Boolean);
    const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
    const db = readDB(game);
    const pred = runEngine(seq, sums, db);
    res.json({
        success: true, game, phien: session,
        xucXac: getDice(latest), tong: getSum(latest),
        ketQua: getResult(latest), ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        duDoan: pred.code ? label(pred.code) : 'CHỜ',
        duDoanCode: pred.code,
        tiLe: pred.tiLe,
        reason: pred.label,
        regime: pred.regime,
        detail: pred.detail
    });
});

app.get('/api/history/all', (req, res) => {
    const out = {};
    for (const g of ['md5', 'taixiu']) {
        const db = readDB(g);
        out[g] = {
            items: db.history.slice(-100).reverse().map(it => ({
                phien: it.phien, phienDuDoan: it.phienDuDoan, tong: it.tong, xucXac: it.xucXac,
                ketQua: it.ketQua, ketQuaLabel: it.ketQuaLabel,
                duDoanCode: it.DU_DOAN_CODE, duDoan: it.DU_DOAN, tiLe: it.TI_LE,
                pattern: { type: it.patternName }, regime: it.regime, trangThai: it.trangThai
            }))
        };
    }
    res.json({ success: true, games: out });
});

app.get('/api/stats/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.status(400).json({ success: false, error: 'Game không hợp lệ' });
    const db = readDB(game);
    const m = db.meta || {};
    const wr = m.totalPred ? (m.totalWin / m.totalPred * 100).toFixed(1) + '%' : 'N/A';
    const recent = m.recent50 || [];
    const r50wr = recent.length ? (recent.filter(x => x.correct).length / recent.length * 100).toFixed(1) + '%' : 'N/A';
    res.json({
        success: true, game,
        totalPredicted: m.totalPred || 0,
        totalWin: m.totalWin || 0,
        winRate: wr, recent50WinRate: r50wr,
        regimeStats: db.regimeStats || {},
        patternStats: db.patternStats || {}
    });
});

app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');
    const db = readDB(game);
    const rows = db.history.slice(-50).reverse();
    const m = db.meta || {};
    const wr = m.totalPred ? (m.totalWin / m.totalPred * 100).toFixed(1) : '0.0';

    const getBadge = (type) => {
        if (!type) return 'badge-default';
        if (type.startsWith('PERSIST')) return 'badge-bet';
        if (type.includes('ANTIPERSIST') || type.includes('ALT')) return 'badge-alt';
        if (type.includes('BLOCK') || type.includes('COMPOSITE') || type.includes('TTTX')) return 'badge-block';
        if (type.includes('CHAOS') || type.includes('MARKOV')) return 'badge-chaos';
        if (type.includes('INVERT') || type.includes('BOOST')) return 'badge-meta';
        return 'badge-default';
    };

    const html = `<!DOCTYPE html><html lang="vi"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>HOANG VIP WIN v4</title>
    <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0}
    .header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:12px;text-align:center}
    h1{color:#fff;font-size:20px;margin:0;font-weight:800;text-transform:uppercase}
    .stats{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;justify-content:center}
    .stat{background:#0f172a;padding:8px 14px;border-radius:8px;border:1px solid #334155;font-size:12px}
    .stat b{color:#fbbf24;font-size:16px}
    .table-wrap{background:#0f172a;border-radius:12px;overflow:hidden;border:1px solid #334155}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{background:#1e40af;color:#fff;padding:10px 4px;font-weight:600;text-transform:uppercase;font-size:10px}
    td{padding:10px 4px;text-align:center;border-bottom:1px solid #1e293b}
    .tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
    .dung{color:#22c55e;font-weight:700;text-transform:uppercase}.sai{color:#ef4444;font-weight:700;text-transform:uppercase}.cho{color:#94a3b8;font-weight:600;font-style:italic}
    .dice{color:#fbbf24;font-weight:700;line-height:1.2}
    .sum{display:inline-block;padding:4px 10px;border-radius:6px;background:#334155;color:#fbbf24;font-weight:800;font-size:14px}
    .session{font-family:monospace;font-size:11px;color:#64748b}
    .ti-le{font-size:12px;color:#cbd5e1;font-weight:600}
    .badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis}
    .badge-bet{background:#78350f;color:#fcd34d}
    .badge-alt{background:#7c2d12;color:#fed7aa}
    .badge-block{background:#14532d;color:#86efac}
    .badge-chaos{background:#312e81;color:#a5b4fc}
    .badge-meta{background:#831843;color:#fbcfe8}
    .badge-default{background:#334155;color:#cbd5e1}
    </style><script>setTimeout(()=>location.reload(),10000)</script></head>
    <body>
      <div class="header"><h1>🎯 HOANG VIP WIN v4 - ${game.toUpperCase()}</h1></div>
      <div class="stats">
        <div class="stat">Tổng: <b>${m.totalPred || 0}</b></div>
        <div class="stat">Thắng: <b>${m.totalWin || 0}</b></div>
        <div class="stat">WinRate: <b>${wr}%</b></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>PHIÊN DĐ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>REGIME / CẦU</th><th>TT</th>
        </tr></thead><tbody>
        ${rows.map(it => {
            const dice = (it.xucXac || []).join('-');
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
        </tbody></table></div>
    </body></html>`;
    res.send(html);
});

app.listen(PORT, () => console.log(`Server v4 chạy trên port ${PORT}`));
