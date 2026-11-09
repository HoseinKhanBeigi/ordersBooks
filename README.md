# Orders Book

Real-time Binance **limit order book** (resting bids/asks) plus **aggressive (taker) trades** on the chart.

## How it works

1. **Limit book** — REST depth snapshot + `@depth` WebSocket diffs (spot or futures)
2. **Wall rows** — each price level shows size + cumulative sum; largest walls become S/R lines
3. **Aggressive orders** — `@aggTrade` stream marks market buys/sells on the candle chart (size-filtered vs recent average)

Passive limits sit on the book. Aggressive orders lift/hit those limits and appear as ▲ / ▼ markers at trade price.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173
