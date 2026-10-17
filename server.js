'use strict';
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 🔥 GỌI C++ CORE (Nếu chưa compile sẽ báo lỗi)
let nativeCore;
try {
  nativeCore = require('./build/Release/predict.node');
} catch (e) {
  console.error('⚠️ Chưa compile C++! Hãy chạy "npm install" trước khi start.');
  process.exit(1);
}

const app = express();
app.use(require('cors')());

const PORT = process.env.PORT || 3000;
const DB_DIR = '/tmp/hoang_vip_data';
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_FILE = path.join(DB_DIR, 'db.json');

const APIS = {
  md5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
  taixiu: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

// Hàm lấy Data
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
  catch (e) { return { history: [] }; }
}
function saveDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data)); } catch (e) {}
}

app.get('/api/predict/:game', async (req, res) => {
  const game = req.params.game;
  if (!APIS[game]) return res.status(400).json({ error: 'Invalid game' });

  try {
    const r = await axios.get(APIS[game]);
    let list = Array.isArray(r.data) ? r.data : r.data.data;
    if (!list || !list.length) return res.status(204).send();

    // Đảo ngược nếu API trả mới nhất ở đầu
    if (Number(list[0].SessionId) > Number(list[list.length - 1].SessionId)) list.reverse();

    const latest = list[list.length - 1];
    const dice = [Number(latest.FirstDice)||0, Number(latest.SecondDice)||0, Number(latest.ThirdDice)||0];
    const sum = dice.reduce((a, b) => a + b, 0);
    const seqStr = list.map(item => {
      const s = (Number(item.FirstDice)||0) + (Number(item.SecondDice)||0) + (Number(item.ThirdDice)||0);
      return s >= 11 ? 'T' : 'X';
    }).join('');

    // Tính Bias động để truyền vào C++
    const db = loadDB();
    let cntT = 0, cntX = 0;
    db.history.slice(-50).forEach(h => {
      if (h.duDoan === 'T') cntT++;
      if (h.duDoan === 'X') cntX++;
    });
    const totalPreds = cntT + cntX || 1;
    const biasT = cntT / totalPreds;
    const biasX = cntX / totalPreds;

    // 🔥 GỌI C++ XỬ LÝ
    const prediction = nativeCore.predict(seqStr, biasT, biasX);
    
    const result = {
      phien: Number(latest.SessionId),
      xucXac: dice,
      tong: sum,
      duDoan: prediction.code === 'T' ? 'Tài' : (prediction.code === 'X' ? 'Xỉu' : 'CHỜ'),
      doTinCay: prediction.confidence > 0 ? (prediction.confidence * 100).toFixed(1) + '%' : '0%',
      meta: "Encrypted C++ Core"
    };

    // Lưu lịch sử
    db.history.push({
      phien: result.phien,
      ketQua: sum >= 11 ? 'T' : 'X',
      duDoan: prediction.code,
      doTinCay: result.doTinCay,
      thoiGian: new Date().toISOString()
    });
    if (db.history.length > 200) db.history.shift();
    saveDB(db);

    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ error: 'Server Error' });
  }
});

app.listen(PORT, () => console.log(`🔒 Server secured (C++ Core) on port ${PORT}`));
