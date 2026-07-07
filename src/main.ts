import { BinanceDepthStream, type ConnectionStatus } from "./depthStream";
import { PriceChart, type SRLevel } from "./chart";
import type { BookDepth, Market, OrderBookState, UpdateSpeed, WallBucket } from "./types";
import { buildStreamUrl } from "./types";
import "./style.css";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "FARTCOINUSDT","XAUUSDT"];
const DEPTHS: BookDepth[] = [20, 50, 100, 500];
const SR_COUNTS = [1,2,3,4,5,6, 12, 18, 24];
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
const battleBar = document.getElementById("battle-bar")!;
const battleBid = document.getElementById("battle-bid")!;
const battleAsk = document.getElementById("battle-ask")!;
const battleVerdict = document.getElementById("battle-verdict")!;
const nearBar = document.getElementById("near-bar")!;
const nearBid = document.getElementById("near-bid")!;
const nearAsk = document.getElementById("near-ask")!;
const nearVerdict = document.getElementById("near-verdict")!;
const depthMetaEl = document.getElementById("depth-meta")!;
const priceHeadEl = document.getElementById("price-head")!;
const marketSelect = document.getElementById("market") as HTMLSelectElement;
const symbolSelect = document.getElementById("symbol") as HTMLSelectElement;
const depthSelect = document.getElementById("depth") as HTMLSelectElement;
const speedSelect = document.getElementById("speed") as HTMLSelectElement;
const srSelect = document.getElementById("sr") as HTMLSelectElement;
const legendSupportEl = document.querySelector(".legend-support")!;
const legendResistanceEl = document.querySelector(".legend-resistance")!;

const chart = new PriceChart(document.getElementById("tv_chart")!);
let lastSRUpdate = 0;

const stream = new BinanceDepthStream(
  { symbol: currentSymbol, depth: currentDepth, speed: currentSpeed, market: currentMarket },
  {
    onUpdate: (state) => {
      renderWalls(state);
      updateNearStrength(state);
      updateSupportResistance(state);
      chart.updateLivePrice(state.midPrice);
    },
    onStatus: (status, message) => {
      setStatus(status, message);
    },
  },
);

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

function syncUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("market", currentMarket);
  url.searchParams.set("symbol", currentSymbol);
  url.searchParams.set("depth", String(currentDepth));
  url.searchParams.set("speed", currentSpeed);
  url.searchParams.set("sr", String(currentSrCount));
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
  void chart.load(currentSymbol, currentMarket);
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

function sumFirstLevels(buckets: WallBucket[], levels: number): number {
  let sum = 0;
  let covered = 0;
  for (const bucket of buckets) {
    const bucketLevels = bucket.levelTo - bucket.levelFrom + 1;
    if (covered + bucketLevels <= levels) {
      sum += bucket.sumQty;
      covered += bucketLevels;
    } else {
      const need = levels - covered;
      sum += bucket.sumQty * (need / bucketLevels);
      break;
    }
    if (covered >= levels) break;
  }
  return sum;
}

function updateNearStrength(state: OrderBookState): void {
  const bidTop = sumFirstLevels(state.bidBuckets, 4);
  const askTop = sumFirstLevels(state.askBuckets, 4);
  const total = bidTop + askTop;
  const bidPct = total > 0 ? (bidTop / total) * 100 : 50;
  const askPct = total > 0 ? (askTop / total) * 100 : 50;

  nearBid.style.width = `${bidPct}%`;
  nearAsk.style.width = `${askPct}%`;

  let leader: "bid" | "ask" | "even" = "even";
  let headline = "Balanced";
  if (bidPct > askPct + 2) {
    leader = "bid";
    headline = `Buyers stronger (${bidPct.toFixed(0)}%)`;
  } else if (askPct > bidPct + 2) {
    leader = "ask";
    headline = `Sellers stronger (${askPct.toFixed(0)}%)`;
  }

  nearBar.dataset.leader = leader;
  nearVerdict.dataset.leader = leader;
  nearVerdict.innerHTML = `
    <span class="verdict-buy">Buy ${formatCompact(bidTop)}</span>
    <span class="verdict-headline">${headline}</span>
    <span class="verdict-sell">Sell ${formatCompact(askTop)}</span>`;
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

  battleBid.style.width = `${state.bidStrength}%`;
  battleAsk.style.width = `${state.askStrength}%`;

  const bidPct = state.bidStrength.toFixed(0);
  const askPct = state.askStrength.toFixed(0);

  let leader: "bid" | "ask" | "even" = "even";
  let headline = "Buyers and sellers balanced";
  if (state.bidStrength > state.askStrength + 2) {
    leader = "bid";
    headline = `Buyers stronger (${bidPct}%)`;
  } else if (state.askStrength > state.bidStrength + 2) {
    leader = "ask";
    headline = `Sellers stronger (${askPct}%)`;
  }

  battleBar.dataset.leader = leader;
  battleVerdict.dataset.leader = leader;
  battleVerdict.innerHTML = `
    <span class="verdict-buy">Buyers ${bidPct}%</span>
    <span class="verdict-headline">${headline}</span>
    <span class="verdict-sell">Sellers ${askPct}%</span>`;
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
        </div>
      </header>

      <section class="stream-info">
        <span id="status" data-status="connecting">Connecting…</span>
        <code id="stream-url"></code>
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
          <section class="verdict-panel">
            <div id="battle-verdict" class="battle-verdict"></div>
            <div id="battle-bar" class="battle-bar">
              <div id="battle-bid" class="battle-fill bid-fill"></div>
              <div id="battle-ask" class="battle-fill ask-fill"></div>
            </div>

            <div class="near-title">Levels 1 + 2 + 3 + 4 combined — who's stronger</div>
            <div id="near-verdict" class="battle-verdict"></div>
            <div id="near-bar" class="battle-bar">
              <div id="near-bid" class="battle-fill bid-fill"></div>
              <div id="near-ask" class="battle-fill ask-fill"></div>
            </div>
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
stream.connect();
void chart.load(currentSymbol, currentMarket);

window.addEventListener("beforeunload", () => stream.disconnect());
