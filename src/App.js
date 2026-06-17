import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SYMBOL = "BTCUSDT";
const BASE = "https://fapi.binance.com";
const STORAGE_KEY = "PHOENIX_PAPER_LOG_V1";
const COOLDOWN_MS = 10 * 60 * 1000;

const money = (n) =>
  Number.isFinite(n)
    ? "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "-";

const round = (n, d = 2) => (Number.isFinite(n) ? +Number(n).toFixed(d) : 0);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("fetch failed");
  return await res.json();
}

async function getKlines(interval) {
  const data = await getJson(
    `${BASE}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=180`
  );

  return data.map((k) => ({
    time: new Date(k[0]),
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));
}

async function getTicker() {
  const d = await getJson(`${BASE}/fapi/v1/ticker/24hr?symbol=${SYMBOL}`);
  return {
    price: +d.lastPrice,
    change: +d.priceChangePercent,
    high: +d.highPrice,
    low: +d.lowPrice,
    volume: +d.volume,
  };
}

async function getFearGreed() {
  try {
    const d = await getJson("https://api.alternative.me/fng/?limit=1");
    const raw = d.data[0];
    const map = {
      "Extreme Fear": "극도의 공포",
      Fear: "공포",
      Neutral: "중립",
      Greed: "탐욕",
      "Extreme Greed": "극도의 탐욕",
    };

    return {
      value: +raw.value,
      label: map[raw.value_classification] || "중립",
    };
  } catch {
    return {
      value: 50,
      label: "중립",
    };
  }
}

function ema(values, period) {
  if (!values.length) return 0;

  const k = 2 / (period + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return round(result, 2);
}

function emaArray(values, period) {
  if (!values.length) return [];

  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];

  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }

  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;

  let gain = 0;
  let loss = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];

    if (diff > 0) gain += diff;
    else loss -= diff;
  }

  if (loss === 0) return 100;

  const rs = gain / loss;
  return round(100 - 100 / (1 + rs), 1);
}

function macd(closes) {
  if (closes.length < 35) {
    return {
      line: 0,
      signal: 0,
      hist: 0,
    };
  }

  const e12 = emaArray(closes, 12);
  const e26 = emaArray(closes, 26);
  const offset = e12.length - e26.length;
  const line = e26.map((v, i) => e12[i + offset] - v);
  const sig = emaArray(line, 9);

  const lastLine = line[line.length - 1] || 0;
  const lastSig = sig[sig.length - 1] || 0;

  return {
    line: round(lastLine, 2),
    signal: round(lastSig, 2),
    hist: round(lastLine - lastSig, 2),
  };
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  const trs = [];

  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  return round(trs.reduce((a, b) => a + b, 0) / trs.length, 2);
}

function volumeRatio(candles, period = 20) {
  if (candles.length < period + 1) return 1;

  const prev = candles.slice(-period - 1, -1);
  const avg = prev.reduce((a, c) => a + c.volume, 0) / prev.length;
  const now = candles[candles.length - 1].volume;

  return avg ? round(now / avg, 2) : 1;
}

function indicators(candles) {
  if (!candles.length) {
    return {
      close: 0,
      rsi: 50,
      ema9: 0,
      ema20: 0,
      ema21: 0,
      macd: { line: 0, signal: 0, hist: 0 },
      atr: 0,
      vol: 1,
      dir: "SIDE",
    };
  }

  const closes = candles.map((c) => c.close);
  const close = closes[closes.length - 1];

  const e9 = ema(closes, 9);
  const e20 = ema(closes, 20);
  const e21 = ema(closes, 21);
  const r = rsi(closes);
  const m = macd(closes);
  const a = atr(candles);
  const v = volumeRatio(candles);

  let score = 0;

  if (close > e20) score++;
  if (e9 > e21) score++;
  if (r > 52) score++;
  if (m.hist > 0) score++;

  if (close < e20) score--;
  if (e9 < e21) score--;
  if (r < 48) score--;
  if (m.hist < 0) score--;

  return {
    close,
    rsi: r,
    ema9: e9,
    ema20: e20,
    ema21: e21,
    macd: m,
    atr: a,
    vol: v,
    dir: score >= 2 ? "BULL" : score <= -2 ? "BEAR" : "SIDE",
  };
}

function detectPattern(candles, ind) {
  if (candles.length < 30) return "데이터 부족";

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const before = candles.slice(-22, -2);

  const high = Math.max(...before.map((c) => c.high));
  const low = Math.min(...before.map((c) => c.low));

  const bullEngulf =
    prev.close < prev.open &&
    last.close > last.open &&
    last.close > prev.open &&
    last.open < prev.close;

  const bearEngulf =
    prev.close > prev.open &&
    last.close < last.open &&
    last.open > prev.close &&
    last.close < prev.open;

  if (last.close > high && ind.vol >= 1.2) return "상방 돌파";
  if (last.close < low && ind.vol >= 1.2) return "하방 이탈";
  if (bullEngulf) return "불리시 엔걸핑";
  if (bearEngulf) return "베어리시 엔걸핑";
  if (ind.ema9 > ind.ema21 && ind.rsi >= 45 && ind.rsi <= 58)
    return "상승 추세 눌림";
  if (ind.ema9 < ind.ema21 && ind.rsi >= 42 && ind.rsi <= 55)
    return "하락 추세 되돌림";

  return "명확한 패턴 없음";
}

function makeSignal({ i1, i5, i15, fear, price, candles5 }) {
  const dirs = [i1.dir, i5.dir, i15.dir];
  const bull = dirs.filter((d) => d === "BULL").length;
  const bear = dirs.filter((d) => d === "BEAR").length;

  let signal = "HOLD";

  const longOk =
    bull >= 2 &&
    i15.dir !== "BEAR" &&
    i5.rsi >= 45 &&
    i5.rsi <= 72 &&
    i5.macd.hist > 0 &&
    fear < 80;

  const shortOk =
    bear >= 2 &&
    i15.dir !== "BULL" &&
    i5.rsi >= 28 &&
    i5.rsi <= 60 &&
    i5.macd.hist < 0 &&
    fear > 20;

  if (longOk) signal = "BUY";
  if (shortOk) signal = "SELL";

  const pattern = detectPattern(candles5, i5);
  const align = signal === "BUY" ? bull : signal === "SELL" ? bear : Math.max(bull, bear);

  let confidence = 45;

  if (signal !== "HOLD") {
    confidence = 50 + align * 10;
    if (i5.vol >= 1.2) confidence += 6;
    if (pattern !== "명확한 패턴 없음") confidence += 6;
    if (signal === "BUY" && fear < 35) confidence += 4;
    if (signal === "SELL" && fear > 65) confidence += 4;
    confidence = Math.min(92, confidence);
  }

  const risk = Math.max((i5.atr || price * 0.005) * 1.5, price * 0.003);
  const reward = risk * 1.5;

  return {
    signal,
    confidence: round(confidence, 0),
    pattern,
    entry: price,
    sl: signal === "BUY" ? price - risk : signal === "SELL" ? price + risk : null,
    tp: signal === "BUY" ? price + reward : signal === "SELL" ? price - reward : null,
    rr: signal === "HOLD" ? "-" : "1:1.5",
    reason:
      signal === "BUY"
        ? `상승 우세 ${bull}/3, 5분봉 RSI ${i5.rsi}, MACD 양전환`
        : signal === "SELL"
        ? `하락 우세 ${bear}/3, 5분봉 RSI ${i5.rsi}, MACD 음전환`
        : `방향 불일치: ${dirs.join(" / ")}. 관망 우선`,
    agree: `${align}/3 ${bull >= bear ? "상승" : "하락"} 우세`,
    market: bull >= 2 ? "BULLISH" : bear >= 2 ? "BEARISH" : "SIDEWAYS",
    size: signal === "HOLD" ? 0 : confidence >= 80 ? 2 : 1,
  };
}

function MiniChart({ candles, color }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || candles.length < 2) return;

    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const prices = candles.map((c) => c.close);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = (max - min) * 0.15 || 1;

    const x = (i) => (i / (prices.length - 1)) * w;
    const y = (v) => h - ((v - min + pad) / (max - min + pad * 2)) * h;

    ctx.beginPath();
    ctx.moveTo(x(0), y(prices[0]));

    prices.forEach((p, i) => ctx.lineTo(x(i), y(p)));

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [candles, color]);

  return (
    <canvas
      ref={ref}
      width={220}
      height={55}
      style={{ width: "100%", height: "55px" }}
    />
  );
}

export default function App() {
  const [tf1, setTf1] = useState([]);
  const [tf5, setTf5] = useState([]);
  const [tf15, setTf15] = useState([]);
  const [ticker, setTicker] = useState({ price: 0, change: 0 });
  const [fear, setFear] = useState(50);
  const [fearLabel, setFearLabel] = useState("중립");
  const [analysis, setAnalysis] = useState(null);
  const [logs, setLogs] = useState([]);
  const [tab, setTab] = useState("dashboard");
  const [auto, setAuto] = useState(false);
  const [sec, setSec] = useState(30);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState(null);

  const autoRef = useRef(null);
  const lastSignal = useRef({ key: "", time: 0 });

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setLogs(JSON.parse(saved));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
  }, [logs]);

  const i1 = useMemo(() => indicators(tf1), [tf1]);
  const i5 = useMemo(() => indicators(tf5), [tf5]);
  const i15 = useMemo(() => indicators(tf15), [tf15]);

  const stats = useMemo(() => {
    const win = logs.filter((x) => x.result === "win").length;
    const loss = logs.filter((x) => x.result === "loss").length;
    const closed = win + loss;

    return {
      total: logs.length,
      win,
      loss,
      pending: logs.filter((x) => x.result === "pending").length,
      rate: closed ? Math.round((win / closed) * 100) : "-",
    };
  }, [logs]);

  const load = useCallback(async () => {
    try {
      setFetching(true);
      setError("");

      const [t, c1, c5, c15, f] = await Promise.all([
        getTicker(),
        getKlines("1m"),
        getKlines("5m"),
        getKlines("15m"),
        getFearGreed(),
      ]);

      setTicker(t);
      setTf1(c1);
      setTf5(c5);
      setTf15(c15);
      setFear(f.value);
      setFearLabel(f.label);
      setUpdated(new Date());
    } catch {
      setError("데이터 로딩 실패");
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    load();

    const timer = setInterval(load, 60000);

    return () => clearInterval(timer);
  }, [load]);

  const run = useCallback(() => {
    if (!tf1.length || !tf5.length || !tf15.length || !ticker.price) return;

    setLoading(true);

    setTimeout(() => {
      const result = makeSignal({
        i1,
        i5,
        i15,
        fear,
        price: ticker.price,
        candles5: tf5,
      });

      setAnalysis(result);

      const now = Date.now();
      const key = `${result.signal}-${Math.round(result.entry / 10) * 10}`;
      const canSave =
        result.signal !== "HOLD" &&
        result.confidence >= 68 &&
        (lastSignal.current.key !== key ||
          now - lastSignal.current.time > COOLDOWN_MS);

      if (canSave) {
        lastSignal.current = { key, time: now };

        setLogs((prev) => [
          {
            id: now,
            time: new Date().toLocaleString("ko-KR"),
            signal: result.signal,
            price: result.entry,
            sl: result.sl,
            tp: result.tp,
            confidence: result.confidence,
            pattern: result.pattern,
            agree: result.agree,
            result: "pending",
          },
          ...prev,
        ]);
      }

      setLoading(false);
    }, 300);
  }, [tf1, tf5, tf15, ticker.price, i1, i5, i15, fear]);

  useEffect(() => {
    if (!auto) {
      clearInterval(autoRef.current);
      return;
    }

    run();

    autoRef.current = setInterval(run, sec * 1000);

    return () => clearInterval(autoRef.current);
  }, [auto, sec, run]);

  function mark(id, result) {
    setLogs((prev) =>
      prev.map((x) => (x.id === id ? { ...x, result } : x))
    );
  }

  function card(title, candles, ind, color) {
    return (
      <div
        style={{
          flex: 1,
          minWidth: 160,
          background: "#0d0d14",
          border: "1px solid #1a1a2e",
          borderRadius: 14,
          padding: 14,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <b style={{ fontSize: 12, color: "#94a3b8" }}>{title}</b>
          <b style={{ fontSize: 11, color }}>
            {ind.dir === "BULL" ? "🟢 강세" : ind.dir === "BEAR" ? "🔴 약세" : "⚪ 중립"}
          </b>
        </div>

        <MiniChart candles={candles} color={color} />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginTop: 10,
            fontSize: 12,
          }}
        >
          <div>RSI <b>{ind.rsi}</b></div>
          <div>MACD <b>{ind.macd.hist}</b></div>
          <div>EMA <b>{ind.ema9 > ind.ema21 ? "상방" : "하방"}</b></div>
          <div>VOL <b>{ind.vol}x</b></div>
        </div>
      </div>
    );
  }

  const sig = analysis?.signal || "HOLD";
  const sigColor =
    sig === "BUY" ? "#00e5a0" : sig === "SELL" ? "#ff4d6d" : "#818cf8";

  const fearColor =
    fear < 25
      ? "#ef4444"
      : fear < 45
      ? "#f59e0b"
      : fear < 55
      ? "#94a3b8"
      : fear < 75
      ? "#22c55e"
      : "#00e5a0";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#07070f",
        color: "#e2e8f0",
        padding: 16,
        maxWidth: 920,
        margin: "0 auto",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <div>
          <div style={{ fontSize: 11, color: "#6366f1", letterSpacing: 3 }}>
            🟡 PAPER ONLY · NO REAL ORDER
          </div>

          <h2 style={{ margin: "6px 0" }}>
            {SYMBOL}{" "}
            <span style={{ color: ticker.change >= 0 ? "#00e5a0" : "#ff4d6d" }}>
              {money(ticker.price)}
            </span>
          </h2>

          <div style={{ fontSize: 12, color: ticker.change >= 0 ? "#00e5a0" : "#ff4d6d" }}>
            {ticker.change >= 0 ? "▲" : "▼"} {Math.abs(ticker.change)}%
          </div>

          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
            {fetching ? "데이터 갱신 중..." : `최근 갱신: ${updated?.toLocaleTimeString("ko-KR") || "-"}`}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => setAuto((v) => !v)}
            style={{
              padding: "9px 14px",
              borderRadius: 8,
              border: "1px solid #1e293b",
              background: auto ? "rgba(0,229,160,0.14)" : "transparent",
              color: auto ? "#00e5a0" : "#64748b",
              fontWeight: 800,
            }}
          >
            {auto ? "자동 ON" : "자동 OFF"}
          </button>

          <button
            onClick={run}
            disabled={loading || fetching}
            style={{
              padding: "9px 16px",
              borderRadius: 8,
              border: "none",
              background: "linear-gradient(135deg,#6366f1,#06b6d4)",
              color: "#fff",
              fontWeight: 800,
            }}
          >
            {loading ? "분석중..." : "PAPER 분석"}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "rgba(239,68,68,0.1)",
            color: "#ef4444",
            border: "1px solid #ef444440",
            padding: 12,
            borderRadius: 10,
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          background: "#0d0d14",
          borderRadius: 10,
          padding: 4,
          marginBottom: 16,
        }}
      >
        {[
          ["dashboard", "대시보드"],
          ["log", `로그 ${logs.length}`],
          ["stats", "승률"],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              flex: 1,
              padding: 9,
              borderRadius: 8,
              border: "none",
              background: tab === id ? "#1e293b" : "transparent",
              color: tab === id ? "#fff" : "#64748b",
              fontWeight: 800,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "dashboard" && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <div
              style={{
                flex: 1,
                minWidth: 170,
                background: "#0d0d14",
                border: "1px solid #1a1a2e",
                borderRadius: 14,
                padding: 16,
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 11, color: "#64748b" }}>공포·탐욕 지수</div>
              <div style={{ fontSize: 42, fontWeight: 900, color: fearColor }}>{fear}</div>
              <b style={{ color: fearColor }}>{fearLabel}</b>
            </div>

            <div
              style={{
                flex: 1,
                minWidth: 170,
                background: "#0d0d14",
                border: "1px solid #1a1a2e",
                borderRadius: 14,
                padding: 16,
              }}
            >
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10 }}>
                자동 분석 주기
              </div>

              <div style={{ display: "flex", gap: 6 }}>
                {[15, 30, 60].map((v) => (
                  <button
                    key={v}
                    onClick={() => setSec(v)}
                    style={{
                      flex: 1,
                      padding: 8,
                      borderRadius: 8,
                      border: "1px solid #1e293b",
                      background: sec === v ? "rgba(99,102,241,0.2)" : "transparent",
                      color: sec === v ? "#818cf8" : "#64748b",
                      fontWeight: 800,
                    }}
                  >
                    {v}초
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
            {card("1분봉", tf1, i1, "#6366f1")}
            {card("5분봉", tf5, i5, "#06b6d4")}
            {card("15분봉", tf15, i15, "#f59e0b")}
          </div>

          {analysis ? (
            <div
              style={{
                background:
                  sig === "BUY"
                    ? "rgba(0,229,160,0.08)"
                    : sig === "SELL"
                    ? "rgba(255,77,109,0.08)"
                    : "rgba(129,140,248,0.08)",
                border: `1px solid ${sigColor}40`,
                borderRadius: 18,
                padding: 20,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 40 }}>{sig === "BUY" ? "🚀" : sig === "SELL" ? "📉" : "⏸"}</div>
                  <h1 style={{ margin: 0, color: sigColor }}>{sig}</h1>
                  <div style={{ color: "#64748b", fontSize: 12 }}>
                    {analysis.market} · {analysis.agree}
                  </div>
                </div>

                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12, color: "#64748b" }}>신뢰도</div>
                  <div style={{ fontSize: 36, fontWeight: 900, color: sigColor }}>
                    {analysis.confidence}%
                  </div>
                </div>
              </div>

              <div
                style={{
                  marginTop: 14,
                  background: "rgba(0,0,0,0.3)",
                  borderRadius: 10,
                  padding: 12,
                  lineHeight: 1.6,
                }}
              >
                {analysis.reason}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))",
                  gap: 8,
                  marginTop: 14,
                }}
              >
                {[
                  ["진입", money(analysis.entry)],
                  ["손절", analysis.sl ? money(analysis.sl) : "-"],
                  ["목표", analysis.tp ? money(analysis.tp) : "-"],
                  ["손익비", analysis.rr],
                  ["패턴", analysis.pattern],
                  ["포지션", analysis.size + "% PAPER"],
                ].map(([a, b]) => (
                  <div key={a} style={{ background: "rgba(0,0,0,0.35)", padding: 10, borderRadius: 10 }}>
                    <div style={{ fontSize: 10, color: "#64748b" }}>{a}</div>
                    <b>{b}</b>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div
              style={{
                background: "#0d0d14",
                border: "1px dashed #1a1a2e",
                borderRadius: 18,
                padding: 40,
                textAlign: "center",
                color: "#64748b",
              }}
            >
              PAPER 분석 버튼을 눌러 신호 확인
            </div>
          )}
        </>
      )}

      {tab === "log" && (
        <div>
          {logs.length === 0 ? (
            <div style={{ textAlign: "center", color: "#64748b", padding: 50 }}>
              아직 기록된 신호 없음
            </div>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                style={{
                  background: "#0d0d14",
                  borderLeft: `4px solid ${log.signal === "BUY" ? "#00e5a0" : "#ff4d6d"}`,
                  padding: 14,
                  borderRadius: 10,
                  marginBottom: 8,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <b style={{ color: log.signal === "BUY" ? "#00e5a0" : "#ff4d6d" }}>
                    {log.signal}
                  </b>

                  <div>
                    <button onClick={() => mark(log.id, "win")}>✅ 성공</button>
                    <button onClick={() => mark(log.id, "loss")}>❌ 실패</button>
                  </div>
                </div>

                <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>
                  진입 {money(log.price)} · SL {money(log.sl)} · TP {money(log.tp)} · 신뢰{" "}
                  {log.confidence}%
                </div>

                <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
                  {log.pattern} · {log.agree} · {log.time}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "stats" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))",
            gap: 10,
          }}
        >
          {[
            ["총 신호", stats.total],
            ["대기", stats.pending],
            ["성공", stats.win],
            ["실패", stats.loss],
            ["승률", stats.rate === "-" ? "-" : stats.rate + "%"],
          ].map(([a, b]) => (
            <div
              key={a}
              style={{
                background: "#0d0d14",
                border: "1px solid #1a1a2e",
                borderRadius: 14,
                padding: 20,
                textAlign: "center",
              }}
            >
              <div style={{ color: "#64748b", fontSize: 12 }}>{a}</div>
              <div style={{ fontSize: 32, fontWeight: 900 }}>{b}</div>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          marginTop: 16,
          padding: 14,
          background: "#0d0d14",
          border: "1px solid #1a1a2e",
          borderRadius: 12,
          color: "#64748b",
          fontSize: 11,
        }}
      >
        ⚠️ PAPER ONLY · 실제 주문 없음 · API KEY 없음 · 실거래 금지
      </div>
    </div>
  );
}