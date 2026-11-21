#!/usr/bin/env node
/**
 * Cross-sectional validation across a panel of real assets.
 *
 * The single-asset problem this repo kept hitting: a 34-trade, 8-year backtest
 * cannot separate an edge from luck. This runs the *same* strategy, risk rules
 * and fee model over many assets and asks two questions:
 *
 *   1. Does the core trend rule make money across the cross-section, after fees?
 *   2. Does the ensemble layer beat that core, or was one asset's result noise?
 *
 * Confidence intervals come from a time-block bootstrap over the panel, which
 * keeps cross-asset correlation inside the interval — 20 correlated coins are
 * not 20 independent experiments.
 *
 *   node --experimental-strip-types scripts/xsection.ts --dir=data/real \
 *     --start=2019-01-01 --window=120 --reps=2000 --block=6
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { defaultSymbolInfo, runBacktest, type BacktestResult } from "../src/backtest.ts";
import { parseCandleCsv } from "../src/data.ts";
import { maxDrawdown, sharpe } from "../src/util/indicators.ts";
import { DAY_MS } from "../src/util/num.ts";
import {
  blockBootstrap,
  mean,
  sd,
  sharpeFromMonthly,
  signTestP,
  tStat,
} from "../src/research/stats.ts";
import type { Candle, StrategyName } from "../src/types.ts";

interface Flags {
  dir: string;
  start: string;
  end?: string;
  window: number;
  reps: number;
  block: number;
  capital: number;
  out: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (n: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split("=").slice(1).join("=") : undefined;
  };
  return {
    dir: get("dir") ?? "data/real",
    start: get("start") ?? "2019-01-01",
    end: get("end"),
    window: Number(get("window") ?? 120),
    reps: Number(get("reps") ?? 2000),
    block: Number(get("block") ?? 6),
    capital: Number(get("capital") ?? 10),
    out: get("out") ?? "/tmp/xsection.json",
  };
}

const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

async function loadPanel(dir: string): Promise<Array<{ symbol: string; candles: Candle[] }>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".csv")).sort();
  const out: Array<{ symbol: string; candles: Candle[] }> = [];
  for (const f of files) {
    const candles = parseCandleCsv(await readFile(join(dir, f), "utf8"));
    if (candles.length === 0) continue;
    out.push({ symbol: f.replace(/\.csv$/, ""), candles });
  }
  return out;
}

interface Row {
  symbol: string;
  bars: number;
  years: number;
  trend: BacktestResult;
  ens: BacktestResult;
  bh: { cagrPct: number; sharpe: number; maxDrawdownPct: number };
}

/** Monthly returns (%) keyed by `YYYY-MM`, from a backtest's monthly equity table. */
function monthlyMap(r: BacktestResult): Map<string, number> {
  const m = new Map<string, number>();
  for (const row of r.monthly) m.set(row.month, row.returnPct / 100);
  return m;
}

/** Monthly returns from raw closes, for the buy-and-hold comparator. */
function buyHoldMonthly(candles: readonly Candle[]): Map<string, number> {
  const byMonth = new Map<string, { first: number; last: number }>();
  for (const c of candles) {
    const key = dayKey(c.openTime).slice(0, 7);
    const cur = byMonth.get(key);
    if (cur === undefined) byMonth.set(key, { first: c.open, last: c.close });
    else cur.last = c.close;
  }
  const out = new Map<string, number>();
  for (const [k, v] of byMonth) out.set(k, v.last / v.first - 1);
  return out;
}

function buyHoldStats(candles: readonly Candle[]): Row["bh"] {
  const closes = candles.map((c) => c.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const years = (candles[candles.length - 1].openTime - candles[0].openTime) / (365.25 * DAY_MS);
  const total = closes[closes.length - 1] / closes[0] - 1;
  return {
    cagrPct: ((1 + total) ** (1 / years) - 1) * 100,
    sharpe: sharpe(rets, 365),
    maxDrawdownPct: maxDrawdown(closes) * 100,
  };
}

/**
 * Build a month × asset panel. Months are the union across assets; a month an
 * asset does not have is simply absent from that row, so an asset listing later
 * contributes fewer cells rather than zero-return ones.
 */
function panelOf(maps: ReadonlyArray<Map<string, number>>): Array<number[]> {
  const months = new Set<string>();
  for (const m of maps) for (const k of m.keys()) months.add(k);
  const rows: Array<number[]> = [];
  for (const month of [...months].sort()) {
    const cells: number[] = [];
    for (const m of maps) {
      const v = m.get(month);
      if (v !== undefined) cells.push(v);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/**
 * Paired difference panel, month-major: one row per month, one cell per asset
 * that has both values. Rows must be *months* — the bootstrap resamples rows as
 * time blocks, so a row-per-asset layout would silently resample whole assets
 * and destroy the time structure it is meant to preserve.
 */
function diffPanel(
  a: ReadonlyArray<Map<string, number>>,
  b: ReadonlyArray<Map<string, number>>,
): Array<number[]> {
  const months = new Set<string>();
  for (const m of a) for (const k of m.keys()) months.add(k);
  const rows: Array<number[]> = [];
  for (const month of [...months].sort()) {
    const cells: number[] = [];
    for (let i = 0; i < a.length; i++) {
      const va = a[i].get(month);
      const vb = b[i].get(month);
      if (va !== undefined && vb !== undefined) cells.push(va - vb);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

const pct = (x: number, d = 1): string => (Number.isFinite(x) ? `${x.toFixed(d)}%` : "—");
const num = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : "—");

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const panel = await loadPanel(flags.dir);
  if (panel.length === 0) throw new Error(`no CSVs in ${flags.dir}`);

  // Common window: everything runs on the same calendar so the cross-section is
  // comparing the same market, not different eras.
  const startMs = Date.parse(flags.start);
  const endMs = flags.end
    ? Date.parse(flags.end)
    : Math.min(...panel.map((p) => p.candles[p.candles.length - 1].openTime));

  console.log(`panel: ${panel.length} assets, ${flags.start} → ${dayKey(endMs)}`);
  console.log(`ensemble window ${flags.window}, bootstrap ${flags.reps} reps / ${flags.block}-month blocks\n`);

  const rows: Row[] = [];
  const trendMonthly: Array<Map<string, number>> = [];
  const ensMonthly: Array<Map<string, number>> = [];
  const bhMonthly: Array<Map<string, number>> = [];

  for (const { symbol, candles } of panel) {
    const clipped = candles.filter((c) => c.openTime >= startMs && c.openTime <= endMs);
    const first = candles[0].openTime;
    const last = candles[candles.length - 1].openTime;
    // Require coverage of the whole window, give or take a fortnight of listing gaps.
    if (first > startMs + 14 * DAY_MS || last < endMs - 14 * DAY_MS) {
      console.log(`  skip ${symbol}: covers ${dayKey(first)} → ${dayKey(last)}`);
      continue;
    }
    if (clipped.length < 500) {
      console.log(`  skip ${symbol}: only ${clipped.length} bars in window`);
      continue;
    }

    const base = { ...process.env, SYMBOL: symbol };
    const run = (strategy: StrategyName): BacktestResult =>
      runBacktest({
        cfg: loadConfig({
          ...base,
          STRATEGY: strategy,
          ENSEMBLE_SCORE_WINDOW: String(flags.window),
        }),
        daily: clipped,
        hourly: [],
        capital: flags.capital,
        info: defaultSymbolInfo(symbol),
      });

    const trend = run("trend");
    const ens = run("ensemble");

    rows.push({
      symbol,
      bars: clipped.length,
      years: (clipped[clipped.length - 1].openTime - clipped[0].openTime) / (365.25 * DAY_MS),
      trend,
      ens,
      bh: buyHoldStats(clipped),
    });
    trendMonthly.push(monthlyMap(trend));
    ensMonthly.push(monthlyMap(ens));
    bhMonthly.push(buyHoldMonthly(clipped));
  }

  if (rows.length < 3) throw new Error(`only ${rows.length} usable assets`);

  // ---------- per-asset table ----------
  const head = ["asset", "bars", "trendCAGR", "trendSh", "trendDD", "trades", "ensSh", "ensDD", "bhSh"];
  console.log(head.map((h, i) => (i === 0 ? h.padEnd(9) : h.padStart(9))).join(""));
  for (const r of rows) {
    const line = [
      r.symbol.padEnd(9),
      String(r.bars).padStart(9),
      pct(r.trend.cagrPct).padStart(9),
      num(r.trend.sharpe).padStart(9),
      pct(-r.trend.maxDrawdownPct, 0).padStart(9),
      String(r.trend.trades).padStart(9),
      num(r.ens.sharpe).padStart(9),
      pct(-r.ens.maxDrawdownPct, 0).padStart(9),
      num(r.bh.sharpe).padStart(9),
    ];
    console.log(line.join(""));
  }

  // ---------- aggregates ----------
  const trendCagr = rows.map((r) => r.trend.cagrPct);
  const ensCagr = rows.map((r) => r.ens.cagrPct);
  const bhCagr = rows.map((r) => r.bh.cagrPct);
  const trendSh = rows.map((r) => r.trend.sharpe);
  const ensSh = rows.map((r) => r.ens.sharpe);
  const bhSh = rows.map((r) => r.bh.sharpe);
  const diffSh = rows.map((r) => r.ens.sharpe - r.trend.sharpe);
  const diffDd = rows.map((r) => r.ens.maxDrawdownPct - r.trend.maxDrawdownPct);
  const diffTrades = rows.map((r) => r.ens.trades - r.trend.trades);

  const trendPanel = panelOf(trendMonthly);
  const ensPanel = panelOf(ensMonthly);
  const bhPanel = panelOf(bhMonthly);
  const ensVsTrend = diffPanel(ensMonthly, trendMonthly);
  const trendVsBh = diffPanel(trendMonthly, bhMonthly);

  const boot = (p: Array<number[]>) => blockBootstrap(p, { block: flags.block, reps: flags.reps, seed: 20261120 });
  const bTrend = boot(trendPanel);
  const bEns = boot(ensPanel);
  const bBh = boot(bhPanel);
  const bDiff = boot(ensVsTrend);
  const bVsBh = boot(trendVsBh);

  const wins = diffSh.filter((d) => d > 0).length;
  const ddWins = diffDd.filter((d) => d < 0).length;
  const profitable = rows.filter((r) => r.trend.cagrPct > 0).length;

  console.log(`\n--- aggregates over ${rows.length} assets ---`);
  console.log(`median CAGR      trend ${pct(mean(trendCagr))}   ens ${pct(mean(ensCagr))}   buy&hold ${pct(mean(bhCagr))}`);
  console.log(`median Sharpe    trend ${num(median(trendSh))}   ens ${num(median(ensSh))}   buy&hold ${num(median(bhSh))}`);
  console.log(`assets profitable after fees (trend): ${profitable}/${rows.length}`);
  console.log(`trend CAGR > buy&hold CAGR: ${rows.filter((r) => r.trend.cagrPct > r.bh.cagrPct).length}/${rows.length}`);
  console.log(`trend Sharpe > buy&hold Sharpe: ${rows.filter((r) => r.trend.sharpe > r.bh.sharpe).length}/${rows.length}`);

  console.log(`\n--- ensemble vs trend, paired ---`);
  console.log(`Sharpe better on ${wins}/${rows.length} assets  (sign test p=${num(signTestP(wins, rows.length), 3)})  mean diff ${num(mean(diffSh), 3)}  t=${num(tStat(diffSh))}`);
  console.log(`drawdown better on ${ddWins}/${rows.length} assets  mean diff ${pct(mean(diffDd))}`);
  console.log(`trades: trend ${num(mean(rows.map((r) => r.trend.trades)), 1)} vs ens ${num(mean(rows.map((r) => r.ens.trades)), 1)}  (mean diff ${num(mean(diffTrades), 1)})`);

  console.log(`\n--- block bootstrap, monthly mean return, ${flags.block}-month blocks ---`);
  const show = (label: string, b: ReturnType<typeof boot>): void => {
    console.log(
      `${label.padEnd(16)} mean/month ${pct(b.observed * 100, 2).padStart(7)}  ` +
        `95% CI [${pct(b.lo95 * 100, 2)}, ${pct(b.hi95 * 100, 2)}]  ` +
        `wrong-sign ${pct(b.wrongSign * 100, 1)}  → ${pct(((1 + b.observed) ** 12 - 1) * 100, 1)}/yr`,
    );
  };
  show("trend", bTrend);
  show("ensemble", bEns);
  show("buy & hold", bBh);
  show("ens − trend", bDiff);
  show("trend − b&h", bVsBh);

  const payload = {
    generatedAt: new Date().toISOString(),
    window: flags.window,
    start: flags.start,
    end: dayKey(endMs),
    assets: rows.map((r) => ({
      symbol: r.symbol,
      bars: r.bars,
      years: r.years,
      trend: pick(r.trend),
      ens: pick(r.ens),
      bh: r.bh,
    })),
    aggregates: {
      trendCagrMean: mean(trendCagr),
      ensCagrMean: mean(ensCagr),
      bhCagrMean: mean(bhCagr),
      trendSharpeMedian: median(trendSh),
      ensSharpeMedian: median(ensSh),
      bhSharpeMedian: median(bhSh),
      profitable,
      ensSharpeWins: wins,
      ensDdWins: ddWins,
      diffSharpeMean: mean(diffSh),
      diffSharpeT: tStat(diffSh),
      diffSharpeSd: sd(diffSh),
      signTestP: signTestP(wins, rows.length),
    },
    bootstrap: {
      trend: bTrend,
      ens: bEns,
      bh: bBh,
      ensVsTrend: bDiff,
      trendVsBh: bVsBh,
    },
    monthlySharpe: {
      trend: sharpeFromMonthly(trendPanel.flat()),
      ens: sharpeFromMonthly(ensPanel.flat()),
      bh: sharpeFromMonthly(bhPanel.flat()),
    },
  };
  await writeFile(flags.out, JSON.stringify(payload, null, 2));
  console.log(`\nwrote ${flags.out}`);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pick(r: BacktestResult): Record<string, number> {
  return {
    cagrPct: r.cagrPct,
    sharpe: r.sharpe,
    maxDrawdownPct: r.maxDrawdownPct,
    trades: r.trades,
    winRatePct: r.winRatePct,
    exposurePct: r.exposurePct,
    finalEquity: r.finalEquity,
  };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
