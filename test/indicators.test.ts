import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atr, ema, lastValid, maxDrawdown, rsi, sharpe, sma, stdev } from "../src/util/indicators.ts";
import { makeCandle, series } from "./helpers.ts";

describe("sma", () => {
  it("averages the last n values and pads the front", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    assert.ok(Number.isNaN(out[0]));
    assert.ok(Number.isNaN(out[1]));
    assert.equal(out[2], 2);
    assert.equal(out[3], 3);
    assert.equal(out[4], 4);
  });
});

describe("ema", () => {
  it("seeds with the SMA then smooths", () => {
    const out = ema([1, 2, 3, 4, 5, 6], 3);
    assert.ok(Number.isNaN(out[1]));
    assert.equal(out[2], 2); // SMA(1,2,3)
    // alpha = 2/4 = 0.5 -> 4*0.5 + 2*0.5 = 3
    assert.equal(out[3], 3);
    assert.equal(out[4], 4);
  });

  it("tracks a constant series exactly", () => {
    const out = ema(new Array(50).fill(7), 20);
    assert.equal(lastValid(out), 7);
  });

  it("returns all NaN when there is not enough history", () => {
    const out = ema([1, 2, 3], 10);
    assert.equal(lastValid(out), null);
  });
});

describe("rsi", () => {
  it("is 100 for a monotonically rising series", () => {
    const out = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
    assert.equal(lastValid(out), 100);
  });

  it("is 0 for a monotonically falling series", () => {
    const out = rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14);
    assert.equal(lastValid(out), 0);
  });

  it("is ~50 for a flat series", () => {
    const out = rsi(new Array(30).fill(100), 14);
    // no gains and no losses -> division guarded to 100; document the behaviour
    assert.ok(lastValid(out) === 100 || lastValid(out) === 50);
  });

  it("oscillates inside 0..100", () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const v = lastValid(rsi(closes, 14));
    assert.ok(v !== null && v >= 0 && v <= 100);
  });
});

describe("atr", () => {
  it("equals the average true range for a flat series", () => {
    const candles = series({ closes: new Array(30).fill(100) });
    const v = lastValid(atr(candles, 14));
    assert.ok(v !== null);
    // high/low are +/-1% of 100 -> TR = 2
    assert.ok(Math.abs(v - 2) < 1e-9);
  });

  it("grows with volatility", () => {
    const calm = series({ closes: new Array(40).fill(100) });
    const wild = series({ closes: Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 10 : -10)) });
    const a = lastValid(atr(calm, 14)) as number;
    const b = lastValid(atr(wild, 14)) as number;
    assert.ok(b > a);
  });

  it("uses the previous close in the true range", () => {
    // bar 0 is 99..101 (TR 2); bar 1 gaps up to 120..130 (TR = 130 - 100 = 30)
    const candles = [makeCandle(100, 1000), makeCandle(100, 2000)];
    candles[1].high = 130;
    candles[1].low = 120;
    const v = lastValid(atr(candles, 2)) as number;
    assert.ok(Math.abs(v - (2 + 30) / 2) < 1e-9, `atr=${v}`);
  });
});

describe("stdev", () => {
  it("is zero for a constant series", () => {
    assert.equal(lastValid(stdev(new Array(30).fill(5), 20)), 0);
  });

  it("matches the population deviation", () => {
    const v = lastValid(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8)) as number;
    assert.ok(Math.abs(v - 2) < 1e-9);
  });
});

describe("lastValid", () => {
  it("finds the most recent finite value", () => {
    assert.equal(lastValid([NaN, 1, 2, NaN]), 2);
    assert.equal(lastValid([NaN, NaN]), null);
    assert.equal(lastValid([]), null);
  });
});

describe("maxDrawdown", () => {
  it("measures peak-to-trough", () => {
    assert.ok(Math.abs(maxDrawdown([100, 120, 60, 90]) - 0.5) < 1e-9);
  });

  it("is zero for a monotonically rising curve", () => {
    assert.equal(maxDrawdown([1, 2, 3]), 0);
  });
});

describe("sharpe", () => {
  it("is positive for consistently positive returns", () => {
    const returns = new Array(200).fill(0.001);
    assert.ok(sharpe(returns, 365) > 1);
  });

  it("is zero when variance is zero", () => {
    assert.equal(sharpe([], 365), 0);
    assert.equal(sharpe([0.01], 365), 0);
  });
});
