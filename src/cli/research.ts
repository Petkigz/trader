#!/usr/bin/env node
/**
 * Walk-forward research harness.
 *
 *   npm run research                    # 8 years of BTCUSDT, live data
 *   npm run research -- --synthetic     # offline, deterministic
 *   npm run research -- --is=500 --oos=250
 *   npm run research -- --csv=data/btc.csv
 *
 * This is the tool for asking "is there a better formula?". It selects
 * parameters on one window and scores them on the next, counts every test it
 * performs, and prints the score that pure chance would have produced from
 * that many attempts. A parameter set that cannot beat its own luck floor out
 * of sample has not been discovered — it has just been fitted.
 */

import { loadConfig } from "../config.ts";
import { defaultSymbolInfo } from "../backtest.ts";
import { fetchHistory, intervalMs, parseCandleCsv, syntheticCandles } from "../data.ts";
import { BinanceHttp, BinanceMarketData } from "../exchange/binance.ts";
import { defaultGrid, expectedMaxZ, walkForward, type WalkForwardResult } from "../research/walkforward.ts";
import type { Candle } from "../types.ts";
import { c, signed } from "./format.ts";

interface Flags {
  synthetic: boolean;
  years: number;
  capital: number;
  isBars: number;
  oosBars: number;
  symbol: string;
  csv?: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : undefined;
  };
  return {
    synthetic: argv.includes("--synthetic"),
    years: Number(get("years") ?? 8),
    capital: Number(get("capital") ?? 10),
    isBars: Number(get("is") ?? 600),
    oosBars: Number(get("oos") ?? 400),
    symbol: (get("symbol") ?? process.env.SYMBOL ?? "BTCUSDT").toUpperCase(),
    csv: get("csv"),
  };
}

async function loadCsv(path: string): Promise<Candle[]> {
  const { readFile } = await import("node:fs/promises");
  return parseCandleCsv(await readFile(path, "utf8"));
}

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function report(res: WalkForwardResult, label: string): void {
  const pad = (s: string, n: number) => s.padEnd(n);

  console.log();
  console.log(c.bold(`Walk-forward: ${label}`));
  console.log(
    c.dim(
      `  ${res.gridSize} parameter sets x ${res.windows.length} windows = ${res.testsRun} backtests`,
    ),
  );
  console.log();

  console.log(
    c.dim("  #   out-of-sample window        chosen              in-sample   out-of-sample   buy&hold  trades"),
  );
  for (const w of res.windows) {
    const chosen = `EMA${w.chosen.emaPeriod}/${(w.chosen.entryBuffer * 100).toFixed(1)}%`;
    console.log(
      `  ${String(w.index + 1).padEnd(3)} ${pad(`${day(w.oosFrom)}→${day(w.oosTo)}`, 25)} ` +
        `${pad(chosen, 19)} ${pad(signed(w.isReturnPct) + "%", 11)} ` +
        `${pad(signed(w.oosReturnPct) + "%", 15)} ${pad(signed(w.oosBuyHoldPct) + "%", 9)} ${w.oosTrades}`,
    );
  }

  console.log();
  const row = (label: string, value: string, note = "") =>
    console.log(`  ${label.padEnd(31)}${value.padStart(10)}${note}`);

  row("best in-sample score", `${signed(res.inSampleBestPct)}%`);
  row(
    `luck floor (${res.gridSize} sets)`,
    `${signed(res.luckFloorPct)}%`,
    c.dim("   <- below this, a winner is noise"),
  );
  row("out-of-sample compounded", `${signed(res.oosCompoundedPct)}%`);
  row("out-of-sample median window", `${signed(res.oosMedianPct)}%`);
  row(
    "windows profitable",
    `${res.oosPositivePct.toFixed(0)}%`,
    c.dim(`   (${res.windows.filter((w) => w.oosReturnPct > 0).length} of ${res.windows.length})`),
  );
  row("degradation (IS -> OOS median)", `${signed(-res.degradationPct)} pts`);
  console.log();

  if (res.edgeFound) {
    console.log(c.green("  VERDICT: survived. The winner beat its luck floor and made money untouched."));
    console.log(c.dim("           Re-run on more history and a different asset before believing it."));
  } else {
    console.log(c.red("  VERDICT: no edge found."));
    if (res.inSampleBestPct <= res.luckFloorPct) {
      console.log(c.dim("           The best in-sample result was within what chance alone produces."));
    }
    if (res.oosCompoundedPct <= 0) {
      console.log(c.dim("           Chosen parameters lost money on the windows they never saw."));
    }
    console.log(c.dim("           This is the normal outcome. It is what the harness is for."));
  }
  console.log();
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const cfg = loadConfig({ ...process.env, STRATEGY: "trend", SYMBOL: flags.symbol });
  const info = defaultSymbolInfo(flags.symbol);

  let daily: Candle[] = [];

  if (flags.csv) {
    console.log(c.dim(`loading ${flags.csv}`));
    daily = await loadCsv(flags.csv);
  } else if (flags.synthetic) {
    console.log(c.dim("generating synthetic market data (offline, deterministic)"));
    daily = syntheticCandles({
      interval: "1d",
      count: Math.ceil(flags.years * 365) + 400,
      seed: 7,
    });
  } else {
    const md = new BinanceMarketData(new BinanceHttp(cfg.exchange.baseUrl));
    console.log(c.dim(`downloading ${flags.years}y of ${flags.symbol} daily candles`));
    daily = await fetchHistory(md, { symbol: flags.symbol, interval: "1d", years: flags.years });
  }

  // Shrink the windows until at least two fit, rather than failing outright.
  let isBars = flags.isBars;
  let oosBars = flags.oosBars;
  while (isBars + oosBars * 2 > daily.length && oosBars > 120) {
    isBars = Math.round(isBars * 0.8);
    oosBars = Math.round(oosBars * 0.8);
  }
  if (isBars + oosBars * 2 > daily.length) {
    console.error(`not enough history: ${daily.length} bars`);
    process.exitCode = 1;
    return;
  }

  const res = walkForward({
    daily,
    hourly: [],
    baseCfg: cfg,
    capital: flags.capital,
    info,
    grid: defaultGrid(),
    inSampleBars: isBars,
    outSampleBars: oosBars,
  });

  report(
    res,
    `${flags.symbol}, ${daily.length} bars, ${day(daily[0].openTime)} → ${day(daily[daily.length - 1].openTime)}` +
      ` (in-sample ${isBars}, out-of-sample ${oosBars})`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
