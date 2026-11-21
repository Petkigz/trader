#!/usr/bin/env node
/**
 * What a given amount of capital actually makes.
 *
 *   npm run income                 # $100
 *   npm run income -- --capital=10
 *   npm run income -- --capital=3636
 *
 * Income is linear in capital at a fixed rate, so this is arithmetic — but the
 * *rate* is the whole argument, and the spread between the rates this repo has
 * measured is 3x. So every figure is given at each rate rather than at a
 * favourite one.
 *
 * The measured cross-check on the middle rate: `npm run catchup` ran the same
 * rule on $100 with 50% deployment over 6.3 years and the median account ended
 * at $185.00 — 1.85x, i.e. 10.1%/yr. That is the number to compare against the
 * table, not the best cell of a backtest.
 */

const RATES = [
  { rate: 0.099, label: "9.9%/yr", note: "realised: 20 assets, costs, drawdowns, busts" },
  { rate: 0.233, label: "23.3%/yr", note: "single-asset backtest, conservative candles" },
  { rate: 0.3, label: "30.0%/yr", note: "best re-measurement — best eight years crypto had" },
];

/**
 * Measured by `npm run daily` over 56,338 asset-days, and pinned there by test:
 * a 1-sigma in-market day is about 2.3% of equity, and 59.3% of days are flat.
 * Re-running that script inside this one would cost seconds to print one line.
 */
const DAILY_SIGMA_PCT = 0.023;
const FLAT_DAY_SHARE = 0.593;

/** From the yearly panel: 19% of years lose money regardless of capital. */
const LOSING_YEAR_SHARE = 0.19;

function money(x: number, dp = 3): string {
  if (!Number.isFinite(x)) return "—";
  const abs = Math.abs(x);
  if (abs >= 1000) return `$${Math.round(x).toLocaleString()}`;
  if (abs >= 1) return `$${x.toFixed(2)}`;
  return `$${x.toFixed(dp)}`;
}

function main(): void {
  const capitalArg = Number(process.argv.find((a) => a.startsWith("--capital="))?.slice(10));
  const capital = Number.isFinite(capitalArg) && capitalArg > 0 ? capitalArg : 100;

  console.log(`Capital ${money(capital)} — what it makes, at each measured rate\n`);
  console.log("rate        per day      per week     per month    per year");
  for (const { rate, label } of RATES) {
    const year = capital * rate;
    console.log(
      `${label.padEnd(10)}  ${money(year / 365).padStart(10)}   ${money(year / 52).padStart(10)}   ` +
        `${money(year / 12).padStart(10)}   ${money(year).padStart(9)}`,
    );
  }

  console.log("\nThe same capital, as the account actually behaves:");
  const swing = capital * DAILY_SIGMA_PCT;
  console.log(`  an ordinary in-market day moves   ${money(swing)} either way (${(DAILY_SIGMA_PCT * 100).toFixed(1)}% of equity)`);
  console.log(`  days that do exactly nothing      ${(FLAT_DAY_SHARE * 100).toFixed(1)}%`);
  console.log(`  years that lose money             ${(LOSING_YEAR_SHARE * 100).toFixed(0)}%`);
  console.log(
    "  the daily figure above is an average across all days, including the quiet ones",
  );

  console.log("\nCapital needed for a given income, at each rate:");
  console.log("income         9.9%/yr      23.3%/yr     30.0%/yr");
  for (const [label, monthly] of [
    ["$1/day", 365 / 12],
    ["$30/mo ($1/day)", 30],
    ["$300/mo ($10/day)", 300],
    ["$1,000/mo", 1000],
  ] as Array<[string, number]>) {
    const cells = RATES.map(({ rate }) => money((monthly * 12) / rate, 0).padStart(12));
    console.log(`${label.padEnd(16)} ${cells.join("  ")}`);
  }

  const crossCheck = 100 * 1.85;
  console.log(
    `\nCross-check, measured rather than modelled: the same rule on $100 with 50% deployed\n` +
      `finished at a median of ${money(crossCheck, 2)} after 6.3 years (npm run catchup) — 1.85x, 10.1%/yr.\n` +
      `That is the 9.9% row above, and it is why the table leads with it.`,
  );
  console.log(
    `\nOn ${money(capital)}: ${money((capital * 0.099) / 365)} a day at the realised rate, against daily swings of\n` +
      `${money(swing)}. The average is real; seeing it in any given week is not.`,
  );
}

main();
