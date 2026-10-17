'use strict';

// language: JavaScript (Node.js ≥ 18), file: server.js
// *multi-layer ensemble: 12 detectors + Markov n-order + meta-predictor + adaptive weight + decay guard*

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
// CORE HELPERS
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
        // per-pattern stats: { name: { win, total, weight, lastSeen, streak } }
        patternStats: {},
        // meta metrics
        meta: { totalPred: 0, totalWin: 0, recent50: [], regimeState: 'NORMAL' }
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
// LAYER 1: DETECTORS — 12 pattern + structural
// Each returns { name, code, weight } or null
// ============================================================
const detectors = {

    // 1. Bệt — streak
    bet(seq) {
        const n = seq.length; if (n < 4) return null;
        const last = seq[n - 1];
        let len = 1;
        for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
        if (len < 3) return null;
        // Bệt 3-4: theo, bệt 5-6: theo (streak thường kéo dài), bệt 7+: gãy
        if (len <= 6) return { name: `BỆT-${len}`, code: last, weight: 1.0 + (len - 3) * 0.15 };
        if (len <= 9) return { name: `BỆT-GÃY-${len}`, code: flip(last), weight: 1.3 };
        return { name: `BỆT-GÃY-MẠNH-${len}`, code: flip(last), weight: 1.6 };
    },

    // 2. 1-1 đảo liên tục
    alt11(seq) {
        const n = seq.length; if (n < 6) return null;
        let alt = 0;
        for (let i = n - 1; i >= 1; i--) { if (seq[i] !== seq[i - 1]) alt++; else break; }
        if (alt < 5) return null;
        return { name: `CẦU-1-1-${alt}`, code: flip(seq[n - 1]), weight: 1.1 + Math.min(alt, 12) * 0.05 };
    },

    // 3. 1-2-1 pattern (TXXTXX / XTTXTT)
    pat121(seq) {
        const s = seq.join('');
        const pats = [
            ['TXXTXX', 'T'], ['XTTXTT', 'X'],
            ['TXTTXT', 'X'], ['XTXXTX', 'T']
        ];
        for (const [tail, code] of pats) {
            if (s.endsWith(tail)) return { name: `CẦU-1-2-1`, code, weight: 1.35 };
        }
        return null;
    },

    // 4. 2-2 pattern
    pat22(seq) {
        const s = seq.join('');
        const pats = [
            ['TTXXTT', 'X'], ['XXTTXX', 'T'],
            ['TTXXTTXX', 'T'], ['XXTTXXTT', 'X']
        ];
        for (const [tail, code] of pats) {
            if (s.endsWith(tail)) return { name: `CẦU-2-2`, code, weight: 1.25 };
        }
        return null;
    },

    // 5. 3-3 pattern
    pat33(seq) {
        const s = seq.join('');
        const pats = [
            ['TTTXXX', 'T'], ['XXXTTT', 'X'],
            ['TTTXXXTTT', 'X'], ['XXXTTTXXX', 'T']
        ];
        for (const [tail, code] of pats) {
            if (s.endsWith(tail)) return { name: `CẦU-3-3`, code, weight: 1.2 };
        }
        return null;
    },

    // 6. Lặp chu kỳ
    cycle(seq) {
        const n = seq.length;
        for (const l of [4, 5, 6, 7, 8]) {
            if (n < l * 2) continue;
            const a = seq.slice(-l * 2, -l).join('');
            const b = seq.slice(-l).join('');
            if (a === b) return { name: `LẶP-${l}`, code: seq[n - l], weight: 1.15 + l * 0.02 };
        }
        return null;
    },

    // 7. Tăng/Giảm block size
    rampBlock(seq) {
        const n = seq.length; if (n < 6) return null;
        const blks = []; let ct = seq[0], cl = 1;
        for (let i = 1; i < n; i++) {
            if (seq[i] === ct) cl++;
            else { blks.push(cl); ct = seq[i]; cl = 1; }
        }
        blks.push(cl);
        if (blks.length < 4) return null;
        const last4 = blks.slice(-4);
        const [a, b, c, d] = last4;
        if (a < b && b < c && c < d) return { name: 'TĂNG-TIẾN', code: flip(seq[n - 1]), weight: 1.15 };
        if (a > b && b > c && c > d) return { name: 'GIẢM-TIẾN', code: flip(seq[n - 1]), weight: 1.15 };
        return null;
    },

    // 8. Symmetric — symmetric window around midpoint
    symmetric(seq) {
        const n = seq.length; if (n < 8) return null;
        const half = Math.min(6, Math.floor(n / 2));
        const L = seq.slice(-half * 2, -half);
        const R = seq.slice(-half);
        // nếu phải là mirror của trái → next = mirror next of L
        let match = 0;
        for (let i = 0; i < half; i++) if (L[i] === R[i]) match++;
        if (match >= half - 1 && match >= 4) {
            return { name: 'ĐỐI-XỨNG', code: L[0] === R[half - 1] ? flip(R[half - 1]) : R[half - 1], weight: 1.05 };
        }
        return null;
    },

    // 9. Cluster sum — sum variance
    sumTrend(seq, sums) {
        if (!sums || sums.length < 6) return null;
        const last6 = sums.slice(-6);
        const avg = last6.reduce((a, b) => a + b, 0) / 6;
        const recentAvg = last6.slice(-3).reduce((a, b) => a + b, 0) / 3;
        if (recentAvg - avg > 3.5) return { name: 'SUM-CAO', code: 'T', weight: 1.0 };
        if (avg - recentAvg > 3.5) return { name: 'SUM-THẤP', code: 'X', weight: 1.0 };
        return null;
    },

    // 10. Tài/Xỉu sát ngưỡng (sum 10-11) → mean reversion
    boundary(seq, sums) {
        if (!sums || sums.length < 3) return null;
        const last3 = sums.slice(-3);
        const near = last3.filter(s => s === 10 || s === 11).length;
        if (near >= 2) {
            const lastSum = last3[last3.length - 1];
            return { name: `NGƯỠNG-${lastSum}`, code: lastSum === 10 ? 'X' : 'T', weight: 0.95 };
        }
        return null;
    },

    // 11. Markov bậc 2-4 ensemble
    markov(seq) {
        if (seq.length < 10) return null;
        let best = null;
        for (const order of [2, 3, 4]) {
            if (seq.length < order + 4) continue;
            const key = seq.slice(-order).join('');
            let t = 0, x = 0;
            for (let i = order; i < seq.length; i++) {
                if (seq.slice(i - order, i).join('') === key) {
                    if (seq[i] === 'T') t++; else x++;
                }
            }
            const tot = t + x;
            if (tot < 3) continue;
            const conf = Math.max(t, x) / tot;
            const code = t > x ? 'T' : 'X';
            const w = conf * (order / 4) * 1.2;
            if (!best || w > best.weight) {
                best = { name: `MARKOV-${order}`, code, weight: w, sample: tot };
            }
        }
        return best;
    },

    // 12. Volatility detector — đổi nhịp
    volatility(seq) {
        const n = seq.length; if (n < 12) return null;
        const blks = []; let ct = seq[0], cl = 1;
        for (let i = 1; i < n; i++) {
            if (seq[i] === ct) cl++;
            else { blks.push(cl); ct = seq[i]; cl = 1; }
        }
        blks.push(cl);
        if (blks.length < 6) return null;
        const last6 = blks.slice(-6);
        const avg = last6.reduce((a, b) => a + b, 0) / 6;
        const variance = last6.reduce((a, b) => a + (b - avg) ** 2, 0) / 6;
        if (variance > 2.5) {
            // nhịp đang loạn → tin markov hơn
            return null;
        }
        return null;
    }
};

// ============================================================
// LAYER 2: ENSEMBLE — weighted vote
// ============================================================
function aggregateVotes(votes) {
    if (!votes.length) return null;
    let wT = 0, wX = 0;
    const detail = [];
    for (const v of votes) {
        if (!v || !v.code) continue;
        const w = v.weight || 1.0;
        if (v.code === 'T') wT += w; else wX += w;
        detail.push({ name: v.name, code: v.code, weight: +w.toFixed(3) });
    }
    const total = wT + wX;
    if (total === 0) return null;
    const code = wT >= wX ? 'T' : 'X';
    const strength = Math.max(wT, wX) / total;
    return { code, strength, detail, wT: +wT.toFixed(3), wX: +wX.toFixed(3) };
}

// ============================================================
// LAYER 3: ADAPTIVE WEIGHT — per-pattern history
// ============================================================
function adaptWeights(votes, db) {
    const stats = db.patternStats || {};
    return votes.map(v => {
        if (!v) return v;
        const s = stats[v.name];
        if (!s || s.total < 3) return v;
        // win rate → multiplier 0.6 .. 1.6
        const wr = s.win / s.total;
        const mult = 0.6 + wr * 1.0;
        // streak bonus
        const streakBonus = Math.min(s.streak || 0, 5) * 0.05;
        return { ...v, weight: (v.weight || 1) * mult + streakBonus, _wr: wr, _n: s.total };
    });
}

function updatePatternStats(db, patternName, wasCorrect) {
    if (!patternName || patternName === 'CHỜ' || patternName === 'META' || patternName === 'ENSEMBLE' || patternName === 'GUARD') return;
    if (!db.patternStats) db.patternStats = {};
    const s = db.patternStats[patternName] || { win: 0, total: 0, streak: 0, weight: 1.0 };
    s.total += 1;
    if (wasCorrect) { s.win += 1; s.streak = (s.streak >= 0 ? s.streak + 1 : 1); }
    else { s.streak = (s.streak <= 0 ? s.streak - 1 : -1); }
    // decay — không để 1 pattern thắng liên tục mãi kiểm soát
    if (s.total > 50) { s.win *= 0.95; s.total *= 0.95; s.win = Math.round(s.win); s.total = Math.round(s.total); }
    db.patternStats[patternName] = s;
}

// ============================================================
// LAYER 4: BALANCE GUARD — adaptive threshold
// ============================================================
function balanceGuard(aggregated, db) {
    if (!aggregated) return aggregated;
    const last50 = db.meta?.recent50 || [];
    if (last50.length < 10) return aggregated;
    const predT = last50.filter(x => x.pred === 'T').length;
    const predX = last50.filter(x => x.pred === 'X').length;
    const tot = predT + predX;
    if (tot < 10) return aggregated;
    const pX = predX / tot;
    // adaptive threshold: càng lệch càng mạnh
    const devT = Math.max(0, pX - 0.60);
    const devX = Math.max(0, 0.40 - pX);
    if (devT > 0.02 && aggregated.code !== 'T') {
        return { ...aggregated, code: 'T', strength: 0.70, guard: `BAL-T+${(devT * 100).toFixed(0)}` };
    }
    if (devX > 0.02 && aggregated.code !== 'X') {
        return { ...aggregated, code: 'X', strength: 0.70, guard: `BAL-X+${(devX * 100).toFixed(0)}` };
    }
    return aggregated;
}

// ============================================================
// LAYER 5: META-PREDICTOR — self-correcting on regime
// ============================================================
function metaPredictor(aggregated, db) {
    const m = db.meta || { recent50: [] };
    const r50 = m.recent50.slice(-20);
    if (r50.length < 8) return aggregated;
    const recentWinRate = r50.filter(x => x.correct).length / r50.length;
    // nếu win rate dưới 40% → invert (thị trường đảo cầu)
    if (recentWinRate < 0.40) {
        return { ...aggregated, code: flip(aggregated.code), strength: 0.55, meta: `INVERT-${(recentWinRate * 100).toFixed(0)}%` };
    }
    // win rate trên 70% → boost strength
    if (recentWinRate > 0.70) {
        return { ...aggregated, strength: Math.min(0.95, aggregated.strength + 0.10), meta: `BOOST-${(recentWinRate * 100).toFixed(0)}%` };
    }
    return aggregated;
}

// ============================================================
// ENGINE — full pipeline
// ============================================================
function runEngine(seq, sums, db) {
    if (!seq || seq.length < 4) return { code: null, label: 'CHỜ', tiLe: 'CHỜ', detail: [] };

    // 1. collect raw votes from all detectors
    const rawVotes = [];
    const bet = detectors.bet(seq); if (bet) rawVotes.push(bet);
    const a11 = detectors.alt11(seq); if (a11) rawVotes.push(a11);
    const p121 = detectors.pat121(seq); if (p121) rawVotes.push(p121);
    const p22 = detectors.pat22(seq); if (p22) rawVotes.push(p22);
    const p33 = detectors.pat33(seq); if (p33) rawVotes.push(p33);
    const cy = detectors.cycle(seq); if (cy) rawVotes.push(cy);
    const rb = detectors.rampBlock(seq); if (rb) rawVotes.push(rb);
    const sym = detectors.symmetric(seq); if (sym) rawVotes.push(sym);
    const st = detectors.sumTrend(seq, sums); if (st) rawVotes.push(st);
    const bd = detectors.boundary(seq, sums); if (bd) rawVotes.push(bd);
    const mk = detectors.markov(seq); if (mk) rawVotes.push(mk);

    // 2. adapt weights theo lịch sử
    const adaptedVotes = adaptWeights(rawVotes, db);

    // 3. aggregate
    let aggregated = aggregateVotes(adaptedVotes);

    // 4. fallback nếu không có detector nào bắn
    if (!aggregated) {
        if (mk) aggregated = { code: mk.code, strength: 0.55, detail: [mk] };
        else {
            const n = seq.length;
            const tRatio = seq.filter(x => x === 'T').length / n;
            const code = tRatio >= 0.5 ? 'X' : 'T';
            aggregated = { code, strength: 0.50, detail: [], fallback: 'ANTI-RATIO' };
        }
    }

    // 5. balance guard
    const guarded = balanceGuard(aggregated, db);

    // 6. meta predictor (self-correcting)
    const final = metaPredictor(guarded, db);

    // 7. confidence
    const conf = Math.max(0.5, Math.min(0.95, final.strength));
    const patternName = final.guard || final.meta || (final.detail?.[0]?.name) || 'ENSEMBLE';

    return {
        code: final.code,
        label: patternName,
        tiLe: (conf * 100).toFixed(1) + '%',
        detail: final.detail || [],
        strength: conf
    };
}

// ============================================================
// FETCH + PROCESS
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

    if (!db.meta) db.meta = { totalPred: 0, totalWin: 0, recent50: [], regimeState: 'NORMAL' };

    // score previous prediction
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        const correct = prev.DU_DOAN_CODE && prev.DU_DOAN_CODE === actual;
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);
        prev.trangThai = !prev.DU_DOAN_CODE ? 'BỎ QUA' : (correct ? 'ĐÚNG' : 'SAI');

        if (prev.DU_DOAN_CODE) {
            db.meta.totalPred = (db.meta.totalPred || 0) + 1;
            if (correct) db.meta.totalWin = (db.meta.totalWin || 0) + 1;
            db.meta.recent50 = db.meta.recent50 || [];
            db.meta.recent50.push({ pred: prev.DU_DOAN_CODE, actual, correct });
            if (db.meta.recent50.length > 50) db.meta.recent50.shift();
            updatePatternStats(db, prev.patternName, correct);
        }
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
        <h2 style="color:green;">🚀 BACKEND v2 — ENGINE ADAPTIVE</h2>
        <ul>
            <li><a href="/api/predict/md5">/api/predict/md5</a></li>
            <li><a href="/api/predict/taixiu">/api/predict/taixiu</a></li>
            <li><a href="/api/history/all">/api/history/all</a></li>
            <li><a href="/api/stats/md5">/api/stats/md5</a></li>
            <li><a href="/api/stats/taixiu">/api/stats/taixiu</a></li>
        </ul>
    </div>`);
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
                pattern: { type: it.patternName }, trangThai: it.trangThai
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
        winRate: wr,
        recent50WinRate: r50wr,
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
        if (type.startsWith('BỆT')) return 'badge-bet';
        if (type.includes('MARKOV') || type.includes('GUARD') || type.includes('BAL-')) return 'badge-markov';
        if (type.includes('META') || type.includes('INVERT') || type.includes('BOOST')) return 'badge-meta';
        if (type.match(/\d-\d/)) return 'badge-cycle';
        return 'badge-default';
    };

    const html = `<!DOCTYPE html><html lang="vi"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>HOANG VIP WIN v2</title>
    <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0}
    .header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:12px;box-shadow:0 8px 24px rgba(59,130,246,.3);text-align:center}
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
    .badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;white-space:nowrap}
    .badge-bet{background:#78350f;color:#fcd34d}.badge-markov{background:#1e3a8a;color:#93c5fd}
    .badge-cycle{background:#1e40af;color:#93c5fd}.badge-default{background:#334155;color:#cbd5e1}
    .badge-meta{background:#7c2d12;color:#fed7aa}
    </style><script>setTimeout(()=>location.reload(),10000)</script></head>
    <body>
      <div class="header"><h1>🎯 HOANG VIP WIN v2 - ${game.toUpperCase()}</h1></div>
      <div class="stats">
        <div class="stat">Tổng: <b>${m.totalPred || 0}</b></div>
        <div class="stat">Thắng: <b>${m.totalWin || 0}</b></div>
        <div class="stat">WinRate: <b>${wr}%</b></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>PHIÊN DĐ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>LOẠI CẦU</th><th>TT</th>
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

app.listen(PORT, () => console.log(`Server v2 chạy trên port ${PORT}`));
