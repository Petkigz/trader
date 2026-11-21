/**
 * GET /api/backtest — run the strategy against real exchange history.
 *
 *   /api/backtest?strategy=trend&years=8&symbol=BTCUSDT
 *
 * Useful because serverless functions have outbound network access even when
 * your laptop (or corporate proxy) does not. The result is the same object
 * `npm run backtest` writes to disk.
 *
 * Requires DASHBOARD_TOKEN/CRON_SECRET, unless PUBLIC_BACKTEST=true is set
 * deliberately for a throwaway demo.
 */

import { authorize, type MinimalRequest } from "../src/auth.ts";
import { defaultSymbolInfo, runBacktest } from "../src/backtest.ts";
import { loadConfig } from "../src/config.ts";
import { fetchHistory } from "../src/data.ts";
import { BinanceHttp, BinanceMarketData } from "../src/exchange/binance.ts";
import type { Candle } from "../src/types.ts";

export const config = { maxDuration: 60 };

interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

function q(req: MinimalRequest, name: string): string | undefined {
  const v = req.query?.[name];
  return Array.isArray(v) ? v[0] : v;
}

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Access-Control-Allow-Origin", "*");

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    res.status(500).json({ ok: false, error: `configuration invalid: ${(err as Error).message}` });
    return;
  }

  const secret = cfg.security.dashboardToken || cfg.security.cronSecret;
  // Failure is the safe default: this endpoint is expensive and upstream
  // rate-limited, so an open one is a way to have your Vercel quota and your
  // exchange IP reputation spent by a stranger. Paper mode alone is not a
  // reason to leave it open — costs are real in every mode.
  const auth = authorize(req, secret, { allowWhenUnset: cfg.publicBacktest });
  if (!auth.ok) {
    res.status(auth.status).json({ ok: false, error: auth.reason });
    return;
  }

  const strategy = (q(req, "strategy") ?? cfg.strategy) === "pullback" ? "pullback" : "trend";
  const symbol = (q(req, "symbol") ?? cfg.symbol).toUpperCase();
  const capital = clamp(Number(q(req, "capital") ?? 10), 5, 1_000_000);
  const years = clamp(Number(q(req, "years") ?? 8), 1, 15);

  try {
    const md = new BinanceMarketData(new BinanceHttp(cfg.exchange.baseUrl));
    const runCfg = loadConfig({ ...process.env, STRATEGY: strategy, SYMBOL: symbol });

    const daily: Candle[] = await fetchHistory(md, { symbol, interval: "1d", years, maxCandles: 6000 });
    let hourly: Candle[] = [];

    if (strategy === "pullback") {
      const hourlyYears = Math.min(years, 2);
      hourly = await fetchHistory(md, { symbol, interval: "1h", years: hourlyYears, maxCandles: 18_000 });
      const from = daily[0]?.openTime ?? 0;
      hourly = hourly.filter((h) => h.openTime >= from);
    }

    if (daily.length < runCfg.trend.emaPeriod + 10) {
      res.status(400).json({
        ok: false,
        error: `not enough history for EMA${runCfg.trend.emaPeriod}: got ${daily.length} daily candles`,
      });
      return;
    }

    const result = runBacktest({ cfg: runCfg, daily, hourly, capital, info: defaultSymbolInfo(symbol) });

    res.status(200).json({
      ok: true,
      dataPoints: { daily: daily.length, hourly: hourly.length },
      result,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: `backtest failed: ${(err as Error).message}`,
      hint: "the exchange public API must be reachable from this deployment",
    });
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
