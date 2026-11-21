/**
 * Parity harness.
 *
 * Runs the shipped backtester over a deterministic formula-driven market so its
 * output can be compared against the independent SQL reference implementation
 * described in docs/BACKTEST.md. Prints one JSON line.
 *
 *   node scripts/xcheck.ts
 */
import { defaultSymbolInfo, runBacktest } from "../src/backtest.ts";
import { loadConfig } from "../src/config.ts";

const N = 2401;
const base = Date.UTC(2015, 0, 1);
const daily = Array.from({ length: N }, (_, i) => {
  const close = 10000 + 3000 * Math.sin(i / 40) + 20 * i;
  const openTime = base + i * 86_400_000;
  return {
    openTime,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1,
    closeTime: openTime + 86_400_000 - 1,
  };
});

const cfg = loadConfig({
  BOT_MODE: "paper",
  SYMBOL: "BTCUSDT",
  STRATEGY: "trend",
  FEE_RATE: "0.001",
  SLIPPAGE_BPS: "2",
  POSITION_FRACTION: "0.97",
  TREND_EMA_PERIOD: "200",
  TREND_ENTRY_BUFFER: "0.005",
  TREND_EXIT_BUFFER: "0.005",
  TREND_CRASH_STOP: "0.25",
  MAX_DRAWDOWN: "0.3",
  HALT_DAYS: "7",
  MAX_DAILY_LOSS: "0.99",
  MAX_CONSECUTIVE_LOSSES: "9999",
  COOLDOWN_HOURS: "0",
});

const r = runBacktest({ cfg, daily, hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") });
console.log(
  JSON.stringify({
    round_trips: r.trades,
    wins: r.wins,
    final_equity: r.finalEquity,
    max_drawdown_pct: r.maxDrawdownPct,
    fees: r.feesPaid,
    exposure_pct: r.exposurePct,
  }),
);
