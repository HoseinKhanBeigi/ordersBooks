import type { RawLevel } from "./orderBook";

export type BookDepth = 20 | 50 | 100 | 500;
export type UpdateSpeed = "100ms" | "1000ms";
export type Market = "spot" | "futures";
export const GROUP_SIZE = 1;

export interface WallBucket {
  groupIndex: number;
  levelFrom: number;
  levelTo: number;
  priceFrom: number;
  priceTo: number;
  sumQty: number;
  cumulative: number;
  wallBlocks: number;
  qtyPercent: number;
}

export interface OrderBookState {
  symbol: string;
  baseAsset: string;
  bidBuckets: WallBucket[];
  askBuckets: WallBucket[];
  spread: number;
  spreadPercent: number;
  midPrice: number;
  lastUpdateId: number;
  updatedAt: number;
  bidWallTotal: number;
  askWallTotal: number;
  bidStrength: number;
  askStrength: number;
  depth: BookDepth;
  groupSize: number;
}

export interface StreamConfig {
  symbol: string;
  depth: BookDepth;
  speed: UpdateSpeed;
  market: Market;
}

export function baseAssetFromSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  for (const quote of ["USDT", "USDC", "BUSD", "BTC", "ETH", "BNB"]) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return upper.slice(0, -quote.length);
    }
  }
  return upper;
}

export function buildStreamUrl(config: StreamConfig): string {
  const symbol = config.symbol.toLowerCase();

  if (config.market === "futures") {
    // Futures diff depth supports @100ms and @500ms (no 1000ms)
    const speedSuffix = config.speed === "100ms" ? "@100ms" : "@500ms";
    return `wss://fstream.binance.com/ws/${symbol}@depth${speedSuffix}`;
  }

  const speedSuffix = config.speed === "100ms" ? "@100ms" : "";
  return `wss://stream.binance.com:9443/ws/${symbol}@depth${speedSuffix}`;
}

export function buildAggTradeUrl(symbol: string, market: Market): string {
  const lower = symbol.toLowerCase();
  if (market === "futures") {
    return `wss://fstream.binance.com/ws/${lower}@aggTrade`;
  }
  return `wss://stream.binance.com:9443/ws/${lower}@aggTrade`;
}

export function aggTradesRestUrl(symbol: string, market: Market, limit: number): string {
  const upper = symbol.toUpperCase();
  if (market === "futures") {
    return `https://fapi.binance.com/fapi/v1/aggTrades?symbol=${upper}&limit=${limit}`;
  }
  return `https://api.binance.com/api/v3/aggTrades?symbol=${upper}&limit=${limit}`;
}

export function depthRestUrl(
  symbol: string,
  limit: number,
  market: Market,
): string {
  const upper = symbol.toUpperCase();
  if (market === "futures") {
    return `https://fapi.binance.com/fapi/v1/depth?symbol=${upper}&limit=${limit}`;
  }
  return `https://api.binance.com/api/v3/depth?symbol=${upper}&limit=${limit}`;
}

export function buildWallBuckets(
  levels: RawLevel[],
  groupSize: number,
  side: "bid" | "ask",
): WallBucket[] {
  const buckets: WallBucket[] = [];

  for (let index = 0; index < levels.length; index += groupSize) {
    const slice = levels.slice(index, index + groupSize);
    if (slice.length === 0) break;

    const prices = slice.map((level) => level.price);
    const sumQty = slice.reduce((sum, level) => sum + level.quantity, 0);

    buckets.push({
      groupIndex: index / groupSize,
      levelFrom: index + 1,
      levelTo: index + slice.length,
      priceFrom: side === "bid" ? Math.max(...prices) : Math.min(...prices),
      priceTo: side === "bid" ? Math.min(...prices) : Math.max(...prices),
      sumQty,
      cumulative: 0,
      wallBlocks: 0,
      qtyPercent: 0,
    });
  }

  const maxSum = Math.max(...buckets.map((bucket) => bucket.sumQty), 0.000001);

  let running = 0;
  return buckets.map((bucket) => {
    running += bucket.sumQty;
    return {
      ...bucket,
      cumulative: running,
      wallBlocks: Math.max(1, Math.round((bucket.sumQty / maxSum) * 5)),
      qtyPercent: (bucket.sumQty / maxSum) * 100,
    };
  });
}

export function buildOrderBookState(
  symbol: string,
  depth: BookDepth,
  bids: RawLevel[],
  asks: RawLevel[],
  lastUpdateId: number,
): OrderBookState {
  const bidBuckets = buildWallBuckets(bids, GROUP_SIZE, "bid");
  const askBuckets = buildWallBuckets(asks, GROUP_SIZE, "ask");

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
  const spread = bestAsk - bestBid;
  const spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : 0;

  const bidWallTotal = bidBuckets.reduce((sum, bucket) => sum + bucket.sumQty, 0);
  const askWallTotal = askBuckets.reduce((sum, bucket) => sum + bucket.sumQty, 0);
  const totalWall = bidWallTotal + askWallTotal;
  const bidStrength = totalWall > 0 ? (bidWallTotal / totalWall) * 100 : 50;
  const askStrength = totalWall > 0 ? (askWallTotal / totalWall) * 100 : 50;

  return {
    symbol: symbol.toUpperCase(),
    baseAsset: baseAssetFromSymbol(symbol),
    bidBuckets,
    askBuckets,
    spread,
    spreadPercent,
    midPrice,
    lastUpdateId,
    updatedAt: Date.now(),
    bidWallTotal,
    askWallTotal,
    bidStrength,
    askStrength,
    depth,
    groupSize: GROUP_SIZE,
  };
}
