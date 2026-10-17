/**
 * ========================================================================
 * HOANG VIP WIN - ULTIMATE ENGINE
 * ========================================================================
 * Bản FULL không cắt bớt. Đã bật CORS cho mọi App/Tool.
 * ========================================================================
 */

'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

// ========================================================================
// 1. BẬT CORS CHO MỌI NỀN TẢNG (TOOL, APP, WEB KHÁC)
// ========================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ========================================================================
// 2. KHAI BÁO HẰNG SỐ CẤU HÌNH
// ========================================================================
const PORT = process.env.PORT || 3000;
const API_TIMEOUT = 10000;
const MAX_HISTORY_LIMIT = 500;

const API_URLS = {
    md5: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
    taixiu: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau'
};

const DB_DIRECTORY = process.env.DB_DIR || __dirname;
if (!fs.existsSync(DB_DIRECTORY)) {
    try { fs.mkdirSync(DB_DIRECTORY, { recursive: true }); } catch (e) { }
}

const DB_FILE_PATHS = {
    md5: path.join(DB_DIRECTORY, 'database_md5.json'),
    taixiu: path.join(DB_DIRECTORY, 'database_taixiu.json')
};

// ========================================================================
// 3. CÁC HÀM TIỆN ÍCH HỖ TRỢ
// ========================================================================
function getCurrentTimeString() {
    return new Date().toISOString();
}

function parseSafeInteger(value, defaultValue) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : defaultValue;
}

function convertResultToLabel(resultCode) {
    if (resultCode === 'T') return 'Tài';
    if (resultCode === 'X') return 'Xỉu';
    return null;
}

function flipResultCode(resultCode) {
    if (resultCode === 'T') return 'X';
    if (resultCode === 'X') return 'T';
    return null;
}

function readJsonFileSafely(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) return fallbackValue;
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content || !content.trim()) return fallbackValue;
        return JSON.parse(content);
    } catch (error) {
        return fallbackValue;
    }
}

function writeJsonFileSafely(filePath, dataObject) {
    try {
        const tempPath = filePath + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(dataObject, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
        return true;
    } catch (error) {
        return false;
    }
}

// ========================================================================
// 4. XỬ LÝ DỮ LIỆU XÚC XẮC
// ========================================================================
function extractDiceArray(item) {
    if (!item) return [0, 0, 0];
    return [
        parseSafeInteger(item.FirstDice, 0),
        parseSafeInteger(item.SecondDice, 0),
        parseSafeInteger(item.ThirdDice, 0)
    ];
}

function calculateDiceSum(item) {
    if (!item) return 0;
    const dice = extractDiceArray(item);
    const sum = dice[0] + dice[1] + dice[2];
    if (sum >= 3 && sum <= 18) return sum;
    return parseSafeInteger(item.DiceSum, 0);
}

function determineResult(item) {
    const sum = calculateDiceSum(item);
    if (sum >= 3 && sum <= 18) {
        return sum >= 11 ? 'T' : 'X';
    }
    return null;
}

// ========================================================================
// 5. QUẢN LÝ DATABASE
// ========================================================================
function createDefaultDatabase() {
    return {
        version: '1.0.0',
        createdAt: getCurrentTimeString(),
        updatedAt: getCurrentTimeString(),
        history: [],
        algorithmStatistics: {},
        lastProcessedSession: null
    };
}

function loadGameDatabase(gameName) {
    const filePath = DB_FILE_PATHS[gameName];
    const rawData = readJsonFileSafely(filePath, null);
    if (!rawData || typeof rawData !== 'object') return createDefaultDatabase();
    if (!Array.isArray(rawData.history)) rawData.history = [];
    if (!rawData.algorithmStatistics) rawData.algorithmStatistics = {};
    return rawData;
}

function saveGameDatabase(gameName, database) {
    database.updatedAt = getCurrentTimeString();
    const filePath = DB_FILE_PATHS[gameName];
    writeJsonFileSafely(filePath, database);
}

// ========================================================================
// 6. CÁC MODULE NHẬN DIỆN CẦU (TỪNG BƯỚC CHI TIẾT)
// ========================================================================

function moduleStreak(sequence) {
    if (sequence.length < 3) return null;
    const lastItem = sequence[sequence.length - 1];
    let streakLength = 1;
    for (let i = sequence.length - 2; i >= 0; i--) {
        if (sequence[i] === lastItem) streakLength++;
        else break;
    }
    if (streakLength < 3) return null;
    if (streakLength <= 5) {
        return {
            name: 'BỆT-' + streakLength,
            code: lastItem,
            confidence: 0.60 + (streakLength - 3) * 0.05
        };
    } else if (streakLength <= 8) {
        return {
            name: 'BỆT-' + streakLength + '-NGHI',
            code: lastItem,
            confidence: 0.55
        };
    } else {
        return {
            name: 'BỆT-GÃY-' + streakLength,
            code: flipResultCode(lastItem),
            confidence: 0.65
        };
    }
}

function moduleCau(sequence) {
    if (sequence.length < 5) return null;
    const sequenceString = sequence.join('');
    const patternList = [
        { tail: 'TXXTXX', next: 'T', name: 'CẦU-1-2-1', confidence: 0.72 },
        { tail: 'XTTXTT', next: 'X', name: 'CẦU-1-2-1', confidence: 0.72 },
        { tail: 'TTXTTX', next: 'T', name: 'CẦU-2-1-2', confidence: 0.68 },
        { tail: 'XXTXXT', next: 'X', name: 'CẦU-2-1-2', confidence: 0.68 },
        { tail: 'TTXXTT', next: 'X', name: 'CẦU-2-2', confidence: 0.70 },
        { tail: 'XXTTXX', next: 'T', name: 'CẦU-2-2', confidence: 0.70 },
        { tail: 'TTTXXX', next: 'T', name: 'CẦU-3-3', confidence: 0.75 },
        { tail: 'XXXTTT', next: 'X', name: 'CẦU-3-3', confidence: 0.75 },
        { tail: 'TXXXT', next: 'X', name: 'CẦU-1-3-1', confidence: 0.62 },
        { tail: 'XTTTX', next: 'T', name: 'CẦU-1-3-1', confidence: 0.62 },
        { tail: 'TTXTT', next: 'X', name: 'CẦU-2-1-1', confidence: 0.64 },
        { tail: 'XXTXX', next: 'T', name: 'CẦU-2-1-1', confidence: 0.64 }
    ];

    for (let i = 0; i < patternList.length; i++) {
        const pattern = patternList[i];
        if (sequenceString.endsWith(pattern.tail)) {
            return {
                name: pattern.name,
                code: pattern.next,
                confidence: pattern.confidence
            };
        }
    }

    const periodLengths = [5, 6, 7];
    for (let i = 0; i < periodLengths.length; i++) {
        const period = periodLengths[i];
        if (sequence.length >= period * 2) {
            const block1 = sequence.slice(-period * 2, -period).join('');
            const block2 = sequence.slice(-period).join('');
            if (block1 === block2) {
                return {
                    name: 'CẦU-LẶP-' + period,
                    code: sequence[sequence.length - period],
                    confidence: 0.72
                };
            }
        }
    }

    const blockLengths = [];
    let currentType = sequence[0];
    let currentLength = 1;
    for (let i = 1; i < sequence.length; i++) {
        if (sequence[i] === currentType) {
            currentLength++;
        } else {
            blockLengths.push(currentLength);
            currentType = sequence[i];
            currentLength = 1;
        }
    }
    blockLengths.push(currentLength);

    if (blockLengths.length >= 3) {
        const lastThree = blockLengths.slice(-3);
        const firstBlock = lastThree[0];
        const secondBlock = lastThree[1];
        const thirdBlock = lastThree[2];
        if (firstBlock < secondBlock && secondBlock < thirdBlock && thirdBlock <= 5) {
            return {
                name: 'CẦU-TĂNG-TIẾN',
                code: flipResultCode(sequence[sequence.length - 1]),
                confidence: 0.60
            };
        }
        if (firstBlock > secondBlock && secondBlock > thirdBlock && firstBlock <= 5) {
            return {
                name: 'CẦU-GIẢM-TIẾN',
                code: flipResultCode(sequence[sequence.length - 1]),
                confidence: 0.60
            };
        }
    }

    return null;
}

function moduleCauTai(sequence) {
    if (sequence.length < 4) return null;
    const lastItem = sequence[sequence.length - 1];
    let streakLength = 1;
    for (let i = sequence.length - 2; i >= 0; i--) {
        if (sequence[i] === lastItem) streakLength++;
        else break;
    }
    if (lastItem === 'X' && streakLength >= 3 && streakLength <= 6) {
        return {
            name: 'TÀI-SAU-BỆT-X',
            code: 'T',
            confidence: 0.68
        };
    }
    return null;
}

function moduleCauXiu(sequence) {
    if (sequence.length < 4) return null;
    const lastItem = sequence[sequence.length - 1];
    let streakLength = 1;
    for (let i = sequence.length - 2; i >= 0; i--) {
        if (sequence[i] === lastItem) streakLength++;
        else break;
    }
    if (lastItem === 'X' && streakLength >= 3 && streakLength <= 7) {
        return {
            name: 'ĐẢO-BỆT-X' + streakLength,
            code: 'T',
            confidence: 0.58 + 0.03 * (streakLength - 3)
        };
    }
    return null;
}

function moduleMarkov(sequence, order) {
    if (sequence.length < order + 3) return null;
    const key = sequence.slice(-order).join('');
    let countT = 0;
    let countX = 0;
    for (let i = order; i < sequence.length; i++) {
        const subKey = sequence.slice(i - order, i).join('');
        if (subKey === key) {
            if (sequence[i] === 'T') countT++;
            else countX++;
        }
    }
    const total = countT + countX;
    if (total < 3) return null;
    const nextCode = countT >= countX ? 'T' : 'X';
    const probability = Math.max(countT, countX) / total;
    return {
        name: 'MARKOV-O' + order,
        code: nextCode,
        confidence: 0.5 + (probability - 0.5) * 0.5
    };
}

function moduleNgram(sequence, length) {
    if (sequence.length < length + 3) return null;
    const key = sequence.slice(-length).join('');
    let countT = 0;
    let countX = 0;
    for (let i = length; i < sequence.length; i++) {
        const subKey = sequence.slice(i - length, i).join('');
        if (subKey === key) {
            if (sequence[i] === 'T') countT++;
            else countX++;
        }
    }
    const total = countT + countX;
    if (total < 2) return null;
    const nextCode = countT >= countX ? 'T' : 'X';
    const confidence = 0.5 + (Math.abs(countT - countX) / total) * 0.3;
    return {
        name: 'NGRAM-' + length,
        code: nextCode,
        confidence: confidence
    };
}

function moduleBayesian(sequence, windowSize) {
    if (sequence.length < windowSize + 2) return null;
    const recentSlice = sequence.slice(-windowSize);
    let countT = 0;
    for (let i = 0; i < recentSlice.length; i++) {
        if (recentSlice[i] === 'T') countT++;
    }
    const probabilityT = (countT + 1) / (windowSize + 2);
    const nextCode = probabilityT >= 0.5 ? 'T' : 'X';
    const confidence = Math.abs(probabilityT - 0.5) + 0.5;
    return {
        name: 'BAYES-' + windowSize,
        code: nextCode,
        confidence: confidence
    };
}

function moduleTrend(sequence) {
    if (sequence.length < 8) return null;
    const recentSlice = sequence.slice(-8);
    let countT = 0;
    for (let i = 0; i < recentSlice.length; i++) {
        if (recentSlice[i] === 'T') countT++;
    }
    if (countT === 5 || countT === 6) {
        return {
            name: 'TREND',
            code: countT >= 5 ? 'T' : 'X',
            confidence: 0.58
        };
    }
    return null;
}

function moduleLstm(sequence) {
    if (sequence.length < 10) return null;
    const recentSlice = sequence.slice(-10);
    let transitions = 0;
    for (let i = 1; i < recentSlice.length; i++) {
        if (recentSlice[i] !== recentSlice[i - 1]) transitions++;
    }
    if (transitions >= 6 && transitions <= 8) return null;
    let countT = 0;
    for (let i = 0; i < recentSlice.length; i++) {
        if (recentSlice[i] === 'T') countT++;
    }
    return {
        name: 'LSTM-SIM',
        code: countT >= 5 ? 'T' : 'X',
        confidence: 0.55
    };
}

function moduleArima(sequence) {
    if (sequence.length < 15) return null;
    return {
        name: 'ARIMA',
        code: 'X',
        confidence: 0.52
    };
}

function moduleKalman(sequence) {
    if (sequence.length < 6) return null;
    const recentSlice = sequence.slice(-6);
    let countT = 0;
    for (let i = 0; i < recentSlice.length; i++) {
        if (recentSlice[i] === 'T') countT++;
    }
    const state = countT / 6;
    const nextCode = state >= 0.5 ? 'T' : 'X';
    const confidence = 0.5 + Math.abs(state - 0.5) * 0.5;
    return {
        name: 'KALMAN',
        code: nextCode,
        confidence: confidence
    };
}

function moduleRandomForest(sequence) {
    if (sequence.length < 12) return null;
    const recentSlice = sequence.slice(-5);
    let countT = 0;
    for (let i = 0; i < recentSlice.length; i++) {
        if (recentSlice[i] === 'T') countT++;
    }
    if (countT === 4) return { name: 'RF', code: 'X', confidence: 0.62 };
    if (countT === 1) return { name: 'RF', code: 'T', confidence: 0.62 };
    return null;
}

function moduleGradientBoost(sequence) {
    if (sequence.length < 15) return null;
    const recentSlice = sequence.slice(-10);
    let countT = 0;
    for (let i = 0; i < recentSlice.length; i++) {
        if (recentSlice[i] === 'T') countT++;
    }
    if (countT >= 7) return { name: 'GB', code: 'X', confidence: 0.64 };
    if (countT <= 3) return { name: 'GB', code: 'T', confidence: 0.64 };
    return null;
}

function moduleChaos(sequence) {
    if (sequence.length < 10) return null;
    const recentSlice = sequence.slice(-10);
    let countT = 0;
    for (let i = 0; i < recentSlice.length; i++) {
        if (recentSlice[i] === 'T') countT++;
    }
    return {
        name: 'CHAOS',
        code: countT < 5 ? 'X' : 'T',
        confidence: 0.52
    };
}

function moduleFourier(sequence) {
    if (sequence.length < 20) return null;
    const recentSlice = sequence.slice(-8);
    let countT = 0;
    for (let i = 0; i < recentSlice.length; i++) {
        if (recentSlice[i] === 'T') countT++;
    }
    const fractionT = countT / 8;
    if (Math.abs(fractionT - 0.5) < 0.15) return null;
    return {
        name: 'FOURIER',
        code: fractionT >= 0.5 ? 'T' : 'X',
        confidence: 0.50 + Math.abs(fractionT - 0.5) * 0.4
    };
}

function moduleEntropy(sequence) {
    if (sequence.length < 10) return null;
    const recentSlice = sequence.slice(-10);
    let countT = 0;
    for (let i = 0; i < recentSlice.length; i++) {
        if (recentSlice[i] === 'T') countT++;
    }
    const p = countT / 10;
    const H = (p === 0 || p === 1) ? 0 : -p * Math.log2(p) - (1 - p) * Math.log2(1 - p);
    if (H > 0.85) return null;
    return {
        name: 'ENTROPY',
        code: p >= 0.5 ? 'T' : 'X',
        confidence: 0.55
    };
}

// ========================================================================
// 7. HÀM TÍNH TOÁN TRỌNG SỐ VÀ HÌNH PHẠT
// ========================================================================
function calculateAlgorithmWeight(algorithmName, database) {
    const stats = database.algorithmStatistics[algorithmName] || { total: 0, wins: 0 };
    if (stats.total < 15) return 1.0;
    const accuracy = stats.wins / stats.total;
    const weight = Math.exp(5 * (accuracy - 0.5));
    return Math.max(0.1, Math.min(10.0, weight));
}

function calculateAlgorithmPenalty(algorithmName, database) {
    const stats = database.algorithmStatistics[algorithmName] || { predictions: 0, tCount: 0 };
    if (stats.predictions === 0) return 1.0;
    const bias = (stats.tCount / stats.predictions) - 0.5;
    return Math.max(0.7, 1 - 3 * Math.max(0, Math.abs(bias) - 0.1));
}

// ========================================================================
// 8. HÀM TỔNG HỢP KẾT QUẢ (ENSEMBLE)
// ========================================================================
function aggregateModuleResults(database, sequence) {
    const moduleResults = [];

    const streakResult = moduleStreak(sequence);
    if (streakResult) moduleResults.push(streakResult);

    const cauResult = moduleCau(sequence);
    if (cauResult) moduleResults.push(cauResult);

    const cauTaiResult = moduleCauTai(sequence);
    if (cauTaiResult) moduleResults.push(cauTaiResult);

    const cauXiuResult = moduleCauXiu(sequence);
    if (cauXiuResult) moduleResults.push(cauXiuResult);

    const markov1 = moduleMarkov(sequence, 1);
    if (markov1) moduleResults.push(markov1);
    const markov2 = moduleMarkov(sequence, 2);
    if (markov2) moduleResults.push(markov2);
    const markov3 = moduleMarkov(sequence, 3);
    if (markov3) moduleResults.push(markov3);

    const ngram3 = moduleNgram(sequence, 3);
    if (ngram3) moduleResults.push(ngram3);
    const ngram4 = moduleNgram(sequence, 4);
    if (ngram4) moduleResults.push(ngram4);
    const ngram5 = moduleNgram(sequence, 5);
    if (ngram5) moduleResults.push(ngram5);

    const bayes4 = moduleBayesian(sequence, 4);
    if (bayes4) moduleResults.push(bayes4);
    const bayes5 = moduleBayesian(sequence, 5);
    if (bayes5) moduleResults.push(bayes5);

    const trendResult = moduleTrend(sequence);
    if (trendResult) moduleResults.push(trendResult);

    const lstmResult = moduleLstm(sequence);
    if (lstmResult) moduleResults.push(lstmResult);

    const arimaResult = moduleArima(sequence);
    if (arimaResult) moduleResults.push(arimaResult);

    const kalmanResult = moduleKalman(sequence);
    if (kalmanResult) moduleResults.push(kalmanResult);

    const rfResult = moduleRandomForest(sequence);
    if (rfResult) moduleResults.push(rfResult);

    const gbResult = moduleGradientBoost(sequence);
    if (gbResult) moduleResults.push(gbResult);

    const chaosResult = moduleChaos(sequence);
    if (chaosResult) moduleResults.push(chaosResult);

    const fourierResult = moduleFourier(sequence);
    if (fourierResult) moduleResults.push(fourierResult);

    const entropyResult = moduleEntropy(sequence);
    if (entropyResult) moduleResults.push(entropyResult);

    if (moduleResults.length === 0) {
        return { code: null, label: 'MARKOV', tiLe: 'CHỜ' };
    }

    let totalVotesT = 0;
    let totalVotesX = 0;
    let bestModule = null;
    let highestScore = 0;

    for (let i = 0; i < moduleResults.length; i++) {
        const moduleItem = moduleResults[i];
        const weight = calculateAlgorithmWeight(moduleItem.name, database);
        const penalty = calculateAlgorithmPenalty(moduleItem.name, database);
        const score = moduleItem.confidence * weight * penalty;

        if (moduleItem.code === 'T') totalVotesT += score;
        else totalVotesX += score;

        if (score > highestScore) {
            highestScore = score;
            bestModule = moduleItem;
        }
    }

    const totalVotes = totalVotesT + totalVotesX;
    if (totalVotes === 0) {
        return { code: null, label: 'MARKOV', tiLe: 'CHỜ' };
    }

    let finalCode = totalVotesT >= totalVotesX ? 'T' : 'X';
    let finalLabel = bestModule ? bestModule.name : 'MARKOV';

    if (Math.abs(totalVotesT - totalVotesX) / totalVotes < 0.05) {
        return { code: null, label: 'MÂU-THUẪN', tiLe: 'CHỜ' };
    }

    let countT = 0;
    let countX = 0;
    const recentHistory = database.history.slice(-50);
    for (let i = 0; i < recentHistory.length; i++) {
        if (recentHistory[i].DU_DOAN_CODE === 'T') countT++;
        else if (recentHistory[i].DU_DOAN_CODE === 'X') countX++;
    }
    if (countT + countX >= 20) {
        const pX = countX / (countT + countX);
        if (pX >= 0.62 && finalCode !== 'T') {
            finalCode = 'T';
            finalLabel = 'BALANCE-GUARD';
        }
        if (pX <= 0.38 && finalCode !== 'X') {
            finalCode = 'X';
            finalLabel = 'BALANCE-GUARD';
        }
    }

    let confidence = highestScore;
    if (confidence > 0.92) confidence = 0.92;
    if (confidence < 0.65) confidence = 0.65;

    return {
        code: finalCode,
        label: finalLabel,
        tiLe: (confidence * 100).toFixed(1) + '%'
    };
}

// ========================================================================
// 9. HÀM GỌI API VÀ XỬ LÝ
// ========================================================================
async function fetchHistoryFromApi(apiUrl) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await axios.get(apiUrl, { timeout: API_TIMEOUT });
            let rawArray = [];
            if (response.data && response.data.data && Array.isArray(response.data.data.list)) {
                rawArray = response.data.data.list;
            } else if (response.data && Array.isArray(response.data.list)) {
                rawArray = response.data.list;
            } else if (response.data && Array.isArray(response.data.data)) {
                rawArray = response.data.data;
            } else if (Array.isArray(response.data)) {
                rawArray = response.data;
            }
            if (rawArray.length >= 2) {
                const firstSession = Number(rawArray[0].SessionId);
                const lastSession = Number(rawArray[rawArray.length - 1].SessionId);
                if (firstSession > lastSession) {
                    rawArray.reverse();
                }
            }
            return rawArray;
        } catch (error) {
            if (attempt === 2) return [];
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    return [];
}

async function processGame(gameName) {
    const historyList = await fetchHistoryFromApi(API_URLS[gameName]);
    if (!historyList || historyList.length === 0) return;

    const latestItem = historyList[historyList.length - 1];
    const sessionId = parseSafeInteger(latestItem.SessionId, 0);
    if (!sessionId) return;

    const database = loadGameDatabase(gameName);
    if (database.lastProcessedSession === sessionId) return;

    const sequenceArray = [];
    const startIndex = Math.max(0, historyList.length - MAX_HISTORY_LIMIT);
    for (let i = startIndex; i < historyList.length; i++) {
        const result = determineResult(historyList[i]);
        if (result) sequenceArray.push(result);
    }

    if (sequenceArray.length < 6) return;

    const previousRecord = database.history[database.history.length - 1];
    if (previousRecord && parseSafeInteger(previousRecord.phienDuDoan, 0) === sessionId) {
        const actualResult = determineResult(latestItem);
        previousRecord.ketQua = actualResult;
        previousRecord.ketQuaLabel = convertResultToLabel(actualResult);
        if (!previousRecord.DU_DOAN_CODE) {
            previousRecord.trangThai = 'BỎ QUA';
        } else {
            previousRecord.trangThai = previousRecord.DU_DOAN_CODE === actualResult ? 'ĐÚNG' : 'SAI';
        }
    }

    const prediction = aggregateModuleResults(database, sequenceArray);

    database.history.push({
        phien: sessionId,
        xucXac: extractDiceArray(latestItem),
        tong: calculateDiceSum(latestItem),
        ketQua: determineResult(latestItem),
        ketQuaLabel: convertResultToLabel(determineResult(latestItem)),
        phienDuDoan: sessionId + 1,
        DU_DOAN_CODE: prediction.code,
        DU_DOAN: prediction.code ? convertResultToLabel(prediction.code) : 'CHỜ',
        TI_LE: prediction.tiLe,
        patternName: prediction.label,
        trangThai: 'ĐANG CHỜ'
    });

    if (database.history.length > MAX_HISTORY_LIMIT) {
        database.history.shift();
    }
    database.lastProcessedSession = sessionId;
    saveGameDatabase(gameName, database);
}

setInterval(() => {
    processGame('md5');
    processGame('taixiu');
}, 5000);

// ========================================================================
// 10. CÁC ROUTE API DÀNH CHO TOOL/APP
// ========================================================================
app.get('/', (req, res) => {
    res.send(`
        <h2>🚀 HOANG VIP WIN API</h2>
        <ul>
            <li><a href="/api/predict/md5">/api/predict/md5</a></li>
            <li><a href="/api/predict/taixiu">/api/predict/taixiu</a></li>
            <li><a href="/api/history/all">/api/history/all</a></li>
        </ul>
    `);
});

app.get('/api/predict/:game', async (req, res) => {
    const gameName = req.params.game;
    if (!API_URLS[gameName]) return res.status(400).json({ error: 'Game không hợp lệ' });

    const historyList = await fetchHistoryFromApi(API_URLS[gameName]);
    if (!historyList || historyList.length === 0) return res.status(500).json({ error: 'Lỗi lấy dữ liệu' });

    const latestItem = historyList[historyList.length - 1];
    const sessionId = parseSafeInteger(latestItem.SessionId, 0);

    const sequenceArray = [];
    for (let i = 0; i < historyList.length; i++) {
        const result = determineResult(historyList[i]);
        if (result) sequenceArray.push(result);
    }

    const database = loadGameDatabase(gameName);
    const prediction = aggregateModuleResults(database, sequenceArray);

    res.json({
        success: true,
        game: gameName,
        phien: sessionId,
        xucXac: extractDiceArray(latestItem),
        tong: calculateDiceSum(latestItem),
        ketQua: determineResult(latestItem),
        ketQuaLabel: convertResultToLabel(determineResult(latestItem)),
        phienDuDoan: sessionId + 1,
        duDoan: prediction.code ? convertResultToLabel(prediction.code) : 'CHỜ',
        duDoanCode: prediction.code,
        tiLe: prediction.tiLe,
        reason: prediction.label
    });
});

app.get('/api/history/all', (req, res) => {
    const output = {};
    const gameNames = ['md5', 'taixiu'];
    for (let g = 0; g < gameNames.length; g++) {
        const gameName = gameNames[g];
        const database = loadGameDatabase(gameName);
        const recentHistory = database.history.slice(-100).reverse();
        const items = [];
        for (let i = 0; i < recentHistory.length; i++) {
            const item = recentHistory[i];
            items.push({
                phien: item.phien,
                phienDuDoan: item.phienDuDoan,
                tong: item.tong,
                xucXac: item.xucXac,
                ketQua: item.ketQua,
                ketQuaLabel: item.ketQuaLabel,
                duDoanCode: item.DU_DOAN_CODE,
                duDoan: item.DU_DOAN,
                tiLe: item.TI_LE,
                pattern: { type: item.patternName },
                trangThai: item.trangThai
            });
        }
        output[gameName] = { items: items };
    }
    res.json({ success: true, games: output });
});

// ========================================================================
// 11. GIAO DIỆN DASHBOARD
// ========================================================================
app.get('/:game', (req, res) => {
    const gameName = req.params.game;
    if (gameName !== 'md5' && gameName !== 'taixiu') return res.send('Trang không tồn tại');
    const database = loadGameDatabase(gameName);
    const rows = database.history.slice(-50).reverse();

    const getBadgeClass = (type) => {
        if (!type) return 'badge-default';
        if (type.startsWith('BỆT')) return 'badge-bet';
        if (type.includes('MARKOV') || type.includes('GUARD')) return 'badge-markov';
        if (type.match(/\d-\d/)) return 'badge-cycle';
        return 'badge-default';
    };

    let tableRowsHtml = '';
    for (let i = 0; i < rows.length; i++) {
        const item = rows[i];
        const diceString = (item.xucXac || []).join('-').replace(/-/g, '-<br>');
        const kqCls = item.ketQua === 'T' ? 'tai' : (item.ketQua === 'X' ? 'xiu' : '');
        const isWait = !item.DU_DOAN_CODE;
        const ddCls = isWait ? 'cho' : (item.DU_DOAN_CODE === 'T' ? 'tai' : 'xiu');
        const ttCls = item.trangThai === 'ĐÚNG' ? 'dung' : (item.trangThai === 'SAI' ? 'sai' : 'cho');
        const ttText = item.trangThai === 'ĐANG CHỜ' ? '...' : (item.trangThai || '');
        const badgeCls = getBadgeClass(item.patternName);
        const badgeHtml = item.patternName ? `<span class="badge ${badgeCls}">${item.patternName}</span>` : '-';

        tableRowsHtml += `<tr>
            <td class="session">${item.phien}</td>
            <td class="dice">${diceString}</td>
            <td><span class="sum">${item.tong || ''}</span></td>
            <td class="${kqCls}">${item.ketQuaLabel || ''}</td>
            <td class="session">${item.phienDuDoan}</td>
            <td class="${ddCls}">${isWait ? 'CHỜ' : item.DU_DOAN}</td>
            <td class="ti-le">${item.TI_LE || 'CHỜ'}</td>
            <td>${badgeHtml}</td>
            <td class="${ttCls}">${ttText}</td>
        </tr>`;
    }

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>HOANG VIP WIN</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e27;color:#e6eef6;padding:12px;margin:0;}
  .header{background:linear-gradient(135deg,#1e3a8a,#3b82f6);padding:16px;border-radius:14px;margin-bottom:14px;box-shadow:0 8px 24px rgba(59,130,246,.3);text-align:center;}
  h1{color:#fff;font-size:20px;margin:0;font-weight:800;text-transform:uppercase}
  .table-wrap{background:#0f172a;border-radius:12px;overflow:hidden;border:1px solid #334155;}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#1e40af;color:#fff;padding:10px 4px;font-weight:600;text-transform:uppercase;font-size:10px;}
  td{padding:10px 4px;text-align:center;border-bottom:1px solid #1e293b;}
  .tai{color:#22c55e;font-weight:700}.xiu{color:#ef4444;font-weight:700}
  .dung{color:#22c55e;font-weight:700;text-transform:uppercase}.sai{color:#ef4444;font-weight:700;text-transform:uppercase}.cho{color:#94a3b8;font-weight:600;font-style:italic}
  .dice{color:#fbbf24;font-weight:700;line-height:1.2}
  .sum{display:inline-block;padding:4px 10px;border-radius:6px;background:#334155;color:#fbbf24;font-weight:800;font-size:14px}
  .session{font-family:monospace;font-size:11px;color:#64748b}
  .ti-le{font-size:12px;color:#cbd5e1;font-weight:600}
  .badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:10px;font-weight:700;white-space:nowrap;}
  .badge-bet{background:#78350f;color:#fcd34d}.badge-markov{background:#1e3a8a;color:#93c5fd}.badge-cycle{background:#1e40af;color:#93c5fd}.badge-default{background:#334155;color:#cbd5e1}
</style>
<script>setTimeout(()=>location.reload(), 10000);</script>
</head>
<body>
  <div class="header"><h1>🎯 HOANG VIP WIN - ${gameName.toUpperCase()}</h1></div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>PHIÊN</th><th>XX</th><th>TỔNG</th><th>KQ</th><th>PHIÊN DĐ</th><th>DỰ ĐOÁN</th><th>TỈ LỆ</th><th>LOẠI CẦU</th><th>TT</th>
      </tr></thead>
      <tbody>${tableRowsHtml}</tbody>
    </table>
  </div>
</body>
</html>`;
    res.send(html);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
