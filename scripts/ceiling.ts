#!/usr/bin/env node
/**
 * How hard can this actually be pushed?
 *
 *   npm run ceiling
 *
 * The question behind "what is the maximum I can push it to" is: what is the
 * highest *sustainable* return this edge supports, and what does that pay on a
 * small account? Three separate ceilings, measured rather than asserted:
 *
 *   1. Kelly — the leverage that maximises growth for the measured drift and
 *      volatility. Beyond it, more leverage means less money, not more.
 *   2. The long-only ceiling in the data — the best rolling year any of the 20
 *      assets ever had, chosen with hindsight.
 *   3. The requirement — 36.5x/yr, which is what $1/day costs on a $10 account.
 *
 * The point is the gap between (1) and (3).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { gaussian, mulberry32, parseCandleCsv } from "../src/data.ts";

/** Measured on authentic candles (`docs/BACKTEST.md`): drift and vol of the champion rule. */
const MU = 0.233;
const SIGMA = 0.42;
const BEST_YEAR = 0.598; // 2021, median across the 20 assets
const DAYS = 252;
const PATHS = 20_000;
const SEED = 20261120;
/** A margin call ends the account: equity at 20% of start. */
const RUIN_LEVEL = 0.2;

const GOAL_DOLLARS = 365; // $1/day for a year
const BUDGETS = [10, 100, 1_000, 3_684];

interface Levelled {
  leverage: number;
  /** Median of the log-normal outcome, which sits below the mean by sigma^2/2. */
  medianCagrPct: number;
  meanCagrPct: number;
  ruinPct: number;
  p5Pct: number;
  p95Pct: number;
}

function simulateLeverage(leverage: number): Levelled {
  const rand = mulberry32(SEED);
  const dt = 1 / DAYS;
  const drift = (MU - (SIGMA * SIGMA) / 2) * leverage * dt;
  const vol = SIGMA * leverage * Math.sqrt(dt);
  const finals: number[] = [];
  let ruined = 0;

  for (let path = 0; path < PATHS; path++) {
    let growth = 1;
    for (let day = 0; day < DAYS; day++) {
      growth *= Math.exp(drift + vol * gaussian(rand));
      if (growth <= RUIN_LEVEL) {
        growth = 0;
        break;
      }
    }
    if (growth === 0) ruined++;
    finals.push(growth);
  }

  finals.sort((a, b) => a - b);
  const at = (q: number) => finals[Math.min(finals.length - 1, Math.floor(finals.length * q))];
  return {
    leverage,
    medianCagrPct: (at(0.5) - 1) * 100,
    meanCagrPct: (finals.reduce((a, b) => a + b, 0) / finals.length - 1) * 100,
    ruinPct: (ruined / PATHS) * 100,
    p5Pct: (at(0.05) - 1) * 100,
    p95Pct: (at(0.95) - 1) * 100,
  };
}

/** Growth-optimal leverage for log-normal returns: mu / sigma^2. */
function kelly(): number {
  return MU / (SIGMA * SIGMA);
}

/** Best rolling 252-day return per asset, plus how often the requirement occurs. */
async function dataCeiling(): Promise<{ best: { symbol: string; multiple: number }; sharePct: number; windows: number }> {
  const files = (await readdir("data/real")).filter((f) => f.endsWith(".csv"));
  const required = 1 + GOAL_DOLLARS / 10; // 36.5x, the $1/day requirement on $10
  let windows = 0;
  let hits = 0;
  let best = { symbol: "", multiple: 0 };

  for (const file of files) {
    const candles = parseCandleCsv(await readFile(join("data/real", file), "utf8")).filter((c) => c.close > 0);
    for (let i = 252; i < candles.length; i++) {
      const multiple = candles[i].close / candles[i - 252].close;
      windows++;
      if (multiple >= required) hits++;
      if (multiple > best.multiple) best = { symbol: file.replace(/\.csv$/, ""), multiple };
    }
  }
  return { best, sharePct: (hits / windows) * 100, windows };
}

/** Percentages here span -100% to trillions; readable beats exact. */
function bigPct(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const abs = Math.abs(x);
  if (abs >= 1e9) return `${(x / 1e9).toFixed(1)}B%`;
  if (abs >= 1e6) return `${(x / 1e6).toFixed(1)}M%`;
  if (abs >= 1e5) return `${(x / 1e3).toFixed(0)}k%`;
  return `${x.toFixed(0)}%`;
}

function money(x: number): string {
  return Number.isFinite(x) ? `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";
}

async function main(): Promise<void> {
  const k = kelly();
  console.log("1. The growth-optimal push (Kelly), for the measured edge");
  console.log(`   drift ${(MU * 100).toFixed(1)}%/yr · volatility ${(SIGMA * 100).toFixed(0)}%/yr`);
  console.log(`   Kelly leverage = drift / variance = ${k.toFixed(2)}x\n`);

  console.log("   leverage   median year    mean year   5th..95th percentile     P(margin call)");
  const rows: Levelled[] = [];
  for (const lev of [1, 1.3, 2, 3, 5, 10, 20]) {
    const r = simulateLeverage(lev);
    rows.push(r);
    const flag = Math.abs(lev - 1.3) < 0.05 ? "  <- Kelly optimum" : "";
    console.log(
      `   ${`${lev.toFixed(1)}x`.padStart(8)}   ${`${r.medianCagrPct.toFixed(0)}%`.padStart(11)}   ${`${r.meanCagrPct.toFixed(0)}%`.padStart(9)}   ` +
        `${`${r.p5Pct.toFixed(0)}% .. ${r.p95Pct.toFixed(0)}%`.padStart(22)}   ${`${r.ruinPct.toFixed(1)}%`.padStart(13)}${flag}`,
    );
  }
  const optimum = rows.reduce((a, b) => (b.meanCagrPct > a.meanCagrPct ? b : a));
  const ten = rows.find((r) => r.leverage === 10);
  console.log(
    `\n   Median versus mean matters here: leverage fattens the right tail faster than it\n` +
      `   raises the typical outcome, so a small number of paths look spectacular while most\n` +
      `   end below the unlevered case. At 10x the median year is ${ten?.medianCagrPct.toFixed(0)}% with a ` +
      `${ten?.ruinPct.toFixed(0)}% chance of a margin call,\n` +
      `   against a mean of ${bigPct(ten?.meanCagrPct ?? 0)} driven entirely by a handful of survivors.`,
  );

  console.log("\n2. The long-only ceiling in the data (hindsight, not a strategy)");
  const ceiling = await dataCeiling();
  console.log(
    `   best rolling year of any asset: ${ceiling.best.symbol} at ${ceiling.best.multiple.toFixed(0)}x ` +
      `(${((ceiling.best.multiple - 1) * 100).toFixed(0)}%)`,
  );
  console.log(
    `   rolling years that reached the 36.5x requirement: ${ceiling.sharePct.toFixed(2)}% ` +
      `of ${ceiling.windows.toLocaleString()} asset-years`,
  );
  console.log(
    `   the bot would have to repeat that every year, having picked the asset in advance.`,
  );

  console.log("\n3. What pushing it to the maximum actually pays");
  console.log(
    `   The bot has no leverage path at all today: spot only, position fraction capped below 1.\n` +
      `   So the reachable maximum is the unlevered edge, ${(MU * 100).toFixed(1)}%/yr — Kelly's ${kelly().toFixed(2)}x\n` +
      `   is the most leverage this edge could ever justify, and it is not available on spot.\n`,
  );
  console.log("   budget     at measured edge        needed for $1/day     shortfall");
  const bestMeasured = BEST_YEAR;
  for (const budget of BUDGETS) {
    const perYear = budget * MU;
    const needed = GOAL_DOLLARS / budget;
    console.log(
      `   ${money(budget).padStart(8)}   ${`${money(perYear)}/yr (${money(perYear / 365)}/day)`.padStart(22)}   ` +
        `${`${(needed * 100).toFixed(0)}%/yr`.padStart(18)}   ${`${(needed / MU).toFixed(1)}x`.padStart(8)}`,
    );
  }
  console.log(
    `\n   Even its best year on record (+${(bestMeasured * 100).toFixed(1)}%) pays ` +
      `${money(10 * bestMeasured)} per year on $10 — ` +
      `${money((10 * bestMeasured) / 365)} a day.`,
  );
  console.log(
    `   The maximum sustainable push is therefore about ${(k * MU * 100).toFixed(0)}%/yr, not 3,650%.\n` +
      `   $1/day needs ${money(GOAL_DOLLARS / (k * MU))} at the Kelly-optimal push, or ` +
      `${money(GOAL_DOLLARS / MU)} at the measured average.`,
  );
}

void main();
