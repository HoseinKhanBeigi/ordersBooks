import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createSeriesMarkers,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { AggressiveTrade } from "./aggTradeStream";
import type { Market } from "./types";

export interface SRLevel {
  price: number;
  label: string;
}

/** Numbers only on recent candles so the full history stays readable. */
const LABELLED_CANDLES = 60;

type KlineTuple = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  ...unknown[],
];

interface VolumeCandle extends CandlestickData {
  volume: number;
  takerBuyVolume: number;
}

// Shift timestamps so the axis reads in UTC+3:30 (Iran time)
const TZ_OFFSET_SECONDS = Math.round(3.5 * 3600);

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
};

// Binance returns at most 1500 klines per request.
const KLINES_PER_REQUEST = 1500;
const KLINES_TARGET = 4500;

export class PriceChart {
  private chart: IChartApi;
  private series: ISeriesApi<"Candlestick">;
  private markersApi: ISeriesMarkersPluginApi<Time>;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private priceLines: IPriceLine[] = [];
  /** Per candle open-time: aggregated aggressive buy/sell flow. */
  private aggressiveByCandle = new Map<number, CandleAggression>();
  private candleOrder: number[] = [];
  private seenTradeIds = new Set<number>();
  private lastBar: CandlestickData | null = null;
  private generation = 0;
  private ready = false;
  private interval = "15m";
  private intervalSeconds = INTERVAL_SECONDS["15m"];
  private markerFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#141820" },
        textColor: "#848e9c",
        fontFamily: "Inter, system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "#1e2430" },
        horzLines: { color: "#1e2430" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1e2430" },
      timeScale: { borderColor: "#1e2430", timeVisible: true, secondsVisible: false },
    });

    this.series = this.chart.addSeries(CandlestickSeries, {
      upColor: "#0ecb81",
      downColor: "#f6465d",
      borderVisible: false,
      wickUpColor: "#0ecb81",
      wickDownColor: "#f6465d",
    });

    this.markersApi = createSeriesMarkers(this.series, []);
  }

  async load(symbol: string, market: Market, interval = this.interval): Promise<void> {
    const generation = ++this.generation;
    this.ready = false;
    this.interval = interval;
    this.intervalSeconds = INTERVAL_SECONDS[interval] ?? INTERVAL_SECONDS["15m"];
    this.stopPolling();
    this.clearLines();
    this.clearAggressiveMarkers();

    const candles = await fetchKlines(symbol, market, interval, KLINES_TARGET);
    if (generation !== this.generation) return;

    this.series.setData(
      candles.map(({ time, open, high, low, close }) => ({
        time,
        open,
        high,
        low,
        close,
      })),
    );
    this.lastBar = candles.at(-1) ?? null;

    const referencePrice = this.lastBar?.close ?? 1;
    const precision = decimalsFor(referencePrice);
    this.series.applyOptions({
      priceFormat: {
        type: "price",
        precision,
        minMove: Number((10 ** -precision).toFixed(precision)),
      },
    });

    this.applyVolumeAggression(candles);
    this.flushMarkers();

    this.chart.timeScale().fitContent();
    this.ready = true;
    this.startPolling(symbol, market, generation);
  }

  /** Live taker prints — updates the forming candle between kline polls. */
  addAggressiveTrade(trade: AggressiveTrade): void {
    if (!this.ready || !this.lastBar) return;
    if (this.seenTradeIds.has(trade.id)) return;
    this.seenTradeIds.add(trade.id);

    const time = candleTimeFromMs(trade.timeMs, this.intervalSeconds);
    if ((time as number) !== (this.lastBar.time as number)) return;

    const bucket = this.ensureBucket(time);
    if (trade.side === "buy") {
      bucket.buyQty += trade.qty;
      bucket.buyQuote += trade.quoteQty;
    } else {
      bucket.sellQty += trade.qty;
      bucket.sellQuote += trade.quoteQty;
    }
    this.scheduleMarkerFlush();
  }

  updateLivePrice(price: number): void {
    if (!this.ready || !this.lastBar || !Number.isFinite(price) || price <= 0) return;

    const bucket = (Math.floor(Date.now() / 1000 / this.intervalSeconds) *
      this.intervalSeconds +
      TZ_OFFSET_SECONDS) as UTCTimestamp;

    if (bucket < (this.lastBar.time as number)) return;

    if (bucket > (this.lastBar.time as number)) {
      this.lastBar = { time: bucket, open: price, high: price, low: price, close: price };
      this.ensureBucket(bucket);
    } else {
      this.lastBar = {
        ...this.lastBar,
        close: price,
        high: Math.max(this.lastBar.high, price),
        low: Math.min(this.lastBar.low, price),
      };
    }

    this.series.update(this.lastBar);
  }

  setSupportResistance(supports: SRLevel[], resistances: SRLevel[]): void {
    if (!this.ready) return;
    this.clearLines();

    for (const level of supports) {
      this.priceLines.push(
        this.series.createPriceLine({
          price: level.price,
          color: "#0ecb81",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: level.label,
        }),
      );
    }

    for (const level of resistances) {
      this.priceLines.push(
        this.series.createPriceLine({
          price: level.price,
          color: "#f6465d",
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: level.label,
        }),
      );
    }
  }

  private applyVolumeAggression(candles: VolumeCandle[]): void {
    for (const candle of candles) {
      this.setCandleFromVolume(candle);
    }
  }

  private setCandleFromVolume(candle: VolumeCandle): void {
    const buyQty = Math.max(0, candle.takerBuyVolume);
    const sellQty = Math.max(0, candle.volume - candle.takerBuyVolume);
    const time = candle.time as UTCTimestamp;
    const bucket = this.ensureBucket(time);
    bucket.buyQty = buyQty;
    bucket.sellQty = sellQty;
    // Quote notionals unknown from base volumes alone; size markers by base qty.
    bucket.buyQuote = buyQty;
    bucket.sellQuote = sellQty;
  }

  private ensureBucket(time: UTCTimestamp): CandleAggression {
    const key = time as number;
    let bucket = this.aggressiveByCandle.get(key);
    if (!bucket) {
      bucket = emptyCandleAggression(time);
      this.aggressiveByCandle.set(key, bucket);
      this.candleOrder.push(key);
    }
    return bucket;
  }

  private scheduleMarkerFlush(): void {
    if (this.markerFlushTimer) return;
    this.markerFlushTimer = setTimeout(() => {
      this.markerFlushTimer = null;
      this.flushMarkers();
    }, 250);
  }

  private flushMarkers(): void {
    const mean = this.meanAggressionQty();
    const labelFrom = Math.max(0, this.candleOrder.length - LABELLED_CANDLES);
    const markers: SeriesMarker<Time>[] = [];

    for (let index = 0; index < this.candleOrder.length; index += 1) {
      const key = this.candleOrder[index]!;
      const bucket = this.aggressiveByCandle.get(key);
      if (!bucket) continue;

      const showLabel = index >= labelFrom;

      if (bucket.buyQty > 0) {
        markers.push({
          time: bucket.time,
          position: "aboveBar",
          shape: "arrowUp",
          color: "#0ecb81",
          size: markerSizeFor(bucket.buyQty, mean),
          text: showLabel ? formatCompactQty(bucket.buyQty) : undefined,
        });
      }

      if (bucket.sellQty > 0) {
        markers.push({
          time: bucket.time,
          position: "belowBar",
          shape: "arrowDown",
          color: "#f6465d",
          size: markerSizeFor(bucket.sellQty, mean),
          text: showLabel ? formatCompactQty(bucket.sellQty) : undefined,
        });
      }
    }

    this.markersApi.setMarkers(markers);
  }

  private clearAggressiveMarkers(): void {
    if (this.markerFlushTimer) {
      clearTimeout(this.markerFlushTimer);
      this.markerFlushTimer = null;
    }
    this.aggressiveByCandle.clear();
    this.candleOrder = [];
    this.seenTradeIds.clear();
    this.markersApi.setMarkers([]);
  }

  private meanAggressionQty(): number {
    if (this.candleOrder.length === 0) return 0;
    let total = 0;
    let count = 0;
    for (const key of this.candleOrder) {
      const bucket = this.aggressiveByCandle.get(key);
      if (!bucket) continue;
      total += bucket.buyQty + bucket.sellQty;
      count += 1;
    }
    return count > 0 ? total / count : 0;
  }

  private startPolling(symbol: string, market: Market, generation: number): void {
    const interval = this.interval;
    const poll = async (): Promise<void> => {
      if (generation !== this.generation) return;
      try {
        const candles = await fetchKlines(symbol, market, interval, 2);
        if (generation !== this.generation) return;
        for (const candle of candles) {
          this.series.update({
            time: candle.time,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          });
          this.setCandleFromVolume(candle);
        }
        const latest = candles.at(-1);
        if (latest) {
          this.lastBar = {
            time: latest.time,
            open: latest.open,
            high: latest.high,
            low: latest.low,
            close: latest.close,
          };
        }
        this.flushMarkers();
      } catch {
        /* ignore transient REST errors, retry next tick */
      }
      if (generation === this.generation) {
        this.pollTimer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private clearLines(): void {
    for (const line of this.priceLines) {
      this.series.removePriceLine(line);
    }
    this.priceLines = [];
  }
}

function decimalsFor(price: number): number {
  if (price >= 1000) return 2;
  if (price >= 1) return 3;
  if (price >= 0.1) return 4;
  if (price >= 0.01) return 5;
  if (price >= 0.0001) return 6;
  return 8;
}

interface CandleAggression {
  time: UTCTimestamp;
  buyQuote: number;
  sellQuote: number;
  buyQty: number;
  sellQty: number;
}

function emptyCandleAggression(time: UTCTimestamp): CandleAggression {
  return {
    time,
    buyQuote: 0,
    sellQuote: 0,
    buyQty: 0,
    sellQty: 0,
  };
}

function candleTimeFromMs(timeMs: number, intervalSeconds: number): UTCTimestamp {
  const seconds = Math.floor(timeMs / 1000);
  const bucket =
    Math.floor(seconds / intervalSeconds) * intervalSeconds + TZ_OFFSET_SECONDS;
  return bucket as UTCTimestamp;
}

function markerSizeFor(qty: number, meanQty: number): number {
  if (meanQty <= 0) return 1;
  const ratio = qty / meanQty;
  if (ratio >= 2.5) return 2;
  if (ratio >= 1.4) return 1.4;
  return 1;
}

function formatCompactQty(qty: number): string {
  if (qty >= 1_000_000) return `${(qty / 1_000_000).toFixed(1)}M`;
  if (qty >= 1_000) return `${(qty / 1_000).toFixed(1)}K`;
  if (qty >= 1) return qty.toFixed(1);
  return qty.toFixed(3);
}

async function fetchKlines(
  symbol: string,
  market: Market,
  interval: string,
  targetCount = KLINES_TARGET,
): Promise<VolumeCandle[]> {
  const base =
    market === "futures"
      ? "https://fapi.binance.com/fapi/v1/klines"
      : "https://api.binance.com/api/v3/klines";

  const batches: VolumeCandle[][] = [];
  let endTime: number | undefined;

  while (batches.reduce((sum, batch) => sum + batch.length, 0) < targetCount) {
    const limit = Math.min(
      KLINES_PER_REQUEST,
      targetCount - batches.reduce((sum, b) => sum + b.length, 0),
    );
    const params = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      interval,
      limit: String(limit),
    });
    if (endTime !== undefined) params.set("endTime", String(endTime));

    const response = await fetch(`${base}?${params}`);
    if (!response.ok) throw new Error(`Klines failed (${response.status})`);

    const rows = (await response.json()) as KlineTuple[];
    if (rows.length === 0) break;

    const candles = rows.map((row) => {
      const volume = parseFloat(row[5]);
      const takerBuyVolume = parseFloat(row[9]);
      return {
        time: (row[0] / 1000 + TZ_OFFSET_SECONDS) as UTCTimestamp,
        open: parseFloat(row[1]),
        high: parseFloat(row[2]),
        low: parseFloat(row[3]),
        close: parseFloat(row[4]),
        volume,
        takerBuyVolume,
      };
    });

    batches.unshift(candles);
    endTime = rows[0][0] - 1;

    if (rows.length < limit) break;
  }

  const merged = batches.flat();
  const seen = new Set<number>();
  return merged.filter((candle) => {
    const key = candle.time as number;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
