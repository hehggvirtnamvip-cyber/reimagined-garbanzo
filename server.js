'use strict';

// ============================================================
// HOANG CUSTOM PREDICTOR — v13 "LOGIC RIÊNG"
// Node >= 18 | express + axios + ws
// Chạy: npm install express axios ws && node server.js
//
// ⚠️  LƯU Ý QUAN TRỌNG:
// Không có thuật toán nào thắng được xúc xắc ngẫu nhiên lâu dài.
// Code này để bạn tự cắm LOGIC RIÊNG và test trung thực.
// ============================================================

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

// ============================================================
// CONFIG
// ============================================================
const PORT = process.env.PORT || 3000;
const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';
const API_KEY = process.env.API_KEY || 'hoang-vip-secret-change-me';
const DB_DIR = process.env.DB_DIR || path.join(__dirname, 'data');
const LOG_DIR = path.join(DB_DIR, 'logs');
const TICK_MS = parseInt(process.env.TICK_MS || '5000', 10);
const MAX_HISTORY = 5000;

// CHỌN PRESET Ở ĐÂY: 'A' | 'B' | 'C'
const PRESET = process.env.PRESET || 'A';

for (const d of [DB_DIR, LOG_DIR]) {
    if (!fs.existsSync(d)) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
}

function log(level, ...args) {
    const ts = new Date().toISOString();
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const line = `[${ts}] [${level}] ${msg}`;
    if (level === 'ERROR') console.error(line); else console.log(line);
    try { fs.appendFileSync(path.join(LOG_DIR, `app-${ts.slice(0,10)}.log`), line + '\n'); } catch (e) {}
}

// ============================================================
// UTILS
// ============================================================
const label = c => c === 'T' ? 'Tài' : c === 'X' ? 'Xỉu' : null;
const flip = c => c === 'T' ? 'X' : c === 'X' ? 'T' : null;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const safeInt = (x, def = 0) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; };
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
// SEQUENCE HELPERS
// ============================================================
function computeRLE(seq) {
    const out = []; if (!seq.length) return out;
    let cur = seq[0], len = 1;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === cur) len++;
        else { out.push({ ch: cur, len }); cur = seq[i]; len = 1; }
    }
    out.push({ ch: cur, len });
    return out;
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
// DB
// ============================================================
function defaultDB() {
    return {
        version: 13,
        createdAt: nowIso(),
        lastProcessedSession: null,
        history: [],
        meta: {
            totalPred: 0, totalWin: 0, totalLose: 0, totalSkip: 0,
            winStreak: 0, loseStreak: 0, maxWinStreak: 0, maxLoseStreak: 0,
            recent50: [],
            byLogic: {},  // { logicName: { win, total } }
            confusion: { TT: 0, TX: 0, XT: 0, XX: 0 }
        },
        bankroll: { initial: 1000000, current: 1000000, bets: [], totalPnl: 0 }
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
                meta: { ...def.meta, ...(raw.meta || {}),
                    confusion: { ...def.meta.confusion, ...((raw.meta || {}).confusion || {}) },
                    byLogic: { ...(raw.meta || {}).byLogic } },
                bankroll: { ...def.bankroll, ...(raw.bankroll || {}) }
            };
        }
    } catch (e) { log('ERROR', `readDB ${game}:`, e.message); }
    return defaultDB();
}
function saveDB(game, db) {
    const p = path.join(DB_DIR, `db_${game}.json`);
    try {
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
        fs.renameSync(tmp, p);
    } catch (e) { log('ERROR', `saveDB ${game}:`, e.message); }
}

// ============================================================
// 🎯 PRESET A — "BÁM CẦU THẬT"
// Chỉ dự đoán khi có cầu RÕ RÀNG, không thì SKIP
// Triết lý: không chắc thì không đánh
// ============================================================
function predictPresetA(seq, sums) {
    if (seq.length < 6) return { code: null, confidence: 0, reason: 'Boot', logic: 'A-Skip' };

    const rle = computeRLE(seq);
    const streak = currentStreak(seq);
    const alt = currentAlternation(seq);
    const last = seq[seq.length - 1];

    // Cầu bệt 4-7: theo bệt (không đảo như code cũ)
    // Lý do: bệt 4-7 thường dài hơn là gãy ngay
    if (streak >= 4 && streak <= 7) {
        return { code: last, confidence: 0.55, reason: `Bệt ${streak} → theo`, logic: 'A-Bệt' };
    }

    // Cầu 1-1 (đảo liên tục ≥ 4 lần): tiếp tục đảo
    if (alt >= 4) {
        return { code: flip(last), confidence: 0.55, reason: `1-1 (${alt} lần) → đảo`, logic: 'A-1-1' };
    }

    // Cầu 2-2 (block đều 2): 3 block gần nhất đều len=2 → đoán block tiếp theo len=2
    if (rle.length >= 3) {
        const [a, b, c] = rle.slice(-3);
        if (a.len === 2 && b.len === 2 && c.len === 2) {
            // Đang ở block thứ 3, đoán nó cũng chỉ 2 rồi đảo
            if (c.len === 2) return { code: flip(last), confidence: 0.55, reason: '2-2-2 → đảo', logic: 'A-2-2' };
        }
    }

    // Cầu 3-3: 2 block 3 gần nhất
    if (rle.length >= 2) {
        const [a, b] = rle.slice(-2);
        if (a.len === 3 && b.len === 3 && streak < 3) {
            return { code: last, confidence: 0.55, reason: '3-3 → theo', logic: 'A-3-3' };
        }
    }

    // Không có cầu rõ → SKIP
    return { code: null, confidence: 0, reason: 'Không cầu → bỏ', logic: 'A-Skip' };
}

// ============================================================
// 🎯 PRESET B — "ANTI-PATTERN" (đánh ngược đám đông)
// Triết lý: đa số người chơi theo bệt → mình đánh ngược khi bệt dài
// ============================================================
function predictPresetB(seq, sums) {
    if (seq.length < 6) return { code: null, confidence: 0, reason: 'Boot', logic: 'B-Skip' };

    const streak = currentStreak(seq);
    const alt = currentAlternation(seq);
    const last = seq[seq.length - 1];

    // Bệt 5-8: đa số sẽ theo → mình đánh NGƯỢC (bẻ cầu)
    if (streak >= 5 && streak <= 8) {
        return { code: flip(last), confidence: 0.55, reason: `Bệt ${streak} → bẻ`, logic: 'B-Bẻ bệt' };
    }

    // Bệt ≥ 9: đa số đã bỏ → mình theo (bệt dai)
    if (streak >= 9) {
        return { code: last, confidence: 0.55, reason: `Bệt ${streak} → theo`, logic: 'B-Bệt dai' };
    }

    // 1-1 dài ≥ 5: đa số đánh đảo → mình đánh theo (bẻ 1-1)
    if (alt >= 5) {
        return { code: last, confidence: 0.55, reason: `1-1 (${alt}) → bẻ`, logic: 'B-Bẻ 1-1' };
    }

    return { code: null, confidence: 0, reason: 'Không tín hiệu → bỏ', logic: 'B-Skip' };
}

// ============================================================
// 🎯 PRESET C — "CUSTOM" (bạn tự viết logic ở đây)
// ============================================================
function predictPresetC(seq, sums) {
    if (seq.length < 6) return { code: null, confidence: 0, reason: 'Boot', logic: 'C-Skip' };

    // ============================================================
    // TODO: VIẾT LOGIC CỦA BẠN Ở ĐÂY
    // Input: seq (mảng 'T'/'X'), sums (mảng tổng 3-18)
    // Output: { code: 'T' | 'X' | null, confidence: 0-1, reason: 'string', logic: 'tên' }
    // ============================================================

    // Ví dụ: đánh theo tổng 5 phiên gần nhất
    // Nếu tổng trung bình 5 phiên ≥ 13 → đoán X (vì sắp về Tài trung bình)
    // Ngược lại ≤ 8 → đoán T
    if (sums.length >= 5) {
        const avg = sums.slice(-5).reduce((a, b) => a + b, 0) / 5;
        if (avg >= 14) return { code: 'X', confidence: 0.55, reason: `Avg5=${avg.toFixed(1)} cao → X`, logic: 'C-Sum' };
        if (avg <= 7)  return { code: 'T', confidence: 0.55, reason: `Avg5=${avg.toFixed(1)} thấp → T`, logic: 'C-Sum' };
    }

    return { code: null, confidence: 0, reason: 'Không tín hiệu', logic: 'C-Skip' };
}

// ============================================================
// ROUTER — CHỌN PRESET
// ============================================================
function predict(seq, sums) {
    if (PRESET === 'A') return predictPresetA(seq, sums);
    if (PRESET === 'B') return predictPresetB(seq, sums);
    if (PRESET === 'C') return predictPresetC(seq, sums);
    return predictPresetA(seq, sums);
}

// ============================================================
// FETCH
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
            if (i === 2) { log('ERROR', `fetchApi ${e.message}`); return []; }
            await new Promise(r => setTimeout(r, 500 * (i + 1)));
        }
    }
    return [];
}

// ============================================================
// KELLY
// ============================================================
function kellyFraction(probWin, payout = 1.0) {
    const f = (payout * probWin - (1 - probWin)) / payout;
    return clamp(f, 0, 0.25);
}

// ============================================================
// PROCESS GAME
// ============================================================
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

    // ---- Chấm phiên trước ----
    const prev = db.history[db.history.length - 1];
    if (prev && safeInt(prev.phienDuDoan) === session) {
        const actual = getResult(latest);
        prev.ketQua = actual;
        prev.ketQuaLabel = label(actual);

        if (prev.DU_DOAN_CODE === null) {
            // SKIP
            prev.trangThai = 'BỎ QUA';
            db.meta.totalSkip = (db.meta.totalSkip || 0) + 1;
        } else {
            const correct = prev.DU_DOAN_CODE === actual;
            prev.trangThai = correct ? 'ĐÚNG' : 'SAI';
            db.meta.totalPred = (db.meta.totalPred || 0) + 1;

            if (correct) {
                db.meta.totalWin = (db.meta.totalWin || 0) + 1;
                db.meta.winStreak = (db.meta.winStreak || 0) + 1;
                db.meta.loseStreak = 0;
                db.meta.maxWinStreak = Math.max(db.meta.maxWinStreak || 0, db.meta.winStreak);
            } else {
                db.meta.totalLose = (db.meta.totalLose || 0) + 1;
                db.meta.loseStreak = (db.meta.loseStreak || 0) + 1;
                db.meta.winStreak = 0;
                db.meta.maxLoseStreak = Math.max(db.meta.maxLoseStreak || 0, db.meta.loseStreak);
            }
            db.meta.recent50.push(correct ? 1 : 0);
            while (db.meta.recent50.length > 50) db.meta.recent50.shift();

            // Confusion
            const key = prev.DU_DOAN_CODE + actual;
            if (key in db.meta.confusion) db.meta.confusion[key]++;

            // By logic
            const lg = prev.logic || 'unknown';
            if (!db.meta.byLogic[lg]) db.meta.byLogic[lg] = { win: 0, total: 0 };
            db.meta.byLogic[lg].total++;
            if (correct) db.meta.byLogic[lg].win++;

            // Bankroll
            const probWin = prev.PROB_RAW >= 0.5 ? prev.PROB_RAW : 1 - prev.PROB_RAW;
            const frac = kellyFraction(probWin);
            const betAmount = Math.floor(db.bankroll.current * frac * 0.5);
            if (betAmount > 0) {
                const pnl = correct ? betAmount : -betAmount;
                db.bankroll.current += pnl;
                db.bankroll.totalPnl = (db.bankroll.totalPnl || 0) + pnl;
                db.bankroll.bets.push({ session: prev.phienDuDoan, amount: betAmount, correct, pnl, at: nowIso() });
                if (db.bankroll.bets.length > 500) db.bankroll.bets.shift();
            }
        }
    }

    // ---- Dự đoán phiên tiếp ----
    const pred = predict(seq, sums);

    db.history.push({
        phien: session,
        xucXac: getDice(latest),
        tong: getSum(latest),
        ketQua: getResult(latest),
        ketQuaLabel: label(getResult(latest)),
        phienDuDoan: session + 1,
        DU_DOAN_CODE: pred.code,
        DU_DOAN: label(pred.code) || 'BỎ',
        PROB_RAW: pred.confidence,
        TI_LE: pred.code ? (pred.confidence * 100).toFixed(1) + '%' : '—',
        logic: pred.logic,
        reason: pred.reason,
        kelly: pred.code ? kellyFraction(pred.confidence >= 0.5 ? pred.confidence : 1 - pred.confidence) : 0,
        trangThai: 'ĐANG CHỜ',
        at: nowIso()
    });

    if (db.history.length > MAX_HISTORY) db.history.shift();
    db.lastProcessedSession = session;
    saveDB(game, db);
    broadcast({ type: 'update', game });
}

// ============================================================
// EXPRESS + WS
// ============================================================
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

function authMiddleware(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    next();
}
function broadcast(payload) {
    const msg = JSON.stringify(payload);
    wss.clients.forEach(c => { if (c.readyState === 1) { try { c.send(msg); } catch (e) {} } });
}

// ============================================================
// API ROUTES
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', preset: PRESET, uptime: process.uptime(), ts: nowIso() }));

app.get('/api/stats/:game', authMiddleware, (req, res) => {
    const game = req.params.game;
    const db = readDB(game);
    const m = db.meta;
    const wr = m.totalPred ? (m.totalWin / m.totalPred * 100).toFixed(2) + '%' : 'N/A';
    const wr50 = m.recent50.length ? ((m.recent50.reduce((a, b) => a + b, 0) / m.recent50.length) * 100).toFixed(2) + '%' : 'N/A';
    res.json({
        success: true, game, preset: PRESET,
        winRate: wr, winRateRecent50: wr50,
        totalPred: m.totalPred, totalWin: m.totalWin, totalLose: m.totalLose, totalSkip: m.totalSkip,
        winStreak: m.winStreak, loseStreak: m.loseStreak,
        maxWinStreak: m.maxWinStreak, maxLoseStreak: m.maxLoseStreak,
        confusion: m.confusion,
        byLogic: m.byLogic,
        bankroll: db.bankroll,
        lastProcessedSession: db.lastProcessedSession
    });
});

app.get('/api/predict/:game', authMiddleware, (req, res) => {
    const db = readDB(req.params.game);
    if (!db.history.length) return res.json({ success: false, message: 'Chưa có dữ liệu' });
    const last = db.history[db.history.length - 1];
    res.json({
        success: true, game: req.params.game, preset: PRESET,
        phienHienTai: last.phien, phienDuDoan: last.phienDuDoan,
        duDoan: last.DU_DOAN, code: last.DU_DOAN_CODE,
        tiLe: last.TI_LE, logic: last.logic, reason: last.reason,
        kelly: last.kelly, thoiGian: last.at
    });
});

app.get('/api/export/:game', authMiddleware, (req, res) => {
    const db = readDB(req.params.game);
    const format = (req.query.format || 'json').toLowerCase();
    if (format === 'csv') {
        const rows = ['phien,xucxac,tong,ketqua,phienDuDoan,duDoan,code,tiLe,logic,reason,trangThai'];
        db.history.forEach(h => {
            rows.push([h.phien, (h.xucXac || []).join('-'), h.tong, h.ketQua || '', h.phienDuDoan,
                h.DU_DOAN || '', h.DU_DOAN_CODE || '', h.TI_LE || '',
                `"${h.logic || ''}"`, `"${h.reason || ''}"`, h.trangThai || ''].join(','));
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.game}-history.csv"`);
        return res.send(rows.join('\n'));
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.game}-db.json"`);
    res.send(JSON.stringify(db, null, 2));
});

// So sánh 3 preset trên cùng dữ liệu
app.get('/api/compare/:game', authMiddleware, (req, res) => {
    const game = req.params.game;
    const db = readDB(game);
    // Chạy lại history, mỗi phiên predict bằng 3 preset
    const seqAll = db.history.map(h => h.ketQua).filter(Boolean);
    const sumsAll = db.history.map(h => h.tong).filter(s => s >= 3 && s <= 18);
    const out = { A: { win: 0, total: 0 }, B: { win: 0, total: 0 }, C: { win: 0, total: 0 } };
    for (let i = 6; i < seqAll.length - 1; i++) {
        const subSeq = seqAll.slice(0, i);
        const subSums = sumsAll.slice(0, i);
        const actual = seqAll[i + 1];
        for (const p of ['A', 'B', 'C']) {
            const fn = p === 'A' ? predictPresetA : p === 'B' ? predictPresetB : predictPresetC;
            const r = fn(subSeq, subSums);
            if (r.code) {
                out[p].total++;
                if (r.code === actual) out[p].win++;
            }
        }
    }
    const result = {};
    for (const p of ['A', 'B', 'C']) {
        result[p] = {
            total: out[p].total,
            win: out[p].win,
            winrate: out[p].total ? (out[p].win / out[p].total * 100).toFixed(2) + '%' : 'N/A'
        };
    }
    res.json({ success: true, game, comparison: result });
});

// ============================================================
// UI
// ============================================================
app.get('/', (req, res) => res.send(HTML_UI));
app.get('/:game', (req, res) => {
    const g = req.params.game;
    if (['api', 'health', 'ws'].includes(g)) return res.status(404).send('Not found');
    res.send(HTML_UI);
});

const HTML_UI = `<!DOCTYPE html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HOANG CUSTOM v13 [${PRESET}]</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;min-height:100vh}
.header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:12px;text-align:center}
h1{color:#fff;font-size:18px;margin:0;font-weight:800;text-transform:uppercase}
.badge-preset{display:inline-block;padding:4px 12px;background:#fbbf24;color:#0a0e27;border-radius:6px;font-weight:800;font-size:13px;margin-top:8px}
h2{color:#93c5fd;font-size:13px;margin:16px 0 8px;text-transform:uppercase}
.tabs{display:flex;gap:8px;margin-bottom:12px}
.tab{flex:1;padding:10px;background:#0f172a;border:1px solid #334155;border-radius:8px;cursor:pointer;text-align:center;font-weight:600;color:#94a3b8;font-size:12px}
.tab.active{background:#1e40af;color:#fff;border-color:#3b82f6}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:12px}
.stat{background:#0f172a;padding:10px;border-radius:8px;border:1px solid #334155;font-size:11px;text-align:center}
.stat b{color:#fbbf24;font-size:15px;display:block;margin-top:4px}
.card{background:#0f172a;border-radius:12px;padding:14px;border:1px solid #334155;margin-bottom:12px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#1e40af;color:#fff;padding:8px 4px;font-size:10px;text-transform:uppercase}
td{padding:8px 4px;text-align:center;border-bottom:1px solid #1e293b}
.tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
.dung{color:#22c55e;font-weight:700}.sai{color:#ef4444;font-weight:700}.cho{color:#94a3b8;font-style:italic}.skip{color:#fbbf24;font-weight:700}
.dice{color:#fbbf24;font-weight:700;font-size:11px}
.sum{display:inline-block;padding:2px 8px;border-radius:6px;background:#334155;color:#fbbf24;font-weight:800}
.badge{display:inline-block;padding:2px 6px;border-radius:6px;font-size:10px;font-weight:700}
.ws-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;margin-right:6px}
.ws-dot.on{background:#22c55e;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.warn{background:#7f1d1d;color:#fca5a5;padding:10px;border-radius:8px;font-size:12px;margin-bottom:12px;border-left:4px solid #dc2626}
.btn{padding:8px 14px;background:#1e40af;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;margin:4px 4px 4px 0}
.btn:hover{background:#2563eb}
pre{background:#020617;padding:10px;border-radius:6px;font-size:11px;overflow-x:auto;max-height:300px}
</style></head>
<body>

<div class="header">
  <h1>🎯 HOANG CUSTOM v13 <span><span class="ws-dot" id="ws-dot"></span></span></h1>
  <div class="badge-preset">PRESET ${PRESET}</div>
  <div style="font-size:11px;margin-top:6px;color:#bfdbfe" id="game-label">TAIXIU</div>
</div>

<div class="warn">
  ⚠️ Không có thuật toán nào thắng xúc xắc ngẫu nhiên lâu dài. Đây là công cụ test LOGIC RIÊNG.
  Winrate thực tế sẽ về ~50% sau vài trăm phiên.
</div>

<div class="tabs">
  <div class="tab active" data-game="taixiu">TÀI XỈU</div>
  <div class="tab" data-game="md5">MD5</div>
</div>

<div class="stats" id="stats-grid"></div>

<h2>📊 Hiệu quả theo Logic</h2>
<div class="card" id="logic-card">—</div>

<h2>🎲 Lịch sử 50 phiên</h2>
<div class="card">
  <table><thead><tr>
    <th>Phiên</th><th>XX</th><th>Tổng</th><th>KQ</th><th>Dự đoán</th><th>Logic</th><th>Lý do</th><th>TT</th>
  </tr></thead><tbody id="history-body"></tbody></table>
</div>

<div class="card">
  <button class="btn" onclick="compare()">⚖️ So sánh A/B/C</button>
  <button class="btn" onclick="exportCSV()">💾 Export CSV</button>
  <pre id="extra-output">—</pre>
</div>

<script>
let currentGame = 'taixiu';
let ws = null;
let API_KEY = localStorage.getItem('api_key') || '';
if (!API_KEY) {
  API_KEY = prompt('API key (mặc định: hoang-vip-secret-change-me):', 'hoang-vip-secret-change-me') || '';
  localStorage.setItem('api_key', API_KEY);
}
function hdr() { return { 'x-api-key': API_KEY }; }

function switchGame(g) {
  currentGame = g;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.game === g));
  document.getElementById('game-label').textContent = g.toUpperCase();
  loadAll();
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchGame(t.dataset.game));

async function loadStats() {
  try {
    const r = await fetch('/api/stats/'+currentGame, { headers: hdr() });
    if (!r.ok) return;
    const s = await r.json();
    renderStats(s);
    renderLogic(s.byLogic || {});
  } catch (e) { console.warn(e); }
}
function renderStats(s) {
  const g = document.getElementById('stats-grid');
  g.innerHTML = \`
    <div class="stat">WinRate<b>\${s.winRate}</b></div>
    <div class="stat">Recent50<b>\${s.winRateRecent50}</b></div>
    <div class="stat">Dự đoán<b>\${s.totalPred||0}</b></div>
    <div class="stat">Win<b style="color:#22c55e">\${s.totalWin||0}</b></div>
    <div class="stat">Lose<b style="color:#ef4444">\${s.totalLose||0}</b></div>
    <div class="stat">Skip<b style="color:#fbbf24">\${s.totalSkip||0}</b></div>
    <div class="stat">WinStreak<b>\${s.winStreak||0}</b></div>
    <div class="stat">LoseStreak<b>\${s.loseStreak||0}</b></div>
    <div class="stat">Bankroll<b>\${(s.bankroll?.current||0).toLocaleString()}</b></div>
    <div class="stat">PnL<b style="color:\${((s.bankroll?.totalPnl)||0)>=0?'#22c55e':'#ef4444'}">\${((s.bankroll?.totalPnl)||0).toLocaleString()}</b></div>
  \`;
}
function renderLogic(byLogic) {
  let html = '<table><thead><tr><th>Logic</th><th>Tổng</th><th>Win</th><th>Winrate</th></tr></thead><tbody>';
  const keys = Object.keys(byLogic);
  if (!keys.length) html += '<tr><td colspan="4" style="color:#64748b">Chưa có dữ liệu</td></tr>';
  keys.sort((a,b) => byLogic[b].total - byLogic[a].total).forEach(k => {
    const { win, total } = byLogic[k];
    const wr = total ? ((win/total)*100).toFixed(1)+'%' : '-';
    const color = total && win/total >= 0.55 ? '#22c55e' : total && win/total <= 0.45 ? '#ef4444' : '#fbbf24';
    html += '<tr><td>'+k+'</td><td>'+total+'</td><td>'+win+'</td><td style="color:'+color+'">'+wr+'</td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('logic-card').innerHTML = html;
}

async function loadHistory() {
  try {
    const r = await fetch('/api/export/'+currentGame+'?format=json', { headers: hdr() });
    if (!r.ok) return;
    const db = await r.json();
    renderHistory(db.history.slice(-50).reverse());
  } catch (e) { console.warn(e); }
}
function renderHistory(rows) {
  document.getElementById('history-body').innerHTML = rows.map(h => {
    const dice = (h.xucXac||[]).join('-');
    const kqCls = h.ketQua==='T'?'tai':(h.ketQua==='X'?'xiu':'');
    const ddCls = h.DU_DOAN_CODE==='T'?'tai':(h.DU_DOAN_CODE==='X'?'xiu':'skip');
    const ttCls = h.trangThai==='ĐÚNG'?'dung':(h.trangThai==='SAI'?'sai':(h.trangThai==='BỎ QUA'?'skip':'cho'));
    return '<tr>'+
      '<td style="font-family:monospace;font-size:10px;color:#64748b">'+h.phien+'</td>'+
      '<td class="dice">'+dice+'</td>'+
      '<td><span class="sum">'+(h.tong||'')+'</span></td>'+
      '<td class="'+kqCls+'">'+(h.ketQuaLabel||'')+'</td>'+
      '<td class="'+ddCls+'">'+(h.DU_DOAN||'—')+'</td>'+
      '<td style="font-size:10px"><span class="badge" style="background:#334155;color:#cbd5e1">'+(h.logic||'-')+'</span></td>'+
      '<td style="font-size:10px;color:#94a3b8;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(h.reason||'')+'">'+(h.reason||'')+'</td>'+
      '<td class="'+ttCls+'">'+(h.trangThai==='ĐANG CHỜ'?'...':(h.trangThai||''))+'</td>'+
    '</tr>';
  }).join('');
}
async function loadAll() { await Promise.all([loadStats(), loadHistory()]); }

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto+'://'+location.host+'/ws');
  ws.onopen = () => document.getElementById('ws-dot').classList.add('on');
  ws.onclose = () => { document.getElementById('ws-dot').classList.remove('on'); setTimeout(connectWS, 3000); };
  ws.onmessage = (e) => { try { const d = JSON.parse(e.data); if (d.type==='update' && d.game===currentGame) loadAll(); } catch (err) {} };
}
async function compare() {
  const r = await fetch('/api/compare/'+currentGame, { headers: hdr() });
  document.getElementById('extra-output').textContent = JSON.stringify(await r.json(), null, 2);
}
function exportCSV() { window.open('/api/export/'+currentGame+'?format=csv&api_key='+API_KEY, '_blank'); }

connectWS(); loadAll(); setInterval(loadAll, 15000);
</script>
</body></html>`;

// ============================================================
// TICK + SHUTDOWN
// ============================================================
let isShuttingDown = false;
async function tick() {
    if (isShuttingDown) return;
    try { await processGame('md5'); await processGame('taixiu'); }
    catch (e) { log('ERROR', 'tick:', e.message); }
}
setInterval(tick, TICK_MS);
wss.on('connection', (ws) => { ws.send(JSON.stringify({ type: 'hello', ts: nowIso() })); });

function shutdown(sig) {
    log('INFO', `Shutdown ${sig}`);
    isShuttingDown = true;
    wss.clients.forEach(c => { try { c.close(); } catch (e) {} });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => log('ERROR', 'uncaught:', e.message));

server.listen(PORT, () => {
    log('INFO', `🚀 HOANG CUSTOM v13 [PRESET=${PRESET}] on port ${PORT}`);
    tick();
});
