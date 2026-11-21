import assert from "node:assert/strict";
import test from "node:test";

import { healthReport } from "../api/health.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { TickRecord } from "../src/types.ts";
import { DAY_MS } from "../src/util/num.ts";
import { testConfig } from "./helpers.ts";

const cfg = testConfig();
const NOW = Date.UTC(2026, 5, 1, 12);

function tick(opts: { ts: number; reason: string; detail?: string }): TickRecord {
  return {
    ts: opts.ts,
    mode: "paper",
    strategy: "trend",
    symbol: "BTCUSDT",
    price: 100,
    equity: 10,
    action: "NONE",
    reason: opts.reason,
    detail: opts.detail ?? "",
    meta: {},
  };
}

async function storeWith(ticks: TickRecord[], lastTickAt: number) {
  const store = new MemoryStore();
  const state = (await store.getState())!;
  await store.saveState({
    ...state,
    lastTickAt,
    updatedAt: lastTickAt,
  } as typeof state);
  // Oldest first, as the engine records them.
  for (const t of [...ticks].reverse()) await store.recordTick(t);
  return store;
}

test("a fresh bot with no tick is unhealthy and says why", async () => {
  const report = await healthReport(new MemoryStore(), cfg, NOW);
  assert.equal(report.ok, false);
  assert.match(report.problems.join(" "), /no tick has ever run/);
});

test("a recent successful tick is healthy", async () => {
  const store = await storeWith([tick({ ts: NOW - 3_600_000, reason: "trend_intact" })], NOW - 3_600_000);
  const report = await healthReport(store, cfg, NOW);
  assert.equal(report.ok, true);
  assert.equal(report.lastOutcome, "trend_intact");
  assert.deepEqual(report.problems, []);
});

test("a dead scheduler is caught by the age of the last tick", async () => {
  const old = NOW - 4 * DAY_MS;
  const store = await storeWith([tick({ ts: old, reason: "trend_intact" })], old);
  const report = await healthReport(store, cfg, NOW);
  assert.equal(report.ok, false);
  assert.match(report.problems.join(" "), /scheduler may be dead/);
});

test("a bot that ticks but always fails is not healthy", async () => {
  // The bug this exists to prevent: every tick errors, but lastTickAt is fresh,
  // so an age-only check would report a green bot that has been broken for days.
  const ticks = [1, 2, 3].map((n) =>
    tick({ ts: NOW - n * 3_600_000, reason: "error", detail: "binance 429 rate limited" }),
  );
  const store = await storeWith(ticks, NOW - 3_600_000);
  const report = await healthReport(store, cfg, NOW);
  assert.equal(report.ok, false);
  assert.equal(report.consecutiveErrors, 3);
  assert.match(report.problems.join(" "), /consecutive ticks failed/);
  assert.match(report.lastError ?? "", /429/);
});

test("one failure after a success is unlucky, not broken", async () => {
  const ticks = [
    tick({ ts: NOW - 3_600_000, reason: "error", detail: "network blip" }),
    tick({ ts: NOW - 2 * 3_600_000, reason: "trend_intact" }),
  ];
  const store = await storeWith(ticks, NOW - 3_600_000);
  const report = await healthReport(store, cfg, NOW);
  assert.equal(report.consecutiveErrors, 1);
  assert.equal(report.ok, true, "a single failed tick should not page anyone");
});

test("a halt is reported but is not a failure", async () => {
  const store = new MemoryStore();
  const state = (await store.getState())!;
  await store.saveState({
    ...state,
    lastTickAt: NOW - 3_600_000,
    haltedUntil: NOW + DAY_MS,
    haltReason: "3 consecutive losing trades",
  } as typeof state);
  await store.recordTick(tick({ ts: NOW - 3_600_000, reason: "blocked:halted" }));

  const report = await healthReport(store, cfg, NOW);
  assert.equal(report.ok, true, "doing nothing on purpose is not an outage");
  assert.equal(report.halted, true);
  assert.match(report.problems.join(" "), /halted until/);
});
