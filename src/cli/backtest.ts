#!/usr/bin/env node
/**
 * Backtest the exact strategy and risk code the bot runs.
 *
 *   npm run backtest                          # 8 years of BTCUSDT daily, live data
 *   npm run backtest -- --strategy=pullback --years=2
 *   npm run backtest -- --synthetic           # works offline, deterministic
 *   npm run backtest -- --csv=data/btc.csv    # time,open,high,low,close,volume
 *
 * Requires outbound HTTPS to your exchange's public API unless --synthetic or
 * --csv is used.
 */

import { writeFile } from "node:fs/promises";
import { loadConfig } from "../config.ts";
import { defaultSymbolInfo, runBacktest, type BacktestResult } from "../backtest.ts";
import { fetchHistory, intervalMs, parseCandleCsv, syntheticCandles } from "../data.ts";
import { BinanceHttp, BinanceMarketData } from "../exchange/binance.ts";
import type { Candle, StrategyName } from "../types.ts";
import { DAY_MS } from "../util/num.ts";
import { c, pnlColor, signed, table } from "./format.ts";

interface Flags {
  synthetic: boolean;
  years: number;
  capital: number;
  strategy: StrategyName;
  symbol: string;
  csv?: string;
  out: string;
  quiet: boolean;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : undefined;
  };
  const raw = (get("strategy") ?? process.env.STRATEGY ?? "trend").toLowerCase();
  const strategy: StrategyName = (["trend", "pullback", "meanrev", "ensemble"] as const).includes(
    raw as StrategyName,
  )
    ? (raw as StrategyName)
    : "trend";
  return {
    synthetic: argv.includes("--synthetic"),
    years: Number(get("years") ?? 8),
    capital: Number(get("capital") ?? 10),
    strategy,
    symbol: (get("symbol") ?? process.env.SYMBOL ?? "BTCUSDT").toUpperCase(),
    csv: get("csv"),
    out: get("out") ?? "backtest-report.json",
    quiet: argv.includes("--quiet"),
  };
}

async function loadCsv(path: string): Promise<Candle[]> {
  const { readFile } = await import("node:fs/promises");
  return parseCandleCsv(await readFile(path, "utf8"));
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  process.env.STRATEGY = flags.strategy;
  process.env.SYMBOL = flags.symbol;
  const cfg = loadConfig({ ...process.env, STRATEGY: flags.strategy, SYMBOL: flags.symbol });
  const interval = cfg.strategy === "pullback" ? "1h" : "1d";

  const info = defaultSymbolInfo(flags.symbol);
  let daily: Candle[] = [];
  let hourly: Candle[] = [];

  const t0 = Date.now();

  if (flags.csv) {
    if (!flags.quiet) console.log(c.dim(`loading ${flags.csv}`));
    daily = await loadCsv(flags.csv);
  } else if (flags.synthetic) {
    if (!flags.quiet) console.log(c.dim("generating synthetic market data (offline, deterministic)"));
    daily = syntheticCandles({ interval: "1d", count: Math.ceil(flags.years * 365) + 400, seed: 7 });
    if (cfg.strategy === "pullback") {
      hourly = syntheticCandles({ interval: "1h", count: Math.min(Math.ceil(flags.years * 365 * 24), 20_000) + 400, seed: 11 });
    }
  } else {
    const md = new BinanceMarketData(new BinanceHttp(cfg.exchange.baseUrl));
    if (!flags.quiet) console.log(c.dim(`downloading ${flags.years}y of ${flags.symbol} ${interval} candles from ${cfg.exchange.baseUrl}`));

    // Fetch the daily series, then trim the hourly series to the same window so
    // the pullback strategy sees consistent history.
    let lastPct = -1;
    daily = await fetchHistory(md, {
      symbol: flags.symbol,
      interval: "1d",
      years: flags.years,
      onProgress: (n, oldest) => {
        const pct = Math.floor((n / (flags.years * 365)) * 100);
        if (!flags.quiet && pct !== lastPct && pct % 25 === 0) {
          lastPct = pct;
          console.log(c.dim(`  daily: ${n} candles, back to ${new Date(oldest).toISOString().slice(0, 10)}`));
        }
      },
    });

    if (cfg.strategy === "pullback") {
      const dailyStart = daily[0]?.openTime ?? Date.now() - flags.years * 365 * DAY_MS;
      const hourlyYears = Math.min(flags.years, 3);
      if (!flags.quiet) console.log(c.dim(`downloading ${hourlyYears}y of hourly candles (this is ~${hourlyYears * 8760} bars, give it a moment)`));
      hourly = await fetchHistory(md, {
        symbol: flags.symbol,
        interval: "1h",
        years: hourlyYears,
        maxCandles: 20_000,
      });
      hourly = hourly.filter((h) => h.openTime >= dailyStart);
    }
  }

  if (daily.length < cfg.trend.emaPeriod + 10) {
    console.error(c.red(`not enough history (${daily.length} daily candles) for EMA${cfg.trend.emaPeriod}. Use --years=3 or more.`));
    process.exitCode = 1;
    return;
  }

  const result = runBacktest({ cfg, daily, hourly, capital: flags.capital, info });

  if (!flags.quiet) printReport(result, Date.now() - t0);

  await writeFile(flags.out, JSON.stringify(result, null, 2));
  if (!flags.quiet) console.log(c.grey(`\n  full report written to ${flags.out}`));
}

function printReport(r: BacktestResult, elapsedMs: number): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    c.bold(`  BACKTEST · ${r.symbol} · ${r.strategy.toUpperCase()} · ${new Date(r.start).toISOString().slice(0, 10)} -> ${new Date(r.end).toISOString().slice(0, 10)} (${r.years}y)`),
  );
  lines.push("");

  lines.push(
    table([
      ["started with", `${r.capital.toFixed(2)} USDT`],
      ["ended with", c.bold(`${r.finalEquity.toFixed(2)} USDT`)],
      ["total return", pnlColor(r.totalReturnPct)(`${signed(r.totalReturnPct)}%`)],
      ["CAGR", pnlColor(r.cagrPct)(`${signed(r.cagrPct)}%`)],
      ["buy & hold", pnlColor(r.buyHoldPct)(`${signed(r.buyHoldPct)}%`)],
      ["max drawdown", c.red(`-${r.maxDrawdownPct}%`)],
      ["sharpe", `${r.sharpe}`],
    ]),
  );

  lines.push("");
  lines.push(
    table([
      ["round trips", `${r.trades}`],
      ["win rate", `${r.winRatePct}% (${r.wins}W / ${r.losses}L)`],
      ["avg hold", `${r.avgHoldDays} days`],
      ["best / worst", `${signed(r.bestTradePct)}% / ${signed(r.worstTradePct)}%`],
      ["time in market", `${r.exposurePct}%`],
      ["fees paid", `${r.feesPaid.toFixed(2)} USDT`],
    ]),
  );

  if (r.trades === 0) {
    lines.push("");
    lines.push(c.yellow("  This strategy never traded in this window."));
    lines.push(c.grey(`  Last signal at the end of the window: ${r.lastSignal.action} — ${r.lastSignal.reason}`));
    lines.push(c.grey(`  ${r.lastSignal.detail}`));
  }

  if (r.monthly.length > 1) {
    lines.push("");
    lines.push(c.bold("  MONTHLY EQUITY"));
    const rows = r.monthly.slice(-24);
    for (const m of rows) {
      const bar = makeBar(m.returnPct);
      lines.push(`  ${c.grey(m.month)}  ${m.equity.toFixed(2).padStart(8)}  ${pnlColor(m.returnPct)(signed(m.returnPct, 2).padStart(7))}%  ${bar}`);
    }
  }

  lines.push("");
  lines.push(c.grey(`  simulated in ${elapsedMs}ms`));
  lines.push("");
  console.log(lines.join("\n"));
}

function makeBar(pct: number): string {
  const width = Math.min(Math.round(Math.abs(pct) * 2), 30);
  return pct >= 0 ? c.green("#".repeat(width)) : c.red("#".repeat(width));
}

main().catch((err) => {
  console.error(c.red(`fatal: ${(err as Error).message}`));
  process.exitCode = 1;
});
