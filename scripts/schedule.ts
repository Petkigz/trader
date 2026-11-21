#!/usr/bin/env node
/**
 * When does it pay? A compounding schedule for a starting balance.
 *
 *   npm run schedule
 *   npm run schedule -- --start=100
 *
 * The request is simple and this is the simple answer to it: start with $10,
 * let it compound, and income rises with the balance — $1/day at one size,
 * $300/month at another. Nothing here changes that mechanism. It only asks how
 * long it takes at a rate that has actually been measured.
 *
 * Two things worth knowing before reading the table:
 *
 *   "$1/day" is $30/month. "$300/month" is $10/day. They are ten apart, so they
 *   land at very different balances and very different dates.
 *
 *   The bot does not have a special "small account" boost: percentage returns
 *   are roughly flat with size. What changes with size is that fixed frictions
 *   ($5 minimum order, 0.00001 BTC lot step, 0.2% round-trip fee) stop mattering.
 *   At $10 they cost several percent a year; at $10,000 they are a rounding
 *   error. That is a real improvement, and it is worth a couple of points — not
 *   the difference between 23% and 3,650%.
 */

/**
 * Three rates this repo has measured, most conservative first. The 9.9% is the
 * one to read: it is what the rule actually delivered across a 20-asset panel
 * once costs, drawdowns and busts are counted (`npm run catchup`).
 */
const RATES = [
  { rate: 0.099, label: "9.9%/yr", note: "realised across 20 assets, costs and drawdowns included" },
  { rate: 0.233, label: "23.3%/yr", note: "single-asset backtest, conservative candles" },
  { rate: 0.3, label: "30.0%/yr", note: "re-measured, best eight years crypto had" },
];

/** Income targets, as monthly dollars. */
const TARGETS = [
  { monthly: 30, label: "$1/day ($30/mo)" },
  { monthly: 300, label: "$300/mo ($10/day)" },
];

const NOW_YEAR = new Date().getFullYear();

function money(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (Math.abs(x) >= 1000) return `$${Math.round(x).toLocaleString()}`;
  return `$${x.toFixed(2)}`;
}

/** Balance that throws off `monthly` at `rate`, assuming capital is untouched. */
function capitalFor(monthly: number, rate: number): number {
  return (monthly * 12) / rate;
}

function yearsTo(start: number, target: number, rate: number): number {
  if (start >= target) return 0;
  return Math.log(target / start) / Math.log(1 + rate);
}

async function main(): Promise<void> {
  const startArg = Number(process.argv.find((a) => a.startsWith("--start="))?.slice(8));
  const starts = Number.isFinite(startArg) && startArg > 0 ? [startArg] : [10, 100, 1_000];

  console.log(`Compounding schedule · from ${starts.map(money).join(", ")} · today is ${NOW_YEAR}\n`);

  for (const target of TARGETS) {
    console.log(`${target.label}`);
    console.log("target balance by rate: " + RATES.map((r) => `${money(capitalFor(target.monthly, r.rate))} at ${r.label}`).join(" · "));
    console.log("start       9.9%/yr            23.3%/yr           30.0%/yr");
    for (const start of starts) {
      const cells = RATES.map(({ rate }) => {
        const capital = capitalFor(target.monthly, rate);
        if (start >= capital) return "already there";
        const years = yearsTo(start, capital, rate);
        return `${years.toFixed(0)}y → ${NOW_YEAR + Math.round(years)}`;
      });
      console.log(`${money(start).padStart(7)}     ${cells[0].padEnd(18)} ${cells[1].padEnd(18)} ${cells[2]}`);
    }
    console.log();
  }

  // The claim worth testing directly: does a bigger balance earn a better rate?
  console.log("Does a bigger balance earn a better rate? Measured, same 6.3 years (npm run catchup):");
  console.log("  $10  → $18.17 median   1.82x   = 9.9%/yr");
  console.log("  $100 → $185.00 median  1.85x   = 10.1%/yr");
  console.log(
    "  Ten times the capital produced ten times the dollars and 0.2 points of rate.\n" +
      "  Capital moves the date; it does not move the rate. The one true scale effect is\n" +
      "  friction: a $5 minimum order and a 0.2% fee cost a $10 account several percent a\n" +
      "  year and a $10,000 account almost nothing, which is worth a point or two — and it\n" +
      "  is already inside the 9.9%.\n",
  );

  // What the balance is worth as the years pass, so the curve is visible.
  const start = starts[0];
  console.log(`The same path in income — starting at ${money(start)}, at 23.3%/yr:`);
  console.log("year       balance      monthly income     per day");
  for (const year of [1, 5, 10, 20, 30, 40]) {
    const balance = start * Math.pow(1.233, year);
    const monthly = (balance * 0.233) / 12;
    console.log(
      `${String(NOW_YEAR + year).padEnd(9)}  ${money(balance).padStart(10)}   ${money(monthly).padStart(15)}   ${money(monthly / 30).padStart(8)}`,
    );
  }

  console.log(
    "\nWhat this schedule assumes, stated because the table cannot show it:\n" +
      "  - the average return, every year, with no losing years. The measured record has\n" +
      "    19% losing years and a -61% peak-to-trough drawdown along the way.\n" +
      "  - no withdrawals. Taking income out slows the compounding that produces it.\n" +
      "  - no bust: on the 6.9-year panel, 1 of 20 assets ended below its start.\n" +
      "  - fees are inside the 23.3%. Adding capital never changes the rate; it changes\n" +
      "    the date.",
  );
}

void main();
