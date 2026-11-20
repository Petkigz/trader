#!/usr/bin/env node
/**
 * "Assume it makes profit — then it needs to cover the losses."
 *
 *   node --experimental-strip-types scripts/recover.ts --dir=data/real
 *
 * Two questions, both about the account *after* it is ahead:
 *
 *  1. When the champion dips, how long until it regains the old high? Not "when
 *     is the next green day" — when is the loss actually covered.
 *  2. Does the goal line get closeable as equity grows? A dollar line is only
 *     catchable once growth per day exceeds $1/day, so the interesting number is
 *     the balance where that happens and the years it takes to get there.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultSymbolInfo, runBacktest, type OverlayCtx } from "../src/backtest.ts";
import { loadConfig } from "../src/config.ts";
import { parseCandleCsv } from "../src/data.ts";
import { escapeVelocity, goalStatus, recoveryStats } from "../src/goal.ts";
import { median } from "../src/research/stats.ts";
import type { Candle } from "../src/types.ts";
import { DAY_MS } from "../src/util/num.ts";

const START = Date.parse("2020-01-01");
const CAPITAL = 10;
const TARGET = 1;

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

interface AssetRecovery {
  symbol: string;
  finalEquity: number;
  cagr: number;
  underWaterPct: number;
  medianRecoveryDays: number | null;
  longestUnderwaterDays: number;
  recoveredWithin90: number;
  recoveredWithin365: number;
  neverRecovered: number;
  episodes: number;
  escape: number;
  aboveEscape: boolean;
  yearsToEscape: number | null;
}

function analyse(symbol: string, candles: Candle[]): AssetRecovery {
  const cfg = loadConfig({ ...process.env, SYMBOL: symbol, STRATEGY: "trend" });
  const curve: Array<{ ts: number; equity: number }> = [];

  const r = runBacktest({
    cfg,
    daily: candles,
    hourly: [],
    capital: CAPITAL,
    info: defaultSymbolInfo(symbol),
    overlay: (ctx: OverlayCtx) => {
      curve.push({ ts: ctx.ts, equity: ctx.equity });
      return {};
    },
  });

  // All dips (for how much time is spent below a high) and real ones ≥5%.
  const rec = recoveryStats(curve, { minDrawdownPct: 5 });
  const days = curve.length;
  const years = days / 365.25;
  const cagr = r.finalEquity > 0 && years > 0 ? Math.pow(r.finalEquity / CAPITAL, 1 / years) - 1 : 0;

  const status = goalStatus(
    { startEquity: CAPITAL, startDate: candles[0].openTime, dailyTarget: TARGET },
    r.finalEquity,
    curve[curve.length - 1].ts,
  );

  return {
    symbol,
    finalEquity: r.finalEquity,
    cagr,
    underWaterPct: rec.daysUnderwaterPct,
    medianRecoveryDays: rec.medianRecoveryDays,
    longestUnderwaterDays: rec.longestUnderwaterDays,
    recoveredWithin90: rec.recoveredWithin90,
    recoveredWithin365: rec.recoveredWithin365,
    neverRecovered: rec.neverRecovered,
    episodes: rec.episodes,
    escape: status.escapeVelocity,
    aboveEscape: status.aboveEscapeVelocity,
    yearsToEscape: status.yearsToEscapeVelocity,
  };
}

async function main(): Promise<void> {
  const dir = arg("dir") ?? "data/real";
  const panel = await loadPanel(dir);
  if (panel.length === 0) throw new Error(`no CSVs in ${dir}`);

  const rows = panel.map(({ symbol, candles }) => analyse(symbol, candles));
  const yrs = median(rows.map((r) => r.finalEquity)) > 0 ? 6.3 : 0;

  console.log(`panel: ${panel.length} assets · champion "trend" · $${CAPITAL} start · +$${TARGET}/day line\n`);

  console.log("does it cover its own losses? (drawdowns of 5% or more)");
  console.log(
    `  median share of days 5%+ under a high     ${median(rows.map((r) => r.underWaterPct)).toFixed(0)}%`,
  );
  const cagrs = rows.map((r) => r.cagr);
  console.log(
    `  median achieved rate                      ${(median(cagrs) * 100).toFixed(0)}%/yr ` +
      `(range ${(Math.min(...cagrs) * 100).toFixed(0)}% to ${(Math.max(...cagrs) * 100).toFixed(0)}%)`,
  );
  const medRec = rows.filter((r) => r.medianRecoveryDays !== null).map((r) => r.medianRecoveryDays!);
  console.log(
    `  median time to regain a lost high         ${medRec.length > 0 ? median(medRec).toFixed(0) : "n/a"} days`,
  );
  console.log(
    `  longest single stretch under water        ${median(rows.map((r) => r.longestUnderwaterDays)).toFixed(0)} days`,
  );
  const eps = rows.reduce((a, r) => a + r.episodes, 0);
  const q90 = rows.reduce((a, r) => a + r.recoveredWithin90, 0);
  const q365 = rows.reduce((a, r) => a + r.recoveredWithin365, 0);
  const never = rows.reduce((a, r) => a + r.neverRecovered, 0);
  console.log(
    `  of ${eps} drawdowns: ${q90} covered within 90d, ${q365} within a year, ` +
      `${never} still open at the end (${((q365 / Math.max(eps, 1)) * 100).toFixed(0)}% recovered)`,
  );

  console.log("\ncan the +$1/day line ever be caught?");
  const ev = escapeVelocity(TARGET, 0.3);
  console.log(
    `  at 30%/yr the threshold is $${ev.toFixed(0)}: below it, a day's growth is less than $1,`,
  );
  console.log(
    `  so every day widens the gap. Growth compounds, so it is not literally never —`,
  );
  console.log(`  it is "decades", which is why the ledger reports it as out of reach.`);
  const above = rows.filter((r) => r.aboveEscape).length;
  console.log(`  accounts past the threshold after ${yrs.toFixed(1)}y: ${above}/${rows.length}`);
  const yrsTo = rows.filter((r) => r.yearsToEscape !== null && r.yearsToEscape > 0).map((r) => r.yearsToEscape!);
  if (yrsTo.length > 0) {
    console.log(
      `  median years to reach it at each asset's own achieved rate: ${median(yrsTo).toFixed(0)}` +
        ` (over 30 is reported as out of reach)`,
    );
  }
  const medFinal = median(rows.map((r) => r.finalEquity));
  console.log(
    `  median final equity after ${yrs.toFixed(1)}y: $${medFinal.toFixed(2)} — ` +
      `$${(ev - medFinal).toFixed(0)} short of the threshold.`,
  );

  console.log("\nwhat this means for covering a loss at normal size:");
  const bestCagr = Math.max(...rows.map((r) => r.cagr));
  console.log(
    `  best asset rate in the panel: ${(bestCagr * 100).toFixed(0)}%/yr, threshold ` +
      `$${escapeVelocity(TARGET, bestCagr).toFixed(0)}. Even the best asset needs that balance ` +
      `before +$${TARGET}/day is arithmetic rather than hope.`,
  );
  console.log(
    `  until then, a loss is covered only by being *ahead of the line*, which on $${CAPITAL} means ` +
      `the gap is permanent and the honest fix is capital, not leverage.`,
  );
  void DAY_MS;
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
