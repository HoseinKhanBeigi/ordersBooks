# Orders Book

Real-time Binance order book with **deep depth** (20–500 levels), grouped into buckets of 5. Each wall row shows **Sum(coin)** for that group — e.g. Sum(BTC) for levels 1–5, 6–10, etc.

## How it works

1. **REST snapshot** — fetches full depth (`/api/v3/depth?limit=100`) for more than 20 levels
2. **Diff WebSocket** — `wss://stream.binance.com:9443/ws/btcusdt@depth@100ms` keeps the local book updated
3. **Group by 5** — top 100 levels → 20 wall rows per side
4. **Sum per group** — wall strength (`▮▮▮▮▮`) is based on total coin in that 5-level bucket

## Example (100 depth)

| Group | Levels | Shows |
|-------|--------|-------|
| 1 | L1–L5 (near mid) | Sum(BTC) + blocks |
| 2 | L6–L10 | Sum(BTC) + blocks |
| … | … | … |
| 20 | L96–L100 | Sum(BTC) + blocks |

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173
# ordersBooks
