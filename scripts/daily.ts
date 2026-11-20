#!/usr/bin/env node
/**
 * What "$1/day" looks like one day at a time.
 *
 *   npm run daily
 *   npm run daily -- --capital=3636
 *
 * "$1/day" is an *average*: $365 a year. It has never meant $1 every calendar
 * day, and this measures the difference at the capital that produces it. The
 * rule holds a position ~40% of the time and trades about four times a year, so
 * most days nothing happens at all and the money arrives in a few jumps.
 *
 * Runs the real strategy through the real backtester on all 20 assets, at the
 * capital each one needs, and reports the distribution of daily dollar changes.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultSymbolInfo, runBacktest } from "../src/backtest.ts";
import { loadConfig } from "../src/config.ts";
import { parseCandleCsv } from "../src/data.ts";

const DIR = "data/real";

function money(x: number): string {
  const sign = x < 0 ? "-" : "";
  const abs = Math.abs(x);
  if (abs >= 1000) return `${sign}$${Math.round(abs).toLocaleString()}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const capitalArg = Number(process.argv.find((a) => a.startsWith("--capital="))?.slice(10));
  const capital = Number.isFinite(capitalArg) && capitalArg > 0 ? capitalArg : 3_636;

  const cfg = loadConfig({ ...process.env, BOT_MODE: "paper", STRATEGY: "trend" });
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".csv")).sort();

  const changes: number[] = [];
  let flat = 0;
  let total = 0;
  let best = { day: -Infinity, symbol: "" };
  let worst = { day: Infinity, symbol: "" };
  const flatRuns: number[] = [];

  for (const file of files) {
    const symbol = file.replace(/\.csv$/, "");
    const daily = parseCandleCsv(await readFile(join(DIR, file), "utf8"));
    const result = runBacktest({
      cfg: { ...cfg, symbol },
      daily,
      hourly: [],
      capital,
      info: defaultSymbolInfo(symbol),
      fullCurve: true,
    });

    const curve = result.equityCurve;
    let run = 0;
    for (let i = 1; i < curve.length; i++) {
      const prev = curve[i - 1].equity;
      if (!(prev > 0)) continue;
      // Measure the day as a *fraction* of the equity then, and re-price it at
      // the capital under discussion. Using raw dollars would report the swings
      // of a balance that has compounded 100x, not of a $3,636 account.
      const delta = curve[i].equity / prev - 1;
      total++;
      changes.push(delta);
      if (Math.abs(delta * capital) < 0.01) {
        flat++;
        run++;
      } else {
        if (run > 0) flatRuns.push(run);
        run = 0;
      }
      if (delta > best.day) best = { day: delta, symbol };
      if (delta < worst.day) worst = { day: delta, symbol };
    }
    if (run > 0) flatRuns.push(run);
  }

  changes.sort((a, b) => a - b);
  const dollars = (f: number) => f * capital;
  const at = (q: number) => changes[Math.min(changes.length - 1, Math.floor(changes.length * q))];
  const up1 = changes.filter((d) => dollars(d) >= 1).length;
  const down1 = changes.filter((d) => dollars(d) <= -1).length;
  const annual = capital * 0.099;

  console.log(`The rule, day by day, at ${money(capital)} across ${files.length} assets`);
  console.log(`${total.toLocaleString()} asset-days measured\n`);

  console.log(
    `"$1/day" at this capital means ${money(annual / 365)} a day *on average* — ${money(annual)} a year.`,
  );
  console.log(`What any single day actually looks like:\n`);
  console.log(`  nothing happened (|change| < 1c)   ${pct(flat / total).padStart(7)} of days`);
  console.log(`  gained $1 or more                  ${pct(up1 / total).padStart(7)} of days`);
  console.log(`  lost $1 or more                    ${pct(down1 / total).padStart(7)} of days`);
  console.log(`  median day                         ${money(dollars(at(0.5))).padStart(7)}`);
  console.log(
    `  10th-90th percentile               ${money(dollars(at(0.1))).padStart(7)} to ${money(dollars(at(0.9)))}  (${pct(at(0.1))} to ${pct(at(0.9))} of equity)`,
  );

  const longestFlat = flatRuns.length > 0 ? Math.max(...flatRuns) : 0;
  console.log(`\n  longest stretch with no change     ${longestFlat} days`);
  console.log(`  biggest single day                 ${money(dollars(best.day))} (${best.symbol}, +${pct(best.day)})`);
  console.log(`  worst single day                   ${money(dollars(worst.day))} (${worst.symbol}, ${pct(worst.day)})`);

  // "It can make more than $1 on a good day" — so how much more, how often?
  console.log("\nHow much a day clears the $1 target, and by how much:");
  console.log("  threshold                       days        share");
  for (const t of [1, 5, 10, 30, 100, 365]) {
    const n = changes.filter((d) => dollars(d) >= t).length;
    console.log(`  gained $${String(t).padEnd(5)} or more          ${String(n).padStart(7)}        ${pct(n / total).padStart(6)}`);
  }
  const wins = changes.filter((d) => dollars(d) >= 1).sort((a, b) => a - b);
  if (wins.length > 0) {
    console.log(`  median winning day              ${money(dollars(wins[Math.floor(wins.length / 2)])).padStart(7)}`);
  }
  const upSum = changes.filter((d) => d > 0).reduce((a, b) => a + b, 0);
  const downSum = changes.filter((d) => d < 0).reduce((a, b) => a + b, 0);
  console.log(
    `  all up-days in total            ${money(dollars(upSum)).padStart(7)}\n` +
      `  all down-days in total          ${money(dollars(downSum)).padStart(7)}   (per asset, over its whole history)`,
  );

  // Where the year's money actually comes from.
  const positive = changes.filter((d) => d > 0).reverse();
  const top = positive.slice(0, 10).reduce((a, b) => a + b, 0);
  const allPositive = positive.reduce((a, b) => a + b, 0);
  console.log(
    `\n  the 10 best days contributed       ${pct(top / allPositive)} of all up-days' gains`,
  );

  console.log(
    `\nThe point: to average $1/day you have to sit through swings of ${money(Math.abs(dollars(at(0.9))))}\n` +
      `a day — about ${Math.round(Math.abs(dollars(at(0.9))))}x the daily goal — and ${pct(flat / total)} of days pay nothing at all.\n` +
      `So: ${money(annual)} a year, and ${pct(flat / total)} of days produce exactly $0.00. This is not a\n` +
      `daily wage, it is four jumps a year with long silences between them. If $1 every\n` +
      `calendar day is the requirement rather than $1/day on average, no capital and no\n` +
      `tweak to this bot delivers it — only an instrument that pays continuously does.\n` +
      `A 4%/yr deposit yields $1/day on ${money(365 / 0.04)} with certainty, and never more.`,
  );
}

void main();
