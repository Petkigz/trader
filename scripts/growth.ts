#!/usr/bin/env node
/**
 * "Does it grow every day, or only every four years?"
 *
 *   node --experimental-strip-types scripts/growth.ts --dir=data/real
 *
 * Answered from the champion's own daily equity curve on 20 assets:
 *
 *   - how often a day is up, down, or flat;
 *   - how much of the total growth came from the best handful of days;
 *   - how long the account sits between new highs (the "four years" feel);
 *   - which calendar years actually paid.
 *
 * The point is to show that a trend follower earns in bursts, and that the
 * bursts are unpredictable in timing — which is why "make it back tomorrow" is
 * a coin flip, not a plan.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultSymbolInfo, runBacktest, type OverlayCtx } from "../src/backtest.ts";
import { loadConfig } from "../src/config.ts";
import { parseCandleCsv } from "../src/data.ts";
import { median } from "../src/research/stats.ts";
import type { Candle } from "../src/types.ts";
import { DAY_MS } from "../src/util/num.ts";

const START = Date.parse("2020-01-01");
const CAPITAL = 10;

async function loadPanel(dir: string): Promise<Array<{ symbol: string; candles: Candle[] }>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".csv")).sort();
  const out: Array<{ symbol: string; candles: Candle[] }> = [];
  for (const f of files) {
    const candles = parseCandleCsv(await readFile(join(dir, f), "utf8")).filter(
      (c) => c.openTime >= START,
    );
    if (candles.length < 500) continue;
    out.push({ symbol: f.replace(/\.csv$/, ""), candles });
  }
  return out;
}

interface Curve {
  symbol: string;
  points: Array<{ ts: number; equity: number }>;
  exposurePct: number;
}

function curveFor(symbol: string, candles: Candle[]): Curve {
  const cfg = loadConfig({ ...process.env, SYMBOL: symbol, STRATEGY: "trend" });
  const points: Array<{ ts: number; equity: number }> = [];
  const r = runBacktest({
    cfg,
    daily: candles,
    hourly: [],
    capital: CAPITAL,
    info: defaultSymbolInfo(symbol),
    overlay: (ctx: OverlayCtx) => {
      points.push({ ts: ctx.ts, equity: ctx.equity });
      return {};
    },
  });
  return { symbol, points, exposurePct: r.exposurePct };
}

/** Days from each new high to the next new high. */
function gapsBetweenHighs(points: Array<{ ts: number; equity: number }>): number[] {
  const gaps: number[] = [];
  let peak = -Infinity;
  let peakTs: number | null = null;
  for (const p of points) {
    if (p.equity >= peak) {
      if (peakTs !== null) gaps.push((p.ts - peakTs) / DAY_MS);
      peak = p.equity;
      peakTs = p.ts;
    }
  }
  return gaps;
}

async function main(): Promise<void> {
  const dir = arg("dir") ?? "data/real";
  const panel = await loadPanel(dir);
  if (panel.length === 0) throw new Error(`no CSVs in ${dir}`);

  const curves = panel.map(({ symbol, candles }) => curveFor(symbol, candles));
  const allDays = curves.flatMap((c) => c.points);
  const lastTs = Math.max(...allDays.map((p) => p.ts));
  const years = (lastTs - START) / (365.25 * DAY_MS);

  // Pooled daily returns across every asset-day.
  const daily: number[] = [];
  const logGrowth: number[] = [];
  for (const c of curves) {
    for (let i = 1; i < c.points.length; i++) {
      const prev = c.points[i - 1].equity;
      const now = c.points[i].equity;
      if (prev > 0) {
        daily.push(now / prev - 1);
        logGrowth.push(Math.log(now / prev));
      }
    }
  }

  daily.sort((a, b) => a - b);
  const up = daily.filter((r) => r > 0).length;
  const down = daily.filter((r) => r < 0).length;
  const flat = daily.length - up - down;
  const pct = (n: number) => `${((n / daily.length) * 100).toFixed(0)}%`;

  console.log(`panel: ${panel.length} assets · champion "trend" · ${years.toFixed(1)} years\n`);

  console.log("how often does a day do anything?");
  console.log(`  up days    ${pct(up)}`);
  console.log(`  down days  ${pct(down)}`);
  console.log(`  flat days  ${pct(flat)}   (out of the market — cash, no position)`);
  console.log(
    `  median daily move  ${(median(daily) * 100).toFixed(3)}%  ·  ` +
      `best ${(daily[daily.length - 1] * 100).toFixed(1)}%  ·  worst ${(daily[0] * 100).toFixed(1)}%`,
  );
  console.log(
    `  median time in market  ${median(curves.map((c) => c.exposurePct)).toFixed(0)}% of days`,
  );

  console.log("\nwhere does the money actually come from? (per asset, then median)");
  const winners = curves
    .map((c) => {
      const logs: number[] = [];
      for (let i = 1; i < c.points.length; i++) {
        const prev = c.points[i - 1].equity;
        if (prev > 0) logs.push(Math.log(c.points[i].equity / prev));
      }
      return { logs, total: logs.reduce((a, b) => a + b, 0) };
    })
    // Only assets with a material gain: a +2% asset makes every share look
    // absurd, because the denominator is noise.
    .filter((c) => c.total > Math.log(1.2));
  console.log(`  assets ending 20%+ up: ${winners.length}/${curves.length}`);
  for (const frac of [0.01, 0.05, 0.1]) {
    const shares = winners.map(({ logs, total }) => {
      const sorted = [...logs].sort((a, b) => b - a);
      const k = Math.max(1, Math.round(sorted.length * frac));
      return (sorted.slice(0, k).reduce((a, b) => a + b, 0) / total) * 100;
    });
    // Over 100% is the interesting case: the best days earned more than the
    // final gain, and everything else gave some of it back.
    console.log(
      `  best ${(frac * 100).toFixed(0).padStart(2)}% of days = ${(median(shares) / 100).toFixed(1)}x the final gain`,
    );
  }
  const daysToAll = winners.map(({ logs, total }) => {
    let running = 0;
    let count = 0;
    for (const r of [...logs].sort((a, b) => b - a)) {
      if (running >= total) break;
      running += r;
      count++;
    }
    return { count, share: (count / logs.length) * 100 };
  });
  console.log(
    `  median: ${median(daysToAll.map((d) => d.count)).toFixed(0)} days out of ~2,300 ` +
      `(${median(daysToAll.map((d) => d.share)).toFixed(1)}% of days) account for the entire gain`,
  );

  console.log("\nhow long between new highs? (the 'every four years' feeling)");
  const gaps = curves.flatMap((c) => gapsBetweenHighs(c.points));
  gaps.sort((a, b) => a - b);
  const q = (f: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * f))];
  console.log(`  median   ${median(gaps).toFixed(0)} days`);
  console.log(`  75th pct ${q(0.75).toFixed(0)} days`);
  console.log(`  90th pct ${q(0.9).toFixed(0)} days  (${(q(0.9) / 365.25).toFixed(1)} years)`);
  console.log(`  worst    ${gaps[gaps.length - 1].toFixed(0)} days  (${(gaps[gaps.length - 1] / 365.25).toFixed(1)} years)`);
  const overYear = gaps.filter((g) => g > 365.25).length;
  console.log(
    `  ${((overYear / gaps.length) * 100).toFixed(0)}% of the waits were longer than a year`,
  );

  // Per asset: this year's end equity against last year's end (or the first day
  // seen). Then the median across assets — summing logs across assets would
  // multiply twenty different markets together, which is meaningless.
  console.log("\nby calendar year (each asset's own return, then median across assets):");
  const yearsSeen = [...new Set(curves.flatMap((c) => c.points.map((p) => new Date(p.ts).getUTCFullYear())))].sort();
  for (const year of yearsSeen) {
    const perAsset: number[] = [];
    for (const c of curves) {
      const inYear = c.points.filter((p) => new Date(p.ts).getUTCFullYear() === year);
      if (inYear.length < 20) continue;
      const start = inYear[0].equity;
      const end = inYear[inYear.length - 1].equity;
      if (start > 0) perAsset.push((end / start - 1) * 100);
    }
    if (perAsset.length === 0) continue;
    const med = median(perAsset);
    const up = perAsset.filter((x) => x > 0).length;
    console.log(
      `  ${year}  ${med >= 0 ? "+" : ""}${med.toFixed(1)}%  ` +
        `(${up}/${perAsset.length} assets up, range ${Math.min(...perAsset).toFixed(0)}% to ${Math.max(...perAsset).toFixed(0)}%)`,
    );
  }

  console.log(
    "\nso: it does not grow every day. It stands in cash, waits, and then moves —\n" +
      "in bursts whose timing nobody can schedule. Some of those bursts are a year apart.",
  );
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

void (async () => {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();
