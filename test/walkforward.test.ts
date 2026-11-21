import test from "node:test";
import assert from "node:assert/strict";

import { defaultSymbolInfo } from "../src/backtest.ts";
import { syntheticCandles } from "../src/data.ts";
import {
  BASELINE,
  defaultGrid,
  expectedMaxZ,
  walkForward,
  type ParamSet,
} from "../src/research/walkforward.ts";
import { testConfig } from "./helpers.ts";

const INFO = defaultSymbolInfo("BTCUSDT");

function series(count: number) {
  return syntheticCandles({ interval: "1d", count, seed: 7 });
}

test("expectedMaxZ is zero for a single test and grows with the number of tests", () => {
  assert.equal(expectedMaxZ(1), 0);
  assert.equal(expectedMaxZ(0), 0);
  assert.ok(expectedMaxZ(2) > 0);
  // More attempts always flatter the best result.
  assert.ok(expectedMaxZ(15) > expectedMaxZ(5));
  assert.ok(expectedMaxZ(100) > expectedMaxZ(15));
  // Roughly matches the true expected maximum of n standard normals:
  // ~1.87 for 20 draws, ~2.51 for 100. The approximation is allowed to be loose.
  assert.ok(Math.abs(expectedMaxZ(20) - 1.87) < 0.3, `n=20 got ${expectedMaxZ(20)}`);
  assert.ok(Math.abs(expectedMaxZ(100) - 2.51) < 0.3, `n=100 got ${expectedMaxZ(100)}`);
});

test("default grid is modest and well-formed", () => {
  const grid = defaultGrid();
  assert.equal(grid.length, 15);
  for (const p of grid) {
    assert.ok(p.emaPeriod > 0);
    assert.ok(p.entryBuffer >= 0 && p.entryBuffer < 1);
    assert.ok(p.exitBuffer >= 0 && p.exitBuffer < 1);
    assert.ok(p.crashStopPct > 0 && p.crashStopPct < 1);
  }
  // The shipped configuration must be a member of the grid it is compared with.
  assert.ok(
    grid.some(
      (p) =>
        p.emaPeriod === BASELINE.emaPeriod &&
        p.entryBuffer === BASELINE.entryBuffer &&
        p.exitBuffer === BASELINE.exitBuffer,
    ),
  );
});

test("a single-set grid runs exactly one test per window", () => {
  const res = walkForward({
    daily: series(1400),
    hourly: [],
    baseCfg: testConfig({ STRATEGY: "trend" }),
    capital: 10,
    info: INFO,
    grid: [BASELINE],
    inSampleBars: 500,
    outSampleBars: 300,
  });

  assert.equal(res.gridSize, 1);
  assert.equal(res.testsRun, res.windows.length);
  assert.ok(res.windows.length >= 2);
  // With one candidate there is no selection effect at all, so the luck floor
  // collapses onto the observed score.
  assert.equal(res.luckFloorPct, res.inSampleMeanPct);
  assert.equal(res.inSampleBestPct, res.inSampleMeanPct);
  // Every window must report the only parameters available.
  for (const w of res.windows) assert.deepEqual(w.chosen, BASELINE);
});

test("the luck floor is never below the mean in-sample score", () => {
  const res = walkForward({
    daily: series(2000),
    hourly: [],
    baseCfg: testConfig({ STRATEGY: "trend" }),
    capital: 10,
    info: INFO,
    inSampleBars: 600,
    outSampleBars: 400,
  });
  assert.ok(res.luckFloorPct >= res.inSampleMeanPct);
  // The floor sits a spread above the mean, by construction.
  assert.ok(res.luckFloorPct <= res.inSampleMeanPct + 4 * res.inSampleSdPct + 1e-9);
});

test("testsRun equals windows x grid and edgeFound requires both conditions", () => {
  const res = walkForward({
    daily: series(2200),
    hourly: [],
    baseCfg: testConfig({ STRATEGY: "trend" }),
    capital: 10,
    info: INFO,
    inSampleBars: 600,
    outSampleBars: 400,
  });

  assert.equal(res.testsRun, res.windows.length * res.gridSize);
  assert.equal(res.windows.length, 4);

  const shouldBe =
    res.inSampleBestPct > res.luckFloorPct && res.oosCompoundedPct > 0 && res.oosMedianPct > 0;
  assert.equal(res.edgeFound, shouldBe);
});

test("windows advance by the step and stay inside the data", () => {
  const daily = series(2000);
  const res = walkForward({
    daily,
    hourly: [],
    baseCfg: testConfig({ STRATEGY: "trend" }),
    capital: 10,
    info: INFO,
    grid: [BASELINE],
    inSampleBars: 500,
    outSampleBars: 300,
    stepBars: 300,
  });

  for (const w of res.windows) {
    assert.ok(w.oosFrom >= daily[0].openTime);
    assert.ok(w.oosTo <= daily[daily.length - 1].closeTime);
  }
  // Strictly increasing out-of-sample start times.
  for (let i = 1; i < res.windows.length; i++) {
    assert.ok(res.windows[i].oosFrom > res.windows[i - 1].oosFrom);
  }
});

test("refuses history too short to form a window", () => {
  assert.throws(
    () =>
      walkForward({
        daily: series(200),
        hourly: [],
        baseCfg: testConfig({ STRATEGY: "trend" }),
        capital: 10,
        info: INFO,
        grid: [BASELINE] as ParamSet[],
        inSampleBars: 600,
        outSampleBars: 400,
      }),
    /not enough history/,
  );
});

test("an empty grid is rejected rather than silently scoring nothing", () => {
  assert.throws(
    () =>
      walkForward({
        daily: series(1400),
        hourly: [],
        baseCfg: testConfig({ STRATEGY: "trend" }),
        capital: 10,
        info: INFO,
        grid: [],
        inSampleBars: 500,
        outSampleBars: 300,
      }),
    /grid must be non-empty/,
  );
});
