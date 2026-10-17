'use strict';

// ============================================================================
// FILE: server.js
// MÔ TẢ: Hệ thống Bot Bán Key Telegram + Web API Kích Hoạt Key Tự Động
// TÁC GIẢ: HOANG VIP WIN
// PHIÊN BẢN: 14.0.0
// NGÔN NGỮ: JavaScript (Node.js >= 18)
// THƯ VIỆN: express, axios, ws, crypto, fs, path, http
// ============================================================================

// ============================================================================
// PHẦN 1: IMPORT CÁC THƯ VIỆN CẦN THIẾT
// ============================================================================
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// ============================================================================
// PHẦN 2: CẤU HÌNH HỆ THỐNG (CONFIG)
// ============================================================================
// Cổng chạy server (Render sẽ tự cấp phát qua biến môi trường PORT)
const PORT = process.env.PORT || 3000;

// Token của Telegram Bot (ĐÃ CẮM CỨNG THEO YÊU CẦU)
// CẢNH BÁO: Token này đã bị lộ, cần đổi mới sau khi test thành công.
const TELEGRAM_BOT_TOKEN = '8801717755:AAG_EpSnfyFXJDZfaEyT1L0XFrH3gtaJTHc';

// ID Telegram của Admin (ĐÃ CẮM CỨNG THEO YÊU CẦU)
const ADMIN_CHAT_ID = '7757046138';

// Đường dẫn thư mục lưu trữ dữ liệu
const DATA_DIRECTORY = path.join(__dirname, 'data');
const KEY_FILE_PATH = path.join(DATA_DIRECTORY, 'keys.json');

// Bảng giá các gói (Đơn vị: VNĐ)
const PRICE_LIST = {
    '1d': 10000,
    '7d': 50000,
    '30d': 150000
};

// Số lần nhập sai tối đa trước khi khóa vĩnh viễn
const MAXIMUM_FAIL_ATTEMPTS = 3;

// Khởi tạo thư mục dữ liệu nếu chưa tồn tại
if (!fs.existsSync(DATA_DIRECTORY)) {
    fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
}

// ============================================================================
// PHẦN 3: CÁC HÀM TIỆN ÍCH (UTILITIES)
// ============================================================================

/**
 * Ghi log ra console kèm theo mốc thời gian.
 * @param {string} level - Cấp độ log (INFO, ERROR, WARN)
 * @param {...any} args - Các tham số cần log
 */
function writeLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => {
        if (typeof arg === 'object') {
            return JSON.stringify(arg);
        }
        return String(arg);
    }).join(' ');
    
    const formattedLine = `[${timestamp}] [${level}] ${message}`;
    
    if (level === 'ERROR') {
        console.error(formattedLine);
    } else {
        console.log(formattedLine);
    }
}

/**
 * Đọc danh sách key từ file JSON.
 * @returns {Array} Mảng các đối tượng key
 */
function loadKeysFromFile() {
    try {
        if (fs.existsSync(KEY_FILE_PATH)) {
            const rawData = fs.readFileSync(KEY_FILE_PATH, 'utf8');
            return JSON.parse(rawData);
        }
    } catch (error) {
        writeLog('ERROR', 'Lỗi đọc file keys.json:', error.message);
    }
    return [];
}

/**
 * Lưu danh sách key vào file JSON.
 * @param {Array} keys - Mảng các đối tượng key
 */
function saveKeysToFile(keys) {
    try {
        fs.writeFileSync(KEY_FILE_PATH, JSON.stringify(keys, null, 2), 'utf8');
    } catch (error) {
        writeLog('ERROR', 'Lỗi ghi file keys.json:', error.message);
    }
}

/**
 * Sinh một key mới với định dạng HVW-XXXX-XXXX-XXXX.
 * @param {string} plan - Gói mua (1d, 7d, 30d)
 * @param {string} telegramId - ID Telegram của người mua
 * @returns {Object} Đối tượng key vừa tạo
 */
function generateNewKey(plan, telegramId) {
    // Sinh 6 byte ngẫu nhiên, chuyển thành chuỗi HEX in hoa
    const randomBytes = crypto.randomBytes(6).toString('hex').toUpperCase();
    
    // Cắt thành 3 khúc, mỗi khúc 4 ký tự
    const part1 = randomBytes.slice(0, 4);
    const part2 = randomBytes.slice(4, 8);
    const part3 = randomBytes.slice(8, 12);
    
    // Ghép thành key hoàn chỉnh
    const keyString = `HVW-${part1}-${part2}-${part3}`;
    
    // Tính thời gian hết hạn
    const currentTime = Date.now();
    const durations = {
        '1d': 1 * 24 * 60 * 60 * 1000,     // 1 ngày
        '7d': 7 * 24 * 60 * 60 * 1000,     // 7 ngày
        '30d': 30 * 24 * 60 * 60 * 1000    // 30 ngày
    };
    const durationMs = durations[plan] || durations['1d'];
    const expirationTime = currentTime + durationMs;
    
    // Tạo đối tượng record
    const keyRecord = {
        key: keyString,
        plan: plan,
        telegramId: telegramId,
        createdAt: currentTime,
        expiresAt: expirationTime,
        active: true,
        revoked: false,
        failAttempts: 0,
        lastFailAt: null,
        activatedAt: null,
        activatedBy: null,
        userInfo: null
    };
    
    // Lưu vào file
    const allKeys = loadKeysFromFile();
    allKeys.push(keyRecord);
    saveKeysToFile(allKeys);
    
    return keyRecord;
}

// ============================================================================
// PHẦN 4: CÁC HÀM TƯƠNG TÁC TELEGRAM API
// ============================================================================

/**
 * Gửi tin nhắn đến một chat ID trên Telegram.
 * @param {string|number} chatId - ID người nhận
 * @param {string} text - Nội dung tin nhắn (HTML)
 * @param {Object} options - Tùy chọn bổ sung (reply_markup, ...)
 */
async function sendTelegramMessage(chatId, text, options = {}) {
    if (!TELEGRAM_BOT_TOKEN) {
        writeLog('WARN', 'Chưa cấu hình TELEGRAM_BOT_TOKEN, không thể gửi tin nhắn.');
        return;
    }
    
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            ...options
        }, { timeout: 10000 });
    } catch (error) {
        writeLog('ERROR', 'Lỗi gửi tin nhắn Telegram:', error.message);
    }
}

/**
 * Lấy danh sách các bản cập nhật (updates) từ Telegram API.
 * @param {number} offset - ID của update cuối cùng đã xử lý
 * @returns {Array} Mảng các update mới
 */
async function getTelegramUpdates(offset = 0) {
    if (!TELEGRAM_BOT_TOKEN) return [];
    
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`;
        const response = await axios.get(url, {
            params: { offset: offset, timeout: 30 },
            timeout: 35000
        });
        return response.data.result || [];
    } catch (error) {
        return [];
    }
}

/**
 * Trả lời callback query (khi user bấm nút inline keyboard).
 * @param {string} callbackQueryId - ID của callback query
 */
async function answerCallbackQuery(callbackQueryId) {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
        await axios.post(url, { callback_query_id: callbackQueryId }, { timeout: 5000 });
    } catch (error) {
        writeLog('ERROR', 'Lỗi answerCallbackQuery:', error.message);
    }
}

// ============================================================================
// PHẦN 5: XỬ LÝ TIN NHẮN VÀ LỆNH TELEGRAM
// ============================================================================

// Map lưu trữ các đơn hàng đang chờ thanh toán: { chatId: { plan, price } }
const pendingOrdersMap = new Map();

/**
 * Xử lý tin nhắn văn bản gửi đến Bot (từ user thường).
 * @param {Object} message - Đối tượng message từ Telegram
 */
async function handleUserMessage(message) {
    const chatId = message.chat.id;
    const messageText = (message.text || '').trim();
    const senderInfo = message.from || {};
    
    // Lệnh /start hoặc /help
    if (messageText === '/start' || messageText === '/help') {
        const helpText = `🎯 <b>BOT BÁN KEY</b>\n\n` +
            `Các lệnh có sẵn:\n` +
            `/mua - Mua key mới\n` +
            `/key - Xem danh sách key đã mua\n` +
            `/huongdan - Hướng dẫn sử dụng\n\n` +
            `💡 <b>Bảng giá:</b>\n` +
            `• 1 Ngày: ${PRICE_LIST['1d'].toLocaleString()}đ\n` +
            `• 7 Ngày: ${PRICE_LIST['7d'].toLocaleString()}đ\n` +
            `• 30 Ngày: ${PRICE_LIST['30d'].toLocaleString()}đ`;
        
        return sendTelegramMessage(chatId, helpText);
    }
    
    // Lệnh /mua
    if (messageText === '/mua') {
        const inlineKeyboard = {
            inline_keyboard: [
                [{ text: `1 Ngày — ${PRICE_LIST['1d'].toLocaleString()}đ`, callback_data: 'buy_1d' }],
                [{ text: `7 Ngày — ${PRICE_LIST['7d'].toLocaleString()}đ`, callback_data: 'buy_7d' }],
                [{ text: `30 Ngày — ${PRICE_LIST['30d'].toLocaleString()}đ`, callback_data: 'buy_30d' }]
            ]
        };
        
        return sendTelegramMessage(chatId, '🛒 <b>Vui lòng chọn gói bạn muốn mua:</b>', {
            reply_markup: inlineKeyboard
        });
    }
    
    // Lệnh /key
    if (messageText === '/key') {
        const userKeys = loadKeysFromFile().filter(
            keyRecord => String(keyRecord.telegramId) === String(senderInfo.id)
        );
        
        if (userKeys.length === 0) {
            return sendTelegramMessage(chatId, '❌ Bạn chưa có key nào. Vui lòng dùng lệnh /mua để mua.');
        }
        
        let responseText = `🔑 <b>DANH SÁCH KEY CỦA BẠN</b>\n\n`;
        
        userKeys.forEach((keyRecord, index) => {
            const expirationDate = new Date(keyRecord.expiresAt).toLocaleString('vi-VN');
            
            let statusIcon = '🟢 HOẠT ĐỘNG';
            if (!keyRecord.active) {
                statusIcon = '🔴 ĐÃ BỊ KHÓA';
            } else if (keyRecord.revoked) {
                statusIcon = '🔴 BỊ THU HỒI';
            } else if (Date.now() > keyRecord.expiresAt) {
                statusIcon = '⚪ ĐÃ HẾT HẠN';
            }
            
            responseText += `<b>#${index + 1}</b> — ${statusIcon}\n`;
            responseText += `Mã: <code>${keyRecord.key}</code>\n`;
            responseText += `Hết hạn: ${expirationDate}\n`;
            responseText += `Số lần sai: ${keyRecord.failAttempts}/${MAXIMUM_FAIL_ATTEMPTS}\n\n`;
        });
        
        return sendTelegramMessage(chatId, responseText);
    }
    
    // Lệnh /huongdan
    if (messageText === '/huongdan') {
        const guideText = `📖 <b>HƯỚNG DẪN SỬ DỤNG</b>\n\n` +
            `1. Mua key qua lệnh /mua\n` +
            `2. Nhận key dạng HVW-XXXX-XXXX-XXXX\n` +
            `3. Truy cập website để nhập key\n` +
            `4. Nhập key và bấm "Kích hoạt"\n\n` +
            `⚠️ <b>Lưu ý:</b> Nhập sai 3 lần sẽ bị khóa vĩnh viễn, không hỗ trợ đổi key.`;
        
        return sendTelegramMessage(chatId, guideText);
    }
}

/**
 * Xử lý callback query (khi user bấm nút inline).
 * @param {Object} callbackQuery - Đối tượng callback từ Telegram
 */
async function handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const callbackData = callbackQuery.data;
    const senderInfo = callbackQuery.from;
    
    // Xử lý nút mua gói
    if (callbackData.startsWith('buy_')) {
        const selectedPlan = callbackData.replace('buy_', '');
        
        if (!PRICE_LIST[selectedPlan]) return;
        
        // Lưu đơn hàng vào map
        pendingOrdersMap.set(String(chatId), {
            plan: selectedPlan,
            price: PRICE_LIST[selectedPlan],
            createdAt: Date.now()
        });
        
        await answerCallbackQuery(callbackQuery.id);
        
        const orderText = `💳 <b>ĐƠN HÀNG</b>\n\n` +
            `Gói: <b>${selectedPlan}</b>\n` +
            `Giá: <b>${PRICE_LIST[selectedPlan].toLocaleString()}đ</b>\n\n` +
            `Vui lòng chuyển khoản và bấm "Đã thanh toán".`;
        
        const paymentKeyboard = {
            inline_keyboard: [
                [{ text: '✅ Đã thanh toán', callback_data: `paid_${selectedPlan}` }],
                [{ text: '❌ Hủy đơn', callback_data: 'cancel_order' }]
            ]
        };
        
        return sendTelegramMessage(chatId, orderText, { reply_markup: paymentKeyboard });
    }
    
    // Xử lý nút đã thanh toán
    if (callbackData.startsWith('paid_')) {
        const selectedPlan = callbackData.replace('paid_', '');
        const pendingOrder = pendingOrdersMap.get(String(chatId));
        
        if (!pendingOrder || pendingOrder.plan !== selectedPlan) {
            await answerCallbackQuery(callbackQuery.id);
            return sendTelegramMessage(chatId, '❌ Đơn hàng không tồn tại hoặc đã hết hạn. Vui lòng dùng /mua lại.');
        }
        
        // Gửi thông báo cho Admin
        const adminNotification = `💰 <b>YÊU CẦU DUYỆT ĐƠN</b>\n\n` +
            `👤 User: ${senderInfo.first_name || ''} (@${senderInfo.username || 'N/A'})\n` +
            `🆔 Chat ID: <code>${chatId}</code>\n` +
            `📦 Gói: <b>${selectedPlan}</b> — ${pendingOrder.price.toLocaleString()}đ\n` +
            `⏰ ${new Date().toLocaleString('vi-VN')}\n\n` +
            `Để duyệt, gõ lệnh:\n<code>/duyet ${chatId} ${selectedPlan}</code>`;
        
        if (ADMIN_CHAT_ID) {
            await sendTelegramMessage(ADMIN_CHAT_ID, adminNotification);
        }
        
        await answerCallbackQuery(callbackQuery.id);
        return sendTelegramMessage(chatId, '⏳ Đã gửi yêu cầu tới Admin. Vui lòng chờ duyệt.');
    }
    
    // Xử lý nút hủy đơn
    if (callbackData === 'cancel_order') {
        pendingOrdersMap.delete(String(chatId));
        await answerCallbackQuery(callbackQuery.id);
        return sendTelegramMessage(chatId, '❌ Đã hủy đơn hàng.');
    }
}

/**
 * Xử lý tin nhắn từ Admin (các lệnh quản trị).
 * @param {Object} message - Đối tượng message từ Telegram
 */
async function handleAdminMessage(message) {
    const chatId = message.chat.id;
    const messageText = (message.text || '').trim();
    
    // Chỉ Admin mới được phép
    if (String(chatId) !== String(ADMIN_CHAT_ID)) {
        return;
    }
    
    // Lệnh /duyet <chatId> <plan>
    if (messageText.startsWith('/duyet ')) {
        const commandParts = messageText.split(/\s+/);
        
        if (commandParts.length < 3) {
            return sendTelegramMessage(chatId, '⚠️ Cú pháp: /duyet <chatId> <plan>');
        }
        
        const targetChatId = commandParts[1];
        const selectedPlan = commandParts[2];
        
        if (!PRICE_LIST[selectedPlan]) {
            return sendTelegramMessage(chatId, '⚠️ Plan không hợp lệ. Chỉ chấp nhận: 1d, 7d, 30d.');
        }
        
        // Sinh key mới
        const newKeyRecord = generateNewKey(selectedPlan, targetChatId);
        const expirationDate = new Date(newKeyRecord.expiresAt).toLocaleString('vi-VN');
        
        // Gửi key cho Admin
        await sendTelegramMessage(chatId, 
            `✅ Đã tạo key cho user <code>${targetChatId}</code>\n` +
            `Mã: <code>${newKeyRecord.key}</code>`
        );
        
        // Gửi key cho User
        await sendTelegramMessage(targetChatId,
            `🎉 <b>ĐƠN HÀNG ĐÃ ĐƯỢC DUYỆT</b>\n\n` +
            `🔑 Key của bạn: <code>${newKeyRecord.key}</code>\n` +
            `📦 Gói: <b>${selectedPlan}</b>\n` +
            `📅 Hết hạn: ${expirationDate}\n\n` +
            `Vui lòng truy cập website để kích hoạt.`
        );
        
        // Xóa khỏi danh sách chờ
        pendingOrdersMap.delete(String(targetChatId));
    }
    
    // Lệnh /keys — xem tổng quan
    if (messageText === '/keys') {
        const allKeys = loadKeysFromFile();
        const activeCount = allKeys.filter(k => k.active && !k.revoked && Date.now() < k.expiresAt).length;
        const lockedCount = allKeys.filter(k => !k.active).length;
        const revokedCount = allKeys.filter(k => k.revoked).length;
        
        return sendTelegramMessage(chatId,
            `📊 <b>TỔNG QUAN HỆ THỐNG</b>\n\n` +
            `Tổng số key: <b>${allKeys.length}</b>\n` +
            `🟢 Đang hoạt động: <b>${activeCount}</b>\n` +
            `🔴 Đã khóa: <b>${lockedCount}</b>\n` +
            `⛔ Đã thu hồi: <b>${revokedCount}</b>`
        );
    }
    
    // Lệnh /revoke <key>
    if (messageText.startsWith('/revoke ')) {
        const keyToRevoke = messageText.replace('/revoke ', '').trim();
        const allKeys = loadKeysFromFile();
        const foundKey = allKeys.find(k => k.key === keyToRevoke);
        
        if (!foundKey) {
            return sendTelegramMessage(chatId, '❌ Không tìm thấy key này.');
        }
        
        foundKey.revoked = true;
        foundKey.active = false;
        saveKeysToFile(allKeys);
        
        return sendTelegramMessage(chatId, `✅ Đã thu hồi key: <code>${keyToRevoke}</code>`);
    }
}

// ============================================================================
// PHẦN 6: VÒNG LẶP LONG POLLING TELEGRAM
// ============================================================================

let telegramUpdateOffset = 0;

/**
 * Vòng lặp liên tục lấy cập nhật từ Telegram và xử lý.
 */
async function telegramPollingLoop() {
    if (!TELEGRAM_BOT_TOKEN) {
        writeLog('WARN', 'Không có TELEGRAM_BOT_TOKEN, bot không chạy.');
        return;
    }
    
    writeLog('INFO', 'Bắt đầu vòng lặp Telegram polling...');
    
    while (true) {
        try {
            const updates = await getTelegramUpdates(telegramUpdateOffset);
            
            for (const update of updates) {
                telegramUpdateOffset = update.update_id + 1;
                
                // Xử lý tin nhắn
                if (update.message) {
                    if (String(update.message.chat.id) === String(ADMIN_CHAT_ID)) {
                        await handleAdminMessage(update.message);
                    } else {
                        await handleUserMessage(update.message);
                    }
                }
                
                // Xử lý callback query
                if (update.callback_query) {
                    await handleCallbackQuery(update.callback_query);
                }
            }
        } catch (error) {
            writeLog('ERROR', 'Lỗi trong vòng lặp polling:', error.message);
        }
        
        // Nghỉ 1 giây trước khi lấy tiếp
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// ============================================================================
// PHẦN 7: EXPRESS SERVER & API KÍCH HOẠT
// ============================================================================

const expressApp = express();
const httpServer = http.createServer(expressApp);
const webSocketServer = new WebSocketServer({ server: httpServer, path: '/ws' });

// Middleware parse JSON
expressApp.use(express.json());

// Middleware CORS
expressApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    
    next();
});

/**
 * Lấy địa chỉ IP thật của client, xử lý qua proxy/Cloudflare.
 * @param {Object} req - Express request
 * @returns {string} Địa chỉ IP
 */
function extractRealIP(req) {
    const cfIP = req.headers['cf-connecting-ip'];
    const xForwardedFor = req.headers['x-forwarded-for'];
    
    if (cfIP) return cfIP;
    if (xForwardedFor) return xForwardedFor.split(',')[0].trim();
    return req.socket.remoteAddress || 'Unknown';
}

// ============================================================================
// API: KÍCH HOẠT KEY (TỰ ĐỘNG THU THẬP THÔNG TIN)
// ============================================================================
expressApp.post('/api/activate', async (req, res) => {
    const requestBody = req.body;
    const providedKey = requestBody.key;
    const deviceId = requestBody.deviceId;
    const userAgent = requestBody.userAgent;
    const screenResolution = requestBody.screen;
    const browserLanguage = requestBody.language;
    
    // Validate cơ bản
    if (!providedKey) {
        return res.status(400).json({
            success: false,
            error: 'Vui lòng cung cấp key.'
        });
    }
    
    // Chuẩn hóa key
    const normalizedKey = providedKey.trim().toUpperCase();
    
    // Tìm key trong DB
    const allKeys = loadKeysFromFile();
    const keyRecord = allKeys.find(k => k.key === normalizedKey);
    
    // Kiểm tra tồn tại
    if (!keyRecord) {
        return res.status(404).json({
            success: false,
            error: 'Key không tồn tại trên hệ thống.'
        });
    }
    
    // Kiểm tra đã bị thu hồi
    if (keyRecord.revoked) {
        return res.status(403).json({
            success: false,
            error: 'Key này đã bị thu hồi vĩnh viễn.'
        });
    }
    
    // Kiểm tra đã bị khóa (do sai 3 lần)
    if (!keyRecord.active) {
        return res.status(403).json({
            success: false,
            error: 'Key đã bị khóa do nhập sai quá 3 lần.'
        });
    }
    
    // Kiểm tra hết hạn
    if (Date.now() > keyRecord.expiresAt) {
        return res.status(403).json({
            success: false,
            error: 'Key đã hết hạn sử dụng.'
        });
    }
    
    // Lấy IP
    const clientIP = extractRealIP(req);
    
    // Kiểm tra thiết bị
    if (keyRecord.activatedBy && deviceId && keyRecord.activatedBy !== deviceId) {
        return res.status(403).json({
            success: false,
            error: 'Key này đã được kích hoạt trên thiết bị khác.'
        });
    }
    
    // Nếu đã kích hoạt đúng thiết bị này rồi -> trả về OK luôn
    if (keyRecord.activatedBy === deviceId) {
        return res.json({
            success: true,
            message: 'Key hợp lệ (đã kích hoạt trước đó).',
            expiresAt: keyRecord.expiresAt,
            plan: keyRecord.plan,
            remaining: Math.floor((keyRecord.expiresAt - Date.now()) / 86400000) + ' ngày'
        });
    }
    
    // Lần đầu kích hoạt -> Thu thập thông tin
    let geoLocation = 'Không xác định';
    let internetProvider = 'Không xác định';
    
    try {
        const geoApiUrl = `http://ip-api.com/json/${clientIP === '::1' ? '' : clientIP}`;
        const geoResponse = await axios.get(geoApiUrl, { timeout: 5000 });
        
        if (geoResponse.data && geoResponse.data.status === 'success') {
            const geoData = geoResponse.data;
            geoLocation = `${geoData.city || ''}, ${geoData.regionName || ''}, ${geoData.country || ''}`;
            internetProvider = geoData.isp || geoData.org || 'Không rõ';
        }
    } catch (error) {
        writeLog('ERROR', 'Lỗi lấy thông tin địa lý:', error.message);
    }
    
    // Cập nhật thông tin vào key
    keyRecord.activatedAt = Date.now();
    keyRecord.activatedBy = deviceId || 'unknown';
    keyRecord.userInfo = {
        ip: clientIP,
        location: geoLocation,
        isp: internetProvider,
        userAgent: userAgent,
        screen: screenResolution,
        language: browserLanguage,
        deviceId: deviceId
    };
    
    // Lưu file
    saveKeysToFile(allKeys);
    
    // Gửi thông báo cho Admin
    const adminNotification = `🚨 <b>KEY VỪA ĐƯỢC KÍCH HOẠT</b>\n\n` +
        `🔑 <b>Key:</b> <code>${keyRecord.key}</code>\n` +
        `📦 <b>Gói:</b> ${keyRecord.plan}\n` +
        `👤 <b>Telegram ID:</b> <code>${keyRecord.telegramId || 'Không rõ'}</code>\n\n` +
        `🌐 <b>IP:</b> <code>${clientIP}</code>\n` +
        `📍 <b>Vị trí:</b> ${geoLocation}\n` +
        `📡 <b>Nhà mạng:</b> ${internetProvider}\n\n` +
        `💻 <b>Thiết bị:</b> ${userAgent || 'Không rõ'}\n` +
        `📱 <b>Màn hình:</b> ${screenResolution || 'Không rõ'}\n` +
        `🌐 <b>Ngôn ngữ:</b> ${browserLanguage || 'Không rõ'}\n` +
        `🆔 <b>Mã thiết bị:</b> <code>${deviceId || 'Không rõ'}</code>\n\n` +
        `⏰ <b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}`;
    
    if (ADMIN_CHAT_ID) {
        await sendTelegramMessage(ADMIN_CHAT_ID, adminNotification);
    }
    
    return res.json({
        success: true,
        message: 'Kích hoạt thành công.',
        expiresAt: keyRecord.expiresAt,
        plan: keyRecord.plan,
        remaining: Math.floor((keyRecord.expiresAt - Date.now()) / 86400000) + ' ngày'
    });
});

// ============================================================================
// API: GHI NHẬN LẦN SAI KEY
// ============================================================================
expressApp.post('/api/fail', (req, res) => {
    const providedKey = (req.body.key || '').trim().toUpperCase();
    
    if (!providedKey) {
        return res.json({ success: false, message: 'Không có key.' });
    }
    
    const allKeys = loadKeysFromFile();
    const keyRecord = allKeys.find(k => k.key === providedKey);
    
    // Nếu key không tồn tại -> không có gì để tăng
    if (!keyRecord) {
        return res.json({ success: false, message: 'Key không tồn tại.' });
    }
    
    // Tăng số lần sai
    keyRecord.failAttempts = (keyRecord.failAttempts || 0) + 1;
    keyRecord.lastFailAt = Date.now();
    
    let isLockedNow = false;
    let responseMessage = `Sai lần ${keyRecord.failAttempts}/${MAXIMUM_FAIL_ATTEMPTS}.`;
    
    // Nếu đủ 3 lần -> KHÓA VĨNH VIỄN
    if (keyRecord.failAttempts >= MAXIMUM_FAIL_ATTEMPTS) {
        keyRecord.active = false;
        keyRecord.revoked = true;
        isLockedNow = true;
        responseMessage = 'Key đã bị khóa vĩnh viễn do sai quá 3 lần.';
        
        // Thông báo cho Admin
        if (ADMIN_CHAT_ID) {
            sendTelegramMessage(ADMIN_CHAT_ID,
                `⛔ <b>KEY BỊ KHÓA</b>\n\n` +
                `Key: <code>${keyRecord.key}</code>\n` +
                `User: <code>${keyRecord.telegramId || 'Không rõ'}</code>\n` +
                `Lý do: Nhập sai 3 lần liên tiếp.`
            );
        }
        
        // Thông báo cho User (nếu có Telegram ID)
        if (keyRecord.telegramId) {
            sendTelegramMessage(keyRecord.telegramId,
                `⛔ <b>KEY ĐÃ BỊ KHÓA</b>\n\n` +
                `Mã: <code>${keyRecord.key}</code>\n` +
                `Lý do: Nhập sai quá 3 lần.\n\n` +
                `<b>Không hỗ trợ đổi key.</b> Vui lòng mua key mới.`
            );
        }
    }
    
    saveKeysToFile(allKeys);
    
    return res.json({
        success: true,
        failAttempts: keyRecord.failAttempts,
        locked: isLockedNow,
        message: responseMessage
    });
});

// ============================================================================
// PHẦN 8: GIAO DIỆN WEB (HTML INLINE)
// ============================================================================

const WEB_INTERFACE_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kích Hoạt Key - HOANG VIP WIN</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0e27;
            color: #e6eef6;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            max-width: 440px;
            width: 100%;
            background: #0f172a;
            border: 1px solid #334155;
            border-radius: 16px;
            padding: 28px;
        }
        h1 {
            color: #fbbf24;
            text-align: center;
            font-size: 22px;
            margin-bottom: 24px;
        }
        label {
            display: block;
            font-size: 12px;
            color: #94a3b8;
            margin-bottom: 6px;
            margin-top: 14px;
        }
        input {
            width: 100%;
            padding: 14px;
            background: #020617;
            border: 2px solid #334155;
            border-radius: 10px;
            color: #fff;
            font-family: monospace;
            font-size: 16px;
            text-align: center;
            text-transform: uppercase;
            outline: none;
        }
        input:focus { border-color: #3b82f6; }
        button {
            width: 100%;
            padding: 14px;
            background: #1e40af;
            color: #fff;
            border: none;
            border-radius: 10px;
            font-weight: 700;
            font-size: 15px;
            cursor: pointer;
            margin-top: 20px;
        }
        button:hover { background: #2563eb; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .result {
            margin-top: 16px;
            padding: 14px;
            border-radius: 10px;
            font-size: 13px;
            line-height: 1.6;
            display: none;
        }
        .result.ok { display: block; background: #064e3b; color: #6ee7b7; border: 1px solid #10b981; }
        .result.err { display: block; background: #7f1d1d; color: #fca5a5; border: 1px solid #dc2626; }
        .result.warn { display: block; background: #78350f; color: #fcd34d; border: 1px solid #f59e0b; }
        .info {
            margin-top: 18px;
            padding: 12px;
            background: #020617;
            border-radius: 8px;
            font-size: 11px;
            color: #64748b;
            text-align: center;
            line-height: 1.6;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔑 KÍCH HOẠT KEY</h1>
        
        <label>Mã Key (Định dạng: HVW-XXXX-XXXX-XXXX)</label>
        <input id="keyInput" type="text" placeholder="HVW-XXXX-XXXX-XXXX" maxlength="18" autocomplete="off">
        
        <button id="activateButton" onclick="performActivation()">Kích Hoạt</button>
        
        <div id="resultBox" class="result"></div>
        
        <div class="info">
            Bằng việc bấm "Kích Hoạt", bạn đồng ý cho hệ thống tự động ghi nhận IP, thiết bị và vị trí để phục vụ bảo mật.
        </div>
    </div>
    
    <script>
        // Hàm lấy hoặc sinh Device ID duy nhất
        function getOrCreateDeviceId() {
            let existingId = localStorage.getItem('device_id');
            if (existingId) return existingId;
            
            const randomPart = Math.random().toString(36).slice(2);
            const timePart = Date.now().toString(36);
            const newId = 'dev_' + randomPart + timePart;
            
            localStorage.setItem('device_id', newId);
            return newId;
        }
        
        // Hàm chính xử lý kích hoạt
        async function performActivation() {
            const button = document.getElementById('activateButton');
            const input = document.getElementById('keyInput');
            const resultBox = document.getElementById('resultBox');
            
            const rawKey = input.value.trim();
            
            if (!rawKey) {
                resultBox.className = 'result err';
                resultBox.textContent = '❌ Vui lòng nhập Key.';
                return;
            }
            
            // Vô hiệu hóa nút trong lúc gọi API
            button.disabled = true;
            button.textContent = 'Đang xử lý...';
            resultBox.className = 'result';
            resultBox.style.display = 'none';
            
            try {
                const screenResolution = window.screen.width + 'x' + window.screen.height;
                const browserLang = navigator.language || 'unknown';
                
                const response = await fetch('/api/activate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        key: rawKey,
                        deviceId: getOrCreateDeviceId(),
                        userAgent: navigator.userAgent,
                        screen: screenResolution,
                        language: browserLang
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    resultBox.className = 'result ok';
                    resultBox.innerHTML = '✅ <b>KÍCH HOẠT THÀNH CÔNG!</b><br>' +
                        'Gói: ' + data.plan + '<br>' +
                        'Hết hạn: ' + new Date(data.expiresAt).toLocaleString('vi-VN') + '<br>' +
                        'Còn lại: ' + data.remaining;
                    
                    localStorage.setItem('activated_key', rawKey);
                } else {
                    // Gọi API để đếm số lần sai
                    const failResponse = await fetch('/api/fail', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ key: rawKey })
                    });
                    
                    const failData = await failResponse.json();
                    
                    if (failData.locked) {
                        resultBox.className = 'result err';
                        resultBox.innerHTML = '⛔ <b>KEY ĐÃ BỊ KHÓA VĨNH VIỄN</b><br>' + failData.message;
                    } else {
                        resultBox.className = 'result warn';
                        resultBox.innerHTML = '⚠️ ' + (data.error || 'Có lỗi xảy ra.') + '<br>' + (failData.message || '');
                    }
                }
            } catch (error) {
                resultBox.className = 'result err';
                resultBox.textContent = '❌ Lỗi kết nối: ' + error.message;
            } finally {
                button.disabled = false;
                button.textContent = 'Kích Hoạt';
            }
        }
        
        // Cho phép nhấn Enter để kích hoạt
        document.getElementById('keyInput').addEventListener('keypress', function(event) {
            if (event.key === 'Enter') {
                performActivation();
            }
        });
        
        // Tự động điền key đã lưu (nếu có)
        window.addEventListener('load', function() {
            const savedKey = localStorage.getItem('activated_key');
            if (savedKey) {
                document.getElementById('keyInput').value = savedKey;
            }
        });
    </script>
</body>
</html>`;

// Route chính trả về giao diện web
expressApp.get('/', (req, res) => {
    res.send(WEB_INTERFACE_HTML);
});

// Route health check (dùng cho Render hoặc monitoring)
expressApp.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ============================================================================
// PHẦN 9: KHỞI ĐỘNG SERVER VÀ BOT
// ============================================================================

httpServer.listen(PORT, () => {
    writeLog('INFO', `🚀 Server đang chạy trên cổng ${PORT}`);
    writeLog('INFO', `📡 Admin ID: ${ADMIN_CHAT_ID}`);
    writeLog('INFO', `🤖 Bot đang khởi động...`);
    
    // Bắt đầu vòng lặp polling
    telegramPollingLoop();
});

// Xử lý tắt server an toàn
process.on('SIGTERM', () => {
    writeLog('INFO', 'Nhận tín hiệu SIGTERM, đang tắt server...');
    httpServer.close(() => {
        writeLog('INFO', 'Server đã tắt.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    writeLog('INFO', 'Nhận tín hiệu SIGINT, đang tắt server...');
    httpServer.close(() => {
        writeLog('INFO', 'Server đã tắt.');
        process.exit(0);
    });
});
