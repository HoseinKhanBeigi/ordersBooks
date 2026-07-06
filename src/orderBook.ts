import { depthRestUrl, type Market } from "./types";

export interface RawLevel {
  price: number;
  quantity: number;
}

export interface DepthDiffEvent {
  e: string;
  E: number;
  s: string;
  U: number;
  u: number;
  b: [string, string][];
  a: [string, string][];
}

export interface RestDepthSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export class LocalOrderBook {
  private bids = new Map<string, number>();
  private asks = new Map<string, number>();
  lastUpdateId = 0;

  loadSnapshot(snapshot: RestDepthSnapshot): void {
    this.bids.clear();
    this.asks.clear();
    for (const [price, qty] of snapshot.bids) {
      const quantity = parseFloat(qty);
      if (quantity > 0) this.bids.set(price, quantity);
    }
    for (const [price, qty] of snapshot.asks) {
      const quantity = parseFloat(qty);
      if (quantity > 0) this.asks.set(price, quantity);
    }
    this.lastUpdateId = snapshot.lastUpdateId;
  }

  applyDiff(event: DepthDiffEvent): boolean {
    if (event.u <= this.lastUpdateId) return false;

    for (const [price, qty] of event.b) {
      const quantity = parseFloat(qty);
      if (quantity === 0) this.bids.delete(price);
      else this.bids.set(price, quantity);
    }

    for (const [price, qty] of event.a) {
      const quantity = parseFloat(qty);
      if (quantity === 0) this.asks.delete(price);
      else this.asks.set(price, quantity);
    }

    this.lastUpdateId = event.u;
    return true;
  }

  getTopBids(count: number): RawLevel[] {
    return [...this.bids.entries()]
      .map(([price, quantity]) => ({ price: parseFloat(price), quantity }))
      .filter((level) => level.quantity > 0)
      .sort((a, b) => b.price - a.price)
      .slice(0, count);
  }

  getTopAsks(count: number): RawLevel[] {
    return [...this.asks.entries()]
      .map(([price, quantity]) => ({ price: parseFloat(price), quantity }))
      .filter((level) => level.quantity > 0)
      .sort((a, b) => a.price - b.price)
      .slice(0, count);
  }
}

export async function fetchDepthSnapshot(
  symbol: string,
  limit: number,
  market: Market,
): Promise<RestDepthSnapshot> {
  const response = await fetch(depthRestUrl(symbol, limit, market));
  if (!response.ok) {
    throw new Error(`Depth snapshot failed (${response.status})`);
  }
  return response.json() as Promise<RestDepthSnapshot>;
}

export function syncOrderBook(
  book: LocalOrderBook,
  snapshot: RestDepthSnapshot,
  buffer: DepthDiffEvent[],
): DepthDiffEvent[] {
  while (buffer.length > 0 && buffer[0].u <= snapshot.lastUpdateId) {
    buffer.shift();
  }

  if (buffer.length > 0 && buffer[0].U > snapshot.lastUpdateId + 1) {
    throw new Error("Snapshot too old — retry");
  }

  book.loadSnapshot(snapshot);

  const remaining: DepthDiffEvent[] = [];
  for (const event of buffer) {
    if (event.u <= book.lastUpdateId) continue;
    book.applyDiff(event);
  }

  return remaining;
}
