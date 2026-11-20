import test from "node:test";
import assert from "node:assert/strict";

import { classifyRegime } from "../src/strategy/regime.ts";
import { evalMeanRev } from "../src/strategy/meanrev.ts";
import { evalEnsemble, scoreFamilies, selectFamily } from "../src/strategy/ensemble.ts";
import { evaluate } from "../src/strategy.ts";
import type { Candle } from "../src/types.ts";
import { DAY_MS } from "../src/util/num.ts";
import { testConfig } from "./helpers.ts";

function candles(closes: number[]): Candle[] {
  const t0 = Date.UTC(2024, 0, 1);
  return closes.map((close, i) => ({
    openTime: t0 + i * DAY_MS,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    closeTime: t0 + i * DAY_MS + DAY_MS - 1,
  }));
}

/** Steady geometric rise. */
function rising(n: number, pctPerBar = 0.3, start = 100): number[] {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + pctPerBar / 100));
  return out;
}

/** Steady geometric fall — no uptrend, so no dip may be bought. */
function falling(n: number, pctPerBar = 0.4, start = 100): number[] {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 - pctPerBar / 100));
  return out;
}

const ENSEMBLE_CFG = () => testConfig({ STRATEGY: "ensemble", SYMBOL: "BTCUSDT" });

test("regime refuses to classify without enough history", () => {
  const r = classifyRegime(candles(rising(50)), ENSEMBLE_CFG());
  assert.equal(r.warmingUp, true);
  assert.match(r.note, /need \d+ closes/);
});

test("regime detects an uptrend and a downtrend", () => {
  const up = classifyRegime(candles(rising(300)), ENSEMBLE_CFG());
  assert.equal(up.warmingUp, false);
  assert.equal(up.trend, "up");
  assert.ok(up.distancePct > 0);
  assert.ok(up.strength > 0);

  const down = classifyRegime(candles(falling(300)), ENSEMBLE_CFG());
  assert.equal(down.trend, "down");
  assert.ok(down.distancePct < 0);
});

test("regime flags a volatility storm after a quiet stretch", () => {
  // 400 quiet bars, then 25 violent ones continuing from the same price.
  const closes: number[] = [100];
  for (let i = 1; i < 400; i++) closes.push(closes[i - 1] * (1 + (i % 2 ? 0.0005 : -0.0005)));
  for (let i = 0; i < 25; i++) {
    closes.push(closes[closes.length - 1] * (1 + (i % 2 ? 0.06 : -0.06)));
  }
  const r = classifyRegime(candles(closes), ENSEMBLE_CFG());
  assert.equal(r.vol, "storm");
  assert.ok(r.volRatio >= 2);
});

test("mean reversion refuses to buy dips in a downtrend", () => {
  // The safety-critical property: a falling market is not a bargain.
  const cfg = ENSEMBLE_CFG();
  const input = {
    daily: candles(falling(300)),
    hourly: [],
    position: null,
    price: 1,
    now: Date.now(),
    cfg,
  };
  const d = evalMeanRev(input);
  assert.equal(d.action, "HOLD");
  assert.equal(d.reason, "no_uptrend");
});

test("mean reversion tolerates being asked for a decision while holding", () => {
  const cfg = ENSEMBLE_CFG();
  const daily = candles(rising(300));
  const d = evalMeanRev({
    daily,
    hourly: [],
    position: {
      symbol: "BTCUSDT",
      qty: 0.0001,
      entryPrice: daily[daily.length - 1].close,
      entryAt: Date.now() - DAY_MS,
      stopPrice: null,
      targetPrice: null,
    },
    price: daily[daily.length - 1].close,
    now: Date.now(),
    cfg,
  });
  assert.ok(["HOLD", "EXIT_LONG"].includes(d.action));
  assert.ok(d.reason.length > 0);
});

test("selection is the argmax of the scores, and edge carries the sign", () => {
  const cfg = ENSEMBLE_CFG();
  const state = selectFamily(candles(rising(600)), cfg);
  assert.ok(Number.isFinite(state.scores.trend) && Number.isFinite(state.scores.meanrev));
  assert.ok(Math.abs(state.edge - (state.scores.meanrev - state.scores.trend)) < 1e-12);
  // No softmax, no temperature: the winner is decided by the sign of the edge,
  // so a knob that merely rescales confidence cannot exist to mislead anyone.
  const expected = state.edge > 0 ? "meanrev" : "trend";
  assert.ok(state.selected === "cash" || state.selected === expected);
});

test("a storm forces cash regardless of family scores", () => {
  const closes: number[] = [100];
  for (let i = 1; i < 400; i++) closes.push(closes[i - 1] * (1 + (i % 2 ? 0.0005 : -0.0005)));
  for (let i = 0; i < 25; i++) {
    closes.push(closes[closes.length - 1] * (1 + (i % 2 ? 0.06 : -0.06)));
  }
  const cfg = ENSEMBLE_CFG();
  const state = selectFamily(candles(closes), cfg);
  assert.equal(state.regime.vol, "storm");
  assert.equal(state.selected, "cash");
});

test("ensemble never exits without a position, and names the managing family when it has one", () => {
  const cfg = ENSEMBLE_CFG();
  const daily = candles(rising(400, 0.2));

  const flat = evalEnsemble({ daily, hourly: [], position: null, price: 100, now: Date.now(), cfg });
  assert.notEqual(flat.action, "EXIT_LONG");

  const held = evalEnsemble({
    daily,
    hourly: [],
    position: {
      symbol: "BTCUSDT",
      qty: 0.0001,
      entryPrice: daily[daily.length - 1].close,
      entryAt: Date.now() - DAY_MS,
      stopPrice: null,
      targetPrice: null,
    },
    price: daily[daily.length - 1].close,
    now: Date.now(),
    cfg,
  });
  // Exactly one family owns the trade — the fix that stopped a 193-trade churn.
  assert.match(held.reason, /^ensemble\/(trend|meanrev):/);
  assert.ok(held.meta?.manager === "trend" || held.meta?.manager === "meanrev");
});

test("evaluate() dispatches to the ensemble and to meanrev", () => {
  const daily = candles(rising(400, 0.2));
  const base = { daily, hourly: [], position: null, price: 100, now: Date.now() };

  const ens = evaluate({ ...base, cfg: testConfig({ STRATEGY: "ensemble" }) });
  assert.match(ens.reason, /^ensemble\//);

  const mr = evaluate({ ...base, cfg: testConfig({ STRATEGY: "meanrev" }) });
  assert.ok(mr.reason.length > 0);
  assert.ok(!mr.reason.startsWith("ensemble/"));
});

test("ensemble decisions are deterministic", () => {
  const cfg = ENSEMBLE_CFG();
  const daily = candles(rising(400, 0.2));
  const a = evalEnsemble({ daily, hourly: [], position: null, price: 100, now: 1, cfg });
  const b = evalEnsemble({ daily, hourly: [], position: null, price: 100, now: 1, cfg });
  assert.deepEqual(a, b);
});
