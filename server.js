'use strict';

// language: JavaScript (Node.js >= 18), file: server.js
// *24 detectors + composite grammar parser + regime detection + adaptive ensemble*
// *patterns target: bệt dài (5-10), block-3/4, composite 2-block, palindrome, mixed*

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
    return { history: [], lastProcessedSession: null, patternStats: {}, meta: { totalPred: 0, totalWin: 0, recent50: [] } };
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
// RUN-LENGTH HELPERS
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

function blockSizes(seq) { return rle(seq).map(b => b.len); }

// ============================================================
// DETECTORS — 24 patterns
// Each returns { name, code, weight, tier } or null
// tier: 1=strong, 2=medium, 3=weak
// ============================================================

const detectors = {

    // ---------- TIER 1: STRONG STRUCTURAL ----------

    // 1. Bệt — streak đang chạy
    bet(seq) {
        const n = seq.length; if (n < 3) return null;
        const last = seq[n - 1];
        let len = 1;
        for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
        if (len < 3) return null;
        // Bệt 3-4: theo, 5-6: theo mạnh, 7-8: theo nhưng cảnh báo, 9+: gãy sớm
        if (len <= 4) return { name: `BỆT-${len}-THEO`, code: last, weight: 1.1 + (len - 3) * 0.20, tier: 1 };
        if (len <= 6) return { name: `BỆT-${len}-MẠNH`, code: last, weight: 1.6 + (len - 5) * 0.15, tier: 1 };
        if (len <= 8) return { name: `BỆT-${len}-RỦI`, code: last, weight: 1.2, tier: 2 };
        return { name: `BỆT-GÃY-${len}`, code: flip(last), weight: 1.7, tier: 1 };
    },

    // 2. Bệt dài 9+ → gãy (mean reversion mạnh)
    longStreak(seq) {
        const n = seq.length; if (n < 9) return null;
        const last = seq[n - 1];
        let len = 1;
        for (let i = n - 2; i >= 0; i--) { if (seq[i] === last) len++; else break; }
        if (len < 9) return null;
        return { name: `LONG-STREAK-${len}`, code: flip(last), weight: 1.9, tier: 1 };
    },

    // 3. Block-3 pattern (TTT XXX TTT XXX)
    block3(seq) {
        const n = seq.length; if (n < 6) return null;
        const r = rle(seq);
        if (r.length < 2) return null;
        const last = r[r.length - 1];
        const prev = r[r.length - 2];
        if (last.len !== 3 || prev.len !== 3) return null;
        // TTT XXX → next = T (repeating block-3)
        if (r.length >= 4) {
            const p2 = r[r.length - 3], p3 = r[r.length - 4];
            if (p2.len === 3 && p3.len === 3) {
                // full 3-3-3-3 detected, next should flip last
                return { name: 'BLOCK-3-REPEAT', code: flip(last.ch), weight: 1.5, tier: 1 };
            }
        }
        return { name: 'BLOCK-3', code: flip(last.ch), weight: 1.2, tier: 2 };
    },

    // 4. Block-4 pattern
    block4(seq) {
        const n = seq.length; if (n < 8) return null;
        const r = rle(seq);
        if (r.length < 2) return null;
        const last = r[r.length - 1];
        const prev = r[r.length - 2];
        if (last.len !== 4 || prev.len !== 4) return null;
        if (r.length >= 4) {
            const p2 = r[r.length - 3], p3 = r[r.length - 4];
            if (p2.len === 4 && p3.len === 4) {
                return { name: 'BLOCK-4-REPEAT', code: flip(last.ch), weight: 1.55, tier: 1 };
            }
        }
        return { name: 'BLOCK-4', code: flip(last.ch), weight: 1.15, tier: 2 };
    },

    // 5. Block-2 (2-2 repeating)
    block2(seq) {
        const n = seq.length; if (n < 8) return null;
        const r = rle(seq);
        if (r.length < 4) return null;
        const last4 = r.slice(-4);
        if (last4.every(b => b.len === 2)) {
            // 2-2-2-2 → next continues pattern
            return { name: 'BLOCK-2-REPEAT', code: flip(last4[3].ch), weight: 1.35, tier: 1 };
        }
        return null;
    },

    // ---------- TIER 1: COMPOSITE GRAMMAR ----------

    // 6. Composite: detect repeated block-group, predict next block
    // Handles cầu như "TTTXTTTX" (block TTT-X repeated) or "TTTXXTTTXX" 
    compositeGrammar(seq) {
        const n = seq.length; if (n < 8) return null;
        const r = rle(seq);
        if (r.length < 4) return null;

        // Thử grammar độ dài k block (k = 2, 3, 4): block-groups lặp lại
        for (const k of [2, 3, 4]) {
            if (r.length < k * 2) continue;
            const grpA = r.slice(-k * 2, -k);
            const grpB = r.slice(-k);
            // cùng chữ + cùng độ dài
            let match = true;
            for (let i = 0; i < k; i++) {
                if (grpA[i].ch !== grpB[i].ch || grpA[i].len !== grpB[i].len) { match = false; break; }
            }
            if (!match) continue;
            // Lặp được → predict block kế = grpA[0]? Không. Nếu chu kỳ 2*k block thì block kế = grpA[0]
            // nhưng thực tế nếu vừa hết grpB (=grpA), cycle tiếp = grpA[0]
            const nextCh = grpA[0].ch;
            return { name: `COMPOSITE-${k}`, code: nextCh, weight: 1.4 + k * 0.05, tier: 1 };
        }

        // Thử grammar "abab" (2 block repeating) — 4 block cuối có dạng A B A B
        if (r.length >= 4) {
            const [a, b, c, d] = r.slice(-4);
            if (a.ch === c.ch && a.len === c.len && b.ch === d.ch && b.len === d.len) {
                // next = a
                return { name: 'ABAB', code: a.ch, weight: 1.35, tier: 1 };
            }
        }
        return null;
    },

    // 7. Palindrome block — đối xứng block size
    palindromeBlock(seq) {
        const n = seq.length; if (n < 8) return null;
        const sizes = blockSizes(seq);
        if (sizes.length < 4) return null;
        const last4 = sizes.slice(-4);
        const [a, b, c, d] = last4;
        // 1-3-3-1, 2-3-3-2, 1-2-2-1, 3-1-1-3, ...
        if (a === d && b === c && a !== b) {
            return { name: `PALIN-BLK-${a}-${b}`, code: flip(seq[n - 1]), weight: 1.25, tier: 2 };
        }
        return null;
    },

    // 8. Mixed TTTXTTTX — pattern TTT-X-TTT-X (1-3-1-3 alternating)
    tttxRepeating(seq) {
        const n = seq.length; if (n < 8) return null;
        const s = seq.join('');
        // TTT-X-TTT-X = 8 chars, hoặc X-TTT-X-TTT
        const pats = [
            ['TTTXTTTX', 'T'], ['XXXTXXXT', 'X'],
            ['XTTTXTTT', 'X'], ['TXXXTXXX', 'T']
        ];
        for (const [tail, code] of pats) {
            if (s.endsWith(tail)) return { name: 'TTTX-REPEAT', code, weight: 1.55, tier: 1 };
        }
        return null;
    },

    // 9. TTTTXTTTXTT — 4T-X-3T-X-2T descending
    descendingBlocks(seq) {
        const n = seq.length; if (n < 10) return null;
        const sizes = blockSizes(seq);
        if (sizes.length < 4) return null;
        const last4 = sizes.slice(-4);
        // 4-3-3-2: nếu giảm dần, predict block nhỏ hơn
        const [a, b, c, d] = last4;
        if (a >= b && b >= c && c >= d && a > d + 1) {
            return { name: `DESC-BLK-${a}${b}${c}${d}`, code: flip(seq[n - 1]), weight: 1.15, tier: 2 };
        }
        if (a <= b && b <= c && c <= d && d > a + 1) {
            return { name: `ASC-BLK-${a}${b}${c}${d}`, code: flip(seq[n - 1]), weight: 1.15, tier: 2 };
        }
        return null;
    },

    // ---------- TIER 2: STANDARD PATTERNS ----------

    // 10. Alternate 1-1
    alt11(seq) {
        const n = seq.length; if (n < 6) return null;
        let alt = 0;
        for (let i = n - 1; i >= 1; i--) { if (seq[i] !== seq[i - 1]) alt++; else break; }
        if (alt < 5) return null;
        return { name: `ALT-1-1-${alt}`, code: flip(seq[n - 1]), weight: 1.1 + Math.min(alt, 12) * 0.04, tier: 2 };
    },

    // 11. Alternate 1-2-1
    pat121(seq) {
        const s = seq.join('');
        const pats = [
            ['TXXTXX', 'T'], ['XTTXTT', 'X'],
            ['TXTTXT', 'X'], ['XTXXTX', 'T'],
            ['TXXTXXTXX', 'T'], ['XTTXTTXTT', 'X']
        ];
        for (const [tail, code] of pats) {
            if (s.endsWith(tail)) return { name: 'CẦU-1-2-1', code, weight: 1.35, tier: 2 };
        }
        return null;
    },

    // 12. Alternate 2-2
    pat22(seq) {
        const s = seq.join('');
        const pats = [
            ['TTXXTT', 'X'], ['XXTTXX', 'T'],
            ['TTXXTTXX', 'T'], ['XXTTXXTT', 'X']
        ];
        for (const [tail, code] of pats) {
            if (s.endsWith(tail)) return { name: 'CẦU-2-2', code, weight: 1.3, tier: 2 };
        }
        return null;
    },

    // 13. Alternate 1-3-1
    pat131(seq) {
        const s = seq.join('');
        const pats = [
            ['TXXXT', 'X'], ['XTTTX', 'T'],
            ['TXXXTXXXT', 'X'], ['XTTTXTTTX', 'T']
        ];
        for (const [tail, code] of pats) {
            if (s.endsWith(tail)) return { name: 'CẦU-1-3-1', code, weight: 1.25, tier: 2 };
        }
        return null;
    },

    // 14. Cycle exact
    cycle(seq) {
        const n = seq.length;
        for (const l of [4, 5, 6, 7, 8, 9, 10]) {
            if (n < l * 2) continue;
            if (seq.slice(-l * 2, -l).join('') === seq.slice(-l).join('')) {
                return { name: `CYCLE-${l}`, code: seq[n - l], weight: 1.15 + l * 0.02, tier: 2 };
            }
        }
        return null;
    },

    // ---------- TIER 3: WEAK / FALLBACK ----------

    // 15. Markov bậc 2-5 ensemble
    markov(seq) {
        if (seq.length < 12) return null;
        let best = null;
        for (const order of [2, 3, 4, 5]) {
            if (seq.length < order + 5) continue;
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
            const w = conf * (order / 5) * 1.15;
            if (!best || w > best.weight) best = { name: `MARKOV-${order}`, code, weight: w, tier: 3, sample: tot };
        }
        return best;
    },

    // 16. Sum trend
    sumTrend(seq, sums) {
        if (!sums || sums.length < 6) return null;
        const last6 = sums.slice(-6);
        const avg = last6.reduce((a, b) => a + b, 0) / 6;
        const recent3 = last6.slice(-3).reduce((a, b) => a + b, 0) / 3;
        if (recent3 - avg > 3.5) return { name: 'SUM-CAO', code: 'T', weight: 1.0, tier: 3 };
        if (avg - recent3 > 3.5) return { name: 'SUM-THẤP', code: 'X', weight: 1.0, tier: 3 };
        return null;
    },

    // 17. Boundary sum (10/11 near threshold)
    boundary(seq, sums) {
        if (!sums || sums.length < 3) return null;
        const last3 = sums.slice(-3);
        const near = last3.filter(s => s === 10 || s === 11).length;
        if (near >= 2) {
            const lastSum = last3[last3.length - 1];
            return { name: `NEAR-BOUND-${lastSum}`, code: lastSum === 10 ? 'X' : 'T', weight: 0.95, tier: 3 };
        }
        return null;
    },

    // 18. Sum parity
    sumParity(sums) {
        if (!sums || sums.length < 6) return null;
        const last6 = sums.slice(-6);
        const even = last6.filter(s => s % 2 === 0).length;
        if (even >= 5) return { name: 'SUM-EVEN', code: 'X', weight: 0.85, tier: 3 };
        if (even <= 1) return { name: 'SUM-ODD', code: 'T', weight: 0.85, tier: 3 };
        return null;
    },

    // 19. Sum cluster (sum hay nổ quanh 10-11)
    sumCluster(sums) {
        if (!sums || sums.length < 8) return null;
        const recent = sums.slice(-8);
        const avg = recent.reduce((a, b) => a + b, 0) / 8;
        if (avg >= 13) return { name: 'SUM-HIGH-CLUSTER', code: 'X', weight: 0.9, tier: 3 };
        if (avg <= 7) return { name: 'SUM-LOW-CLUSTER', code: 'T', weight: 0.9, tier: 3 };
        return null;
    },

    // 20. Anti-ratio — fallback
    antiRatio(seq) {
        if (seq.length < 10) return null;
        const last10 = seq.slice(-10);
        const t = last10.filter(x => x === 'T').length;
        if (t >= 8) return { name: 'ANTI-T', code: 'X', weight: 0.75, tier: 3 };
        if (t <= 2) return { name: 'ANTI-X', code: 'T', weight: 0.75, tier: 3 };
        return null;
    },

    // 21. Reversal after long run
    reversal(seq) {
        const n = seq.length; if (n < 6) return null;
        const r = rle(seq);
        if (r.length < 3) return null;
        const [a, b, c] = r.slice(-3);
        // a-len > b-len < c-len — valley — next block should be short (b-len) → predict flip
        if (a.len >= 3 && b.len === 1 && c.len >= 3) {
            return { name: 'REVERSAL-VALLEY', code: flip(seq[n - 1]), weight: 1.1, tier: 2 };
        }
        // a-len < b-len > c-len — peak
        if (a.len === 1 && b.len >= 3 && c.len >= 3) {
            return { name: 'REVERSAL-PEAK', code: seq[n - 1], weight: 1.05, tier: 2 };
        }
        return null;
    },

    // 22. Transition matrix recent-window
    transitionRecent(seq) {
        const n = seq.length; if (n < 20) return null;
        const win = seq.slice(-20);
        let tt = 0, tx = 0, xt = 0, xx = 0;
        for (let i = 1; i < win.length; i++) {
            const a = win[i - 1], b = win[i];
            if (a === 'T' && b === 'T') tt++;
            else if (a === 'T' && b === 'X') tx++;
            else if (a === 'X' && b === 'T') xt++;
            else xx++;
        }
        const last = win[win.length - 1];
        let pT, pX;
        if (last === 'T') { pT = tt / (tt + tx || 1); pX = 1 - pT; }
        else { pT = xt / (xt + xx || 1); pX = 1 - pT; }
        if (Math.abs(pT - pX) < 0.15) return null;
        return { name: `TRANS-W20`, code: pT > pX ? 'T' : 'X', weight: 0.85 + Math.abs(pT - pX) * 0.8, tier: 3 };
    },

    // 23. Entropy — low entropy = predictable
    entropy(seq) {
        if (seq.length < 15) return null;
        const win = seq.slice(-15);
        const p = win.filter(x => x === 'T').length / 15;
        if (p === 0 || p === 1) return null;
        const H = -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
        if (H > 0.85) return null; // high entropy → skip
        // low entropy → predict majority
        return { name: `LOW-ENTROPY-${H.toFixed(2)}`, code: p > 0.5 ? 'T' : 'X', weight: 1.0, tier: 3 };
    },

    // 24. Symmetric — mirror half-window
    symmetric(seq) {
        const n = seq.length; if (n < 8) return null;
        const half = Math.min(6, Math.floor(n / 2));
        const L = seq.slice(-half * 2, -half);
        const R = seq.slice(-half);
        let match = 0;
        for (let i = 0; i < half; i++) if (L[i] === R[i]) match++;
        if (match >= half - 1 && match >= 4) {
            return { name: 'SYMMETRIC', code: flip(R[half - 1]), weight: 1.0, tier: 3 };
        }
        return null;
    }
};

// ============================================================
// AGGREGATE — weighted vote by tier
// ============================================================
function tierMultiplier(tier) {
    return tier === 1 ? 1.6 : tier === 2 ? 1.2 : 1.0;
}

function aggregateVotes(votes) {
    if (!votes.length) return null;
    let wT = 0, wX = 0;
    const detail = [];
    for (const v of votes) {
        if (!v || !v.code) continue;
        const w = (v.weight || 1.0) * tierMultiplier(v.tier || 3);
        if (v.code === 'T') wT += w; else wX += w;
        detail.push({ name: v.name, code: v.code, weight: +w.toFixed(3), tier: v.tier });
    }
    const total = wT + wX;
    if (total === 0) return null;
    return {
        code: wT >= wX ? 'T' : 'X',
        strength: Math.max(wT, wX) / total,
        detail,
        wT: +wT.toFixed(3),
        wX: +wX.toFixed(3)
    };
}

// ============================================================
// ADAPTIVE WEIGHT
// ============================================================
function adaptWeights(votes, db) {
    const stats = db.patternStats || {};
    return votes.map(v => {
        if (!v) return v;
        const s = stats[v.name];
        if (!s || s.total < 3) return v;
        const wr = s.win / s.total;
        const mult = 0.55 + wr * 1.1;
        const streakBonus = Math.max(-0.3, Math.min(0.4, (s.streak || 0) * 0.06));
        return { ...v, weight: Math.max(0.3, (v.weight || 1) * mult + streakBonus) };
    });
}

function updatePatternStats(db, patternName, wasCorrect) {
    if (!patternName || ['CHỜ', 'META', 'ENSEMBLE', 'GUARD', 'INVERT', 'BOOST'].some(x => patternName.includes(x))) return;
    if (!db.patternStats) db.patternStats = {};
    const s = db.patternStats[patternName] || { win: 0, total: 0, streak: 0 };
    s.total += 1;
    if (wasCorrect) { s.win += 1; s.streak = s.streak >= 0 ? s.streak + 1 : 1; }
    else { s.streak = s.streak <= 0 ? s.streak - 1 : -1; }
    if (s.total > 50) { s.win *= 0.95; s.total *= 0.95; s.win = Math.round(s.win); s.total = Math.round(s.total); }
    db.patternStats[patternName] = s;
}

// ============================================================
// BALANCE + META
// ============================================================
function balanceGuard(aggregated, db) {
    if (!aggregated) return aggregated;
    const r50 = db.meta?.recent50 || [];
    if (r50.length < 10) return aggregated;
    const predT = r50.filter(x => x.pred === 'T').length;
    const predX = r50.filter(x => x.pred === 'X').length;
    const tot = predT + predX;
    if (tot < 10) return aggregated;
    const pX = predX / tot;
    const devT = Math.max(0, pX - 0.60);
    const devX = Math.max(0, 0.40 - pX);
    if (devT > 0.02 && aggregated.code !== 'T') return { ...aggregated, code: 'T', strength: 0.70, guard: `BAL-T+${(devT * 100).toFixed(0)}` };
    if (devX > 0.02 && aggregated.code !== 'X') return { ...aggregated, code: 'X', strength: 0.70, guard: `BAL-X+${(devX * 100).toFixed(0)}` };
    return aggregated;
}

function metaPredictor(aggregated, db) {
    const r50 = (db.meta?.recent50 || []).slice(-20);
    if (r50.length < 8) return aggregated;
    const wr = r50.filter(x => x.correct).length / r50.length;
    if (wr < 0.40) return { ...aggregated, code: flip(aggregated.code), strength: 0.55, meta: `INVERT-${(wr * 100).toFixed(0)}%` };
    if (wr > 0.70) return { ...aggregated, strength: Math.min(0.95, aggregated.strength + 0.10), meta: `BOOST-${(wr * 100).toFixed(0)}%` };
    return aggregated;
}

// ============================================================
// ENGINE PIPELINE
// ============================================================
function runEngine(seq, sums, db) {
    if (!seq || seq.length < 4) return { code: null, label: 'CHỜ', tiLe: 'CHỜ', detail: [] };

    const raw = [];
    const push = fn => { const r = fn(); if (r) raw.push(r); };
    push(() => detectors.bet(seq));
    push(() => detectors.longStreak(seq));
    push(() => detectors.block3(seq));
    push(() => detectors.block4(seq));
    push(() => detectors.block2(seq));
    push(() => detectors.compositeGrammar(seq));
    push(() => detectors.palindromeBlock(seq));
    push(() => detectors.tttxRepeating(seq));
    push(() => detectors.descendingBlocks(seq));
    push(() => detectors.alt11(seq));
    push(() => detectors.pat121(seq));
    push(() => detectors.pat22(seq));
    push(() => detectors.pat131(seq));
    push(() => detectors.cycle(seq));
    push(() => detectors.markov(seq));
    push(() => detectors.sumTrend(seq, sums));
    push(() => detectors.boundary(seq, sums));
    push(() => detectors.sumParity(sums));
    push(() => detectors.sumCluster(sums));
    push(() => detectors.antiRatio(seq));
    push(() => detectors.reversal(seq));
    push(() => detectors.transitionRecent(seq));
    push(() => detectors.entropy(seq));
    push(() => detectors.symmetric(seq));

    const adapted = adaptWeights(raw, db);
    let agg = aggregateVotes(adapted);

    if (!agg) {
        const tRatio = seq.filter(x => x === 'T').length / seq.length;
        agg = { code: tRatio >= 0.5 ? 'X' : 'T', strength: 0.50, detail: [], fallback: 'ANTI-RATIO' };
    }

    const guarded = balanceGuard(agg, db);
    const final = metaPredictor(guarded, db);

    const conf = Math.max(0.50, Math.min(0.95, final.strength));
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

    if (!db.meta) db.meta = { totalPred: 0, totalWin: 0, recent50: [] };

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
        <h2 style="color:green;">🚀 BACKEND v3 — 24 DETECTORS</h2>
        <ul>
            <li><a href="/api/predict/md5">/api/predict/md5</a></li>
            <li><a href="/api/predict/taixiu">/api/predict/taixiu</a></li>
            <li><a href="/api/history/all">/api/history/all</a></li>
            <li><a href="/api/stats/md5">/api/stats/md5</a></li>
            <li><a href="/api/stats/taixiu">/api/stats/taixiu</a></li>
            <li><a href="/api/analyze?seq=TTTXTTTXTTT">/api/analyze — test engine với chuỗi bất kỳ</a></li>
        </ul>
    </div>`);
});

// Test engine với chuỗi tùy ý
app.get('/api/analyze', (req, res) => {
    const seqStr = String(req.query.seq || '').toUpperCase().replace(/[^TX]/g, '');
    if (seqStr.length < 4) return res.status(400).json({ success: false, error: 'seq phải >= 4 ký tự T/X' });
    const seq = seqStr.split('');
    const db = readDB('md5');
    const pred = runEngine(seq, [], db);
    res.json({ success: true, seq: seqStr, length: seqStr.length, prediction: pred });
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
        if (type.startsWith('BỆT') || type.startsWith('LONG-STREAK')) return 'badge-bet';
        if (type.includes('BLOCK') || type.includes('COMPOSITE') || type.includes('ABAB') || type.includes('PALIN')) return 'badge-block';
        if (type.includes('MARKOV') || type.includes('BAL-')) return 'badge-markov';
        if (type.includes('META') || type.includes('INVERT') || type.includes('BOOST')) return 'badge-meta';
        if (type.includes('CẦU-') || type.includes('CYCLE') || type.includes('TTTX')) return 'badge-cycle';
        return 'badge-default';
    };

    const html = `<!DOCTYPE html><html lang="vi"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>HOANG VIP WIN v3</title>
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
    .badge-bet{background:#78350f;color:#fcd34d}
    .badge-block{background:#14532d;color:#86efac}
    .badge-markov{background:#1e3a8a;color:#93c5fd}
    .badge-cycle{background:#1e40af;color:#93c5fd}
    .badge-default{background:#334155;color:#cbd5e1}
    .badge-meta{background:#7c2d12;color:#fed7aa}
    </style><script>setTimeout(()=>location.reload(),10000)</script></head>
    <body>
      <div class="header"><h1>🎯 HOANG VIP WIN v3 - ${game.toUpperCase()}</h1></div>
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

app.listen(PORT, () => console.log(`Server v3 chạy trên port ${PORT}`));
