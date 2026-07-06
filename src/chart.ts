import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Market } from "./types";

export interface SRLevel {
  price: number;
  label: string;
}

type KlineTuple = [number, string, string, string, string, string, ...unknown[]];

const INTERVAL = "15m";
const INTERVAL_SECONDS = 15 * 60;
// Shift timestamps so the axis reads in UTC+3:30 (Iran time)
const TZ_OFFSET_SECONDS = Math.round(3.5 * 3600);

export class PriceChart {
  private chart: IChartApi;
  private series: ISeriesApi<"Candlestick">;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private priceLines: IPriceLine[] = [];
  private lastBar: CandlestickData | null = null;
  private generation = 0;
  private ready = false;

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
  }

  async load(symbol: string, market: Market): Promise<void> {
    const generation = ++this.generation;
    this.ready = false;
    this.stopPolling();
    this.clearLines();

    const candles = await fetchKlines(symbol, market, 300);
    if (generation !== this.generation) return;

    this.series.setData(candles);
    this.lastBar = candles.at(-1) ?? null;

    const referencePrice = this.lastBar?.close ?? candles.at(-1)?.close ?? 1;
    const precision = decimalsFor(referencePrice);
    this.series.applyOptions({
      priceFormat: {
        type: "price",
        precision,
        minMove: Number((10 ** -precision).toFixed(precision)),
      },
    });

    this.chart.timeScale().fitContent();
    this.ready = true;
    this.startPolling(symbol, market, generation);
  }

  updateLivePrice(price: number): void {
    if (!this.ready || !this.lastBar || !Number.isFinite(price) || price <= 0) return;

    const bucket = (Math.floor(Date.now() / 1000 / INTERVAL_SECONDS) *
      INTERVAL_SECONDS +
      TZ_OFFSET_SECONDS) as UTCTimestamp;

    if (bucket < (this.lastBar.time as number)) return;

    if (bucket > (this.lastBar.time as number)) {
      this.lastBar = { time: bucket, open: price, high: price, low: price, close: price };
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

  private startPolling(symbol: string, market: Market, generation: number): void {
    const poll = async (): Promise<void> => {
      if (generation !== this.generation) return;
      try {
        const candles = await fetchKlines(symbol, market, 2);
        if (generation !== this.generation) return;
        for (const candle of candles) {
          this.series.update(candle);
        }
        const latest = candles.at(-1);
        if (latest) this.lastBar = latest;
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

async function fetchKlines(
  symbol: string,
  market: Market,
  limit: number,
): Promise<CandlestickData[]> {
  const base =
    market === "futures"
      ? "https://fapi.binance.com/fapi/v1/klines"
      : "https://api.binance.com/api/v3/klines";
  const response = await fetch(
    `${base}?symbol=${symbol.toUpperCase()}&interval=${INTERVAL}&limit=${limit}`,
  );
  if (!response.ok) throw new Error(`Klines failed (${response.status})`);

  const rows = (await response.json()) as KlineTuple[];
  return rows.map((row) => ({
    time: (row[0] / 1000 + TZ_OFFSET_SECONDS) as UTCTimestamp,
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
  }));
}
