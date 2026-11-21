#!/usr/bin/env node
/**
 * Take the request literally: X dollars a day, from Y dollars of capital.
 *
 *   npm run required                          # $1/day from $10
 *   npm run required -- --capital=100 --per-day=10
 *
 * This does not argue about strategy. It converts the request into the one
 * number that decides it — the daily return percentage — and then states what
 * that number implies, using this repo's own market data and long-run
 * track records that are public.
 *
 * If the implied return is achievable, the script says so and quotes what it
 * would take. If it is not, it shows why, in a form that does not depend on
 * trusting this repository.
 */

/** Global gross product, ~$110T, for the "how big does this get" check. */
const WORLD_GDP = 110e12;
const TRADING_DAYS = 252;

const COMPARISONS: Array<{ label: string; annualPct: number; source: string }> = [
  { label: "Buffett, 1965-2024 (Berkshire)", annualPct: 19.9, source: "Berkshire annual letters" },
  { label: "Best long-run hedge fund (Medallion, gross)", annualPct: 66, source: "public estimates" },
  { label: "This bot, realised across 20 assets", annualPct: 9.9, source: "npm run catchup" },
  { label: "Bitcoin, best calendar year (2013)", annualPct: 5_500, source: "price history" },
  { label: "Best single year of any of the 20 assets here", annualPct: 21_036, source: "data/real, DOGE" },
];

function money(x: number): string {
  if (!Number.isFinite(x)) return "—";
  // Past a point the digits stop meaning anything; the ratio to world output is
  // the only reading a person can actually feel.
  if (x >= 1e15) {
    const worlds = x / WORLD_GDP;
    return `${worlds.toLocaleString(undefined, { maximumFractionDigits: 0 })}x the world economy`;
  }
  if (x >= 1e12) return `$${(x / 1e12).toFixed(1)} trillion`;
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)} billion`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)} million`;
  if (x >= 1000) return `$${Math.round(x).toLocaleString()}`;
  return `$${x.toFixed(2)}`;
}

function pct(x: number): string {
  if (x >= 1e6) return `${(x / 1e6).toFixed(0)}M%`;
  if (x >= 1e4) return `${Math.round(x).toLocaleString()}%`;
  return `${x.toFixed(x < 10 ? 2 : 0)}%`;
}

function main(): void {
  const args = process.argv.slice(2);
  const capital = Number(args.find((a) => a.startsWith("--capital="))?.slice(10)) || 10;
  const perDay = Number(args.find((a) => a.startsWith("--per-day="))?.slice(10)) || 1;

  const dailyPct = (perDay / capital) * 100;
  const dailyMultiple = 1 + perDay / capital;
  const simpleAnnualPct = dailyPct * TRADING_DAYS;
  const afterYear = capital * Math.pow(dailyMultiple, TRADING_DAYS);
  const afterTwo = capital * Math.pow(dailyMultiple, TRADING_DAYS * 2);
  const daysToWorld = Math.log(WORLD_GDP / capital) / Math.log(dailyMultiple);

  console.log(`${money(perDay)} every day from ${money(capital)} of capital\n`);
  console.log(`  that is                ${pct(dailyPct)} per day`);
  console.log(`  = ${pct(simpleAnnualPct)} per year, simple`);
  console.log(`  = multiplying the account by ${dailyMultiple.toFixed(2)}x every single day\n`);

  console.log(`Taken literally, with the gains left in the account:`);
  console.log(`  after one year         ${money(afterYear)}`);
  console.log(`  after two years        ${money(afterTwo)}`);
  console.log(
    `  time to own more than the whole world economy (${money(WORLD_GDP)}): ${daysToWorld.toFixed(0)} trading days\n`,
  );

  console.log(`For scale, ${pct(dailyPct)} a day against the best long-run records there are:`);
  for (const c of COMPARISONS) {
    const perDayPct = (Math.pow(1 + c.annualPct / 100, 1 / TRADING_DAYS) - 1) * 100;
    const ratio = dailyPct / perDayPct;
    console.log(
      `  ${c.label.padEnd(42)} ${pct(c.annualPct).padStart(9)}/yr = ${pct(perDayPct).padStart(8)}/day ` +
        `(the request is ${ratio.toFixed(0)}x larger)`,
    );
  }

  console.log(`\nWhat ${money(perDay)}/day costs at each rate this repo measured:`);
  for (const rate of [0.099, 0.233, 0.3]) {
    const need = (perDay * 365) / rate;
    console.log(`  ${(rate * 100).toFixed(1)}%/yr -> ${money(need)} of capital (${(need / capital).toFixed(0)}x what you have)`);
  }

  // Where, exactly, does the line sit? Everything above the best sustained
  // record in finance is not a strategy question.
  const bestFundDaily = (Math.pow(1.66, 1 / TRADING_DAYS) - 1) * 100;
  console.log("\nThe boundary — daily rates, and what each yields on this capital:");
  console.log("per day    per year (simple)   yields/day on capital   vs best fund ever   status");
  for (const ratePct of [10, 5, 2, 1, 0.2, 0.04]) {
    const ratio = ratePct / bestFundDaily;
    const status =
      ratio > 10
        ? "never sustained by anything"
        : ratio > 1.2
          ? "beyond every long-run record"
          : ratio > 0.8
            ? "the best fund in history"
            : "what this bot has measured";
    console.log(
      `${`${ratePct}%`.padStart(7)}   ${pct(ratePct * TRADING_DAYS).padStart(16)}   ${money((capital * ratePct) / 100).padStart(21)}   ` +
        `${`${ratio.toFixed(1)}x`.padStart(17)}   ${status}`,
    );
  }

  console.log(
    `\nThe honest conclusion. ${money(perDay)} a day from ${money(capital)} is ${pct(dailyPct)} every day, and\n` +
      `no strategy, this one or any other, has ever produced that: the best long-run record in\n` +
      `finance is about ${pct((Math.pow(1.66, 1 / TRADING_DAYS) - 1) * 100)}/day, and the best *single* day in the data here is a one-off, not a rate.\n` +
      `The bot does not fail this test because it is badly built. It fails it because the test is\n` +
      `not passable, and money that could pass it would make its owner the richest person alive\n` +
      `within ${daysToWorld.toFixed(0)} trading days.`,
  );
}

main();
