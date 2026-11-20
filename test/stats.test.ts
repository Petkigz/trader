import test from "node:test";
import assert from "node:assert/strict";

import {
  blockBootstrap,
  mean,
  sd,
  sharpeFromMonthly,
  signTestP,
  tStat,
} from "../src/research/stats.ts";

test("mean and sample sd use n-1", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.ok(Math.abs(sd([1, 2, 3, 4]) - 1.2909944) < 1e-6);
});

test("t statistic is zero for a symmetric sample and positive for a shifted one", () => {
  assert.ok(Math.abs(tStat([-1, 1, -1, 1])) < 1e-12);
  assert.ok(tStat([1, 2, 3, 4, 5]) > 4);
  assert.ok(Number.isNaN(tStat([2, 2, 2])));
});

test("sign test is one-sided and matches the exact binomial", () => {
  // P(X >= 6) = 1/64; P(X >= 4) = 22/64; P(X >= 3) = 42/64.
  assert.ok(Math.abs(signTestP(6, 6) - 0.015625) < 1e-12);
  assert.ok(Math.abs(signTestP(4, 6) - 0.34375) < 1e-12);
  assert.ok(Math.abs(signTestP(3, 6) - 0.65625) < 1e-12);
  assert.equal(signTestP(0, 6), 1);
});

test("block bootstrap is deterministic and centred on the observed mean", () => {
  const panel = Array.from({ length: 60 }, (_, i) => [0.01 + 0.001 * (i % 5), 0.02 - 0.001 * (i % 3)]);
  const a = blockBootstrap(panel, { block: 6, reps: 500, seed: 7 });
  const b = blockBootstrap(panel, { block: 6, reps: 500, seed: 7 });
  assert.deepEqual(a, b, "same seed must give the same interval");
  assert.ok(a.lo95 <= a.hi95);
  assert.ok(Math.abs(a.drawsMean - a.observed) < 1e-3, `drawsMean ${a.drawsMean} vs ${a.observed}`);
  // A strictly positive panel should rarely resample to a negative mean.
  assert.ok(a.wrongSign < 0.05, `wrongSign ${a.wrongSign}`);
});

test("block bootstrap of a constant panel is exactly that constant", () => {
  const panel = Array.from({ length: 24 }, () => [0.01, 0.01, 0.01]);
  const b = blockBootstrap(panel, { block: 3, reps: 100, seed: 3 });
  assert.ok(Math.abs(b.lo95 - 0.01) < 1e-12);
  assert.ok(Math.abs(b.hi95 - 0.01) < 1e-12);
  assert.equal(b.wrongSign, 0);
});

test("block bootstrap widens when months are correlated inside blocks", () => {
  // Twenty months in five long runs: block resampling should show far more
  // spread than an iid assumption would.
  const panel: number[][] = [];
  for (const v of [0.1, 0.1, 0.1, 0.1, 0.1, -0.1, -0.1, -0.1, -0.1, -0.1]) {
    for (let k = 0; k < 3; k++) panel.push([v]);
  }
  const wide = blockBootstrap(panel, { block: 6, reps: 800, seed: 1 });
  const narrow = blockBootstrap(panel, { block: 1, reps: 800, seed: 1 });
  assert.ok(wide.hi95 - wide.lo95 > narrow.hi95 - narrow.lo95);
});

test("sharpeFromMonthly annualises by sqrt(12)", () => {
  const xs = [0.01, -0.005, 0.02, 0.0, 0.01, -0.01];
  const expected = (mean(xs) / sd(xs)) * Math.sqrt(12);
  assert.ok(Math.abs(sharpeFromMonthly(xs) - expected) < 1e-12);
});

test("block bootstrap actually uses every month, not every k-th month", () => {
  // A sawtooth: block starts are all high, the rest are low. If the resampler
  // only kept the first row of each block it would report the high mean.
  const panel = Array.from({ length: 48 }, (_, i) => [i % 6 === 0 ? 1 : 0]);
  const b = blockBootstrap(panel, { block: 6, reps: 400, seed: 5 });
  assert.ok(Math.abs(b.observed - 8 / 48) < 1e-12, `observed ${b.observed}`);
  assert.ok(
    Math.abs(b.drawsMean - b.observed) < 0.02,
    `draws should centre on the observed mean, got ${b.drawsMean} vs ${b.observed}`,
  );
});
