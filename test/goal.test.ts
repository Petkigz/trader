import assert from "node:assert/strict";
import test from "node:test";

import {
  capitalFor,
  chaseMultiplier,
  expectedPerDay,
  daysToCloseGap,
  escapeVelocity,
  goalStatus,
  planParticipation,
  shortfallToPeak,
  recoveryStats,
  utcMidnight,
  type GoalConfig,
  type GoalStatus,
} from "../src/goal.ts";
import { DAY_MS } from "../src/util/num.ts";

const START = Date.UTC(2026, 0, 1); // 2026-01-01
const cfg: GoalConfig = { startEquity: 10, startDate: START, dailyTarget: 1 };
const day = (n: number) => START + n * DAY_MS;
const near = (actual: number, expected: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, msg ?? `${actual} != ${expected}`);

test("the goal line rises by the daily target, linearly not compounded", () => {
  const s = goalStatus(cfg, 10, day(10));
  assert.equal(s.daysElapsed, 10);
  assert.equal(s.targetEquity, 20); // 10 + 1*10, not 10*1.05^10
  near(s.deficit, 10);
  assert.equal(s.pressure, "unreachable", "10%/day needed cannot be called 'behind'");
});

test("a day of losses shows up as a deficit, and tomorrow starts from it", () => {
  // Day 0: flat. Day 1: lost $0.90. The line is now 11, equity 9.10.
  const s = goalStatus(cfg, 9.1, day(1), -0.9);
  assert.equal(s.targetEquity, 11);
  near(s.deficit, 1.9);
  assert.equal(s.lastDayPnl, -0.9);
  near(s.achievedPerDay, -0.9);
  assert.equal(s.daysToCloseAtAchievedRate, null, "losing never closes the gap");
  assert.equal(s.pressure, "unreachable", "and $1.90 on $9 is not a survivable rate");
  assert.match(s.verdict, /gap grows/);
});

test("being ahead reports surplus and claims no deficit", () => {
  const s = goalStatus(cfg, 25, day(10));
  assert.equal(s.deficit, 0);
  assert.equal(s.surplus, 5);
  assert.equal(s.pressure, "ahead");
  assert.equal(s.requiredDailyReturn30d, null);
});

test("small gaps are on-track, not emergencies", () => {
  const s = goalStatus(cfg, 49.2, day(40)); // line 50, equity 49.2
  assert.equal(s.daysElapsed, 40);
  near(s.deficit, 0.8);
  assert.equal(s.pressure, "on-track");
});

test("pressure never softens the language about what is unreachable", () => {
  const s = goalStatus(cfg, 10, day(365));
  assert.equal(s.pressure, "unreachable");
  // 365 * $1 of deficit on a $10 account is a demand for 4,000%/yr.
  assert.ok((s.requiredDailyReturn30d ?? 0) > 1);
  // Flat is reported as flat, because that is the more useful fact.
  assert.match(s.verdict, /gap grows/);
});

test("a growing account is told what it is short of, not just that it is short", () => {
  // $20 after a year of gains: doubling, which is 100%/yr and still not enough.
  const s = goalStatus(cfg, 20, day(365));
  assert.equal(s.pressure, "unreachable");
  assert.equal(s.aboveEscapeVelocity, false);
  // The message names the threshold, because that is the actionable number.
  assert.match(s.verdict, /escape velocity/);
  assert.ok(Number.isFinite(s.escapeVelocity));
});

test("a sub-month history does not claim a CAGR it cannot support", () => {
  assert.equal(goalStatus(cfg, 12, day(5)).achievedCagr, null);
  const month = goalStatus(cfg, 12, day(30)).achievedCagr;
  assert.ok(month !== null && month > 0);
});

test("same UTC day is the same elapsed day, whatever the hour", () => {
  const midday = START + 1 * DAY_MS + 13 * 3600_000;
  assert.equal(goalStatus(cfg, 10, midday).daysElapsed, 1);
  assert.equal(utcMidnight(midday), day(1));
});

/* The invariants that keep the ledger from becoming a licence to gamble. */

test("a deficit never enlarges the position", () => {
  const behind = goalStatus(cfg, 9, day(3)); // deficit 4
  const deep = goalStatus(cfg, 1.1, day(30)); // deficit 38.9
  for (const status of [behind, deep]) {
    const d = planParticipation({
      status,
      opportunity: true,
      entriesBlocked: false,
      inPosition: false,
    });
    assert.equal(d.riskMultiplier, 1, `${status.pressure} must not size up`);
  }
});

test("reaching the target does not earn a day off", () => {
  const ahead = goalStatus(cfg, 30, day(10));
  const d = planParticipation({
    status: ahead,
    opportunity: true,
    entriesBlocked: false,
    inPosition: false,
  });
  assert.equal(d.allow, true, "opportunities decide, not the quota");
  assert.match(d.reason, /signal present/);
});

test("a loss does not unlock a second bite either", () => {
  const behind = goalStatus(cfg, 8, day(5));
  const d = planParticipation({
    status: behind,
    opportunity: true,
    entriesBlocked: false,
    inPosition: true,
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /already positioned/);
});

test("risk rails outrank both the goal and the signal", () => {
  const d = planParticipation({
    status: goalStatus(cfg, 4, day(20)),
    opportunity: true,
    entriesBlocked: true,
    inPosition: false,
  });
  assert.equal(d.allow, false);
  assert.equal(d.riskMultiplier, 1);
});

test("no signal means no trade, however far behind", () => {
  const d = planParticipation({
    status: goalStatus(cfg, 1, day(60)),
    opportunity: false,
    entriesBlocked: false,
    inPosition: false,
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /waiting for an opportunity/);
});

test("chaseMultiplier is the research lever, and it is bounded", () => {
  assert.equal(chaseMultiplier(0, 10, 99), 1);
  assert.equal(chaseMultiplier(2, 10, 99), 1.2);
  assert.equal(chaseMultiplier(50, 10, 3), 3);
  assert.equal(chaseMultiplier(5, 0, 9), 1, "no equity, no multiplier");
});

test("the $1/day arithmetic is stated, not hidden", () => {
  // At the measured 30% CAGR, $10 earns about 0.8 cents a day.
  assert.ok(expectedPerDay(10, 0.3) < 0.01);
  // So $1/day needs roughly $1,200 of capital, and no strategy trick fixes that.
  const need = capitalFor(1, 0.3);
  assert.ok(need > 1200 && need < 1230, `got ${need}`);
});

test("staying flat against a rising line goes unreachable rather than 'behind'", () => {
  let status: GoalStatus = goalStatus(cfg, 10, day(0));
  assert.equal(status.deficit, 0);
  status = goalStatus(cfg, 10, day(45));
  assert.equal(status.pressure, "unreachable");
});

/* The research hook must not be able to change production by accident. */

test("an absent overlay and an identity overlay produce the same backtest", async () => {
  const { runBacktest, defaultSymbolInfo } = await import("../src/backtest.ts");
  const { makeCandle, series, testConfig } = await import("./helpers.ts");
  const candles = series({
    closes: Array.from({ length: 600 }, (_, i) => 100 + Math.sin(i / 7) * 12 + i * 0.05),
    endTime: Date.UTC(2026, 0, 1),
  });
  const base = { cfg: testConfig(), daily: candles, hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") };
  const plain = runBacktest(base);
  const identity = runBacktest({ ...base, overlay: () => ({}) });
  assert.equal(identity.finalEquity, plain.finalEquity);
  assert.equal(identity.trades, plain.trades);
  assert.ok(plain.trades > 0, "the fixture must actually trade, or this proves nothing");
  void makeCandle;
});

test("an overlay that blocks entries stops trading without touching exits", async () => {
  const { runBacktest, defaultSymbolInfo } = await import("../src/backtest.ts");
  const { series, testConfig } = await import("./helpers.ts");
  const candles = series({
    closes: Array.from({ length: 600 }, (_, i) => 100 + Math.sin(i / 7) * 12 + i * 0.05),
    endTime: Date.UTC(2026, 0, 1),
  });
  const base = { cfg: testConfig(), daily: candles, hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") };
  const blocked = runBacktest({ ...base, overlay: () => ({ blockEntries: true }) });
  assert.equal(blocked.trades, 0);
  assert.equal(blocked.finalEquity, 10, "blocked entries must leave the cash untouched");
});

test("the status snapshot reports a deficit and still never blocks entries", async () => {
  const { buildStatus } = await import("../src/status.ts");
  const { MemoryStore } = await import("../src/store/memory.ts");
  const { testConfig } = await import("./helpers.ts");

  const store = new MemoryStore();
  const cfg = testConfig({ PAPER_START_USDT: "10", GOAL_DAILY_TARGET: "1" });
  const t0 = Date.UTC(2026, 0, 1);
  const state = {
    ...(await store.getState())!,
    paperUsdt: 9.2,
    dayStartEquity: 10.1,
    highWaterMark: 10.4,
  } as Parameters<typeof store.saveState>[0];
  await store.saveState(state);
  for (let d = 0; d < 20; d++) {
    await store.recordTick({
      ts: t0 + d * DAY_MS,
      equity: 10 - d * 0.04,
      price: 100,
      action: "HOLD",
      reason: "test",
      detail: "",
    } as Parameters<typeof store.recordTick>[0]);
  }

  const s = await buildStatus(cfg, store, t0 + 20 * DAY_MS);
  assert.equal(s.goal.dailyTarget, 1);
  assert.equal(s.goal.daysElapsed, 20);
  assert.ok(s.goal.deficit > 0, "equity is below the line, so the gap is real");
  assert.equal(s.goal.entriesBlockedByGoal, false);
  assert.ok(s.goal.verdict.length > 0);
});

test("escape velocity is the balance at which growth out-earns the line", () => {
  // $1/day at 30%/yr: ~$1,400 of capital, because a smaller balance grows by
  // less than a dollar a day and the line walks away from it for ever.
  const ev = escapeVelocity(1, 0.3);
  assert.ok(ev > 1300 && ev < 1450, `got ${ev}`);
  assert.equal(escapeVelocity(1, 0), Infinity);
  // Roughly twice the rate, roughly half the balance (not exactly: the
  // threshold is a daily compound, not a linear annualisation).
  const double = escapeVelocity(1, 0.6);
  assert.ok(double < ev && Math.abs(double - ev / 2) < ev * 0.2, `got ${double}`);
});

test("above escape velocity the gap closes, below it the gap never closes", () => {
  // Doubling over eight years is ~9%/yr: the line walks away for ever.
  const poor = goalStatus({ ...cfg, startEquity: 10 }, 20, day(3000));
  assert.equal(poor.aboveEscapeVelocity, false);
  // It does close one day — around 88 years out — so the honest answer inside a
  // 30-year horizon is "no".
  assert.equal(daysToCloseGap({ ...cfg }, 20, 3000, poor.achievedCagr), null);
  assert.equal(daysToCloseGap({ ...cfg }, 20, 3000, poor.achievedCagr, 40000) !== null, true);

  // $1,500 after 8 years: 84%/yr, past the threshold, so the line is catchable.
  const rich = goalStatus({ ...cfg, startEquity: 10 }, 1500, day(3000));
  assert.equal(rich.aboveEscapeVelocity, true);
  assert.ok(rich.deficit > 0, "still behind the line — that is the point");
  const days = daysToCloseGap({ ...cfg }, 1500, 3000, rich.achievedCagr);
  assert.ok(days !== null && days > 30 && days < 5000, `got ${days}`);
});

test("recovery measures the old peak, not a green day", () => {
  const curve = [
    { ts: day(0), equity: 10 },
    { ts: day(1), equity: 9 },
    { ts: day(2), equity: 8 },
    { ts: day(20), equity: 11 }, // recovered: back above 10
    { ts: day(21), equity: 10.5 },
    { ts: day(100), equity: 12 }, // recovered again
    { ts: day(101), equity: 9 }, // still under water at the end
  ];
  const r = recoveryStats(curve);
  assert.equal(r.episodes, 3);
  assert.equal(r.recoveredWithin30, 1, "only the 18-day dip is quick");
  assert.equal(r.recoveredWithin90, 2, "the 79-day dip is recovered but slow");
  assert.equal(r.neverRecovered, 1);
  assert.ok(r.daysUnderwaterPct > 0 && r.daysUnderwaterPct < 100);
  assert.ok(r.medianRecoveryDays !== null);
});

test("an account that only ever rises has no drawdown to recover", () => {
  const curve = Array.from({ length: 10 }, (_, i) => ({ ts: day(i), equity: 10 + i }));
  const r = recoveryStats(curve);
  assert.equal(r.episodes, 0);
  assert.equal(r.neverRecovered, 0);
  assert.equal(r.medianRecoveryDays, null);
  assert.equal(r.daysUnderwaterPct, 0);
});

test("the dollars needed to regain a peak, and the return that implies", () => {
  const fromThree = shortfallToPeak(3, 15);
  assert.equal(fromThree.dollars, 12);
  assert.equal(fromThree.pct, 400, "$3 back to $15 is a 400% climb, not a $12 errand");
  assert.equal(fromThree.recoverable, true);

  const wipedOut = shortfallToPeak(0, 15);
  assert.equal(wipedOut.dollars, 15);
  assert.equal(wipedOut.pct, Infinity);
  assert.equal(wipedOut.recoverable, false);

  // Already at or above the peak: nothing to regain.
  assert.equal(shortfallToPeak(20, 15).dollars, 0);
});

test("status names the dollars to regain the peak and the minimum tradeable balance", async () => {
  const { buildStatus } = await import("../src/status.ts");
  const { MemoryStore } = await import("../src/store/memory.ts");
  const { testConfig } = await import("./helpers.ts");

  const store = new MemoryStore();
  const cfg = testConfig({ PAPER_START_USDT: "10", MIN_NOTIONAL: "5", POSITION_FRACTION: "0.97" });
  const t0 = Date.UTC(2026, 0, 1);
  const state = (await store.getState())!;
  await store.saveState({ ...state, paperUsdt: 3, highWaterMark: 3, dayStartEquity: 9 } as typeof state);
  // A recorded peak of $15, then a collapse to $3.
  for (const [d, eq] of [[0, 10], [1, 15], [2, 3]] as Array<[number, number]>) {
    await store.recordTick({
      ts: t0 + d * DAY_MS, equity: eq, price: 100, action: "HOLD", reason: "test", detail: "",
    } as Parameters<typeof store.recordTick>[0]);
  }

  const s = await buildStatus(cfg, store, t0 + 3 * DAY_MS);
  assert.equal(s.account.allTimeHigh, 15);
  assert.equal(s.account.dollarsToRegainPeak, 12, "the balance it must fill is $12");
  assert.ok(s.account.pctToRegainPeak > 399, "which is a 400% climb from $3");
  assert.equal(s.capital.belowMinimum, true, "$3 cannot place a $5 order");
  assert.ok(s.capital.shortfall > 2 && s.capital.shortfall < 2.3);
  assert.match(s.capital.message, /cannot place/);
  assert.equal(s.risk.blockReason, "below_min_notional");
});

function atRate(plan: { rows: Array<{ rate: number; progressPct: number; capitalRequired: number }> }, rate: number) {
  const row = plan.rows.find((r) => r.rate === rate);
  assert.ok(row, `no row for rate ${rate}`);
  return row;
}

test("a monthly target reports the capital it needs, not encouragement", async () => {
  const { targetPlan } = await import("../src/goal.ts");

  const plan = targetPlan({ monthlyTarget: 300, equity: 10, achievedCagr: null });
  assert.equal(plan.annualTarget, 3_600);

  const at30 = plan.rows.find((r) => r.rate === 0.3)!;
  const at233 = plan.rows.find((r) => r.rate === 0.233)!;
  const at10 = plan.rows.find((r) => r.rate === 0.1)!;
  assert.equal(at30.capitalRequired, 12_000);
  assert.ok(Math.abs(at233.capitalRequired - 15_450.64) < 0.01, `got ${at233.capitalRequired}`);
  assert.equal(at10.capitalRequired, 36_000);

  // $10 against $15,450 is 0.065% of the way — the number, not a pep talk.
  assert.ok(at233.progressPct > 0.06 && at233.progressPct < 0.07, `got ${at233.progressPct}`);
  assert.equal(at233.yearsToReach, null, "with no achieved rate, the gap has no projection");
  assert.match(plan.summary, /needs \$15,451 at 23\.3%\/yr/);
  assert.match(plan.summary, /does not close the gap at all/);
});

test("an achieved rate turns the gap into a dated projection", async () => {
  const { targetPlan } = await import("../src/goal.ts");
  const plan = targetPlan({ monthlyTarget: 300, equity: 10, achievedCagr: 0.233 });
  const at233 = plan.rows.find((r) => r.rate === 0.233)!;

  // 10 -> 15,450 at 23.3%/yr is ~34 years; the point is it is finite and long.
  assert.ok(at233.yearsToReach !== null && at233.yearsToReach > 30 && at233.yearsToReach < 40, `got ${at233.yearsToReach}`);
});

test("a funded target says so, and reports what it actually pays", async () => {
  const { targetPlan } = await import("../src/goal.ts");
  const plan = targetPlan({ monthlyTarget: 300, equity: 20_000, achievedCagr: 0.233 });
  assert.equal(atRate(plan, 0.233).progressPct, 100);
  assert.equal(atRate(plan, 0.3).progressPct, 100);
  // $20,000 does not fund the same target at 10%/yr, and the plan says so.
  assert.ok(atRate(plan, 0.1).progressPct < 60, `got ${atRate(plan, 0.1).progressPct}`);
  assert.match(plan.summary, /is funded/);
  // 20,000 at 23.3%/yr is ~$388/month.
  assert.ok(plan.summary.includes("388"), plan.summary);
});

test("the target is report-only: nothing on the trading path can see it", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { targetPlan } = await import("../src/goal.ts");

  // The guarantee, asserted structurally: the goal ledger may only be imported
  // by the two reporting modules. If the engine, strategy or risk rails ever
  // import it, this fails — which is the point.
  const allowed = new Set(["goal.ts", "status.ts", "demo.ts", "cli/status.ts", "cli/tick.ts"]);
  const offenders: string[] = [];
  for (const entry of await readdir("src", { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (allowed.has(entry.name)) continue;
    const text = await readFile(`src/${entry.name}`, "utf8");
    if (/from "\.\/goal\.ts"/.test(text)) offenders.push(entry.name);
  }
  assert.deepEqual(offenders, [], `these files import the goal ledger: ${offenders.join(", ")}`);

  // And a huge gap still produces no risk instruction of any kind.
  const poor = targetPlan({ monthlyTarget: 300, equity: 10, achievedCagr: 0.05 });
  assert.ok(poor.rows[0].progressPct < 1);
  assert.ok(!("riskMultiplier" in poor), "the plan must not carry a sizing field");
});
