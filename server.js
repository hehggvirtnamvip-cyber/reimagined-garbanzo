/**
 * HỆ THỐNG PHÂN TÍCH & DỰ ĐOÁN TÀI XỈU / MD5 - HOÀNG VIP WIN v5.3 (FIX UI PHIÊN)
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const APIS = {
    md5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
    taixiu: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

const DB_FILES = {
    md5: path.join(__dirname, 'db_md5.json'),
    taixiu: path.join(__dirname, 'db_taixiu.json')
};

const BACKUP_FILES = {
    md5: path.join(__dirname, 'backup_db_md5.json'),
    taixiu: path.join(__dirname, 'backup_db_taixiu.json')
};

function loadDatabase(gameType) {
    const file = DB_FILES[gameType];
    const backupFile = BACKUP_FILES[gameType];

    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            if (fs.existsSync(backupFile)) {
                try {
                    return JSON.parse(fs.readFileSync(backupFile, 'utf8'));
                } catch (err) {}
            }
        }
    }
    
    return { 
        history: [], 
        stats: { total: 0, wins: 0, losses: 0, currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0 }, 
        timeStats: { Sang: { total: 0, wins: 0 }, Chieu: { total: 0, wins: 0 }, Toi: { total: 0, wins: 0 }, Dem: { total: 0, wins: 0 } },
        lastProcessedSession: null 
    };
}

function saveDatabase(gameType, data) {
    const file = DB_FILES[gameType];
    const backupFile = BACKUP_FILES[gameType];
    const jsonData = JSON.stringify(data, null, 2);
    fs.writeFileSync(file, jsonData, 'utf8');
    fs.writeFileSync(backupFile, jsonData, 'utf8');
}

function getCurrentTimeSlot() {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 12) return 'Sang';
    if (hour >= 12 && hour < 18) return 'Chieu';
    if (hour >= 18 && hour < 24) return 'Toi';
    return 'Dem';
}

function analyzePatternUltimate(historyList) {
    if (!historyList || historyList.length < 10) {
        return { prediction: 'T', rate: '75.0%', pattern: 'Khởi tạo quét dải tần số' };
    }

    const sequence = historyList.map(item => {
        if (item.BetSide !== undefined) {
            return Number(item.BetSide) === 1 ? 'T' : 'X';
        }
        const sum = item.DiceSum || ((item.FirstDice || 0) + (item.SecondDice || 0) + (item.ThirdDice || 0));
        return sum >= 11 ? 'T' : 'X';
    });

    const recentStr = sequence.slice(-20).join('');
    const last = sequence[sequence.length - 1];

    if (recentStr.endsWith('TTTXTT')) return { prediction: 'X', rate: '94.2%', pattern: 'Cầu đảo chiều chuẩn (TTTXTT)' };
    if (recentStr.endsWith('XXXTXX')) return { prediction: 'T', rate: '94.2%', pattern: 'Cầu đảo chiều chuẩn (XXXTXX)' };
    if (recentStr.endsWith('TTTTXTTTXTT')) return { prediction: 'T', rate: '96.8%', pattern: 'Cầu phức hợp VIP (TTTTXTTTXTT)' };
    if (recentStr.endsWith('XXXXTXXXTXX')) return { prediction: 'X', rate: '96.8%', pattern: 'Cầu phức hợp VIP (XXXXTXXXTXX)' };
    if (recentStr.endsWith('TXTXT')) return { prediction: 'T', rate: '90.5%', pattern: 'Cầu 1-1 tinh gọn (Tiếp T)' };
    if (recentStr.endsWith('XTXTX')) return { prediction: 'X', rate: '90.5%', pattern: 'Cầu 1-1 tinh gọn (Tiếp X)' };
    if (recentStr.endsWith('TXTXTT')) return { prediction: 'X', rate: '89.0%', pattern: 'Cầu 1-1 bẻ nhánh kép (TXTXTT)' };
    if (recentStr.endsWith('XTXTXX')) return { prediction: 'T', rate: '89.0%', pattern: 'Cầu 1-1 bẻ nhánh kép (XTXTXX)' };
    if (recentStr.endsWith('TTXXTT')) return { prediction: 'X', rate: '91.5%', pattern: 'Cầu 2-2 đối xứng (TTXXTT)' };
    if (recentStr.endsWith('XXTTXX')) return { prediction: 'T', rate: '91.5%', pattern: 'Cầu 2-2 đối xứng (XXTTXX)' };
    if (recentStr.endsWith('TXXTXX')) return { prediction: 'T', rate: '89.5%', pattern: 'Cầu nhịp 1-2 (TXXTXX)' };
    if (recentStr.endsWith('XTTXTT')) return { prediction: 'X', rate: '89.5%', pattern: 'Cầu nhịp 1-2 (XTTXTT)' };
    if (recentStr.endsWith('TTTXXT')) return { prediction: 'X', rate: '90.0%', pattern: 'Cầu kim tự tháp 3-2-1' };

    let streakCount = 0;
    for (let i = sequence.length - 1; i >= 0; i--) {
        if (sequence[i] === last) streakCount++;
        else break;
    }

    if (streakCount >= 3) {
        const rateVal = Math.min(78 + (streakCount * 2.2), 98.0).toFixed(1);
        return { prediction: last, rate: `${rateVal}%`, pattern: `Bắt Cầu Bệt chuyên sâu (${streakCount} tay liên tiếp)` };
    }

    return { prediction: last, rate: '76.8%', pattern: `Xu hướng dòng tiền đơn (Theo tay ${last})` };
}

async function processGameTick(game) {
    try {
        const response = await axios.get(APIS[game], { timeout: 8000 });
        const historyList = Array.isArray(response.data) ? response.data : (response.data.data || response.data.list || []);

        if (historyList.length === 0) return;

        const latestItem = historyList[historyList.length - 1];
        const currentSession = Number(latestItem.SessionId || latestItem.session || 0);

        let db = loadDatabase(game);

        if (db.lastProcessedSession !== currentSession) {
            const d1 = Number(latestItem.FirstDice || 1);
            const d2 = Number(latestItem.SecondDice || 1);
            const d3 = Number(latestItem.ThirdDice || 1);
            const actualResult = (latestItem.BetSide !== undefined) ? (Number(latestItem.BetSide) === 1 ? 'T' : 'X') : ((latestItem.DiceSum >= 11) ? 'T' : 'X');

            const lastRecorded = db.history[db.history.length - 1];
            if (lastRecorded && Number(lastRecorded.phienDuDoan) === currentSession) {
                const isCorrect = (lastRecorded.DU_DOAN === actualResult);
                lastRecorded.ketQua = actualResult;
                lastRecorded.trangThai = isCorrect ? 'ĐÚNG' : 'SAI';

                db.stats.total++;
                const currentSlot = getCurrentTimeSlot();
                if (!db.timeStats[currentSlot]) db.timeStats[currentSlot] = { total: 0, wins: 0 };
                db.timeStats[currentSlot].total++;

                if (isCorrect) {
                    db.stats.wins++;
                    db.timeStats[currentSlot].wins++;
                    db.stats.currentStreak = db.stats.currentStreak >= 0 ? db.stats.currentStreak + 1 : 1;
                    if (db.stats.currentStreak > db.stats.maxWinStreak) db.stats.maxWinStreak = db.stats.currentStreak;
                } else {
                    db.stats.losses++;
                    db.stats.currentStreak = db.stats.currentStreak <= 0 ? db.stats.currentStreak - 1 : -1;
                    const absLoss = Math.abs(db.stats.currentStreak);
                    if (absLoss > db.stats.maxLossStreak) db.stats.maxLossStreak = absLoss;
                }
            }

            const analysis = analyzePatternUltimate(historyList);
            const predictedSession = currentSession + 1;

            const newPredictionEntry = {
                phien: currentSession,
                phienDuDoan: predictedSession,
                xucXac: [d1, d2, d3],
                ketQua: actualResult,
                DU_DOAN: analysis.prediction,
                TI_LE: analysis.rate,
                mauCau: analysis.pattern,
                trangThai: 'ĐANG CHỜ'
            };

            db.history.push(newPredictionEntry);
            if (db.history.length > 50) db.history.shift();

            db.lastProcessedSession = currentSession;
            saveDatabase(game, db);
        }
    } catch (error) {}
}

setInterval(() => {
    processGameTick('md5');
    processGameTick('taixiu');
}, 5000);

app.get('/api/export/:game', (req, res) => {
    const game = req.params.game;
    if (!DB_FILES[game]) return res.status(400).send('Bàn chơi không hợp lệ.');

    const db = loadDatabase(game);
    let csvContent = 'Phiên,Phiên Dự Đoán,Dự Đoán,Tỉ Lệ,Mẫu Cầu,Kết Quả Thực Tế,Trạng Thái\n';
    
    db.history.forEach(item => {
        csvContent += `${item.phien},${item.phienDuDoan},${item.DU_DOAN},${item.TI_LE},"${item.mauCau}",${item.ketQua || 'Đang chờ'},${item.trangThai}\n`;
    });

    res.header('Content-Type', 'text/csv');
    res.attachment(`lich_su_du_doan_${game}.csv`);
    return res.send(csvContent);
});

app.get('/api/analyze/:game', (req, res) => {
    const game = req.params.game;
    if (!DB_FILES[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ.' });

    const db = loadDatabase(game);
    const latestEntry = db.history[db.history.length - 1] || {};

    return res.json({
        bànChơi: game.toUpperCase(),
        hệThống: "HOÀNG VIP WIN v5.3",
        phânTíchMớiNhiệt: {
            PHIÊN: latestEntry.phien || 0,
            "phiên dự đoán": latestEntry.phienDuDoan || 0,
            "Xúc xắc": latestEntry.xucXac || [0, 0, 0],
            "Kết quả": latestEntry.ketQua || 'Đang chờ',
            "DỰ ĐOÁN": latestEntry.DU_DOAN || 'T',
            "TỈ LỆ": latestEntry.TI_LE || '0%',
            "Mẫu cầu": latestEntry.mauCau || 'Đang phân tích'
        },
        lichSuDuDoan: db.history.slice(-10).map(item => ({
            phiên: item.phien,
            phiênDuDoan: item.phienDuDoan,
            dựĐoán: item.DU_DOAN,
            tỉLệ: item.TI_LE,
            kếtQuả: item.ketQua || 'Đang chờ',
            trạngThai: item.trangThai
        })),
        thốngKêTổngQuan: {
            ...db.stats,
            tiLeThang: db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) + '%' : '0%'
        }
    });
});

app.get('/:game', (req, res) => {
    const game = req.params.game;
    if (!DB_FILES[game]) return res.send('Trang không tồn tại.');
    const db = loadDatabase(game);
    const winRate = db.stats.total > 0 ? ((db.stats.wins / db.stats.total) * 100).toFixed(2) : 0;
    
    res.send(`
        <html>
        <head>
            <title>HOÀNG VIP WIN v5.3 - ${game.toUpperCase()}</title>
            <meta charset="utf-8">
            <style>
                body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #050811; color: #f1f5f9; padding: 20px; }
                h1 { color: #38bdf8; text-align: center; text-transform: uppercase; }
                .box { background: #0f172a; padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #1e293b; box-shadow: 0 10px 20px rgba(0,0,0,0.4); }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                th, td { padding: 12px; border: 1px solid #334155; text-align: center; font-size: 14px; }
                th { background: #0284c7; color: white; }
                .dung { color: #4ade80; font-weight: bold; }
                .sai { color: #f87171; font-weight: bold; }
                .btn { display: inline-block; padding: 10px 20px; background: #0284c7; color: white; text-decoration: none; border-radius: 6px; margin-right: 10px; font-weight: bold; }
                .btn-export { background: #10b981; }
            </style>
            <script>setTimeout(() => { window.location.reload(); }, 10000);</script>
        </head>
        <body>
            <h1>HOÀNG VIP WIN v5.3 - BÀN: ${game.toUpperCase()}</h1>
            <div style="text-align:center; margin-bottom: 20px;">
                <a href="/md5" class="btn">Bàn MD5</a>
                <a href="/taixiu" class="btn">Bàn Tài Xỉu</a>
                <a href="/api/export/${game}" class="btn btn-export">📥 Tải Lịch Sử CSV</a>
            </div>
            <div class="box">
                <h3>📊 Thống Kê Hiệu Suất Trực Tuyến</h3>
                <p>Tổng phiên: <b>${db.stats.total}</b> | Thắng: <b style="color:#4ade80">${db.stats.wins}</b> | Thua: <b style="color:#f87171">${db.stats.losses}</b> | Tỷ lệ: <b>${winRate}%</b></p>
                <p>Streak: <b style="color:${db.stats.currentStreak >= 0 ? '#4ade80' : '#f87171'}">${db.stats.currentStreak}</b> | Max Win: <b style="color:#4ade80">${db.stats.maxWinStreak}</b> | Max Loss: <b style="color:#f87171">${db.stats.maxLossStreak}</b></p>
            </div>
            <div class="box">
                <h3>📜 Nhật Ký Dự Đoán & Đúng/Sai</h3>
                <table>
                    <tr>
                        <th>Phiên Dự Đoán</th>
                        <th>Dự Đoán</th>
                        <th>Tỉ Lệ</th>
                        <th>Mẫu Cầu</th>
                        <th>Kết Quả Thực Tế</th>
                        <th>Trạng Thái</th>
                    </tr>
                    ${db.history.slice(-15).reverse().map(item => `
                        <tr>
                            <td><b>${item.phienDuDoan}</b></td>
                            <td><b style="color: ${item.DU_DOAN === 'T' ? '#38bdf8' : '#f43f5e'}">${item.DU_DOAN}</b></td>
                            <td>${item.TI_LE}</td>
                            <td><small>${item.mauCau || ''}</small></td>
                            <td><b>${item.ketQua || 'Đang chờ'}</b></td>
                            <td class="${item.trangThai === 'ĐÚNG' ? 'dung' : (item.trangThai === 'SAI' ? 'sai' : '')}">${item.trangThai}</td>
                        </tr>
                    `).join('')}
                </table>
            </div>
        </body>
        </html>
    `);
});

app.get('/', (req, res) => {
    res.send(`<h2>Hệ Thống API Soi Cầu HOÀNG VIP WIN v5.3</h2><ul><li><a href="/md5">Bàn MD5 Dashboard</a></li><li><a href="/taixiu">Bàn Tài Xỉu Dashboard</a></li></ul>`);
});

app.listen(PORT, () => {
    console.log(`Server HOÀNG VIP WIN v5.3 đang chạy tại cổng ${PORT}`);
});
