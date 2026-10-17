'use strict';

// language: JavaScript (Node.js >= 18), file: server.js
// *40+ pattern matchers: bệt, 1-1, 2-2, 3-3, 4-4, 1-2-1, 2-1-2, 1-3-1, 3-1-3, 2-3-2, 3-2-3, 1-4-1, 4-2, 2-4, nghiêng, so le, gối, đảo, nhảy cóc, zic-zac, bẻ, xóc đĩa, đối xứng, lặp kép, bậc thang, tam giác, hỗn hợp, mixed-block*
// *regime Bayesian + pattern-library dual layer*

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
        history: [], lastProcessedSession: null,
        regimeStats: {}, patternStats: {}, mem: [],
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
// RUN-LENGTH + STATISTICAL
// ============================================================
function rle(seq) {
    const out = []; if (!seq.length) return out;
    let cur = seq[0], len = 1;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === cur) len++;
        else { out.push({ ch: cur, len }); cur = seq[i]; len = 1; }
    }
    out.push({ ch: cur, len });
    return out;
}
function binaryEntropy(arr) {
    if (!arr.length) return 0;
    const p = arr.filter(x => x === 'T').length / arr.length;
    if (p === 0 || p === 1) return 0;
    return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}
function blockStats(seq) {
    const r = rle(seq);
    if (r.length < 2) return { mean: 1, std: 0, max: 1, count: r.length };
    const lens = r.map(b => b.len);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    return { mean, std: Math.sqrt(variance), max: Math.max(...lens), count: lens.length };
}

// ============================================================
// PATTERN LIBRARY — 40+ cầu
// Mỗi entry: { name, check(seq, rle, sums) => { code, conf } | null }
// ============================================================
const PATTERN_LIBRARY = [

    // --- BỆT / STREAK (3 loại) ---
    { name: 'BỆT-3-THEO', check: (s, r) => {
        if (!r.length || r[r.length-1].len !== 3) return null;
        return { code: r[r.length-1].ch, conf: 0.70 };
    }},
    { name: 'BỆT-4-THEO', check: (s, r) => {
        if (!r.length || r[r.length-1].len !== 4) return null;
        return { code: r[r.length-1].ch, conf: 0.75 };
    }},
    { name: 'BỆT-5-7-THEO', check: (s, r) => {
        if (!r.length) return null;
        const l = r[r.length-1].len;
        if (l < 5 || l > 7) return null;
        return { code: r[r.length-1].ch, conf: 0.68 };
    }},
    { name: 'BỆT-8-10-GÃY', check: (s, r) => {
        if (!r.length) return null;
        const l = r[r.length-1].len;
        if (l < 8 || l > 10) return null;
        return { code: flip(r[r.length-1].ch), conf: 0.80 };
    }},
    { name: 'BỆT-11+CHẮC-GÃY', check: (s, r) => {
        if (!r.length) return null;
        if (r[r.length-1].len < 11) return null;
        return { code: flip(r[r.length-1].ch), conf: 0.88 };
    }},

    // --- 1-1 ALTERNATE ---
    { name: 'CẦU-1-1', check: (s) => {
        const n = s.length; if (n < 6) return null;
        let alt = 0;
        for (let i = n - 1; i >= 1; i--) { if (s[i] !== s[i-1]) alt++; else break; }
        if (alt >= 4 && alt <= 12) return { code: flip(s[n-1]), conf: 0.65 + Math.min(alt, 10) * 0.03 };
        return null;
    }},

    // --- 2-2 ---
    { name: 'CẦU-2-2', check: (s) => {
        if (s.length < 8) return null;
        const tail = s.slice(-6).join('');
        if (['TTXXTT','XXTTXX'].includes(tail)) return { code: flip(s[s.length-1]), conf: 0.72 };
        if (['TTXXTTXX','XXTTXXTT'].includes(s.slice(-8).join(''))) return { code: s[s.length-1], conf: 0.75 };
        return null;
    }},

    // --- 3-3 ---
    { name: 'CẦU-3-3', check: (s) => {
        if (s.length < 6) return null;
        const tail = s.slice(-6).join('');
        if (['TTTXXX','XXXTTT'].includes(tail)) return { code: flip(s[s.length-1]), conf: 0.78 };
        if (['TTTXXXTTT','XXXTTTXXX'].includes(s.slice(-9).join(''))) return { code: s[s.length-1], conf: 0.75 };
        return null;
    }},

    // --- 4-4 ---
    { name: 'CẦU-4-4', check: (s) => {
        if (s.length < 8) return null;
        const tail = s.slice(-8).join('');
        if (['TTTTXXXX','XXXXTTTT'].includes(tail)) return { code: flip(s[s.length-1]), conf: 0.82 };
        return null;
    }},

    // --- 1-2-1 ---
    { name: 'CẦU-1-2-1', check: (s) => {
        if (s.length < 5) return null;
        const tail = s.slice(-5).join('');
        if (tail === 'TXXTX') return { code: 'X', conf: 0.72 };
        if (tail === 'XTTXT') return { code: 'T', conf: 0.72 };
        if (s.slice(-6).join('') === 'TXXTXX') return { code: 'T', conf: 0.75 };
        if (s.slice(-6).join('') === 'XTTXTT') return { code: 'X', conf: 0.75 };
        return null;
    }},

    // --- 2-1-2 ---
    { name: 'CẦU-2-1-2', check: (s) => {
        if (s.length < 5) return null;
        const tail = s.slice(-5).join('');
        if (tail === 'TTXTT') return { code: 'T', conf: 0.72 };
        if (tail === 'XXTXX') return { code: 'X', conf: 0.72 };
        return null;
    }},

    // --- 1-3-1 ---
    { name: 'CẦU-1-3-1', check: (s) => {
        if (s.length < 5) return null;
        const tail = s.slice(-5).join('');
        if (tail === 'TXXXT') return { code: 'X', conf: 0.70 };
        if (tail === 'XTTTX') return { code: 'T', conf: 0.70 };
        return null;
    }},

    // --- 3-1-3 ---
    { name: 'CẦU-3-1-3', check: (s) => {
        if (s.length < 7) return null;
        const tail = s.slice(-7).join('');
        if (tail === 'TTT X TTT'.replace(/ /g,'')) return { code: 'T', conf: 0.74 };
        if (tail === 'XXX T XXX'.replace(/ /g,'')) return { code: 'X', conf: 0.74 };
        return null;
    }},

    // --- 2-3-2 ---
    { name: 'CẦU-2-3-2', check: (s) => {
        if (s.length < 7) return null;
        const t = s.slice(-7).join('');
        if (t === 'TTXXXTT') return { code: 'T', conf: 0.72 };
        if (t === 'XXTTTXX') return { code: 'X', conf: 0.72 };
        return null;
    }},

    // --- 3-2-3 ---
    { name: 'CẦU-3-2-3', check: (s) => {
        if (s.length < 8) return null;
        const t = s.slice(-8).join('');
        if (t === 'TTTXXTTT') return { code: 'T', conf: 0.74 };
        if (t === 'XXXTTXXX') return { code: 'X', conf: 0.74 };
        return null;
    }},

    // --- 1-4-1 ---
    { name: 'CẦU-1-4-1', check: (s) => {
        if (s.length < 6) return null;
        const t = s.slice(-6).join('');
        if (t === 'TXXXXT') return { code: 'X', conf: 0.72 };
        if (t === 'XTTTTX') return { code: 'T', conf: 0.72 };
        return null;
    }},

    // --- 4-2 / 2-4 ---
    { name: 'CẦU-4-2', check: (s) => {
        if (s.length < 6) return null;
        const t = s.slice(-6).join('');
        if (t === 'TTTTXX') return { code: 'X', conf: 0.76 };
        if (t === 'XXXXTT') return { code: 'T', conf: 0.76 };
        return null;
    }},
    { name: 'CẦU-2-4', check: (s) => {
        if (s.length < 6) return null;
        const t = s.slice(-6).join('');
        if (t === 'TTXXXX') return { code: 'X', conf: 0.76 };
        if (t === 'XXTTTT') return { code: 'T', conf: 0.76 };
        return null;
    }},

    // --- NGHIÊNG (block giảm dần) ---
    { name: 'CẦU-NGHIÊNG-GIẢM', check: (s, r) => {
        if (r.length < 3) return null;
        const [a, b, c] = r.slice(-3);
        if (a.len > b.len && b.len > c.len) return { code: flip(s[s.length-1]), conf: 0.70 };
        return null;
    }},
    { name: 'CẦU-NGHIÊNG-TĂNG', check: (s, r) => {
        if (r.length < 3) return null;
        const [a, b, c] = r.slice(-3);
        if (a.len < b.len && b.len < c.len) return { code: flip(s[s.length-1]), conf: 0.70 };
        return null;
    }},

    // --- SO LE (1-2-1-2...) ---
    { name: 'CẦU-SO-LE', check: (s, r) => {
        if (r.length < 4) return null;
        const sizes = r.slice(-4).map(b => b.len);
        if (sizes.every((x, i) => i % 2 === 0 ? x === sizes[0] : x === sizes[1]) && sizes[0] !== sizes[1]) {
            return { code: flip(s[s.length-1]), conf: 0.72 };
        }
        return null;
    }},

    // --- GỐI (block lớn kẹp block nhỏ) ---
    { name: 'CẦU-GỐI', check: (s, r) => {
        if (r.length < 3) return null;
        const [a, b, c] = r.slice(-3);
        if (a.len >= 3 && b.len === 1 && c.len >= 3) return { code: flip(s[s.length-1]), conf: 0.72 };
        return null;
    }},

    // --- ĐẢO (reversal sau bệt) ---
    { name: 'CẦU-ĐẢO', check: (s, r) => {
        if (r.length < 4) return null;
        const last = r[r.length-1];
        const prev = r[r.length-2];
        if (prev.len >= 3 && last.len <= 2) return { code: flip(s[s.length-1]), conf: 0.65 };
        return null;
    }},

    // --- NHẢY CÓC (block size nhảy cóc) ---
    { name: 'CẦU-NHẢY-CÓC', check: (s, r) => {
        if (r.length < 4) return null;
        const sizes = r.slice(-4).map(b => b.len);
        if (sizes[0] === sizes[2] && sizes[1] === sizes[3] && sizes[0] !== sizes[1]) {
            return { code: sizes[sizes.length-1] === sizes[1] ? flip(s[s.length-1]) : s[s.length-1], conf: 0.70 };
        }
        return null;
    }},

    // --- ZIC-ZAC (1-2-1-2-1) ---
    { name: 'CẦU-ZIC-ZAC', check: (s, r) => {
        if (r.length < 5) return null;
        const sizes = r.slice(-5).map(b => b.len);
        if (sizes[0] === 1 && sizes[1] === 2 && sizes[2] === 1 && sizes[3] === 2 && sizes[4] === 1) {
            return { code: flip(s[s.length-1]), conf: 0.74 };
        }
        return null;
    }},

    // --- BẺ (block cuối dài bất thường) ---
    { name: 'CẦU-BẺ', check: (s, r) => {
        if (r.length < 4) return null;
        const last = r[r.length-1];
        const prev3 = r.slice(-4, -1).map(b => b.len);
        const avg = prev3.reduce((a,b)=>a+b,0)/3;
        if (last.len >= avg * 2.5 && last.len >= 4) return { code: flip(s[s.length-1]), conf: 0.70 };
        return null;
    }},

    // --- XÓC ĐĨA (block 2 xen 1) ---
    { name: 'CẦU-XÓC-ĐĨA', check: (s, r) => {
        if (r.length < 5) return null;
        const sizes = r.slice(-5).map(b => b.len);
        const pattern = sizes.join('-');
        if (['2-1-2-1-2','1-2-1-2-1'].includes(pattern)) return { code: flip(s[s.length-1]), conf: 0.72 };
        return null;
    }},

    // --- ĐỐI XỨNG (mirror block) ---
    { name: 'CẦU-ĐỐI-XỨNG', check: (s, r) => {
        if (r.length < 4) return null;
        const sizes = r.slice(-4).map(b => b.len);
        if (sizes[0] === sizes[3] && sizes[1] === sizes[2] && sizes[0] !== sizes[1]) {
            return { code: flip(s[s.length-1]), conf: 0.73 };
        }
        return null;
    }},

    // --- LẶP KÉP (chu kỳ 2 block lặp) ---
    { name: 'CẦU-LẶP-KÉP', check: (s, r) => {
        if (r.length < 4) return null;
        const A = r.slice(-4, -2);
        const B = r.slice(-2);
        if (A[0].ch === B[0].ch && A[0].len === B[0].len && A[1].ch === B[1].ch && A[1].len === B[1].len) {
            return { code: A[0].ch, conf: 0.78 };
        }
        return null;
    }},

    // --- BẬC THANG ---
    { name: 'CẦU-BẬC-THANG', check: (s, r) => {
        if (r.length < 4) return null;
        const sizes = r.slice(-4).map(b => b.len);
        if ((sizes[0]+1 === sizes[1] && sizes[1]+1 === sizes[2] && sizes[2]+1 === sizes[3]) ||
            (sizes[0]-1 === sizes[1] && sizes[1]-1 === sizes[2] && sizes[2]-1 === sizes[3])) {
            return { code: flip(s[s.length-1]), conf: 0.68 };
        }
        return null;
    }},

    // --- TAM GIÁC (block tăng rồi giảm) ---
    { name: 'CẦU-TAM-GIÁC', check: (s, r) => {
        if (r.length < 5) return null;
        const sizes = r.slice(-5).map(b => b.len);
        if (sizes[0] < sizes[1] && sizes[1] < sizes[2] && sizes[2] > sizes[3] && sizes[3] > sizes[4]) {
            return { code: flip(s[s.length-1]), conf: 0.70 };
        }
        if (sizes[0] > sizes[1] && sizes[1] > sizes[2] && sizes[2] < sizes[3] && sizes[3] < sizes[4]) {
            return { code: flip(s[s.length-1]), conf: 0.70 };
        }
        return null;
    }},

    // --- MARKOV / LẶP CHUỖI ---
    { name: 'LẶP-CHUỖI-5', check: (s) => {
        if (s.length < 10) return null;
        if (s.slice(-10, -5).join('') === s.slice(-5).join('')) return { code: s[s.length-5], conf: 0.75 };
        return null;
    }},
    { name: 'LẶP-CHUỖI-6', check: (s) => {
        if (s.length < 12) return null;
        if (s.slice(-12, -6).join('') === s.slice(-6).join('')) return { code: s[s.length-6], conf: 0.75 };
        return null;
    }},
    { name: 'LẶP-CHUỖI-7', check: (s) => {
        if (s.length < 14) return null;
        if (s.slice(-14, -7).join('') === s.slice(-7).join('')) return { code: s[s.length-7], conf: 0.75 };
        return null;
    }},

    // --- HỖN HỢP ---
    { name: 'TTTX-REPEAT', check: (s) => {
        if (s.length < 8) return null;
        const t = s.slice(-8).join('');
        if (t === 'TTTXTTTX') return { code: 'T', conf: 0.78 };
        if (t === 'XXXTXXXT') return { code: 'X', conf: 0.78 };
        return null;
    }},
    { name: 'TTXX-TTXX-REPEAT', check: (s) => {
        if (s.length < 8) return null;
        const t = s.slice(-8).join('');
        if (t === 'TTXXTTXX') return { code: 'T', conf: 0.72 };
        if (t === 'XXTTXXTT') return { code: 'X', conf: 0.72 };
        return null;
    }},

    // --- ANTI-RATIO ---
    { name: 'ANTI-RATIO-10', check: (s) => {
        if (s.length < 10) return null;
        const t = s.slice(-10).filter(x => x === 'T').length;
        if (t >= 8) return { code: 'X', conf: 0.60 };
        if (t <= 2) return { code: 'T', conf: 0.60 };
        return null;
    }},

    // --- SUM-BASED (chỉ chạy khi có sums) ---
    { name: 'SUM-HIGH-REVERSAL', check: (s, r, sums) => {
        if (!sums || sums.length < 5) return null;
        const last5 = sums.slice(-5);
        const avg = last5.reduce((a,b)=>a+b,0)/5;
        if (avg >= 14) return { code: 'X', conf: 0.65 };
        return null;
    }},
    { name: 'SUM-LOW-REVERSAL', check: (s, r, sums) => {
        if (!sums || sums.length < 5) return null;
        const last5 = sums.slice(-5);
        const avg = last5.reduce((a,b)=>a+b,0)/5;
        if (avg <= 7) return { code: 'T', conf: 0.65 };
        return null;
    }},

    // --- BOUNDARY (sum 10-11 xuất hiện liên tiếp) ---
    { name: 'SUM-NEAR-BOUNDARY', check: (s, r, sums) => {
        if (!sums || sums.length < 3) return null;
        const last3 = sums.slice(-3);
        const near = last3.filter(x => x === 10 || x === 11).length;
        if (near >= 2) {
            const l = last3[last3.length-1];
            return { code: l === 10 ? 'X' : 'T', conf: 0.62 };
        }
        return null;
    }}
];

// ============================================================
// RUN FULL PATTERN LIBRARY
// ============================================================
function runPatternLibrary(seq, sums) {
    const r = rle(seq);
    const votes = [];
    for (const p of PATTERN_LIBRARY) {
        try {
            const res = p.check(seq, r, sums);
            if (res && res.code) votes.push({ name: p.name, code: res.code, weight: res.conf });
        } catch (e) {}
    }
    return votes;
}

// ============================================================
// REGIME DETECTION (giữ v4 nhưng tinh chỉnh)
// ============================================================
function detectRegime(seq) {
    if (!seq || seq.length < 8) return { name: 'COLD', confidence: 0.5 };
    const win = seq.slice(-Math.min(30, seq.length));
    const bs = blockStats(win);
    const ent = binaryEntropy(win);
    const r = rle(win);

    const last = win[win.length - 1];
    let streak = 1;
    for (let i = win.length - 2; i >= 0; i--) { if (win[i] === last) streak++; else break; }
    if (streak >= 4) return { name: 'PERSIST', confidence: Math.min(0.95, 0.6 + (streak - 3) * 0.08), streak, last };

    if (bs.mean <= 2.2 && r.length >= 6) {
        const shortRatio = r.filter(b => b.len === 1).length / r.length;
        if (shortRatio >= 0.45) return { name: 'ANTI-PERSIST', confidence: Math.min(0.90, 0.5 + shortRatio * 0.5), meanBlk: bs.mean, shortRatio };
    }

    let altRun = 0;
    for (let i = win.length - 1; i >= 1; i--) { if (win[i] !== win[i-1]) altRun++; else break; }
    if (altRun >= 4) return { name: 'ALTERNATE', confidence: Math.min(0.92, 0.5 + altRun * 0.06), altRun };

    if (r.length >= 3) {
        const last3 = r.slice(-3).map(b => b.len);
        if (last3[0] === last3[1] && last3[1] === last3[2]) return { name: 'BLOCK', confidence: 0.80, blockSize: last3[0], color: r[r.length-1].ch };
    }

    const tRatio = win.filter(x => x === 'T').length / win.length;
    if (tRatio >= 0.65 || tRatio <= 0.35) return { name: 'TREND', confidence: 0.65, tRatio };

    return { name: 'CHAOS', confidence: 0.40, entropy: ent, meanBlk: bs.mean };
}

// ============================================================
// BAYESIAN COMBINE — pattern library + regime prior
// ============================================================
function bayesianCombine(votes, db) {
    if (!votes.length) return { code: null, strength: 0.5, detail: [] };

    let logOddsT = 0;
    const detail = [];

    for (const v of votes) {
        // adaptive per-pattern win rate
        const ps = db.patternStats[v.name] || { win: 0, total: 0 };
        const wr = ps.total >= 3 ? ps.win / ps.total : 0.5;
        const adaptedConf = v.weight * (0.55 + wr * 0.9);
        const w = Math.max(0.2, adaptedConf);
        if (v.code === 'T') logOddsT += Math.log(w * 2);
        else logOddsT -= Math.log(w * 2);
        detail.push({ name: v.name, code: v.code, w: +adaptedConf.toFixed(3) });
    }

    const pT = 1 / (1 + Math.exp(-logOddsT));
    const code = pT >= 0.5 ? 'T' : 'X';
    const strength = Math.max(0.5, Math.min(0.95, 0.5 + Math.abs(pT - 0.5) * 0.9));

    // top 3 contributing patterns
    const top = detail.sort((a, b) => Math.abs(b.w - 0.5) - Math.abs(a.w - 0.5)).slice(0, 3);
    const topName = top.map(t => t.name).join('+');

    return { code, strength, pT, detail: top, label: topName };
}

// ============================================================
// META ADJUST — invert khi regime thua nặng
// ============================================================
function metaAdjust(pred, db, regimeName) {
    const rs = db.regimeStats[regimeName];
    if (rs && rs.total >= 10) {
        const wr = rs.correct / rs.total;
        if (wr < 0.35) return { ...pred, code: flip(pred.code), strength: 0.55, meta: `INVERT-${regimeName}-${(wr*100).toFixed(0)}%` };
        if (wr > 0.72) return { ...pred, strength: Math.min(0.95, pred.strength + 0.08), meta: `BOOST-${regimeName}-${(wr*100).toFixed(0)}%` };
    }
    return pred;
}

// ============================================================
// FULL PIPELINE
// ============================================================
function runEngine(seq, sums, db) {
    if (!seq || seq.length < 6) return { code: null, label: 'CHỜ', tiLe: 'CHỜ', detail: [], regime: 'COLD' };

    const regime = detectRegime(seq);
    const votes = runPatternLibrary(seq, sums);

    // Luôn có ít nhất 1 vote: nếu pattern library im → dùng regime fallback
    if (!votes.length) {
        // regime-based fallback
        const last = seq[seq.length-1];
        if (regime.name === 'PERSIST') {
            votes.push({ name: `PERSIST-FALLBACK-${regime.streak}`, code: regime.streak <= 6 ? last : flip(last), weight: 0.6 });
        } else if (regime.name === 'ALTERNATE') {
            votes.push({ name: 'ALT-FALLBACK', code: flip(last), weight: 0.6 });
        } else {
            const tRatio = seq.slice(-15).filter(x => x === 'T').length / Math.min(15, seq.length);
            votes.push({ name: 'ANTI-RATIO-FALLBACK', code: tRatio > 0.5 ? 'X' : 'T', weight: 0.55 });
        }
    }

    const combined = bayesianCombine(votes, db);
    const final = metaAdjust(combined, db, regime.name);

    return {
        code: final.code,
        label: final.meta || final.label || 'ENSEMBLE',
        tiLe: (final.strength * 100).toFixed(1) + '%',
        detail: final.detail,
        regime: regime.name,
        strength: final.strength,
        pT: final.pT,
        patternCount: votes.length
    };
}

// ============================================================
// UPDATE STATS
// ============================================================
function updateStats(db, pred, actual) {
    if (!pred || !pred.code) return;
    const correct = pred.code === actual;
    if (!db.meta) db.meta = { totalPred: 0, totalWin: 0, recent50: [] };
    db.meta.totalPred = (db.meta.totalPred || 0) + 1;
    if (correct) db.meta.totalWin = (db.meta.totalWin || 0) + 1;
    db.meta.recent50.push({ pred: pred.code, actual, correct, regime: pred.regime });
    if (db.meta.recent50.length > 50) db.meta.recent50.shift();

    const rName = pred.regime || 'CHAOS';
    if (!db.regimeStats[rName]) db.regimeStats[rName] = { correct: 0, total: 0 };
    db.regimeStats[rName].total++;
    if (correct) db.regimeStats[rName].correct++;

    if (!db.patternStats) db.patternStats = {};
    const pName = pred.label || 'UNKNOWN';
    const ps = db.patternStats[pName] || { win: 0, total: 0 };
    ps.total++;
    if (correct) ps.win++;
    if (ps.total > 50) { ps.win *= 0.95; ps.total *= 0.95; ps.win = Math.round(ps.win); ps.total = Math.round(ps.total); }
    db.patternStats[pName] = ps;
}

// ============================================================
// FETCH + LOOP
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
        <h2 style="color:green;">🚀 BACKEND v5 — 40+ PATTERN LIBRARY</h2>
        <p>Tổng cộng <b>${PATTERN_LIBRARY.length}</b> pattern matcher đang chạy.</p>
        <ul>
            <li><a href="/api/predict/md5">/api/predict/md5</a></li>
            <li><a href="/api/predict/taixiu">/api/predict/taixiu</a></li>
            <li><a href="/api/history/all">/api/history/all</a></li>
            <li><a href="/api/stats/md5">/api/stats/md5</a></li>
            <li><a href="/api/stats/taixiu">/api/stats/taixiu</a></li>
            <li><a href="/api/analyze?seq=TTTXTTTXTTT">/api/analyze — test engine</a></li>
            <li><a href="/api/patterns">/api/patterns — xem toàn bộ pattern library</a></li>
            <li><a href="/api/regime?seq=TXTXTXXTXT">/api/regime — regime hiện tại</a></li>
        </ul>
    </div>`);
});

app.get('/api/patterns', (req, res) => {
    res.json({ success: true, count: PATTERN_LIBRARY.length, patterns: PATTERN_LIBRARY.map(p => p.name) });
});

app.get('/api/analyze', (req, res) => {
    const seqStr = String(req.query.seq || '').toUpperCase().replace(/[^TX]/g, '');
    if (seqStr.length < 4) return res.status(400).json({ success: false, error: 'seq >= 4 ký tự' });
    const seq = seqStr.split('');
    const db = readDB('md5');
    const pred = runEngine(seq, [], db);
    // cũng chạy pattern library thô để debug
    const r = rle(seq);
    const rawVotes = runPatternLibrary(seq, []);
    res.json({
        success: true, seq: seqStr, length: seqStr.length, prediction: pred,
        detectedPatterns: rawVotes, rle: r.map(b => `${b.ch}${b.len}`)
    });
});

app.get('/api/regime', (req, res) => {
    const seqStr = String(req.query.seq || '').toUpperCase().replace(/[^TX]/g, '');
    if (seqStr.length < 4) return res.status(400).json({ success: false, error: 'seq >= 4 ký tự' });
    const seq = seqStr.split('');
    const regime = detectRegime(seq);
    const bs = blockStats(seq);
    res.json({ success: true, seq: seqStr, regime, blockStats: bs, entropy: +binaryEntropy(seq).toFixed(3), rle: rle(seq).map(b => `${b.ch}${b.len}`).join(',') });
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
        tiLe: pred.tiLe, reason: pred.label,
        regime: pred.regime, patternCount: pred.patternCount,
        detail: pred.detail
    });
});

app.get('/api/history/all', (req, res) => {
    const out = {};
    for (const g of ['md5', 'taixiu']) {
        const db = readDB(g);
        out[g] = { items: db.history.slice(-100).reverse().map(it => ({
            phien: it.phien, phienDuDoan: it.phienDuDoan, tong: it.tong, xucXac: it.xucXac,
            ketQua: it.ketQua, ketQuaLabel: it.ketQuaLabel,
            duDoanCode: it.DU_DOAN_CODE, duDoan: it.DU_DOAN, tiLe: it.TI_LE,
            pattern: { type: it.patternName }, regime: it.regime, trangThai: it.trangThai
        })) };
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
        totalPredicted: m.totalPred || 0, totalWin: m.totalWin || 0,
        winRate: wr, recent50WinRate: r50wr,
        regimeStats: db.regimeStats || {},
        patternStats: db.patternStats || {}
    });
});

// ============================================================
// UI
// ============================================================
app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (game !== 'md5' && game !== 'taixiu') return res.send('Trang không tồn tại');
    const db = readDB(game);
    const rows = db.history.slice(-50).reverse();
    const m = db.meta || {};
    const wr = m.totalPred ? (m.totalWin / m.totalPred * 100).toFixed(1) : '0.0';

    const getBadge = (type) => {
        if (!type) return 'badge-default';
        if (type.startsWith('PERSIST') || type.startsWith('BỆT')) return 'badge-bet';
        if (type.includes('ANTIPERSIST') || type.includes('ALT') || type.includes('1-1')) return 'badge-alt';
        if (type.includes('BLOCK') || type.includes('COMPOSITE') || type.includes('TTTX') || type.includes('2-2') || type.includes('3-3') || type.includes('4-4')) return 'badge-block';
        if (type.includes('CHAOS') || type.includes('MARKOV')) return 'badge-chaos';
        if (type.includes('INVERT') || type.includes('BOOST')) return 'badge-meta';
        if (type.includes('GỐI') || type.includes('ĐẢO') || type.includes('ZIC') || type.includes('SO-LE') || type.includes('XÓC')) return 'badge-alt';
        return 'badge-default';
    };

    const html = `<!DOCTYPE html><html lang="vi"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>HOANG VIP WIN v5</title>
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
      <div class="header"><h1>🎯 HOANG VIP WIN v5 - ${game.toUpperCase()}</h1></div>
      <div class="stats">
        <div class="stat">Tổng: <b>${m.totalPred || 0}</b></div>
        <div class="stat">Thắng: <b>${m.totalWin || 0}</b></div>
        <div class="stat">WinRate: <b>${wr}%</b></div>
        <div class="stat">Patterns: <b>${PATTERN_LIBRARY.length}</b></div>
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

app.listen(PORT, () => console.log(`Server v5 chạy trên port ${PORT} — ${PATTERN_LIBRARY.length} patterns`));
