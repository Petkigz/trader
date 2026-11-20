#!/usr/bin/env node
/**
 * "I made a loss today, tomorrow I'll make it back" — measured, not argued.
 *
 *   node --experimental-strip-types scripts/catchup.ts --dir=data/real
 *
 * Three readings of the same request are run through the same fill model on the
 * same panel:
 *
 *   opportunity  trade whenever the signal fires, no daily quota (what the bot
 *                does today)
 *   quota        stop entering for the day once the day's target is banked
 *                (what "a quota" would mean)
 *   chase-Nx     size up while behind the goal line, capped at Nx (what "pull
 *                up to fill the loss" means, said out loud)
 *
 * Every arm starts from $10 with a goal line of +$1/day, which is the target as
 * stated. The point of the exercise is not to find the best arm; it is to find
 * out which arms survive long enough to still be trading.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultSymbolInfo, runBacktest } from "../src/backtest.ts";
import type { OverlayCtx, OverlayResult } from "../src/backtest.ts";
import { loadConfig } from "../src/config.ts";
import { parseCandleCsv } from "../src/data.ts";
import { capitalFor, chaseMultiplier, expectedPerDay, goalStatus } from "../src/goal.ts";
import { mean, median } from "../src/research/stats.ts";
import type { Candle } from "../src/types.ts";
import { DAY_MS } from "../src/util/num.ts";

const START = Date.parse("2020-01-01");
const CAPITAL = 10;
const DAILY_TARGET = 1;

interface Arm {
  id: string;
  note: string;
  overlay: (ctx: OverlayCtx, anchor: { ts: number; equity: number }) => OverlayResult;
}

const ARMS: Arm[] = [
  {
    id: "opportunity",
    note: "trade when the signal fires; no quota",
    overlay: () => ({}),
  },
  {
    id: "quota",
    note: "stop for the day once +$1 is banked",
    overlay: (ctx) => ({
      blockEntries: ctx.equity - ctx.dayStartEquity >= DAILY_TARGET,
    }),
  },
  ...[2, 5, Infinity].map((cap) => ({
    id: cap === Infinity ? "chase-open" : `chase-${cap}x`,
    note:
      cap === Infinity
        ? "size up by the whole deficit (spot-bounded, so: all cash)"
        : `size up by the deficit, capped at ${cap}x`,
    overlay: (ctx: OverlayCtx, anchor: { ts: number; equity: number }): OverlayResult => {
      const status = goalStatus(
        { startEquity: anchor.equity, startDate: anchor.ts, dailyTarget: DAILY_TARGET },
        ctx.equity,
        ctx.ts,
      );
      return { sizeMultiplier: chaseMultiplier(status.deficit, ctx.equity, cap) };
    },
  })),
];

interface RunStats {
  symbol: string;
  finalEquity: number;
  maxDrawdownPct: number;
  days: number;
  daysGoalMet: number;
  daysTargetHit: number;
  exposurePct: number;
  busted: boolean;
  bustedOnDay: number | null;
  trades: number;
}

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

function runArm(
  arm: Arm,
  symbol: string,
  candles: Candle[],
  fraction: number,
  capital: number,
  target: number,
): RunStats {
  const anchor = { ts: candles[0].openTime, equity: capital };
  const cfg = loadConfig({
    ...process.env,
    SYMBOL: symbol,
    STRATEGY: "trend",
    POSITION_FRACTION: String(fraction),
  });

  // Daily closes are recorded from the overlay, which sees every bar, rather
  // than from the result curve, which is downsampled for display.
  const dailyEquity: Array<{ ts: number; equity: number }> = [];
  let bustedOnDay: number | null = null;

  const r = runBacktest({
    cfg,
    daily: candles,
    hourly: [],
    capital,
    info: defaultSymbolInfo(symbol),
    overlay: (ctx) => {
      const out = arm.overlay(ctx, anchor);
      dailyEquity.push({ ts: ctx.ts, equity: ctx.equity });
      if (bustedOnDay === null && ctx.equity < capital * 0.5 && dailyEquity.length > 1) {
        bustedOnDay = Math.floor((ctx.ts - anchor.ts) / DAY_MS);
      }
      return out;
    },
  });

  // Daily candles mean one bar per day, so a day's first and last equity are the
  // same number. Day PnL is therefore today's close against yesterday's.
  const order: string[] = [];
  const days = new Map<string, { close: number; lastTs: number }>();
  for (const p of dailyEquity) {
    const key = new Date(p.ts).toISOString().slice(0, 10);
    if (!days.has(key)) order.push(key);
    days.set(key, { close: p.equity, lastTs: p.ts });
  }

  let daysGoalMet = 0;
  let daysTargetHit = 0;
  let prevClose: number | null = null;
  for (const key of order) {
    const row = days.get(key)!;
    if (prevClose !== null && row.close - prevClose >= target) daysTargetHit++;
    const s = goalStatus(
      { startEquity: anchor.equity, startDate: anchor.ts, dailyTarget: target },
      row.close,
      row.lastTs,
    );
    if (row.close >= s.targetEquity) daysGoalMet++;
    prevClose = row.close;
  }

  return {
    symbol,
    finalEquity: r.finalEquity,
    maxDrawdownPct: r.maxDrawdownPct,
    days: order.length,
    exposurePct: r.exposurePct,
    daysGoalMet,
    daysTargetHit,
    busted: bustedOnDay !== null || r.finalEquity < 5,
    bustedOnDay,
    trades: r.trades,
  };
}

interface Block {
  label: string;
  capital: number;
  target: number;
  fractions: number[];
}

/**
 * Two settings, because they answer different halves of the question.
 *
 *  $10 at the live 97% deployment is the account as it actually is: so little
 *  cash that a normal entry is already nearly all of it. There is no room to
 *  "pull up", which is the first honest answer to "size up to fill the loss".
 *
 *  $100 at 50% deployment is the same request with standing room, so the
 *  catch-up arms can actually do what they say.
 */
const BLOCKS: Block[] = [
  { label: "the real thing: $10, 97% deployed", capital: 10, target: 1, fractions: [0.97] },
  { label: "with room to size up: $100, 50% deployed", capital: 100, target: 1, fractions: [0.5] },
];

async function main(): Promise<void> {
  const dir = arg("dir") ?? "data/real";
  const panel = await loadPanel(dir);
  if (panel.length === 0) throw new Error(`no CSVs in ${dir}`);

  console.log(`panel: ${panel.length} assets from ${new Date(START).toISOString().slice(0, 10)}`);
  console.log(`champion strategy "trend" · goal line +$1/day\n`);

  const pct = (x: number) => `$${x.toFixed(2)}`;
  const header =
    `${"arm".padEnd(12)} ${"median final".padStart(13)} ${"worst final".padStart(12)} ` +
    `${"median DD".padStart(10)} ${"busted".padStart(7)} ${"in mkt".padStart(8)} ${"+$1 days".padStart(10)} ${"trades".padStart(7)}`;

  const summary: Array<{ block: Block; fraction: number; arms: Map<string, RunStats[]> }> = [];

  for (const block of BLOCKS) {
    for (const fraction of block.fractions) {
      const arms = new Map<string, RunStats[]>();
      for (const arm of ARMS) {
        const stats: RunStats[] = [];
        for (const { symbol, candles } of panel) {
          stats.push(runArm(arm, symbol, candles, fraction, block.capital, block.target));
        }
        arms.set(arm.id, stats);
      }
      summary.push({ block, fraction, arms });

      console.log(`${block.label} · deployment ${(fraction * 100).toFixed(0)}%`);
      console.log(header);
      console.log("-".repeat(90));
      for (const arm of ARMS) {
        const s = arms.get(arm.id)!;
        const busted = s.filter((x) => x.busted).length;
        const hit = s.reduce((a, x) => a + x.daysTargetHit, 0);
        const days = s.reduce((a, x) => a + x.days, 0);
        const dead = s.every((x) => x.trades === 0);
        if (dead) {
          console.log(`${arm.id.padEnd(12)} ${"—".padStart(13)} ${"—".padStart(12)} ${"—".padStart(10)} ${"—".padStart(7)} ${"—".padStart(8)} ${"—".padStart(10)} ${"0".padStart(7)}   (cannot trade: ${pct(block.capital * fraction)} < $5 minimum)`);
          continue;
        }
        console.log(
          `${arm.id.padEnd(12)} ${pct(median(s.map((x) => x.finalEquity))).padStart(13)} ` +
            `${pct(Math.min(...s.map((x) => x.finalEquity))).padStart(12)} ` +
            `${(median(s.map((x) => x.maxDrawdownPct)).toFixed(1) + "%").padStart(10)} ` +
            `${`${busted}/${s.length}`.padStart(7)} ` +
            `${(median(s.map((x) => x.exposurePct)).toFixed(0) + "%").padStart(8)} ` +
            `${`${hit}/${days}`.padStart(10)} ` +
            `${median(s.map((x) => x.trades)).toFixed(0).padStart(7)}`,
        );
      }
      console.log();
    }
  }

  const room = summary.find((x) => x.block.capital === 100)!;
  const opp = room.arms.get("opportunity")!;
  const open = room.arms.get("chase-open")!;
  const chase5 = room.arms.get("chase-5x")!;
  const deaths = open.filter((x) => x.bustedOnDay !== null);
  console.log("with room to size up ($100, 50% deployed):");
  if (deaths.length > 0) {
    console.log(
      `  chase-open killed ${deaths.length}/${open.length} accounts, median on day ` +
        `${median(deaths.map((x) => x.bustedOnDay!)).toFixed(0)} of ~${median(open.map((x) => x.days)).toFixed(0)}`,
    );
  }
  console.log(
    `  median final: opportunity ${pct(median(opp.map((x) => x.finalEquity)))} · ` +
      `chase-5x ${pct(median(chase5.map((x) => x.finalEquity)))} · ` +
      `chase-open ${pct(median(open.map((x) => x.finalEquity)))}`,
  );
  console.log(
    `  worst account: opportunity ${pct(Math.min(...opp.map((x) => x.finalEquity)))} vs ` +
      `chase-open ${pct(Math.min(...open.map((x) => x.finalEquity)))}`,
  );
  console.log(
    `  median DD: ${median(opp.map((x) => x.maxDrawdownPct)).toFixed(1)}% -> ` +
      `${median(open.map((x) => x.maxDrawdownPct)).toFixed(1)}%`,
  );

  console.log("\nwhat the target would actually require ($10 account):");
  const ten = summary.find((x) => x.block.capital === 10)!;
  const tOpp = ten.arms.get("opportunity")!;
  const tOpp5 = ten.arms.get("chase-5x")!;
  const measured = median(tOpp.map((x) => x.finalEquity));
  const yrs = median(tOpp.map((x) => x.days)) / 365.25;
  const cagr = Math.pow(measured / 10, 1 / yrs) - 1;
  console.log(
    `  $10 -> ${pct(measured)} over ${yrs.toFixed(1)}y = ${(cagr * 100).toFixed(1)}%/yr, ` +
      `i.e. $${expectedPerDay(10, cagr).toFixed(4)}/day expected.`,
  );
  console.log(`  $1/day at that rate needs ${pct(capitalFor(1, cagr))} of capital.`);
  console.log(
    `  on $10 it demands ${((1 / 10) * 100 * 365).toFixed(0)}% of the account per year — ` +
      `impossible by construction, not by bad luck.`,
  );
  const hitAny = median(tOpp.map((x) => x.daysTargetHit));
  console.log(
    `  +$1 days that actually happened: median ${hitAny.toFixed(0)} per asset in ${yrs.toFixed(1)} years. ` +
      `The deficit is the permanent state, not a temporary one.`,
  );
  console.log(
    `  chasing it: median ${pct(median(tOpp5.map((x) => x.finalEquity)))} vs ${pct(measured)}, ` +
      `and ${tOpp5.filter((x) => x.busted).length}/${tOpp5.length} accounts busted against ${tOpp.filter((x) => x.busted).length}/${tOpp.length}.`,
  );
  console.log("\nconclusion: the deficit is worth *seeing*. It is not worth sizing up for.");
  void mean;
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
