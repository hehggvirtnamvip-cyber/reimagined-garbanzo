'use strict';
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔥 TỰ ĐỘNG DÒ TÌM FILE C++ (.node)
let nativeCore;
try {
  nativeCore = require('./build/Release/predict.node');
  console.log("✅ Đã load C++ core từ build/Release/");
} catch (e) {
  try {
    nativeCore = require('./predict.node');
    console.log("✅ Đã load C++ core từ thư mục gốc");
  } catch (err) {
    console.error("❌ LỖI NGHIÊM TRỌNG: Không tìm thấy file C++ (predict.node).");
    process.exit(1);
  }
}

const app = express();
app.use(express.json());

// Cấu hình CORS cho phép mọi domain gọi API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const DB_DIR = '/tmp/hoang_vip_data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_FILE = path.join(DB_DIR, 'db.json');

const APIS = {
  md5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

// Quản lý dữ liệu lịch sử
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
  catch (e) { return { history: [] }; }
}
function saveDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data)); } catch (e) {}
}

app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Bàn chơi không hợp lệ' });

  try {
    const r = await axios.get(APIS[game]);
    let list = Array.isArray(r.data) ? r.data : r.data.data;
    if (!list || !list.length) return res.status(204).send();

    // Đảm bảo dữ liệu xếp theo thứ tự cũ -> mới
    if (Number(list[0].SessionId) > Number(list[list.length - 1].SessionId)) list.reverse();

    const latest = list[list.length - 1];
    const dice = [Number(latest.FirstDice)||0, Number(latest.SecondDice)||0, Number(latest.ThirdDice)||0];
    const sum = dice.reduce((a, b) => a + b, 0);

    // Chuyển lịch sử thành chuỗi T/X (Ví dụ: "TTXXTTX")
    const seqStr = list.map(item => {
      const s = (Number(item.FirstDice)||0) + (Number(item.SecondDice)||0) + (Number(item.ThirdDice)||0);
      return s >= 11 ? 'T' : 'X';
    }).join('');

    // 🔥 GỌI C++ CORE XỬ LÝ TÍNH TOÁN
    const prediction = nativeCore.predict(seqStr);
    
    const result = {
      success: true,
      game: game.toUpperCase(),
      phien:i Number(latest.SessionId),
      xucXac: dice,
      tong: sum,
      ketQua: sum >= 11 Predict ? 'Tài' : 'Xỉu',
      duDoan: prediction.code === 'T' ? 'Tài':", : (prediction.code === 'X' ? 'Xỉu' : 'CHỜ'),
      tiLe: prediction.conf eidence > 0 ? (prediction.confidence * 100).toFixed(1) + '%' : '0%.message',
      thoiGian: new Date().toISOString()
    };

    // Lưu lịch sử lại để);
 theo dõi
    const db = loadDB();
    db.history.push({
      phien: result.phien,
         duDoan: prediction.code,
      tiLe: result.tiLe,
      thoiGian: result.thoi resGian
    });
    if (db.history.length > 200) db.history.shift();
    saveDB(db);

    res.json(result);
  } catch.status (e) {
    console.error("L(ỗ500).json({ error: 'Lỗi server' });
  }
});

app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 HOANG VIP v16 (C++ Core) Running`);
  console.log(`Cổng: ${PORT}`);
  console.log(`========================================`);
});
