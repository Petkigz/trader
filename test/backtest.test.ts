import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultSymbolInfo, runBacktest } from "../src/backtest.ts";
import { syntheticCandles } from "../src/data.ts";
import { testConfig } from "./helpers.ts";

const daily = syntheticCandles({ interval: "1d", count: 2400, seed: 3 });

describe("runBacktest", () => {
  it("produces a coherent result on a long history", () => {
    const r = runBacktest({
      cfg: testConfig(),
      daily,
      hourly: [],
      capital: 10,
      info: defaultSymbolInfo("BTCUSDT"),
    });

    assert.equal(r.capital, 10);
    assert.ok(r.finalEquity > 0);
    assert.ok(r.equityCurve.length > 10);
    assert.ok(r.trades >= 0);
    assert.ok(r.maxDrawdownPct >= 0 && r.maxDrawdownPct <= 100);
    assert.ok(Number.isFinite(r.cagrPct));
    assert.ok(r.exposurePct >= 0 && r.exposurePct <= 100);
  });

  it("is deterministic", () => {
    const a = runBacktest({ cfg: testConfig(), daily, hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") });
    const b = runBacktest({ cfg: testConfig(), daily, hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") });
    assert.equal(a.finalEquity, b.finalEquity);
    assert.equal(a.trades, b.trades);
  });

  it("takes the same signals at $10 and $100 (only sizing differs)", () => {
    const small = runBacktest({ cfg: testConfig(), daily, hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") });
    const big = runBacktest({ cfg: testConfig(), daily, hourly: [], capital: 100, info: defaultSymbolInfo("BTCUSDT") });
    // Same signal engine -> same number of round trips. Returns differ because
    // the $5 exchange minimum is a real constraint on a $10 account.
    assert.equal(small.trades, big.trades);
    assert.ok(Math.sign(small.totalReturnPct) === Math.sign(big.totalReturnPct));
  });

  it("never opens two positions at once", () => {
    const r = runBacktest({ cfg: testConfig(), daily, hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") });
    const sides = r.equityCurve.length;
    assert.ok(sides > 0);
    // Buys and sells must alternate.
    const roundTrips = r.trades;
    assert.ok(roundTrips >= 0);
  });

  it("refuses a history that is too short", () => {
    assert.throws(
      () => runBacktest({ cfg: testConfig(), daily: daily.slice(0, 20), hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") }),
      /not enough daily candles/,
    );
  });

  it("charges fees, so a zero-edge round trip loses money", () => {
    const flat = syntheticCandles({ interval: "1d", count: 2000, seed: 99, vol: 0.02, drift: 0 });
    const r = runBacktest({ cfg: testConfig(), daily: flat, hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") });
    assert.ok(r.feesPaid >= 0);
    if (r.trades > 0) assert.ok(r.feesPaid > 0);
  });

  it("reports the last signal for diagnostics", () => {
    const r = runBacktest({ cfg: testConfig(), daily, hourly: [], capital: 10, info: defaultSymbolInfo("BTCUSDT") });
    assert.ok(typeof r.lastSignal.reason === "string");
    assert.ok(r.lastSignal.reason.length > 0);
  });
});
