import { BinanceDepthStream, type ConnectionStatus } from "./depthStream";
import { PriceChart, type SRLevel } from "./chart";
import { formatUtcClock, getActiveSessionLabels, getSessionStatuses } from "./sessions";
import { BinanceTradeStream, type TradeFlowState } from "./tradeStream";
import type { BookDepth, Market, OrderBookState, UpdateSpeed, WallBucket } from "./types";
import { buildStreamUrl } from "./types";
import "./style.css";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "FARTCOINUSDT","XAUUSDT"];
const DEPTHS: BookDepth[] = [20, 50, 100, 500];
const SR_COUNTS = [1,2,3,4,5,6, 12, 18, 24];
const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];
const SPEEDS: UpdateSpeed[] = ["100ms", "1000ms"];
const MARKETS: { value: Market; label: string }[] = [ 
  { value: "spot", label: "Spot" },
  { value: "futures", label: "Futures" },
];

const params = new URLSearchParams(window.location.search);

let currentMarket: Market =
  params.get("market") === "spot" || params.get("market") === "futures"
    ? (params.get("market") as Market)
    : "futures";
let currentSymbol = (params.get("symbol") ?? "FARTCOINUSDT").toUpperCase();
let currentDepth: BookDepth =
  DEPTHS.includes(Number(params.get("depth")) as BookDepth)
    ? (Number(params.get("depth")) as BookDepth)
    : 50;
let currentSpeed: UpdateSpeed =
  params.get("speed") === "1000ms" ? "1000ms" : "100ms";
let currentSrCount =
  SR_COUNTS.includes(Number(params.get("sr")))
    ? Number(params.get("sr"))
    : 12;
let currentTimeframe = TIMEFRAMES.includes(params.get("tf") ?? "")
  ? (params.get("tf") as string)
  : "15m";

if (!SYMBOLS.includes(currentSymbol)) {
  SYMBOLS.push(currentSymbol);
}

document.title = `${currentSymbol} · Orders Book`;

const app = document.getElementById("app")!;
app.innerHTML = renderShell();

const statusEl = document.getElementById("status")!;
const streamUrlEl = document.getElementById("stream-url")!;
const spreadEl = document.getElementById("spread")!;
const midPriceEl = document.getElementById("mid-price")!;
const asksWalls = document.getElementById("asks-walls")!;
const bidsWalls = document.getElementById("bids-walls")!;
const aggressionHeadlineEl = document.getElementById("aggression-headline")!;
const cvdValueEl = document.getElementById("cvd-value")!;
const cvdSlopeEl = document.getElementById("cvd-slope")!;
const aggressionBar = document.getElementById("aggression-bar")!;
const aggressionBuy = document.getElementById("aggression-buy")!;
const aggressionSell = document.getElementById("aggression-sell")!;
const aggressionMetaEl = document.getElementById("aggression-meta")!;
const tapeEl = document.getElementById("tape")!;
const tradeStatusEl = document.getElementById("trade-status")!;
const depthMetaEl = document.getElementById("depth-meta")!;
const priceHeadEl = document.getElementById("price-head")!;
const marketSelect = document.getElementById("market") as HTMLSelectElement;
const symbolSelect = document.getElementById("symbol") as HTMLSelectElement;
const depthSelect = document.getElementById("depth") as HTMLSelectElement;
const speedSelect = document.getElementById("speed") as HTMLSelectElement;
const srSelect = document.getElementById("sr") as HTMLSelectElement;
const timeframeSelect = document.getElementById("timeframe") as HTMLSelectElement;
const legendSupportEl = document.querySelector(".legend-support")!;
const legendResistanceEl = document.querySelector(".legend-resistance")!;
const sessionsEl = document.getElementById("sessions")!;
const sessionsUtcEl = document.getElementById("sessions-utc")!;
const sessionsSummaryEl = document.getElementById("sessions-summary")!;

const chart = new PriceChart(document.getElementById("tv_chart")!);
let lastSRUpdate = 0;

const stream = new BinanceDepthStream(
  { symbol: currentSymbol, depth: currentDepth, speed: currentSpeed, market: currentMarket },
  {
    onUpdate: (state) => {
      renderWalls(state);
      updateSupportResistance(state);
      chart.updateLivePrice(state.midPrice);
    },
    onStatus: (status, message) => {
      setStatus(status, message);
    },
  },
);

const tradeStream = new BinanceTradeStream({
  onUpdate: (state) => {
    renderAggression(state);
  },
  onStatus: (status) => {
    const labels = {
      connecting: "Trades connecting…",
      connected: "Trades live",
      disconnected: "Trades disconnected",
      error: "Trades error",
    };
    tradeStatusEl.textContent = labels[status];
    tradeStatusEl.dataset.status = status;
  },
});

marketSelect.addEventListener("change", () => {
  currentMarket = marketSelect.value as Market;
  reconnect();
});

symbolSelect.addEventListener("change", () => {
  const chosen = symbolSelect.value;
  const url = new URL(window.location.href);
  url.searchParams.set("symbol", chosen);
  url.searchParams.set("market", currentMarket);
  url.searchParams.set("depth", String(currentDepth));
  url.searchParams.set("speed", currentSpeed);
  url.searchParams.set("sr", String(currentSrCount));
  url.searchParams.set("tf", currentTimeframe);
  window.open(url.toString(), "_blank");
  symbolSelect.value = currentSymbol;
});

depthSelect.addEventListener("change", () => {
  currentDepth = Number(depthSelect.value) as BookDepth;
  reconnect();
});

speedSelect.addEventListener("change", () => {
  currentSpeed = speedSelect.value as UpdateSpeed;
  reconnect();
});

srSelect.addEventListener("change", () => {
  currentSrCount = Number(srSelect.value);
  legendSupportEl.textContent = `— Support (top ${currentSrCount} buy walls)`;
  legendResistanceEl.textContent = `— Resistance (top ${currentSrCount} sell walls)`;
  syncUrl();
});

timeframeSelect.addEventListener("change", () => {
  currentTimeframe = timeframeSelect.value;
  syncUrl();
  void chart.load(currentSymbol, currentMarket, currentTimeframe);
});

function syncUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("market", currentMarket);
  url.searchParams.set("symbol", currentSymbol);
  url.searchParams.set("depth", String(currentDepth));
  url.searchParams.set("speed", currentSpeed);
  url.searchParams.set("sr", String(currentSrCount));
  url.searchParams.set("tf", currentTimeframe);
  window.history.replaceState(null, "", url);
}

function reconnect(): void {
  syncUrl();
  updateStreamUrl();
  stream.updateConfig({
    symbol: currentSymbol,
    depth: currentDepth,
    speed: currentSpeed,
    market: currentMarket,
  });
  tradeStream.updateConfig(currentSymbol, currentMarket);
  void chart.load(currentSymbol, currentMarket, currentTimeframe);
}

function updateStreamUrl(): void {
  streamUrlEl.textContent = buildStreamUrl({
    symbol: currentSymbol,
    depth: currentDepth,
    speed: currentSpeed,
    market: currentMarket,
  });
}

function setStatus(status: ConnectionStatus, message?: string): void {
  const labels: Record<ConnectionStatus, string> = {
    connecting: "Connecting…",
    syncing: "Syncing book…",
    connected: "Live",
    disconnected: "Disconnected",
    error: message ?? "Error",
  };
  statusEl.textContent = labels[status];
  statusEl.dataset.status = status;
}

function formatPrice(price: number): string {
  if (price >= 1000) {
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(8);
}

function formatQty(qty: number): string {
  if (qty >= 1000) return qty.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (qty >= 1) return qty.toFixed(4);
  return qty.toFixed(6);
}

function formatCompact(qty: number): string {
  const abs = Math.abs(qty);
  if (abs >= 1_000_000_000) return `${trim(qty / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim(qty / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(qty / 1_000)}K`;
  if (abs >= 1) return trim(qty, 2);
  return trim(qty, 4);
}

function trim(value: number, decimals = 2): string {
  return value
    .toFixed(decimals)
    .replace(/\.?0+$/, "");
}

function renderBucketRow(
  bucket: WallBucket,
  side: "bid" | "ask",
): string {
  const price =
    side === "bid" ? bucket.priceFrom : bucket.priceTo;

  const levelLabel =
    bucket.levelFrom === bucket.levelTo
      ? `L${bucket.levelFrom}`
      : `L${bucket.levelFrom}–${bucket.levelTo}`;
  const levelTitle =
    bucket.levelFrom === bucket.levelTo
      ? `Price level ${bucket.levelFrom}`
      : `Price levels ${bucket.levelFrom} to ${bucket.levelTo} added together`;

  return `
    <div class="row ${side}-row">
      <span class="row-levels" title="${levelTitle}">${levelLabel}</span>
      <span class="row-price">${formatPrice(price)}</span>
      <span class="row-size" title="${formatQty(bucket.sumQty)}">${formatCompact(bucket.sumQty)}</span>
      <span class="row-sum" title="${formatQty(bucket.cumulative)}">${formatCompact(bucket.cumulative)}</span>
      <span class="row-bar" style="width: ${bucket.qtyPercent}%"></span>
    </div>`;
}

function updateSupportResistance(state: OrderBookState): void {
  const now = Date.now();
  if (now - lastSRUpdate < 250) return;
  lastSRUpdate = now;

  const toLevels = (buckets: WallBucket[], side: "bid" | "ask"): SRLevel[] =>
    [...buckets]
      .filter((bucket) =>
        side === "bid"
          ? bucket.priceFrom < state.midPrice
          : bucket.priceFrom > state.midPrice,
      )
      .sort((a, b) => b.sumQty - a.sumQty)
      .slice(0, currentSrCount)
      .map((bucket) => {
        const levelLabel =
          bucket.levelFrom === bucket.levelTo
            ? `L${bucket.levelFrom}`
            : `L${bucket.levelFrom}–${bucket.levelTo}`;
        return {
          price: bucket.priceFrom,
          label: `${levelLabel} · ${formatPrice(bucket.priceFrom)} · ${formatCompact(bucket.sumQty)} · Σ${formatCompact(bucket.cumulative)}`,
        };
      });

  chart.setSupportResistance(
    toLevels(state.bidBuckets, "bid"),
    toLevels(state.askBuckets, "ask"),
  );
}

function formatTradeTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Tehran",
  }).format(new Date(timestamp));
}

function formatSignedDelta(value: number): string {
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${prefix}${formatCompact(Math.abs(value))}`;
}

function renderAggression(state: TradeFlowState): void {
  aggressionHeadlineEl.textContent = state.aggressionLabel;
  aggressionHeadlineEl.dataset.leader = state.aggression;

  cvdValueEl.textContent = formatSignedDelta(state.cvd);
  cvdValueEl.dataset.leader =
    state.cvd > 0 ? "buy" : state.cvd < 0 ? "sell" : "even";

  const slopeLabel =
    state.cvdSlope > 0
      ? `↑ +${formatCompact(state.cvdSlope)} (30s)`
      : state.cvdSlope < 0
        ? `↓ −${formatCompact(Math.abs(state.cvdSlope))} (30s)`
        : "→ flat (30s)";
  cvdSlopeEl.textContent = slopeLabel;
  cvdSlopeEl.dataset.leader =
    state.cvdSlope > 0 ? "buy" : state.cvdSlope < 0 ? "sell" : "even";

  const recentTotal = state.recentBuyVolume + state.recentSellVolume;
  const buyPct = recentTotal > 0 ? (state.recentBuyVolume / recentTotal) * 100 : 50;
  const sellPct = recentTotal > 0 ? (state.recentSellVolume / recentTotal) * 100 : 50;
  aggressionBuy.style.width = `${buyPct}%`;
  aggressionSell.style.width = `${sellPct}%`;
  aggressionBar.dataset.leader = state.aggression;

  aggressionMetaEl.innerHTML = `
    <span class="verdict-buy">Market buys ${formatCompact(state.recentBuyVolume)}</span>
    <span class="verdict-sell">Market sells ${formatCompact(state.recentSellVolume)}</span>`;

  tapeEl.innerHTML =
    state.tape.length === 0
      ? `<div class="tape-empty">Waiting for trades…</div>`
      : state.tape
          .map(
            (trade) => `
    <div class="tape-row ${trade.side}-tape">
      <span class="tape-time">${formatTradeTime(trade.time)}</span>
      <span class="tape-price">${formatPrice(trade.price)}</span>
      <span class="tape-size">${formatCompact(trade.quantity)}</span>
      <span class="tape-side">${trade.side === "buy" ? "BUY" : "SELL"}</span>
    </div>`,
          )
          .join("");
}

function renderWalls(state: OrderBookState): void {
  spreadEl.textContent = `Spread ${formatPrice(state.spread)}`;
  midPriceEl.textContent = formatPrice(state.midPrice);

  const quoteAsset = state.symbol.slice(state.baseAsset.length) || "USDT";
  const rowsPerSide = Math.ceil(state.depth / state.groupSize);
  priceHeadEl.textContent = `Price (${quoteAsset})`;
  depthMetaEl.textContent =
    state.groupSize === 1
      ? `${state.depth} levels · every price level shown · Size in ${state.baseAsset} · Sum = running total`
      : `${state.depth} levels ÷ ${state.groupSize} = ${rowsPerSide} rows per side · each row = ${state.groupSize} levels · Size in ${state.baseAsset} · Sum = running total`;

  asksWalls.innerHTML = [...state.askBuckets]
    .reverse()
    .map((bucket) => renderBucketRow(bucket, "ask"))
    .join("");

  bidsWalls.innerHTML = state.bidBuckets
    .map((bucket) => renderBucketRow(bucket, "bid"))
    .join("");
}

function renderSessions(): void {
  const now = new Date();
  const statuses = getSessionStatuses(now);
  const active = getActiveSessionLabels(now);

  sessionsUtcEl.textContent = `UTC ${formatUtcClock(now)}`;
  sessionsSummaryEl.textContent =
    active.length > 0
      ? `Active: ${active.join(" + ")}`
      : "All sessions closed — lower liquidity window";

  sessionsEl.innerHTML = statuses
    .map(
      (session) => `
    <div class="session-card${session.isOpen ? " session-open" : ""}" data-session="${session.id}">
      <div class="session-head">
        <span class="session-dot" aria-hidden="true"></span>
        <span class="session-name">${session.label}</span>
        <span class="session-state">${session.isOpen ? "Open" : "Closed"}</span>
      </div>
      <div class="session-time">${session.localTime}</div>
      <div class="session-hours">${session.hoursLabel}</div>
    </div>`,
    )
    .join("");
}

function renderShell(): string {
  return `
    <div class="layout">
      <header class="header">
        <div class="brand">
          <h1>Orders Book</h1>
          <p class="subtitle">Where are the big buy and sell walls right now?</p>
        </div>
        <div class="controls">
          <label>
            Market
            <select id="market">
              ${MARKETS.map((market) => `<option value="${market.value}"${market.value === currentMarket ? " selected" : ""}>${market.label}</option>`).join("")}
            </select>
          </label>
          <label>
            Symbol
            <select id="symbol">
              ${SYMBOLS.map((symbol) => `<option value="${symbol}"${symbol === currentSymbol ? " selected" : ""}>${symbol}</option>`).join("")}
            </select>
          </label>
          <label>
            Depth
            <select id="depth">
              ${DEPTHS.map((depth) => `<option value="${depth}"${depth === currentDepth ? " selected" : ""}>${depth} levels</option>`).join("")}
            </select>
          </label>
          <label>
            Speed
            <select id="speed">
              ${SPEEDS.map((speed) => `<option value="${speed}"${speed === currentSpeed ? " selected" : ""}>${speed}</option>`).join("")}
            </select>
          </label>
          <label>
            Chart lines
            <select id="sr">
              ${SR_COUNTS.map((count) => `<option value="${count}"${count === currentSrCount ? " selected" : ""}>Top ${count}</option>`).join("")}
            </select>
          </label>
          <label>
            Timeframe
            <select id="timeframe">
              ${TIMEFRAMES.map((tf) => `<option value="${tf}"${tf === currentTimeframe ? " selected" : ""}>${tf}</option>`).join("")}
            </select>
          </label>
        </div>
      </header>

      <section class="stream-info">
        <span id="status" data-status="connecting">Connecting…</span>
        <span id="trade-status" data-status="connecting">Trades connecting…</span>
        <code id="stream-url"></code>
      </section>

      <section class="sessions-panel">
        <div class="sessions-head">
          <span class="sessions-title">Trading sessions</span>
          <span id="sessions-utc" class="sessions-utc">UTC —</span>
        </div>
        <div id="sessions" class="sessions-grid"></div>
        <p id="sessions-summary" class="sessions-summary"></p>
      </section>

      <div class="workspace">
        <section class="chart-panel">
          <div id="tv_chart" class="tv-chart"></div>
          <div class="chart-legend">
            <span class="legend-item legend-support">— Support (top ${currentSrCount} buy walls)</span>
            <span class="legend-item legend-resistance">— Resistance (top ${currentSrCount} sell walls)</span>
          </div>
        </section>

        <div class="book-side">
          <section class="aggression-panel">
            <div class="aggression-head">
              <span class="aggression-title">Market aggression</span>
              <span class="aggression-subtitle">Resting orders are passive · market orders hit them</span>
            </div>

            <div id="aggression-headline" class="aggression-headline" data-leader="even">Balanced aggression</div>

            <div class="cvd-row">
              <div class="cvd-block">
                <span class="cvd-label">CVD</span>
                <span id="cvd-value" class="cvd-value" data-leader="even">0</span>
              </div>
              <div id="cvd-slope" class="cvd-slope" data-leader="even">→ flat (30s)</div>
            </div>

            <div class="fight-row-label">Last 60s market volume</div>
            <div id="aggression-meta" class="aggression-meta"></div>
            <div id="aggression-bar" class="battle-bar">
              <div id="aggression-buy" class="battle-fill bid-fill"></div>
              <div id="aggression-sell" class="battle-fill ask-fill"></div>
            </div>

            <div class="fight-row-label">Time &amp; Sales</div>
            <div class="tape-head">
              <span>Time</span>
              <span>Price</span>
              <span>Size</span>
              <span>Side</span>
            </div>
            <div id="tape" class="tape"></div>
          </section>

          <main class="orderbook">
            <div class="col-head">
              <span>Levels</span>
              <span id="price-head">Price</span>
              <span>Size</span>
              <span>Sum</span>
            </div>

            <div id="asks-walls" class="rows"></div>

            <div class="mid-bar">
              <span class="mid-price" id="mid-price">—</span>
              <span class="spread-value" id="spread">—</span>
            </div>

            <div id="bids-walls" class="rows"></div>
          </main>

          <p id="depth-meta" class="depth-meta"></p>
        </div>
      </div>
    </div>`;
}

updateStreamUrl();
renderSessions();
window.setInterval(renderSessions, 30_000);
stream.connect();
tradeStream.connect(currentSymbol, currentMarket);
void chart.load(currentSymbol, currentMarket, currentTimeframe);

window.addEventListener("beforeunload", () => {
  stream.disconnect();
  tradeStream.disconnect();
});
