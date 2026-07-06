import {
  fetchDepthSnapshot,
  LocalOrderBook,
  syncOrderBook,
  type DepthDiffEvent,
} from "./orderBook";
import { buildOrderBookState, buildStreamUrl, type OrderBookState, type StreamConfig } from "./types";

export type ConnectionStatus = "connecting" | "syncing" | "connected" | "disconnected" | "error";

export interface DepthStreamCallbacks {
  onUpdate: (state: OrderBookState) => void;
  onStatus: (status: ConnectionStatus, message?: string) => void;
}

export class BinanceDepthStream {
  private ws: WebSocket | null = null;
  private config: StreamConfig;
  private callbacks: DepthStreamCallbacks;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private book = new LocalOrderBook();
  private eventBuffer: DepthDiffEvent[] = [];
  private synced = false;
  private generation = 0;

  constructor(config: StreamConfig, callbacks: DepthStreamCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  connect(): void {
    this.disconnect(false);
    this.shouldReconnect = true;
    this.synced = false;
    this.eventBuffer = [];
    this.book = new LocalOrderBook();
    const generation = ++this.generation;

    this.callbacks.onStatus("connecting");

    const url = buildStreamUrl(this.config);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      void this.bootstrap(generation);
    };

    this.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as DepthDiffEvent;
        if (payload.e !== "depthUpdate") return;

        if (!this.synced) {
          this.eventBuffer.push(payload);
          return;
        }

        if (this.book.applyDiff(payload)) {
          this.emitState();
        }
      } catch {
        this.callbacks.onStatus("error", "Failed to parse depth update");
      }
    };

    this.ws.onerror = () => {
      this.callbacks.onStatus("error", "WebSocket connection error");
    };

    this.ws.onclose = () => {
      this.synced = false;
      this.callbacks.onStatus("disconnected");
      if (this.shouldReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    };
  }

  private async bootstrap(generation: number): Promise<void> {
    this.callbacks.onStatus("syncing");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (generation !== this.generation) return;

      try {
        const snapshot = await fetchDepthSnapshot(
          this.config.symbol,
          this.config.depth,
          this.config.market,
        );
        if (generation !== this.generation) return;

        syncOrderBook(this.book, snapshot, this.eventBuffer);
        this.synced = true;
        this.callbacks.onStatus("connected");
        this.emitState();
        return;
      } catch {
        await sleep(300);
      }
    }

    if (generation === this.generation) {
      this.callbacks.onStatus("error", "Failed to sync order book");
      this.ws?.close();
    }
  }

  private emitState(): void {
    const bids = this.book.getTopBids(this.config.depth);
    const asks = this.book.getTopAsks(this.config.depth);
    const state = buildOrderBookState(
      this.config.symbol,
      this.config.depth,
      bids,
      asks,
      this.book.lastUpdateId,
    );
    this.callbacks.onUpdate(state);
  }

  updateConfig(config: StreamConfig): void {
    this.config = config;
    this.connect();
  }

  disconnect(permanent = true): void {
    if (permanent) {
      this.shouldReconnect = false;
    }
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
    this.synced = false;
    this.eventBuffer = [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
