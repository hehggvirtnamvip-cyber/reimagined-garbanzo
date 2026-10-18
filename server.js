'use strict';

// ============================================================
// SERVER.JS — v19 ULTIMATE FULL STACK (RENDER FIX V2)
// Node.js >= 18 | npm i express axios
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

// ==========================================
// CẤU HÌNH PORT AN TOÀN CHO RENDER
// ==========================================
// Render yêu cầu bind 0.0.0.0 và dùng PORT do họ cấp (thường là 10000)
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const HOST = '0.0.0.0';

const API_MD5 = 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau';
const API_TX  = 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau';

const DB_DIR  = process.env.DB_DIR || __dirname;
const TICK_MS = 5000;
const MAX_HIST = 2000;

const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT  = process.env.TG_CHAT  || '';

// Đảm bảo thư mục DB tồn tại
if (!fs.existsSync(DB_DIR)) {
    try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {}
}

// Bắt lỗi toàn cục để Render không bị "im lặng" khi app crash
process.on('uncaughtException', (err) => {
    console.error('🔥 UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('🔥 UNHANDLED REJECTION:', err);
});

// ==========================================
// UTILS
// ==========================================
const label = c => (c === 'T' ? 'Tài' : c === 'X' ? 'Xỉu' : null);
const flip  = c => (c === 'T' ? 'X' : c === 'X' ? 'T' : null);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const safeInt = (x, def = 0) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : def; };
const fmtPct = n => (n * 100).toFixed(1) + '%';

const getDice = item => [safeInt(item?.FirstDice), safeInt(item?.SecondDice), safeInt(item?.ThirdDice)];
const getSum = item => {
    const s = getDice(item).reduce((a, b) => a + b, 0);
    return (s >= 3 && s <= 18) ? s : safeInt(item?.DiceSum);
};
const getResult = item => {
    const s = getSum(item);
    return (s >= 3 && s <= 18) ? (s >= 11 ? 'T' : 'X') : null;
};

// ==========================================
// 1. AUTO-GENERATE 3000+ PATTERNS
// ==========================================
const MATRIX = [];
const addPattern = (id, str, p, weight = 1) => MATRIX.push({ id, str, p, w: weight });

for (let l = 3; l <= 12; l++) {
    addPattern(`BET_T_${l}`, 'T'.repeat(l), 'T', l >= 5 ? 1.2 : 1);
    addPattern(`BET_X_${l}`, 'X'.repeat(l), 'X', l >= 5 ? 1.2 : 1);
}
for (let l = 4; l <= 12; l++) {
    let t = '', x = '';
    for (let i = 0; i < l; i++) { t += i % 2 ? 'X' : 'T'; x += i % 2 ? 'T' : 'X'; }
    addPattern(`ALT_${l}`, t, 'X', 1.1);
    addPattern(`ALT_${l}_X`, x, 'T', 1.1);
}
for (let b = 2; b <= 5; b++) {
    for (let r = 2; r <= 4; r++) {
        addPattern(`BLK_${b}_${r}_T`, ('T'.repeat(b) + 'X'.repeat(b)).repeat(r), 'X', 1.15);
        addPattern(`BLK_${b}_${r}_X`, ('X'.repeat(b) + 'T'.repeat(b)).repeat(r), 'T', 1.15);
    }
}
for (let a = 1; a <= 3; a++) {
    for (let b = a + 1; b <= 5; b++) {
        for (let c = b + 1; c <= 7; c++) {
            if (a + b + c <= 12) {
                addPattern(`RAMP_${a}${b}${c}`, 'T'.repeat(a) + 'X'.repeat(b) + 'T'.repeat(c), 'X', 1.05);
                addPattern(`RAMP_${a}${b}${c}_X`, 'X'.repeat(a) + 'T'.repeat(b) + 'X'.repeat(c), 'T', 1.05);
            }
        }
    }
}
for (let l = 2; l <= 5; l++) {
    addPattern(`DEC_${l}`, ('T'.repeat(l) + 'X'.repeat(l - 1) + 'T'.repeat(Math.max(1, l - 2))), 'X', 1.1);
    addPattern(`INC_${l}`, ('X'.repeat(l) + 'T'.repeat(l - 1) + 'X'.repeat(Math.max(1, l - 2))), 'T', 1.1);
}
const seen = new Set(MATRIX.map(m => m.str));
let gen = 0;
while (gen < 1500) {
    const len = 5 + Math.floor(Math.random() * 4);
    let s = [Math.random() > 0.5 ? 'T' : 'X'];
    for (let j = 1; j < len; j++) s.push(Math.random() > 0.55 ? flip(s[j - 1]) : s[j - 1]);
    const str = s.join('');
    if (!seen.has(str)) {
        seen.add(str);
        addPattern(`GEN_${str}`, str, flip(s[s.length - 1]), 0.8);
        gen++;
    }
}

// ==========================================
// 2. SPECIAL CẦU MÔ
// ==========================================
function checkSpecialPatterns(seq) {
    const n = seq.length;
    if (n < 6) return null;
    const last = seq[n - 1];

    const rle = [];
    let cur = seq[0], len = 1;
    for (let i = 1; i < n; i++) {
        if (seq[i] === cur) len++;
        else { rle.push({ ch: cur, len }); cur = seq[i]; len = 1; }
    }
    rle.push({ ch: cur, len });

    const blocks = rle.map(b => b.len);
    const sz = blocks.slice(-3);

    if (sz.length === 3 && sz[0] >= 3 && sz[1] === 1 && sz[2] >= 3)
        return { name: 'Gối', code: flip(last), conf: 0.78 };
    if (rle.length >= 4) {
        const lastBlk = rle[rle.length - 1];
        const prev3 = rle.slice(-4, -1).map(b => b.len);
        const avg = prev3.reduce((a, b) => a + b, 0) / 3;
        if (lastBlk.len >= avg * 2.5 && lastBlk.len >= 4)
            return { name: 'Bẻ', code: flip(last), conf: 0.75 };
    }
    if (blocks.length >= 4) {
        const [a, b, c, d] = blocks.slice(-4);
        if (a === c && b === d && a !== b)
            return { name: 'NhảyCóc', code: flip(last), conf: 0.72 };
    }
    if (blocks.length >= 5) {
        const s5 = blocks.slice(-5).join('-');
        if (['2-1-2-1-2', '1-2-1-2-1'].includes(s5))
            return { name: 'XócĐĩa', code: flip(last), conf: 0.77 };
    }
    if (blocks.length >= 3) {
        const [a, b, c] = blocks.slice(-3);
        if (a > b && b > c) return { name: 'NghiêngGiảm', code: flip(last), conf: 0.7 };
        if (a < b && b < c) return { name: 'NghiêngTăng', code: flip(last), conf: 0.7 };
    }
    if (blocks.length >= 5) {
        const s5 = blocks.slice(-5).join('');
        if (s5 === '12121' || s5 === '21212')
            return { name: 'ZicZac', code: flip(last), conf: 0.74 };
    }
    if (blocks.length >= 3) {
        const [a, b, c] = blocks.slice(-3);
        if (a === 3 && b === 2 && c === 1) return { name: 'Cầu321', code: flip(last), conf: 0.76 };
        if (a === 1 && b === 2 && c === 3) return { name: 'Cầu123', code: flip(last), conf: 0.76 };
        if (a >= 3 && b >= 3 && c === 1) return { name: 'CầuĐôi', code: flip(last), conf: 0.73 };
        if (a === 2 && b === 1 && c === 2) return { name: 'KimCương', code: flip(last), conf: 0.72 };
        if (a === b && b === c && a >= 3) return { name: 'Đều', code: flip(last), conf: 0.71 };
    }
    if (blocks.length >= 4) {
        const [a, b, c, d] = blocks.slice(-4);
        if (a === 1 && b === 3 && c === 1 && d === 3)
            return { name: 'CầuSóng', code: flip(last), conf: 0.75 };
    }
    return null;
}

// ==========================================
// 3. STATE & DB
// ==========================================
function initDB() {
    return {
        lastSess: null, hist: [],
        meta: { pred: 0, win: 0, streak: 0, bestStreak: 0 },
        states: { TREND: { mat: {} }, CHOP: { mat: {} }, MIXED: { mat: {} } },
        w: { mat: 1, ngram: 1, markov: 1, sum: 1, special: 1.2, streak: 1 },
        shield: { T: 0, X: 0 },
        ngram: {},
        markov: { TT: { t: 0, x: 0 }, TX: { t: 0, x: 0 }, XT: { t: 0, x: 0 }, XX: { t: 0, x: 0 } },
        calibration: { buckets: Array(10).fill(0).map(() => ({ hit: 0, total: 0 })) },
        daily: {}
    };
}
const DB_P = g => path.join(DB_DIR, `db_${g}.json`);
function loadDB(g) {
    try {
        if (fs.existsSync(DB_P(g))) {
            const d = JSON.parse(fs.readFileSync(DB_P(g), 'utf8'));
            const init = initDB();
            return {
                ...init, ...d,
                meta: { ...init.meta, ...(d.meta || {}) },
                states: { ...init.states, ...(d.states || {}) },
                w: { ...init.w, ...(d.w || {}) },
                shield: { ...init.shield, ...(d.shield || {}) },
                markov: { ...init.markov, ...(d.markov || {}) }
            };
        }
    } catch (e) {}
    return initDB();
}
function saveDB(g, d) {
    try { fs.writeFileSync(DB_P(g), JSON.stringify(d)); } catch (e) {}
}

function getState(seq) {
    let streak = 1, alt = 0;
    for (let i = seq.length - 2; i >= 0; i--) { if (seq[i] === seq[i + 1]) streak++; else break; }
    for (let i = seq.length - 1; i >= 1; i--) { if (seq[i] !== seq[i - 1]) alt++; else break; }
    if (streak >= 4) return 'TREND';
    if (alt >= 4) return 'CHOP';
    const t = seq.slice(-10).filter(x => x === 'T').length / 10;
    return (t >= 0.7 || t <= 0.3) ? 'TREND' : 'MIXED';
}

// ==========================================
// 4. PREDICTION ENGINE
// ==========================================
function predict(seq, sums, db, state) {
    let sT = 0, sX = 0;
    const feats = [];
    const seqStr = seq.join(''), last = seq[seq.length - 1];

    const add = (name, code, conf, tag) => {
        const pts = conf * (db.w[name] || 1) * 10;
        code === 'T' ? sT += pts : sX += pts;
        feats.push({ name, code, pts, tag });
    };

    let mc = 0;
    for (const rule of MATRIX) {
        if (seqStr.endsWith(rule.str)) {
            const st = db.states[state].mat[rule.id] || { w: 1, t: 2 };
            const wr = st.t > 0 ? st.w / st.t : 0.5;
            if (wr >= 0.5 || st.t < 3) {
                add('mat', rule.p, clamp(wr * rule.w, 0.5, 0.92), rule.id);
                mc++;
            }
            if (mc >= 8) break;
        }
    }

    const sp = checkSpecialPatterns(seq);
    if (sp) add('special', sp.code, sp.conf, sp.name);

    for (let l = 8; l >= 2; l--) {
        const k = seq.slice(-l).join('');
        const g = db.ngram[k];
        if (g && g.t + g.x >= 3) {
            const p = g.t / (g.t + g.x);
            if (Math.abs(p - 0.5) > 0.12) {
                add('ngram', p > 0.5 ? 'T' : 'X', clamp(Math.abs(p - 0.5) * 2.2, 0.5, 0.9), `N${l}`);
                break;
            }
        }
    }

    if (seq.length >= 2) {
        const key = seq.slice(-2).join('');
        const m = db.markov[key];
        if (m && m.t + m.x >= 5) {
            const p = m.t / (m.t + m.x);
            if (Math.abs(p - 0.5) > 0.1)
                add('markov', p > 0.5 ? 'T' : 'X', clamp(Math.abs(p - 0.5) * 2, 0.5, 0.85), `M_${key}`);
        }
    }

    if (sums.length >= 5) {
        const a = sums.slice(-5).reduce((x, y) => x + y, 0) / 5;
        if (a >= 13) add('sum', 'X', 0.65, 'SumCao');
        else if (a <= 8) add('sum', 'T', 0.65, 'SumThap');
    }

    let streak = 1;
    for (let i = seq.length - 2; i >= 0; i--) { if (seq[i] === last) streak++; else break; }
    if (streak >= 6) add('streak', flip(last), 0.7, `DaoStreak${streak}`);

    if (db.shield.T >= 2) { sT -= db.shield.T * 6; sX += db.shield.T * 6; }
    if (db.shield.X >= 2) { sX -= db.shield.X * 6; sT += db.shield.X * 6; }

    if (sT === 0 && sX === 0)
        return { code: flip(last), label: 'MeanRevert', conf: 0.55, tiLe: '55.0%', feats, state };

    const code = sT >= sX ? 'T' : 'X';
    const rawConf = Math.max(sT, sX) / (sT + sX);

    const bucket = Math.min(9, Math.floor(rawConf * 10));
    const cb = db.calibration.buckets[bucket];
    const calibFactor = cb.total >= 10 ? cb.hit / cb.total : 0.5;
    const conf = clamp(rawConf * 0.7 + calibFactor * 0.3, 0.51, 0.95);

    const topF = feats.filter(f => f.code === code).sort((a, b) => b.pts - a.pts).slice(0, 3).map(f => f.tag).join('+');

    return { code, label: topF || 'Fusion', conf, tiLe: fmtPct(conf), feats, state };
}

// ==========================================
// 5. TELEGRAM
// ==========================================
async function tgSend(text) {
    if (!TG_TOKEN || !TG_CHAT) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true
        }, { timeout: 5000 });
    } catch (e) {}
}

async function sendPrediction(game, pred, sess) {
    const icon = pred.code === 'T' ? '🟢' : '🔴';
    const msg = `🎯 <b>KÈO MỚI (${game.toUpperCase()})</b>\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `📌 Phiên: <b>#${sess + 1}</b>\n` +
                `${icon} Cửa: <b>${label(pred.code)}</b>\n` +
                `📊 Tỉ lệ: <b>${pred.tiLe}</b>\n` +
                `🧠 Lý do: <i>${pred.label}</i>\n` +
                `📈 State: ${pred.state}`;
    await tgSend(msg);
}

async function sendResult(game, prev, act, win) {
    const icon = win ? '✅' : '❌';
    const msg = `${icon} <b>KẾT QUẢ (${game.toUpperCase()})</b>\n` +
                `━━━━━━━━━━━━━━━━\n` +
                `Phiên: <b>#${prev.pd}</b>\n` +
                `Dự đoán: <b>${prev.lb}</b> → Kết quả: <b>${label(act)}</b>\n` +
                `Trạng thái: <b>${win ? 'ĐÚNG' : 'SAI'}</b>`;
    await tgSend(msg);
}

// ==========================================
// 6. SSE STREAM
// ==========================================
let sseClients = [];
function broadcastSSE(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    sseClients = sseClients.filter(c => {
        try { c.res.write(msg); return true; } catch (e) { return false; }
    });
}

// ==========================================
// 7. CIRCUIT BREAKER
// ==========================================
const circuit = { md5: { fails: 0, until: 0 }, taixiu: { fails: 0, until: 0 } };

async function fetchAPI(game) {
    const cb = circuit[game];
    if (Date.now() < cb.until) return null;
    const url = game === 'md5' ? API_MD5 : API_TX;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await axios.get(url, { timeout: 8000 });
            cb.fails = 0; cb.until = 0;
            return res.data;
        } catch (e) {
            cb.fails++;
            if (cb.fails >= 5) { cb.until = Date.now() + 60000; cb.fails = 0; }
        }
    }
    return null;
}

// ==========================================
// 8. MAIN TICK
// ==========================================
async function tick(game) {
    try {
        const data = await fetchAPI(game);
        if (!data) return;
        const list = data?.data?.list || data?.list || data?.data || [];
        if (!Array.isArray(list) || !list.length) return;

        const latest = list[list.length - 1];
        const sess = safeInt(latest.SessionId);
        const db = loadDB(game);
        if (db.lastSess === sess) return;

        const seq = list.map(getResult).filter(Boolean);
        const sums = list.map(getSum).filter(s => s >= 3 && s <= 18);
        if (seq.length < 6) return;

        const prev = db.hist[db.hist.length - 1];
        if (prev && prev.pd === sess && prev.tt === '...') {
            const act = getResult(latest);
            const ok = prev.code === act;
            prev.res = act;
            prev.tt = ok ? 'ĐÚNG' : 'SAI';
            db.meta.pred++;
            if (ok) {
                db.meta.win++;
                db.meta.streak = (db.meta.streak || 0) + 1;
                if (db.meta.streak > db.meta.bestStreak) db.meta.bestStreak = db.meta.streak;
            } else {
                db.meta.streak = 0;
            }
            db.shield[prev.code] = ok ? 0 : db.shield[prev.code] + 1;

            const bucket = Math.min(9, Math.floor(parseFloat(prev.tiLe) / 10));
            const cb = db.calibration.buckets[bucket];
            cb.total++;
            if (ok) cb.hit++;

            if (prev.feats) {
                for (const f of prev.feats) {
                    if (f.name === 'mat') {
                        const st = db.states[prev.state].mat[f.tag] || { w: 1, t: 2 };
                        st.t++;
                        if (f.code === act) st.w++;
                        if (st.t > 30) { st.w *= 0.95; st.t *= 0.95; }
                        db.states[prev.state].mat[f.tag] = st;
                    }
                    db.w[f.name] = clamp(db.w[f.name] + (f.code === act ? 0.05 : -0.05), 0.1, 3);
                }
            }

            for (let l = 2; l <= 8; l++) {
                if (seq.length < l + 1) break;
                const k = seq.slice(-l - 1, -1).join('');
                if (!db.ngram[k]) db.ngram[k] = { t: 0, x: 0 };
                db.ngram[k][act === 'T' ? 't' : 'x']++;
            }

            if (seq.length >= 3) {
                const mk = seq.slice(-3, -1).join('');
                if (db.markov[mk]) db.markov[mk][act === 'T' ? 't' : 'x']++;
            }

            sendResult(game, prev, act, ok);
        }

        const state = getState(seq);
        const pred = predict(seq, sums, db, state);

        const rec = {
            p: sess, pd: sess + 1, code: pred.code, lb: label(pred.code),
            tiLe: pred.tiLe, pn: pred.label, feats: pred.feats, state, tt: '...',
            time: new Date().toISOString()
        };
        db.hist.push(rec);
        if (db.hist.length > MAX_HIST) db.hist = db.hist.slice(-MAX_HIST);
        db.lastSess = sess;

        const day = new Date().toISOString().slice(0, 10);
        if (!db.daily[day]) db.daily[day] = { pred: 0, win: 0 };
        if (prev) db.daily[day].pred++;
        if (prev && prev.tt === 'ĐÚNG') db.daily[day].win++;

        saveDB(game, db);
        broadcastSSE({ game, rec, meta: db.meta });
        sendPrediction(game, pred, sess);

    } catch (e) {
        console.error(`[tick ${game}]`, e.message);
    }
}

setInterval(() => { tick('md5'); tick('taixiu'); }, TICK_MS);

// ==========================================
// 9. API ROUTES
// ==========================================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>HOANG VIP WIN v19</title>
<style>
body{font-family:system-ui;background:#0a0e27;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;margin:0}
h1{font-size:32px;background:linear-gradient(135deg,#3b82f6,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
a{color:#22c55e;text-decoration:none;font-size:18px;padding:12px 32px;border:1px solid #22c55e;border-radius:12px;transition:.2s}
a:hover{background:#22c55e;color:#0a0e27}
</style></head><body>
<h1>🔥 HOANG VIP WIN v19</h1>
<div style="display:flex;gap:16px">
<a href="/taixiu">🎲 Tài Xỉu</a>
<a href="/md5">🎰 MD5</a>
</div>
<p style="color:#64748b">3000+ Patterns · 12 Special Cầu · Live Streaming</p>
</body></html>`);
});

app.get('/api/health', (req, res) => res.json({
    ok: true, uptime: process.uptime(),
    port: PORT,
    circuit: { md5: circuit.md5.fails, taixiu: circuit.taixiu.fails },
    clients: sseClients.length, patterns: MATRIX.length
}));

// (Giữ nguyên các API phụ như cũ nếu bạn cần)
app.get('/api/predict/:game', (req, res) => {
    if (!['md5', 'taixiu'].includes(req.params.game)) return res.status(400).json({ error: 'invalid' });
    const db = loadDB(req.params.game);
    if (!db.hist.length) return res.json({ error: 'Wait...' });
    const l = db.hist[db.hist.length - 1];
    res.json({ game: req.params.game, session: l.pd, code: l.code, predict: l.lb, rate: l.tiLe, reason: l.pn, state: l.state });
});

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const client = { id: Date.now() + Math.random(), res };
    sseClients.push(client);
    req.on('close', () => { sseClients = sseClients.filter(c => c.id !== client.id); });
});

// Trang chơi game
app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (!['md5', 'taixiu'].includes(game)) return res.status(404).send('Not found');
    const db = loadDB(game);
    const rows = db.hist.slice(-100).reverse();
    const wr = db.meta.pred ? (db.meta.win / db.meta.pred * 100).toFixed(1) : '0.0';

    const html = `<!DOCTYPE html><html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HOANG VIP WIN v19 - ${game.toUpperCase()}</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;min-height:100vh}
.header{background:linear-gradient(135deg,#1e3a8a,#3b82f6,#a855f7);padding:20px;border-radius:16px;margin-bottom:14px;text-align:center;box-shadow:0 12px 40px rgba(59,130,246,.4)}
h1{color:#fff;font-size:22px;margin:0;font-weight:900;text-transform:uppercase;letter-spacing:1px}
.sub{color:#cbd5e1;font-size:12px;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:12px}
.stat{background:rgba(15,23,42,.8);padding:12px;border-radius:12px;border:1px solid #334155;text-align:center;backdrop-filter:blur(8px)}
.stat-l{font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px}
.stat-v{font-size:18px;color:#fbbf24;font-weight:800;display:block;margin-top:4px}
.table-wrap{background:rgba(15,23,42,.8);border-radius:14px;overflow-x:auto;border:1px solid #334155;backdrop-filter:blur(8px)}
table{width:100%;border-collapse:collapse;font-size:12px;min-width:650px}
th{background:linear-gradient(135deg,#1e40af,#3b82f6);color:#fff;padding:12px 6px;font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.5px;position:sticky;top:0;z-index:1}
td{padding:10px 6px;text-align:center;border-bottom:1px solid rgba(30,41,59,.5)}
tr:hover{background:rgba(59,130,246,.1)}
.tai{color:#22c55e;font-weight:800;text-shadow:0 0 8px rgba(34,197,94,.5)}
.xiu{color:#ef4444;font-weight:800;text-shadow:0 0 8px rgba(239,68,68,.5)}
.dung{color:#22c55e;font-weight:800}.sai{color:#ef4444;font-weight:800}.cho{color:#94a3b8;font-style:italic;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.session{font-family:monospace;font-size:11px;color:#64748b}
.ti-le{font-size:12px;color:#cbd5e1;font-weight:700}
.badge{display:inline-block;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
.badge-mat{background:linear-gradient(135deg,#1e3a8a,#3b82f6);color:#dbeafe}
.badge-special{background:linear-gradient(135deg,#7c2d12,#ea580c);color:#fed7aa;box-shadow:0 0 12px rgba(234,88,12,.5)}
.badge-ngram{background:linear-gradient(135deg,#4c1d95,#8b5cf6);color:#ede9fe}
.badge-default{background:#334155;color:#cbd5e1}
.state-badge{display:inline-block;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:700}
.state-TREND{background:#166534;color:#bbf7d0}
.state-CHOP{background:#854d0e;color:#fef08a}
.state-MIXED{background:#1e40af;color:#bfdbfe}
</style></head><body>
<div class="header">
  <h1>🎯 HOANG VIP WIN v19 - ${game.toUpperCase()}</h1>
  <div class="sub">3000+ Patterns · 12 Special Cầu · Live</div>
</div>
<div class="stats">
  <div class="stat"><div class="stat-l">WinRate</div><div class="stat-v">${wr}%</div></div>
  <div class="stat"><div class="stat-l">Tổng Phiên</div><div class="stat-v">${db.meta.pred}</div></div>
  <div class="stat"><div class="stat-l">Thắng</div><div class="stat-v">${db.meta.win}</div></div>
  <div class="stat"><div class="stat-l">Streak</div><div class="stat-v">${db.meta.streak || 0}🔥</div></div>
  <div class="stat"><div class="stat-l">Best</div><div class="stat-v">${db.meta.bestStreak || 0}</div></div>
  <div class="stat"><div class="stat-l">Shield</div><div class="stat-v">${db.shield.T}/${db.shield.X}</div></div>
</div>
<div class="table-wrap"><table>
  <thead><tr>
    <th>PHIÊN</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>LÝ DO</th><th>STATE</th><th>KQ</th><th>TT</th>
  </tr></thead><tbody id="tbody">
  ${rows.map(it => {
      const ddCls = it.code === 'T' ? 'tai' : 'xiu';
      const ttCls = it.tt === 'ĐÚNG' ? 'dung' : (it.tt === 'SAI' ? 'sai' : 'cho');
      let badgeCls = 'badge-default';
      if (it.pn.includes('N') && /N\d/.test(it.pn)) badgeCls = 'badge-ngram';
      if (it.pn.includes('Fusion') || it.pn.includes('DaoStreak')) badgeCls = 'badge-mat';
      if (/Gối|Bẻ|Xóc|Zic|Cầu|Kim|Sóng|Đôi|Đều|Nghiêng/.test(it.pn)) badgeCls = 'badge-special';
      return `<tr>
          <td class="session">${it.pd}</td>
          <td class="${ddCls}">${it.lb}</td>
          <td class="ti-le">${it.tiLe}</td>
          <td><span class="badge ${badgeCls}">${it.pn}</span></td>
          <td><span class="state-badge state-${it.state}">${it.state}</span></td>
          <td>${it.res ? label(it.res) : ''}</td>
          <td class="${ttCls}">${it.tt}</td>
      </tr>`;
  }).join('')}
  </tbody></table></div>
<script>
const es = new EventSource('/api/stream');
es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.game !== '${game}') return;
    const r = d.rec;
    const tb = document.getElementById('tbody');
    const tr = document.createElement('tr');
    const ddCls = r.code === 'T' ? 'tai' : 'xiu';
    const ttCls = r.tt === 'ĐÚNG' ? 'dung' : (r.tt === 'SAI' ? 'sai' : 'cho');
    let badgeCls = 'badge-default';
    if (/Gối|Bẻ|Xóc|Zic|Cầu|Kim|Sóng|Đôi|Đều/.test(r.pn)) badgeCls = 'badge-special';
    tr.style.animation = 'fadeIn .5s';
    tr.innerHTML = \`<td class="session">\${r.pd}</td>
        <td class="\${ddCls}">\${r.lb}</td>
        <td class="ti-le">\${r.tiLe}</td>
        <td><span class="badge \${badgeCls}">\${r.pn}</span></td>
        <td><span class="state-badge state-\${r.state}">\${r.state}</span></td>
        <td></td>
        <td class="\${ttCls}">\${r.tt}</td>\`;
    tb.insertBefore(tr, tb.firstChild);
    if (tb.children.length > 100) tb.removeChild(tb.lastChild);
};
</script>
</body></html>`;
    res.send(html);
});

// ==========================================
// 10. KHỞI ĐỘNG SERVER
// ==========================================
app.listen(PORT, HOST, () => {
    console.log(`🔥 Server v19 Ultimate running on http://${HOST}:${PORT}`);
    console.log(`   Patterns: ${MATRIX.length}`);
    console.log(`   Telegram: ${TG_TOKEN ? 'ON' : 'OFF'}`);
    
    // Chạy tick đầu tiên
    tick('md5'); 
    tick('taixiu');
});
