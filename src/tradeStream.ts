import { aggTradesRestUrl, buildAggTradeUrl, type Market } from "./types";

export type AggressionSide = "buy" | "sell" | "even";

export interface TapeTrade {
  id: number;
  price: number;
  quantity: number;
  time: number;
  side: "buy" | "sell";
}

export interface TradeFlowState {
  tape: TapeTrade[];
  cvd: number;
  buyVolume: number;
  sellVolume: number;
  recentBuyVolume: number;
  recentSellVolume: number;
  cvdSlope: number;
  aggression: AggressionSide;
  aggressionLabel: string;
}

export interface TradeStreamCallbacks {
  onUpdate: (state: TradeFlowState) => void;
  onStatus: (status: "connecting" | "connected" | "disconnected" | "error", message?: string) => void;
}

interface AggTradeEvent {
  e?: string;
  a?: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

interface RestAggTrade {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

const MAX_TAPE = 50;
const BOOTSTRAP_LIMIT = 100;
const RECENT_WINDOW_MS = 60_000;
const SLOPE_WINDOW_MS = 30_000;
const UI_THROTTLE_MS = 120;
const REST_POLL_MS = 2_000;
const MAX_SEEN_IDS = 2_000;

export class BinanceTradeStream {
  private ws: WebSocket | null = null;
  private symbol = "";
  private market: Market = "futures";
  private callbacks: TradeStreamCallbacks;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;

  private tape: TapeTrade[] = [];
  private cvd = 0;
  private buyVolume = 0;
  private sellVolume = 0;
  private recentTrades: { time: number; side: "buy" | "sell"; quantity: number }[] = [];
  private cvdSnapshots: { time: number; cvd: number }[] = [];
  private seenTradeIds = new Set<number>();
  private pendingEmit = false;
  private lastEmitAt = 0;

  constructor(callbacks: TradeStreamCallbacks) {
    this.callbacks = callbacks;
  }

  connect(symbol: string, market: Market): void {
    this.disconnect(false);
    this.symbol = symbol;
    this.market = market;
    this.shouldReconnect = true;
    this.resetState();
    const generation = ++this.generation;

    this.callbacks.onStatus("connecting");
    this.emitNow();

    void this.bootstrapFromRest(generation);

    const url = buildAggTradeUrl(symbol, market);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      if (generation !== this.generation) return;
      this.callbacks.onStatus("connected");
      this.startRestPoll(generation);
    };

    this.ws.onmessage = (event) => {
      if (generation !== this.generation) return;
      this.handleMessage(event.data);
    };

    this.ws.onerror = () => {
      if (generation !== this.generation) return;
      this.callbacks.onStatus("error", "Trade stream error");
    };

    this.ws.onclose = () => {
      if (generation !== this.generation) return;
      this.stopRestPoll();
      this.callbacks.onStatus("disconnected");
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(this.symbol, this.market), 2000);
      }
    };
  }

  updateConfig(symbol: string, market: Market): void {
    if (symbol === this.symbol && market === this.market && this.ws) return;
    this.connect(symbol, market);
  }

  disconnect(permanent = true): void {
    if (permanent) this.shouldReconnect = false;
    this.generation += 1;
    this.stopRestPoll();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private resetState(): void {
    this.tape = [];
    this.cvd = 0;
    this.buyVolume = 0;
    this.sellVolume = 0;
    this.recentTrades = [];
    this.cvdSnapshots = [];
    this.seenTradeIds = new Set();
    this.pendingEmit = false;
    this.lastEmitAt = 0;
  }

  private async bootstrapFromRest(generation: number): Promise<void> {
    try {
      const trades = await fetchRecentAggTrades(this.symbol, this.market, BOOTSTRAP_LIMIT);
      if (generation !== this.generation) return;
      for (const trade of trades) {
        this.ingestTrade(trade, false);
      }
      this.emitNow();
    } catch {
      /* live stream / polling will still try */
    }
  }

  private startRestPoll(generation: number): void {
    this.stopRestPoll();
    this.pollTimer = setInterval(() => {
      void this.pollRecentTrades(generation);
    }, REST_POLL_MS);
  }

  private stopRestPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollRecentTrades(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    try {
      const trades = await fetchRecentAggTrades(this.symbol, this.market, 20);
      if (generation !== this.generation) return;
      let added = false;
      for (const trade of trades) {
        if (this.ingestTrade(trade, false)) added = true;
      }
      if (added) this.scheduleEmit();
    } catch {
      /* ignore transient REST errors */
    }
  }

  private handleMessage(data: unknown): void {
    const raw = readMessageText(data);
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    const record = parsed as Record<string, unknown>;
    const event =
      record.e === "aggTrade"
        ? (record as unknown as AggTradeEvent)
        : record.data && typeof record.data === "object"
          ? (record.data as AggTradeEvent)
          : null;

    if (!event || (event.e && event.e !== "aggTrade")) return;

    const trade = parseAggTrade(event);
    if (!trade) return;
    if (this.ingestTrade(trade, true)) this.scheduleEmit();
  }

  private ingestTrade(trade: TapeTrade, prependTape: boolean): boolean {
    if (this.seenTradeIds.has(trade.id)) return false;
    this.seenTradeIds.add(trade.id);
    if (this.seenTradeIds.size > MAX_SEEN_IDS) {
      const oldest = this.seenTradeIds.values().next().value;
      if (oldest !== undefined) this.seenTradeIds.delete(oldest);
    }

    const delta = trade.side === "buy" ? trade.quantity : -trade.quantity;
    this.cvd += delta;
    if (trade.side === "buy") this.buyVolume += trade.quantity;
    else this.sellVolume += trade.quantity;

    this.recentTrades.push({ time: trade.time, side: trade.side, quantity: trade.quantity });
    this.cvdSnapshots.push({ time: trade.time, cvd: this.cvd });

    const cutoff = Date.now() - RECENT_WINDOW_MS;
    this.recentTrades = this.recentTrades.filter((item) => item.time >= cutoff);
    this.cvdSnapshots = this.cvdSnapshots.filter((item) => item.time >= cutoff);

    if (prependTape) {
      this.tape.unshift(trade);
      if (this.tape.length > MAX_TAPE) this.tape.length = MAX_TAPE;
    } else {
      this.tape.push(trade);
      if (this.tape.length > MAX_TAPE) {
        this.tape = this.tape.slice(-MAX_TAPE);
      }
    }

    return true;
  }

  private scheduleEmit(): void {
    if (this.pendingEmit) return;
    const now = Date.now();
    const wait = Math.max(0, UI_THROTTLE_MS - (now - this.lastEmitAt));
    this.pendingEmit = true;
    setTimeout(() => {
      this.pendingEmit = false;
      this.lastEmitAt = Date.now();
      this.emitNow();
    }, wait);
  }

  private emitNow(): void {
    this.tape.sort((a, b) => b.time - a.time);
    if (this.tape.length > MAX_TAPE) this.tape.length = MAX_TAPE;
    this.callbacks.onUpdate(this.buildState());
  }

  private buildState(): TradeFlowState {
    let recentBuyVolume = 0;
    let recentSellVolume = 0;
    for (const trade of this.recentTrades) {
      if (trade.side === "buy") recentBuyVolume += trade.quantity;
      else recentSellVolume += trade.quantity;
    }

    const now = Date.now();
    const slopeCutoff = now - SLOPE_WINDOW_MS;
    const oldSnapshot = this.cvdSnapshots.find((snap) => snap.time >= slopeCutoff);
    const cvdSlope = oldSnapshot ? this.cvd - oldSnapshot.cvd : 0;

    const aggression = compareAggression(recentBuyVolume, recentSellVolume);
    let aggressionLabel = "Balanced aggression";
    if (aggression === "buy") aggressionLabel = "Buyers aggressing";
    if (aggression === "sell") aggressionLabel = "Sellers aggressing";

    return {
      tape: this.tape,
      cvd: this.cvd,
      buyVolume: this.buyVolume,
      sellVolume: this.sellVolume,
      recentBuyVolume,
      recentSellVolume,
      cvdSlope,
      aggression,
      aggressionLabel,
    };
  }
}

async function fetchRecentAggTrades(
  symbol: string,
  market: Market,
  limit: number,
): Promise<TapeTrade[]> {
  const response = await fetch(aggTradesRestUrl(symbol, market, limit));
  if (!response.ok) throw new Error(`Agg trades failed (${response.status})`);

  const rows = (await response.json()) as RestAggTrade[];
  return rows
    .map((row) => parseAggTrade(row))
    .filter((trade): trade is TapeTrade => trade !== null)
    .sort((a, b) => a.time - b.time);
}

function parseAggTrade(event: AggTradeEvent | RestAggTrade): TapeTrade | null {
  const id = event.a ?? event.T;
  const price = parseFloat(event.p);
  const quantity = parseFloat(event.q);
  if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) return null;

  return {
    id,
    price,
    quantity,
    time: event.T,
    side: event.m ? "sell" : "buy",
  };
}

function readMessageText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return null;
}

function compareAggression(buy: number, sell: number): AggressionSide {
  const total = buy + sell;
  if (total <= 0) return "even";
  const buyPct = (buy / total) * 100;
  const sellPct = (sell / total) * 100;
  if (buyPct > sellPct + 5) return "buy";
  if (sellPct > buyPct + 5) return "sell";
  return "even";
}
