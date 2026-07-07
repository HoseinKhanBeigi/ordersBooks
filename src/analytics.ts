import type { OrderBookState, WallBucket } from "./types";

export interface NearestWall {
  price: number;
  qty: number;
  cumulative: number;
  distancePercent: number;
  ageMs: number;
}

export interface PersistentLevel {
  price: number;
  side: "bid" | "ask";
  qty: number;
  ageMs: number;
  distancePercent: number;
}

export interface AnalyticsResult {
  imbalanceRatio: number;
  imbalanceLabel: string;
  dominantSide: "bid" | "ask" | "even";
  nearestBidWall: NearestWall | null;
  nearestAskWall: NearestWall | null;
  persistentLevels: PersistentLevel[];
}

interface TrackedWall {
  side: "bid" | "ask";
  firstSeen: number;
  lastSeen: number;
  maxQty: number;
}

const SIGNIFICANCE_FACTOR = 2;
const PRUNE_AFTER_MS = 4_000;

function meanQty(buckets: WallBucket[]): number {
  if (buckets.length === 0) return 0;
  const total = buckets.reduce((sum, bucket) => sum + bucket.sumQty, 0);
  return total / buckets.length;
}

function significantBuckets(
  buckets: WallBucket[],
  side: "bid" | "ask",
  midPrice: number,
): WallBucket[] {
  const threshold = meanQty(buckets) * SIGNIFICANCE_FACTOR;
  return buckets.filter((bucket) => {
    const onCorrectSide =
      side === "bid" ? bucket.priceFrom < midPrice : bucket.priceFrom > midPrice;
    return onCorrectSide && bucket.sumQty >= threshold;
  });
}

export class BookAnalytics {
  private tracked = new Map<string, TrackedWall>();

  update(state: OrderBookState): AnalyticsResult {
    const now = Date.now();
    const { midPrice } = state;

    const bidWalls = significantBuckets(state.bidBuckets, "bid", midPrice);
    const askWalls = significantBuckets(state.askBuckets, "ask", midPrice);

    this.trackWalls(bidWalls, "bid", now);
    this.trackWalls(askWalls, "ask", now);
    this.prune(now);

    const ratio =
      state.askWallTotal > 0
        ? state.bidWallTotal / state.askWallTotal
        : state.bidWallTotal > 0
          ? Infinity
          : 1;

    let dominantSide: "bid" | "ask" | "even" = "even";
    if (state.bidStrength > state.askStrength + 2) dominantSide = "bid";
    else if (state.askStrength > state.bidStrength + 2) dominantSide = "ask";

    return {
      imbalanceRatio: ratio,
      imbalanceLabel: formatRatio(ratio),
      dominantSide,
      nearestBidWall: this.nearest(bidWalls, "bid", midPrice, now),
      nearestAskWall: this.nearest(askWalls, "ask", midPrice, now),
      persistentLevels: this.topPersistent(midPrice, now),
    };
  }

  private trackWalls(
    walls: WallBucket[],
    side: "bid" | "ask",
    now: number,
  ): void {
    for (const wall of walls) {
      const key = `${side}:${wall.priceFrom}`;
      const existing = this.tracked.get(key);
      if (existing) {
        existing.lastSeen = now;
        existing.maxQty = Math.max(existing.maxQty, wall.sumQty);
      } else {
        this.tracked.set(key, {
          side,
          firstSeen: now,
          lastSeen: now,
          maxQty: wall.sumQty,
        });
      }
    }
  }

  private prune(now: number): void {
    for (const [key, wall] of this.tracked) {
      if (now - wall.lastSeen > PRUNE_AFTER_MS) {
        this.tracked.delete(key);
      }
    }
  }

  private ageForPrice(side: "bid" | "ask", price: number, now: number): number {
    const tracked = this.tracked.get(`${side}:${price}`);
    return tracked ? now - tracked.firstSeen : 0;
  }

  private nearest(
    walls: WallBucket[],
    side: "bid" | "ask",
    midPrice: number,
    now: number,
  ): NearestWall | null {
    if (walls.length === 0 || midPrice <= 0) return null;
    const closest = walls.reduce((best, wall) =>
      Math.abs(wall.priceFrom - midPrice) < Math.abs(best.priceFrom - midPrice)
        ? wall
        : best,
    );
    return {
      price: closest.priceFrom,
      qty: closest.sumQty,
      cumulative: closest.cumulative,
      distancePercent: (Math.abs(closest.priceFrom - midPrice) / midPrice) * 100,
      ageMs: this.ageForPrice(side, closest.priceFrom, now),
    };
  }

  private topPersistent(midPrice: number, now: number): PersistentLevel[] {
    const levels: PersistentLevel[] = [];
    for (const [key, wall] of this.tracked) {
      const price = Number(key.slice(key.indexOf(":") + 1));
      if (!Number.isFinite(price) || midPrice <= 0) continue;
      levels.push({
        price,
        side: wall.side,
        qty: wall.maxQty,
        ageMs: now - wall.firstSeen,
        distancePercent: (Math.abs(price - midPrice) / midPrice) * 100,
      });
    }
    return levels.sort((a, b) => b.ageMs - a.ageMs).slice(0, 4);
  }
}

function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "∞ : 1";
  if (ratio >= 1) return `${ratio.toFixed(2)} : 1`;
  return `1 : ${(1 / ratio).toFixed(2)}`;
}

export function formatAge(ageMs: number): string {
  const totalSeconds = Math.floor(ageMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}
