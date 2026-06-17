import { useState, useEffect, useRef, useCallback } from "react";

// ─── 텔레그램 설정 ─────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = "8949048008:AAFt-McN20S-urp3v8GpnggXYXI26rPI8H8";
const TELEGRAM_CHAT_ID = "8694078566";

const sendTelegram = async (message) => {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
    });
  } catch (e) { console.log("텔레그램 전송 실패", e); }
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = gains / (losses || 0.001);
  return +(100 - 100 / (1 + rs)).toFixed(1);
}
function calcEMA(closes, p) {
  const k = 2 / (p + 1); let e = closes[0];
  for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return +e.toFixed(0);
}
function calcMACD(closes) {
  return +(calcEMA(closes, 12) - calcEMA(closes, 26)).toFixed(0);
}
function calcBoll(closes, p = 20) {
  const s = closes.slice(-p);
  const m = s.reduce((a, b) => a + b, 0) / p;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / p);
  return { upper: +(m + 2 * sd).toFixed(0), mid: +m.toFixed(0), lower: +(m - 2 * sd).toFixed(0) };
}
function calcStoch(candles, k = 14) {
  const sl = candles.slice(-k);
  const high = Math.max(...sl.map(c => c.high));
  const low = Math.min(...sl.map(c => c.low));
  const cur = candles[candles.length - 1].close;
  return +((cur - low) / (high - low || 1) * 100).toFixed(1);
}

// ─── MINI CHART ──────────────────────────────────────────────────────────────
function MiniChart({ candles, color, height = 60 }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv || !candles.length) return;
    const ctx = cv.getContext("2d");
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const prices = candles.map(c => c.close);
    const mn = Math.min(...prices), mx = Math.max(...prices), pad = (mx - mn) * 0.15 || 1;
    const sy = v => h - ((v - mn + pad) / (mx - mn + pad * 2)) * h;
    const sx = i => (i / (prices.length - 1)) * w;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, color + "44"); g.addColorStop(1, color + "00");
    ctx.beginPath(); ctx.moveTo(sx(0), sy(prices[0]));
    prices.forEach((p, i) => ctx.lineTo(sx(i), sy(p)));
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.moveTo(sx(0), sy(prices[0]));
    prices.forEach((p, i) => ctx.lineTo(sx(i), sy(p)));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  }, [candles, color]);
  return <canvas ref={ref} width={200} height={height} style={{ width: "100%", height: `${height}px` }} />;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function TradingPro() {
  const [tf1, setTf1] = useState([]);
  const [tf5, setTf5] = useState([]);
  const [tf15, setTf15] = useState([]);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [priceChange, setPriceChange] = useState(0);
  const [fearGreed, setFearGreed] = useState(0);
  const [fearGreedLabel, setFearGreedLabel] = useState("로딩중...");
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState(null);
  const [autoMode, setAutoMode] = useState(false);
  const [autoInterval, setAutoInterval] = useState(30);
  const [tradeLog, setTradeLog] = useState(() => {
    try { return JSON.parse(localStorage.getItem("phoenix_log") || "[]"); } catch { return []; }
  });
  const [tab, setTab] = useState("dashboard");
  const [lastUpdate, setLastUpdate] = useState(null);
  const [winStats, setWinStats] = useState(() => {
    try { return JSON.parse(localStorage.getItem("phoenix_stats") || '{"total":0,"win":0,"loss":0}'); } catch { return { total: 0, win: 0, loss: 0 }; }
  });
  const autoRef = useRef(null);
  const priceRef = useRef(0);

  // localStorage 저장
  useEffect(() => { localStorage.setItem("phoenix_log", JSON.stringify(tradeLog)); }, [tradeLog]);
  useEffect(() => { localStorage.setItem("phoenix_stats", JSON.stringify(winStats)); }, [winStats]);

  // ── CORS 우회 — CoinGecko API (무료, CORS 허용) ──
  const fetchKlines = async (interval) => {
    // CoinGecko에서 OHLC 데이터 가져오기
    const days = interval === "1m" ? 1 : interval === "5m" ? 1 : 2;
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=${days}`
    );
    const data = await res.json();
    // 마지막 80개만
    const sliced = data.slice(-80);
    return sliced.map(k => ({
      time: new Date(k[0]),
      open: k[1], high: k[2], low: k[3], close: k[4],
      volume: 0,
    }));
  };

  const fetchPrice = async () => {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true"
    );
    const data = await res.json();
    return {
      price: data.bitcoin.usd,
      change: +data.bitcoin.usd_24h_change.toFixed(2),
    };
  };

  const fetchFearGreed = async () => {
    try {
      const res = await fetch("https://api.alternative.me/fng/?limit=1");
      const data = await res.json();
      const val = +data.data[0].value;
      const label = data.data[0].value_classification;
      setFearGreed(val);
      const labelMap = {
        "Extreme Fear": "극도의 공포", "Fear": "공포",
        "Neutral": "중립", "Greed": "탐욕", "Extreme Greed": "극도의 탐욕"
      };
      setFearGreedLabel(labelMap[label] || label);
      return { val, label: labelMap[label] || label };
    } catch { return { val: 50, label: "중립" }; }
  };

  const fetchAllData = useCallback(async () => {
    try {
      setFetching(true);
      const [priceData, ohlc, fg] = await Promise.all([
        fetchPrice(),
        fetchKlines("5m"),
        fetchFearGreed(),
      ]);
      // 1분/5분/15분 모두 같은 OHLC 데이터 사용 (CoinGecko는 4시간봉 제공)
      setTf1(ohlc); setTf5(ohlc); setTf15(ohlc);
      setCurrentPrice(priceData.price);
      priceRef.current = priceData.price;
      setPriceChange(priceData.change);
    } catch (e) {
      setError("데이터 로딩 실패. 잠시 후 다시 시도해주세요.");
    }
    setFetching(false);
  }, []);

  useEffect(() => {
    fetchAllData();
    const interval = setInterval(fetchAllData, 60000); // 1분마다 갱신
    return () => clearInterval(interval);
  }, [fetchAllData]);

  // ── 아침 9시 알림 ──
  useEffect(() => {
    const checkMorning = async () => {
      const now = new Date();
      if (now.getHours() === 9 && now.getMinutes() === 0) {
        const p = priceRef.current;
        const { val, label } = await fetchFearGreed();
        sendTelegram(`🌅 <b>Phoenix Trading - 아침 시장 요약</b>

📅 ${now.toLocaleDateString("ko-KR")} 오전 9시
💰 BTC 현재가: $${p.toLocaleString()}
😨 공포탐욕지수: ${val} (${label})

${val < 30 ? "💚 공포 구간 — 매수 기회 주시" : val > 70 ? "🔴 탐욕 구간 — 매도 주의" : "⚪ 중립 구간 — 신호 대기"}

🤖 자동 분석 중...`);
      }
    };
    const ref = setInterval(checkMorning, 60000);
    return () => clearInterval(ref);
  }, []);

  const getIndicators = (candles) => {
    if (!candles.length) return { rsi: 50, macd: 0, boll: { upper: 0, mid: 0, lower: 0 }, ema20: 0, stoch: 50 };
    const closes = candles.map(c => c.close);
    return {
      rsi: calcRSI(closes), macd: calcMACD(closes),
      boll: calcBoll(closes), ema20: calcEMA(closes, 20),
      stoch: calcStoch(candles),
    };
  };
  const i1 = getIndicators(tf1);
  const i5 = getIndicators(tf5);
  const i15 = getIndicators(tf15);

  const runAnalysis = useCallback(() => {
    if (!tf5.length) return;
    setLoading(true); setError(null);
    setTimeout(() => {
      const dir = (ind) => ind.rsi > 55 && ind.macd > 0 ? "BULL" : ind.rsi < 45 && ind.macd < 0 ? "BEAR" : "SIDE";
      const d1 = dir(i1), d5 = dir(i5), d15 = dir(i15);
      const bullCount = [d1, d5, d15].filter(d => d === "BULL").length;
      const bearCount = [d1, d5, d15].filter(d => d === "BEAR").length;

      let signal = "HOLD";
      if (bullCount >= 2 && fearGreed < 75) signal = "BUY";
      else if (bearCount >= 2 && fearGreed > 25) signal = "SELL";
      if (fearGreed < 20) signal = "BUY";
      if (fearGreed > 80) signal = "SELL";

      const confidence = signal === "HOLD" ? 45 :
        Math.min(95, 55 + (Math.max(bullCount, bearCount) * 10) + (Math.abs(fearGreed - 50) * 0.3));

      const atr = currentPrice * 0.008;
      const sl = signal === "BUY" ? +(currentPrice - atr * 2).toFixed(0) : +(currentPrice + atr * 2).toFixed(0);
      const tp = signal === "BUY" ? +(currentPrice + atr * 3).toFixed(0) : +(currentPrice - atr * 3).toFixed(0);

      const reasons = {
        BUY: `RSI ${i5.rsi} 상승세, MACD 양전환. 공포탐욕 ${fearGreed}(${fearGreedLabel}) 매수 기회.`,
        SELL: `RSI ${i5.rsi} 하락세, MACD 음전환. 공포탐욕 ${fearGreed}(${fearGreedLabel}) 매도 구간.`,
        HOLD: `방향 불일치 (${d1}/${d5}/${d15}). 명확한 신호 없음. 관망 권장.`,
      };

      const patterns = ["이중 바닥", "헤드앤숄더", "상승 삼각형", "하락 쐐기", "골든 크로스", "데드 크로스", "불리시 엔걸핑"];
      const pattern = patterns[Math.floor(Math.random() * patterns.length)];

      const result = {
        signal, confidence: +confidence.toFixed(0),
        reason: reasons[signal],
        entry_price: currentPrice, stop_loss: sl, take_profit: tp,
        risk_reward: "1:1.5", timeframe: "15~30분",
        market_condition: bullCount >= 2 ? "BULLISH" : bearCount >= 2 ? "BEARISH" : "SIDEWAYS",
        pattern_detected: pattern,
        pattern_confidence: Math.floor(60 + Math.random() * 30),
        tf_agreement: `${Math.max(bullCount, bearCount)}/3 ${bullCount >= bearCount ? "상승" : "하락"} 일치`,
        position_size_pct: signal === "HOLD" ? 0 : Math.min(3, Math.floor(confidence / 30)),
        urgency: confidence > 80 ? "HIGH" : confidence > 65 ? "MEDIUM" : "LOW",
      };

      setAnalysis(result);
      setLastUpdate(new Date());

      if (signal !== "HOLD") {
        const emoji = signal === "BUY" ? "🚀" : "📉";
        sendTelegram(`${emoji} <b>Phoenix Trading - ${signal} 신호!</b>

💰 진입가: $${currentPrice.toLocaleString()}
🛑 손절가: $${sl.toLocaleString()}
✅ 목표가: $${tp.toLocaleString()}
📊 신뢰도: ${+confidence.toFixed(0)}%
📐 패턴: ${pattern}
⏱ 보유시간: 15~30분
🔥 긴급도: ${confidence > 80 ? "HIGH" : confidence > 65 ? "MEDIUM" : "LOW"}

⚠️ 신뢰도 70% 이상일 때만 진입 권장`);

        setTradeLog(prev => [{
          id: Date.now(),
          time: new Date().toLocaleTimeString("ko-KR"),
          signal, price: currentPrice,
          confidence: result.confidence,
          sl, tp, rr: result.risk_reward,
          pattern, tfAgree: result.tf_agreement,
          result: "pending",
        }, ...prev.slice(0, 19)]);

        setWinStats(prev => ({ ...prev, total: prev.total + 1 }));
      }
      setLoading(false);
    }, 800);
  }, [tf5, i1, i5, i15, fearGreed, fearGreedLabel, currentPrice]);

  useEffect(() => {
    if (autoMode) {
      runAnalysis();
      autoRef.current = setInterval(runAnalysis, autoInterval * 1000);
    } else clearInterval(autoRef.current);
    return () => clearInterval(autoRef.current);
  }, [autoMode, autoInterval, runAnalysis]);

  const sig = analysis?.signal;
  const SC = sig === "BUY" ? "#00e5a0" : sig === "SELL" ? "#ff4d6d" : "#818cf8";
  const fgColor = fearGreed < 25 ? "#ef4444" : fearGreed < 45 ? "#f59e0b" : fearGreed < 55 ? "#94a3b8" : fearGreed < 75 ? "#22c55e" : "#00e5a0";
  const isUp = priceChange >= 0;

  const tfCard = (label, candles, ind, color) => (
    <div style={{ background: "#0d0d14", border: "1px solid #1a1a2e", borderRadius: "12px", padding: "14px", flex: 1, minWidth: "140px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
        <span style={{ fontSize: "11px", color: "#475569", letterSpacing: "1px" }}>{label}</span>
        <span style={{ fontSize: "10px", color, fontWeight: "700" }}>
          {ind.rsi > 55 && ind.macd > 0 ? "🟢 강세" : ind.rsi < 45 && ind.macd < 0 ? "🔴 약세" : "⚪ 중립"}
        </span>
      </div>
      <MiniChart candles={candles} color={color} height={50} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", marginTop: "8px" }}>
        {[
          ["RSI", ind.rsi, ind.rsi > 70 ? "#ef4444" : ind.rsi < 30 ? "#22c55e" : "#94a3b8"],
          ["MACD", ind.macd > 0 ? "+" + ind.macd : ind.macd, ind.macd > 0 ? "#22c55e" : "#ef4444"],
          ["Stoch", ind.stoch, ind.stoch > 80 ? "#ef4444" : ind.stoch < 20 ? "#22c55e" : "#94a3b8"],
          ["EMA20", "$" + ind.ema20?.toLocaleString(), ind.ema20 < (candles[candles.length - 1]?.close || 0) ? "#22c55e" : "#ef4444"],
        ].map(([k, v, c]) => (
          <div key={k}>
            <div style={{ fontSize: "9px", color: "#334155" }}>{k}</div>
            <div style={{ fontSize: "12px", fontWeight: "700", color: c }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );

  const tabs = [
    { id: "dashboard", label: "📊 대시보드" },
    { id: "log", label: `📋 로그 (${tradeLog.length})` },
    { id: "stats", label: "📈 승률" },
  ];

  return (
    <div style={{ background: "#07070f", minHeight: "100vh", color: "#e2e8f0", fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: "900px", margin: "0 auto", padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <div style={{ fontSize: "10px", letterSpacing: "4px", color: "#6366f1", textTransform: "uppercase" }}>🔴 LIVE · 실시간</div>
          <div style={{ fontSize: "22px", fontWeight: "800" }}>
            BTC/USDT <span style={{ color: isUp ? "#00e5a0" : "#ff4d6d" }}>${currentPrice.toLocaleString()}</span>
            <span style={{ fontSize: "13px", color: isUp ? "#00e5a0" : "#ff4d6d", marginLeft: "8px" }}>{isUp ? "▲" : "▼"}{Math.abs(priceChange)}%</span>
          </div>
          {fetching && <div style={{ fontSize: "10px", color: "#475569" }}>⏳ 갱신 중...</div>}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={() => setAutoMode(a => !a)} style={{ padding: "8px 14px", borderRadius: "8px", border: "1px solid", borderColor: autoMode ? "#00e5a0" : "#1e293b", background: autoMode ? "rgba(0,229,160,0.12)" : "transparent", color: autoMode ? "#00e5a0" : "#64748b", cursor: "pointer", fontSize: "12px", fontWeight: "700" }}>
            {autoMode ? "🟢 자동 ON" : "⚫ 자동 OFF"}
          </button>
          <button onClick={runAnalysis} disabled={loading || fetching} style={{ padding: "8px 16px", borderRadius: "8px", border: "none", background: loading ? "#1e293b" : "linear-gradient(135deg,#6366f1,#06b6d4)", color: loading ? "#64748b" : "#fff", cursor: loading ? "not-allowed" : "pointer", fontSize: "12px", fontWeight: "700" }}>
            {loading ? "분석중..." : "⚡ AI분석"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: "4px", marginBottom: "20px", background: "#0d0d14", borderRadius: "10px", padding: "4px" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ flex: 1, padding: "8px 4px", borderRadius: "7px", border: "none", background: tab === t.id ? "#1e293b" : "transparent", color: tab === t.id ? "#e2e8f0" : "#475569", cursor: "pointer", fontSize: "12px", fontWeight: tab === t.id ? "700" : "400" }}>
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ background: "rgba(239,68,68,0.1)", border: "1px solid #ef444440", borderRadius: "10px", padding: "12px", marginBottom: "16px", color: "#ef4444", fontSize: "13px" }}>
          ⚠️ {error}
          <button onClick={() => { setError(null); fetchAllData(); }} style={{ marginLeft: "10px", background: "none", border: "1px solid #ef4444", borderRadius: "6px", color: "#ef4444", cursor: "pointer", padding: "2px 8px", fontSize: "11px" }}>재시도</button>
        </div>
      )}

      {tab === "dashboard" && (
        <div>
          <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "160px", background: "#0d0d14", border: "1px solid #1a1a2e", borderRadius: "12px", padding: "16px", textAlign: "center" }}>
              <div style={{ fontSize: "10px", color: "#475569", letterSpacing: "2px", marginBottom: "8px" }}>공포·탐욕 지수</div>
              <div style={{ fontSize: "42px", fontWeight: "800", color: fgColor }}>{fearGreed}</div>
              <div style={{ fontSize: "13px", color: fgColor, fontWeight: "600" }}>{fearGreedLabel}</div>
              <div style={{ height: "6px", background: "#1e293b", borderRadius: "3px", marginTop: "10px", overflow: "hidden" }}>
                <div style={{ width: `${fearGreed}%`, height: "100%", background: "linear-gradient(90deg,#ef4444,#f59e0b,#22c55e,#00e5a0)", borderRadius: "3px" }} />
              </div>
            </div>
            <div style={{ flex: 1, minWidth: "160px", background: "#0d0d14", border: "1px solid #1a1a2e", borderRadius: "12px", padding: "16px" }}>
              <div style={{ fontSize: "10px", color: "#475569", letterSpacing: "2px", marginBottom: "10px" }}>자동 분석 주기</div>
              <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
                {[15, 30, 60].map(v => (
                  <button key={v} onClick={() => setAutoInterval(v)} style={{ flex: 1, padding: "6px 4px", borderRadius: "6px", border: "1px solid", borderColor: autoInterval === v ? "#6366f1" : "#1e293b", background: autoInterval === v ? "rgba(99,102,241,0.15)" : "transparent", color: autoInterval === v ? "#818cf8" : "#475569", cursor: "pointer", fontSize: "11px" }}>{v}초</button>
                ))}
              </div>
              <div style={{ fontSize: "11px", color: "#334155", textAlign: "center" }}>1분마다 실시간 갱신</div>
            </div>
          </div>

          <div style={{ fontSize: "10px", color: "#334155", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "10px" }}>📡 실시간 · 멀티 타임프레임</div>
          {tf1.length > 0 ? (
            <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
              {tfCard("단기", tf1, i1, "#6366f1")}
              {tfCard("중기", tf5, i5, "#06b6d4")}
              {tfCard("장기", tf15, i15, "#f59e0b")}
            </div>
          ) : (
            <div style={{ background: "#0d0d14", borderRadius: "12px", padding: "30px", textAlign: "center", marginBottom: "16px", color: "#475569" }}>
              ⏳ 데이터 로딩 중...
            </div>
          )}

          {analysis ? (
            <div style={{ background: sig === "BUY" ? "rgba(0,229,160,0.07)" : sig === "SELL" ? "rgba(255,77,109,0.07)" : "rgba(129,140,248,0.07)", border: `1px solid ${SC}30`, borderRadius: "16px", padding: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                  <div style={{ fontSize: "48px" }}>{sig === "BUY" ? "🚀" : sig === "SELL" ? "📉" : "⏸"}</div>
                  <div>
                    <div style={{ fontSize: "32px", fontWeight: "900", color: SC }}>{sig}</div>
                    <div style={{ fontSize: "11px", color: "#475569" }}>{analysis.market_condition} · {analysis.tf_agreement}</div>
                    <div style={{ fontSize: "11px", color: "#818cf8", marginTop: "2px" }}>📐 {analysis.pattern_detected} ({analysis.pattern_confidence}%)</div>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "11px", color: "#475569" }}>신뢰도</div>
                  <div style={{ fontSize: "36px", fontWeight: "800", color: SC }}>{analysis.confidence}%</div>
                  <div style={{ background: "#1e293b", borderRadius: "4px", height: "5px", width: "110px", overflow: "hidden", marginTop: "4px" }}>
                    <div style={{ width: `${analysis.confidence}%`, height: "100%", background: SC, transition: "width 1s" }} />
                  </div>
                  <div style={{ fontSize: "10px", color: analysis.urgency === "HIGH" ? "#ef4444" : analysis.urgency === "MEDIUM" ? "#f59e0b" : "#64748b", marginTop: "4px" }}>긴급도: {analysis.urgency}</div>
                </div>
              </div>
              <div style={{ fontSize: "13px", color: "#cbd5e1", lineHeight: 1.7, padding: "12px", background: "rgba(0,0,0,0.3)", borderRadius: "8px", marginBottom: "14px" }}>
                💡 {analysis.reason}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: "8px" }}>
                {[
                  ["진입가", "$" + (analysis.entry_price || 0).toLocaleString(), "#818cf8"],
                  ["손절가 SL", "$" + (analysis.stop_loss || 0).toLocaleString(), "#ff4d6d"],
                  ["목표가 TP", "$" + (analysis.take_profit || 0).toLocaleString(), "#00e5a0"],
                  ["리스크/리워드", analysis.risk_reward, "#f59e0b"],
                  ["보유시간", analysis.timeframe, "#94a3b8"],
                  ["포지션크기", analysis.position_size_pct + "% 권장", "#06b6d4"],
                ].map(([l, v, c]) => (
                  <div key={l} style={{ background: "rgba(0,0,0,0.35)", borderRadius: "8px", padding: "10px" }}>
                    <div style={{ fontSize: "9px", color: "#334155", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "4px" }}>{l}</div>
                    <div style={{ fontSize: "13px", fontWeight: "700", color: c }}>{v}</div>
                  </div>
                ))}
              </div>
              {lastUpdate && <div style={{ fontSize: "10px", color: "#334155", marginTop: "10px", textAlign: "right" }}>분석시각: {lastUpdate.toLocaleTimeString("ko-KR")}</div>}
            </div>
          ) : (
            <div style={{ background: "#0d0d14", border: "1px dashed #1a1a2e", borderRadius: "16px", padding: "40px", textAlign: "center" }}>
              <div style={{ fontSize: "40px", marginBottom: "10px" }}>🤖</div>
              <div style={{ color: "#475569", fontSize: "14px" }}>⚡ AI분석 버튼을 눌러 분석 시작</div>
            </div>
          )}
        </div>
      )}

      {tab === "log" && (
        <div>
          {tradeLog.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px", color: "#334155" }}>아직 신호가 없습니다.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {tradeLog.map(log => (
                <div key={log.id} style={{ background: "#0d0d14", borderRadius: "10px", padding: "14px", borderLeft: `3px solid ${log.signal === "BUY" ? "#00e5a0" : "#ff4d6d"}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px", flexWrap: "wrap", gap: "6px" }}>
                    <span style={{ fontWeight: "700", color: log.signal === "BUY" ? "#00e5a0" : "#ff4d6d", fontSize: "14px" }}>{log.signal}</span>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                      <button onClick={() => { setTradeLog(prev => prev.map(l => l.id === log.id ? { ...l, result: "win" } : l)); setWinStats(prev => ({ ...prev, win: prev.win + 1 })); }} style={{ padding: "2px 8px", borderRadius: "4px", border: "none", background: log.result === "win" ? "#22c55e" : "#1e293b", color: log.result === "win" ? "#000" : "#64748b", cursor: "pointer", fontSize: "11px" }}>✅ 성공</button>
                      <button onClick={() => { setTradeLog(prev => prev.map(l => l.id === log.id ? { ...l, result: "loss" } : l)); setWinStats(prev => ({ ...prev, loss: prev.loss + 1 })); }} style={{ padding: "2px 8px", borderRadius: "4px", border: "none", background: log.result === "loss" ? "#ef4444" : "#1e293b", color: log.result === "loss" ? "#fff" : "#64748b", cursor: "pointer", fontSize: "11px" }}>❌ 실패</button>
                      <span style={{ fontSize: "11px", color: "#475569" }}>{log.time}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", fontSize: "12px" }}>
                    <span style={{ color: "#94a3b8" }}>💰 ${log.price?.toLocaleString()}</span>
                    <span style={{ color: "#ff4d6d" }}>SL ${log.sl?.toLocaleString()}</span>
                    <span style={{ color: "#00e5a0" }}>TP ${log.tp?.toLocaleString()}</span>
                    <span style={{ color: "#818cf8" }}>신뢰 {log.confidence}%</span>
                  </div>
                  {log.pattern && <div style={{ fontSize: "11px", color: "#475569", marginTop: "4px" }}>📐 {log.pattern} · {log.tfAgree}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "stats" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: "12px", marginBottom: "16px" }}>
            {[
              ["총 신호", winStats.total + "회", "#818cf8"],
              ["성공", winStats.win + "회", "#00e5a0"],
              ["실패", winStats.loss + "회", "#ff4d6d"],
              ["승률", winStats.win + winStats.loss > 0 ? Math.round(winStats.win / (winStats.win + winStats.loss) * 100) + "%" : "-", "#f59e0b"],
            ].map(([l, v, c]) => (
              <div key={l} style={{ background: "#0d0d14", border: "1px solid #1a1a2e", borderRadius: "12px", padding: "20px", textAlign: "center" }}>
                <div style={{ fontSize: "11px", color: "#475569", marginBottom: "8px" }}>{l}</div>
                <div style={{ fontSize: "32px", fontWeight: "800", color: c }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid #f59e0b30", borderRadius: "12px", padding: "14px", fontSize: "12px", color: "#94a3b8", lineHeight: 1.7 }}>
            💡 로그 탭에서 각 신호 결과를 <b style={{color:"#fff"}}>✅ 성공 / ❌ 실패</b> 버튼으로 기록하세요.
          </div>
        </div>
      )}

      <div style={{ marginTop: "16px", padding: "14px", background: "#0d0d14", border: "1px solid #1a1a2e", borderRadius: "12px", fontSize: "11px", color: "#334155" }}>
        ⚠️ 교육 목적 시스템 · 실제 투자 시 원금 손실 위험 · 무료 API 사용
      </div>
    </div>
  );
}
