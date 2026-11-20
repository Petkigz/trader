import assert from "node:assert/strict";
import test from "node:test";

import {
  capitalFor,
  chaseMultiplier,
  expectedPerDay,
  goalStatus,
  planParticipation,
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

test("a growing account that is still far short hears the harsher verdict", () => {
  // $20 after a year of gains: the gap is smaller and the rate still absurd.
  const s = goalStatus(cfg, 20, day(365));
  assert.equal(s.pressure, "unreachable");
  assert.ok((s.requiredDailyReturn30d ?? 0) > 0.05);
  assert.match(s.verdict, /lottery ticket/);
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
