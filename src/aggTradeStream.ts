import {
  aggTradesRestUrl,
  buildAggTradeUrl,
  type Market,
} from "./types";

export type AggressiveSide = "buy" | "sell";

export interface AggressiveTrade {
  id: number;
  price: number;
  qty: number;
  quoteQty: number;
  side: AggressiveSide;
  timeMs: number;
}

export type AggTradeStatus = "connecting" | "connected" | "disconnected" | "error";

export interface AggTradeStreamCallbacks {
  onTrade: (trade: AggressiveTrade) => void;
  onStatus?: (status: AggTradeStatus, message?: string) => void;
}

interface RawAggTradeEvent {
  e: string;
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

interface RawAggTradeRest {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export class BinanceAggTradeStream {
  private ws: WebSocket | null = null;
  private symbol: string;
  private market: Market;
  private callbacks: AggTradeStreamCallbacks;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private generation = 0;

  constructor(
    symbol: string,
    market: Market,
    callbacks: AggTradeStreamCallbacks,
  ) {
    this.symbol = symbol;
    this.market = market;
    this.callbacks = callbacks;
  }

  connect(): void {
    this.disconnect(false);
    this.shouldReconnect = true;
    const generation = ++this.generation;

    this.callbacks.onStatus?.("connecting");
    this.ws = new WebSocket(buildAggTradeUrl(this.symbol, this.market));

    this.ws.onopen = () => {
      if (generation !== this.generation) return;
      this.callbacks.onStatus?.("connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as RawAggTradeEvent;
        if (payload.e !== "aggTrade") return;
        this.callbacks.onTrade(parseAggTrade(payload));
      } catch {
        this.callbacks.onStatus?.("error", "Failed to parse agg trade");
      }
    };

    this.ws.onerror = () => {
      this.callbacks.onStatus?.("error", "AggTrade WebSocket error");
    };

    this.ws.onclose = () => {
      this.callbacks.onStatus?.("disconnected");
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    };
  }

  update(symbol: string, market: Market): void {
    this.symbol = symbol;
    this.market = market;
    this.connect();
  }

  disconnect(permanent = true): void {
    if (permanent) this.shouldReconnect = false;
    this.generation += 1;
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
}

export async function fetchRecentAggTrades(
  symbol: string,
  market: Market,
  limit = 200,
): Promise<AggressiveTrade[]> {
  const response = await fetch(aggTradesRestUrl(symbol, market, limit));
  if (!response.ok) {
    throw new Error(`Agg trades failed (${response.status})`);
  }
  const rows = (await response.json()) as RawAggTradeRest[];
  return rows.map(parseAggTrade);
}

function parseAggTrade(raw: RawAggTradeEvent | RawAggTradeRest): AggressiveTrade {
  const price = parseFloat(raw.p);
  const qty = parseFloat(raw.q);
  return {
    id: raw.a,
    price,
    qty,
    quoteQty: price * qty,
    // m = buyer is maker → seller was the aggressor (market sell)
    side: raw.m ? "sell" : "buy",
    timeMs: raw.T,
  };
}
