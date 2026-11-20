#!/usr/bin/env node
/**
 * What a target actually demands: the arithmetic of "$1/day" and "$300/month".
 *
 *   npm run target
 *   npm run target -- --income=300
 *
 * Three questions that get confused with each other, answered separately:
 *
 *   1. What monthly return does this target require at a given capital?
 *   2. What capital does it require at a given return?
 *   3. How long does compounding take to get from $10 to that capital?
 *
 * Plus the reality check: the largest monthly move any of the 20 assets in
 * `data/real` has ever made, so requirement and precedent sit in one table.
 *
 * The point is not to talk anyone out of a target. It is that the answer to
 * "can I do this with $10" is arithmetic, and arithmetic does not care which
 * broker the account is at.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCandleCsv } from "../src/data.ts";

/** Measured returns this repo has on record, worst-to-best. */
const RETURNS = [
  { label: "9.9%/yr", rate: 0.099, note: "realised with costs and drawdowns (turn 18-19)" },
  { label: "23.3%/yr", rate: 0.233, note: "measured crypto trend, conservative candles" },
  { label: "30.0%/yr", rate: 0.3, note: "re-measured on authentic candles" },
];

const CAPITALS = [10, 100, 1_000, 10_000, 100_000];

function money(x: number): string {
  if (!Number.isFinite(x)) return "never";
  const rounded = Math.round(x);
  return `$${rounded.toLocaleString()}`;
}

function pct(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (x >= 100) return `${Math.round(x).toLocaleString()}%`;
  return `${x.toFixed(1)}%`;
}

/** Capital needed to draw `annualIncome` at `rate`. Simple, no drawdown of principal. */
function capitalFor(annualIncome: number, rate: number): number {
  return annualIncome / rate;
}

/** Years for `start` to compound to `target` at `rate`. */
function yearsTo(start: number, target: number, rate: number): number {
  if (target <= start) return 0;
  return Math.log(target / start) / Math.log(1 + rate);
}

/** Largest rolling return over `window` days for each asset — the precedent. */
async function bestMoves(dir: string, window: number): Promise<Array<{ symbol: string; movePct: number }>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".csv"));
  const out: Array<{ symbol: string; movePct: number }> = [];
  for (const file of files) {
    const candles = parseCandleCsv(await readFile(join(dir, file), "utf8")).filter((c) => c.close > 0);
    let best = -Infinity;
    for (let i = window; i < candles.length; i++) {
      best = Math.max(best, candles[i].close / candles[i - window].close - 1);
    }
    if (Number.isFinite(best)) out.push({ symbol: file.replace(/\.csv$/, ""), movePct: best * 100 });
  }
  return out.sort((a, b) => b.movePct - a.movePct);
}

async function main(): Promise<void> {
  const incomeArg = Number(process.argv.find((a) => a.startsWith("--income="))?.slice(9));
  const monthly = Number.isFinite(incomeArg) && incomeArg > 0 ? incomeArg : 30;
  const annualIncome = monthly * 12;

  console.log(
    `Target: ${money(monthly)}/month (${money(annualIncome)}/year). ` +
      "Ask it as a rate, not an event:\n",
  );

  console.log("1. What monthly return would it demand, at each capital?");
  console.log("capital      monthly return needed      annualised        ");
  for (const capital of CAPITALS) {
    const monthlyReturn = monthly / capital;
    const annualised = monthlyReturn * 12;
    const flag = monthlyReturn > 1 ? "   <- more than doubling every month" : "";
    console.log(
      `${money(capital).padStart(9)}      ${pct(monthlyReturn * 100).padStart(12)} of capital      ` +
        `${pct(annualised * 100).padStart(10)} simple${flag}`,
    );
  }

  console.log("\n2. What capital does it require, at each measured return?");
  console.log("return       capital needed   basis");
  for (const r of RETURNS) {
    console.log(`${r.label.padEnd(10)}   ${money(capitalFor(annualIncome, r.rate)).padStart(13)}   ${r.note}`);
  }

  console.log(`\n3. How long does compounding take to reach that, from $10 and $100?`);
  console.log("return       from $10        from $100");
  for (const r of RETURNS) {
    const target = capitalFor(annualIncome, r.rate);
    const from10 = yearsTo(10, target, r.rate);
    const from100 = yearsTo(100, target, r.rate);
    console.log(
      `${r.label.padEnd(10)}   ${(Number.isFinite(from10) ? `${from10.toFixed(0)} years` : "—").padStart(13)}   ` +
        `${(Number.isFinite(from100) ? `${from100.toFixed(0)} years` : "—").padStart(13)}`,
    );
  }
  console.log(
    "compounding is not a shortcut here — it is the thing that makes the answer slow.",
  );

  const month21 = await bestMoves("data/real", 21);
  const month30 = await bestMoves("data/real", 30);
  const year = await bestMoves("data/real", 252);
  console.log("\n4. Reality check — the biggest month any of the 20 assets has ever had:");
  console.log(`best 21 trading days   ${month21[0].symbol.padEnd(9)} +${pct(month21[0].movePct)}`);
  console.log(`best 30 calendar days  ${month30[0].symbol.padEnd(9)} +${pct(month30[0].movePct)}`);
  console.log(`median best-month      ${pct(month21[Math.floor(month21.length / 2)].movePct)} (across the 20 assets)`);

  console.log(`best 252 days         ${year[0].symbol.padEnd(9)} +${pct(year[0].movePct)} (a single asset, its best year)`);

  // The comparator that matters is the strategy, not a lucky asset: the bot is
  // what would have to deliver, and its best measured year is on record.
  const BEST_STRATEGY_YEAR = 59.8; // 2021, median across the 20 assets (docs/INTELLIGENCE.md)
  console.log(`\nAnd the strategy itself: best measured year +${BEST_STRATEGY_YEAR}% (2021, median across 20 assets).`);

  console.log(`\nSo ${money(monthly)}/month is a demand on the *annual* return, every year:`);
  console.log("capital     return needed    vs the strategy's best year");
  for (const capital of [10, 100, 1_000, 3_636, 10_000]) {
    const needed = (monthly * 12) / capital * 100;
    const ratio = needed / BEST_STRATEGY_YEAR;
    const verdict =
      ratio > 2
        ? `${ratio.toFixed(1)}x the best year ever — not a plan, an impossibility`
        : ratio > 1
          ? `${ratio.toFixed(1)}x the best year ever — needs its best year, every year`
          : `below the best year, and ${
              Math.abs(((monthly * 12) / capital) * 100 - 23.3) < 12 ? "around the measured average" : "within reach"
            }`;
    console.log(`${money(capital).padStart(9)}   ${pct(needed).padStart(12)}    ${verdict}`);
  }
  console.log(
    `\nThe single best month on record (${month30[0].symbol} +${pct(month30[0].movePct)}) shows the target is not\n` +
      "impossible as a one-off event. It is impossible as a rate: 300% a month sustained is\n" +
      "3,600% a year, and the best the strategy has ever done is 59.8%.",
  );
}

void main();
