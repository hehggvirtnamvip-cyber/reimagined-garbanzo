#include <node.h>
#include <v8.h>
#include <vector>
#include <string>
#include <cmath>
#include <map>
#include <algorithm>

using namespace v8;
using namespace std;

// Hàm Sigmoid
double sigmoid(double z) {
    if (z >= 0) { double e = exp(-z); return 1.0 / (1.0 + e); }
    else { double e = exp(z); return e / (1.0 + e); }
}

struct PredictResult {
    char code;
    double confidence;
};

// ================== CÁC THUẬT TOÁN ==================

PredictResult algoStreak(const vector<char>& seq) {
    int n = seq.size();
    if (n < 4) return {'N', 0};
    char last = seq[n - 1];
    int len = 1;
    for (int i = n - 2; i >= 0; i--) {
        if (seq[i] == last) len++;
        else break;
    }
    // FIX: Theo bệt đến 14, >=15 mới đoán gãy
    if (len >= 4 && len <= 14) return {last, 0.75 + min((len - 4) * 0.01, 0.10)};
    if (len >= 15) return {last == 'T' ? 'X' : 'T', 0.65};
    return {'N', 0};
}

PredictResult algoCau(const vector<char>& seq) {
    int n = seq.size();
    if (n < 4) return {'N', 0};
    char last = seq[n - 1];
    
    // Cầu 1-1
    int alt = 0;
    for (int i = n - 1; i >= 1; i--) {
        if (seq[i] != seq[i - 1]) alt++;
        else break;
    }
    if (alt >= 5) return {last == 'T' ? 'X' : 'T', min(0.62 + (alt - 5) * 0.04, 0.80)};

    // Cầu 2-2
    string p8 = "";
    for (int i = max(0, n - 8); i < n; i++) p8 += seq[i];
    if (p8 == "TTXXTTXX") return {'T', 0.75};
    if (p8 == "XXTTXXTT") return {'X', 0.75};

    // Cầu 3-3
    string p6 = "";
    for (int i = max(0, n - 6); i < n; i++) p6 += seq[i];
    if (p6 == "TTTXXX") return {'T', 0.72};
    if (p6 == "XXXTTT") return {'X', 0.72};

    return {'N', 0};
}

PredictResult algoCauTai(const vector<char>& seq) {
    int n = seq.size();
    if (n < 6) return {'N', 0};
    char last = seq[n - 1];
    if (last == 'T' && seq[n-2] == 'X' && seq[n-3] == 'X' && seq[n-4] == 'X') return {'T', 0.68};
    
    int streak = 1;
    for (int i = n - 2; i >= 0; i--) { if (seq[i] == last) streak++; else break; }
    if (last == 'X' && streak >= 3 && streak <= 5) return {'T', 0.58 + min((streak - 3) * 0.03, 0.08)};
    
    return {'N', 0};
}

PredictResult algoCauXiu(const vector<char>& seq) {
    int n = seq.size();
    if (n < 6) return {'N', 0};
    char last = seq[n - 1];
    if (last == 'X' && seq[n-2] == 'T' && seq[n-3] == 'T' && seq[n-4] == 'T') return {'X', 0.68};
    
    int streak = 1;
    for (int i = n - 2; i >= 0; i--) { if (seq[i] == last) streak++; else break; }
    if (last == 'T' && streak >= 3 && streak <= 5) return {'X', 0.58 + min((streak - 3) * 0.03, 0.08)};
    
    return {'N', 0};
}

PredictResult algoMarkov(const vector<char>& seq) {
    int n = seq.size();
    if (n < 10) return {'N', 0};
    for (int order = 5; order >= 1; order--) {
        if (n <= order) continue;
        string ctx = "";
        for (int i = n - order; i < n; i++) ctx += seq[i];
        int countT = 0, countX = 0;
        for (int i = 0; i <= n - order - 1; i++) {
            bool match = true;
            for (int j = 0; j < order; j++) if (seq[i+j] != ctx[j]) { match = false; break; }
            if (match) { if (seq[i + order] == 'T') countT++; else countX++; }
        }
        int total = countT + countX;
        if (total < 3) continue;
        double pT = (countT + 1.0) / (total + 2.0);
        double conf = abs(pT - 0.5) * 2;
        if (conf < 0.15) continue;
        return {pT >= 0.5 ? 'T' : 'X', min(0.5 + conf * 0.30, 0.75)};
    }
    return {'N', 0};
}

PredictResult algoNgram(const vector<char>& seq) {
    int n = seq.size();
    if (n < 30) return {'N', 0};
    for (int len = 7; len >= 3; len--) {
        if (n <= len) continue;
        string ctx = "";
        for (int i = n - len; i < n; i++) ctx += seq[i];
        int countT = 0, countX = 0;
        for (int i = 0; i <= n - len - 1; i++) {
            bool match = true;
            for (int j = 0; j < len; j++) if (seq[i+j] != ctx[j]) { match = false; break; }
            if (match) { if (seq[i + len] == 'T') countT++; else countX++; }
        }
        int total = countT + countX;
        if (total < 3) continue;
        double pT = (countT + 1.0) / (total + 2.0);
        double conf = abs(pT - 0.5) * 2;
        if (conf < 0.2) continue;
        return {pT >= 0.5 ? 'T' : 'X', min(0.5 + conf * 0.35, 0.78)};
    }
    return {'N', 0};
}

// ================== HÀM TỔNG HỢP ENSEMBLE ==================
PredictResult computeEnsemble(const vector<char>& seq, double currentBiasT, double currentBiasX) {
    struct AlgoResult { char c; double f; };
    vector<AlgoResult> results = {
        algoStreak(seq), algoCau(seq), algoCauTai(seq), algoCauXiu(seq),
        algoMarkov(seq), algoNgram(seq)
    };

    double voteT = 0.0, voteX = 0.0;
    
    // Phân tích Bias của phiên hiện tại (JS truyền vào)
    double biasPenaltyT = max(0.7, 1.0 - 3.0 * max(0.0, currentBiasT - 0.1));
    double biasPenaltyX = max(0.7, 1.0 - 3.0 * max(0.0, currentBiasX - 0.1));

    for (const auto& r : results) {
        if (r.c == 'N') continue;
        if (r.c == 'T') voteT += r.f * biasPenaltyT;
        else voteX += r.f * biasPenaltyX;
    }

    double total = voteT + voteX;
    if (total < 0.1) return {'N', 0};

    double pT = voteT / total;
    double conf = abs(pT - 0.5) * 2;
    if (conf < 0.10) return {'N', 0};

    return {pT >= 0.5 ? 'T' : 'X', min(0.55 + conf * 0.30, 0.82)};
}

// ================== BINDING NODE.JS ==================
void Predict(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();

    if (args.Length() < 3 || !args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8(isolate, "Sai tham số").ToLocalChecked()));
        return;
    }

    String::Utf8Value utf8(isolate, args[0]);
    string seqStr(*utf8);
    vector<char> seq(seqStr.begin(), seqStr.end());

    double biasT = args[1]->NumberValue(context).FromMaybe(0.5);
    double biasX = args[2]->NumberValue(context).FromMaybe(0.5);

    PredictResult result = computeEnsemble(seq, biasT, biasX);

    Local<Object> obj = Object::New(isolate);
    string codeStr = (result.code == 'N') ? "NONE" : string(1, result.code);
    
    obj->Set(context, String::NewFromUtf8(isolate, "code").ToLocalChecked(),
        String::NewFromUtf8(isolate, codeStr.c_str()).ToLocalChecked()).Check();
    obj->Set(context, String::NewFromUtf8(isolate, "confidence").ToLocalChecked(),
        Number::New(isolate, result.confidence)).Check();

    args.GetReturnValue().Set(obj);
}

void Init(Local<Object> exports) {
    NODE_SET_METHOD(exports, "predict", Predict);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Init)
