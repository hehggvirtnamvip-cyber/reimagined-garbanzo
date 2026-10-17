#include <node.h>
#include <node_buffer.h>
#include <v8.h>
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>

using namespace v8;
using namespace std;

double sigmoid(double z) {
    if (z >= 0) { double e = exp(-z); return 1.0 / (1.0 + e); }
    else { double e = exp(z); return e / (1.0 + e); }
}

struct PredictResult {
    char code;
    double confidence;
};

PredictResult algoStreak(const vector<char>& seq) {
    int n = seq.size();
    if (n < 4) return {'N', 0};
    char last = seq[n - 1];
    int len = 1;
    for (int i = n - 2; i >= 0; i--) {
        if (seq[i] == last) len++;
        else break;
    }
    if (len >= 4 && len <= 14) return {last, 0.75 + min((len - 4) * 0.01, 0.10)};
    if (len >= 15) return {last == 'T' ? 'X' : 'T', 0.65};
    return {'N', 0};
}

PredictResult algoCau(const vector<char>& seq) {
    int n = seq.size();
    if (n < 4) return {'N', 0};
    char last = seq[n - 1];
    int alt = 0;
    for (int i = n - 1; i >= 1; i--) {
        if (seq[i] != seq[i - 1]) alt++;
        else break;
    }
    if (alt >= 5) return {last == 'T' ? 'X' : 'T', min(0.62 + (alt - 5) * 0.04, 0.80)};
    string p8 = "";
    for (int i = max(0, n - 8); i < n; i++) p8 += seq[i];
    if (p8 == "TTXXTTXX") return {'T', 0.75};
    if (p8 == "XXTTXXTT") return {'X', 0.75};
    return {'N', 0};
}

PredictResult computeEnsemble(const vector<char>& seq) {
    vector<PredictResult> results = { algoStreak(seq), algoCau(seq) };
    double voteT = 0.0, voteX = 0.0;
    for (const auto& r : results) {
        if (r.code == 'N') continue;
        if (r.code == 'T') voteT += r.confidence;
        else voteX += r.confidence;
    }
    double total = voteT + voteX;
    if (total < 0.1) return {'N', 0};
    double pT = voteT / total;
    double conf = abs(pT - 0.5) * 2;
    if (conf < 0.10) return {'N', 0};
    return {pT >= 0.5 ? 'T' : 'X', min(0.55 + conf * 0.30, 0.82)};
}

// ✅ SỬA LẠI CÚ PHÁP BINDING CHO NODE.JS 20
void Predict(const FunctionCallbackInfo<Value>& args) {
    Isolate* isolate = args.GetIsolate();
    Local<Context> context = isolate->GetCurrentContext();

    if (args.Length() < 1 || !args[0]->IsString()) {
        isolate->ThrowException(Exception::TypeError(String::NewFromUtf8(isolate, "Need string").ToLocalChecked()));
        return;
    }

    String::Utf8Value utf8(isolate, args[0]);
    string seqStr(*utf8);
    vector<char> seq(seqStr.begin(), seqStr.end());

    PredictResult result = computeEnsemble(seq);

    Local<Object> obj = Object::New(isolate);
    string codeStr = (result.code == 'N') ? "NONE" : string(1, result.code);
    
    // Sử dụng cú pháp chuẩn mới (không dùng Check())
    obj->Set(context, String::NewFromUtf8(isolate, "code").ToLocalChecked(),
        String::NewFromUtf8(isolate, codeStr.c_str()).ToLocalChecked()).FromMaybe(false);
        
    obj->Set(context, String::NewFromUtf8(isolate, "confidence").ToLocalChecked(),
        Number::New(isolate, result.confidence)).FromMaybe(false);

    args.GetReturnValue().Set(obj);
}

void Init(Local<Object> exports) {
    NODE_SET_METHOD(exports, "predict", Predict);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Init)
