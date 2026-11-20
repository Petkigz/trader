import test from "node:test";
import assert from "node:assert/strict";

import { adaptiveFraction, realisedVol } from "../src/strategy/adaptive.ts";
import type { Candle } from "../src/types.ts";
import { DAY_MS } from "../src/util/num.ts";
import { testConfig } from "./helpers.ts";

/** Build daily candles from a list of closes. */
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

/** Alternating up/down moves of a fixed size — a controllable volatility knob. */
function series(n: number, dailyMovePct: number, start = 60_000): number[] {
  const out = [start];
  for (let i = 1; i < n; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    out.push(out[i - 1] * (1 + (dir * dailyMovePct) / 100));
  }
  return out;
}

test("realisedVol annualises daily moves and rejects short input", () => {
  // Alternating +/-1% daily => ~1% daily sd => ~19% annualised (1% * sqrt(365)).
  const v = realisedVol(series(41, 1), 40);
  assert.ok(Number.isFinite(v));
  assert.ok(v > 0.15 && v < 0.25, `expected ~0.19 annualised, got ${v}`);

  const calm = realisedVol(series(41, 0.05), 40);
  assert.ok(calm < 0.02, `quiet series should annualise near zero, got ${calm}`);
  assert.ok(calm < v, "a quieter series must produce a lower volatility");

  assert.ok(Number.isNaN(realisedVol(series(10, 1), 40)), "too few bars must be NaN");
});

test("disabled adaptive sizing returns the configured fraction unchanged", () => {
  const cfg = testConfig({ ADAPTIVE_SIZING: "0" });
  const snap = adaptiveFraction(candles(series(240, 1)), cfg);
  assert.equal(snap.fraction, cfg.risk.positionFraction);
  assert.equal(snap.scale, 1);
  assert.equal(snap.regime, "unknown");
});

test("high volatility shrinks the position", () => {
  const cfg = testConfig({ ADAPTIVE_SIZING: "1", TARGET_VOL: "0.2", CALM_VOL_MULTIPLE: "0.1" });
  const snap = adaptiveFraction(candles(series(240, 2)), cfg);
  assert.ok(snap.realisedVol > cfg.adaptive.targetVol);
  assert.ok(snap.scale < 1, `scale should be < 1, got ${snap.scale}`);
  assert.ok(snap.fraction < cfg.risk.positionFraction);
  assert.ok(snap.fraction > 0);
});

test("low volatility never enlarges the position beyond the configured fraction", () => {
  // A very low target makes the raw ratio large; maxScale=1 must cap it.
  const cfg = testConfig({ ADAPTIVE_SIZING: "1", TARGET_VOL: "5" });
  const snap = adaptiveFraction(candles(series(240, 0.5)), cfg);
  assert.equal(snap.scale, 1);
  assert.equal(snap.fraction, cfg.risk.positionFraction);
});

test("a volatility spike against its own baseline is flagged as a storm", () => {
  // 400 quiet days, then 25 violent ones continuing from the same price.
  const closes = series(400, 0.05);
  let last = closes[closes.length - 1];
  for (let i = 0; i < 25; i++) {
    last = last * (1 + ((i % 2 === 0 ? 1 : -1) * 6) / 100);
    closes.push(last);
  }
  const cfg = testConfig({ ADAPTIVE_SIZING: "1", TARGET_VOL: "0.4" });
  const snap = adaptiveFraction(candles(closes), cfg);
  assert.equal(snap.regime, "storm");
  // Storm applies an extra cut on top of vol targeting.
  assert.ok(snap.scale <= cfg.adaptive.stormScale);
});

test("the fraction is always clamped into (0, positionFraction]", () => {
  const cfg = testConfig({ ADAPTIVE_SIZING: "1", TARGET_VOL: "0.1", ADAPTIVE_MIN_SCALE: "0.25" });
  for (const move of [0.1, 1, 5, 12]) {
    const snap = adaptiveFraction(candles(series(240, move)), cfg);
    assert.ok(snap.fraction > 0, `fraction must stay positive (move ${move})`);
    assert.ok(
      snap.fraction <= cfg.risk.positionFraction + 1e-12,
      `fraction must not exceed the configured cap (move ${move})`,
    );
    assert.ok(snap.scale >= cfg.adaptive.minScale - 1e-12);
  }
});

test("adaptation is a pure function of candles and config", () => {
  const cfg = testConfig({ ADAPTIVE_SIZING: "1" });
  const data = candles(series(240, 1.5));
  const a = adaptiveFraction(data, cfg);
  const b = adaptiveFraction(data, cfg);
  assert.deepEqual(a, b);
});

test("insufficient history falls back to the static fraction instead of guessing", () => {
  const cfg = testConfig({ ADAPTIVE_SIZING: "1", VOL_WINDOW: "20" });
  const snap = adaptiveFraction(candles(series(5, 1)), cfg);
  assert.equal(snap.fraction, cfg.risk.positionFraction);
  assert.equal(snap.regime, "unknown");
  assert.match(snap.note, /not enough history/);
});
