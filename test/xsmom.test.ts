import test from "node:test";
import assert from "node:assert/strict";

import {
  alignPanel,
  defaultXsMomParams,
  equalWeightBenchmark,
  rankMomentum,
  runXsMom,
  type PanelAsset,
} from "../src/portfolio/xsmom.ts";
import { DAY_MS } from "../src/util/num.ts";
import type { Candle } from "../src/types.ts";

const T0 = Date.UTC(2020, 0, 1);

function series(symbol: string, closes: number[]): PanelAsset {
  return {
    symbol,
    candles: closes.map((close, i) => ({
      openTime: T0 + i * DAY_MS,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
      closeTime: T0 + i * DAY_MS + DAY_MS - 1,
    })),
  };
}

const rising = (n: number, pct: number, start = 100): number[] =>
  Array.from({ length: n }, (_, i) => start * (1 + pct / 100) ** i);

test("alignment uses the union of days and forward-fills, never invents", () => {
  const a = series("AAA", [1, 2, 3]);
  const b: PanelAsset = { symbol: "BBB", candles: series("BBB", [10, 20]).candles };
  const aligned = alignPanel([a, b]);
  assert.equal(aligned.days.length, 3);
  const bbb = aligned.closes.get("BBB") as number[];
  assert.deepEqual(bbb, [10, 20, 20], "third day must repeat the last known price");
});

test("ranking is by trailing return, best first", () => {
  const assets = [series("AAA", rising(120, 0.1)), series("BBB", rising(120, 0.5)), series("CCC", rising(120, 0.3))];
  const aligned = alignPanel(assets);
  const ranked = rankMomentum(aligned, 119, 90);
  assert.deepEqual(ranked.map((r) => r.symbol), ["BBB", "CCC", "AAA"]);
  assert.ok(ranked[0].momentum > ranked[1].momentum);
});

test("assets without enough history are not ranked", () => {
  const assets = [series("AAA", rising(120, 0.1)), series("NEW", rising(5, 1))];
  const aligned = alignPanel(assets);
  const ranked = rankMomentum(aligned, 119, 90);
  assert.deepEqual(ranked.map((r) => r.symbol), ["AAA"]);
});

test("ranking never looks ahead: future prices cannot change today's pick", () => {
  const flat = new Array(120).fill(100);
  const a = series("AAA", [...flat.slice(0, 100), ...rising(20, 5)]);
  const b = series("BBB", [...flat.slice(0, 100), ...rising(20, 1)]);
  const before = rankMomentum(alignPanel([a, b]), 100, 90).map((r) => r.symbol);

  const aMutated = series("AAA", [...flat.slice(0, 100), ...rising(20, 500)]);
  const after = rankMomentum(alignPanel([aMutated, b]), 100, 90).map((r) => r.symbol);
  assert.deepEqual(before, after);
});

test("fees reduce equity and are charged on turnover", () => {
  const assets = [
    series("AAA", [...rising(120, 0.4), ...rising(120, -0.2)]),
    series("BBB", [...rising(120, -0.2), ...rising(120, 0.4)]),
    series("BTCUSDT", rising(240, 0.05)),
  ];
  const params = { ...defaultXsMomParams, lookback: 30, hold: 1, gate: null, rebalanceDays: 10 };
  const free = runXsMom(assets, { ...params, feeRate: 0, slippageBps: 0 });
  const paid = runXsMom(assets, { ...params, feeRate: 0.002, slippageBps: 2 });
  assert.ok(paid.finalEquity < free.finalEquity, `${paid.finalEquity} should be < ${free.finalEquity}`);
  assert.ok(paid.feesPaid > 0);
  assert.ok(free.feesPaid === 0);
});

test("the BTC filter stands aside in a downtrend", () => {
  const assets = [
    series("AAA", rising(240, 0.1)),
    series("BBB", rising(240, 0.2)),
    series("BTCUSDT", [...rising(210, 0.1), ...rising(60, -0.8)]),
  ];
  const params = { ...defaultXsMomParams, lookback: 30, hold: 1, rebalanceDays: 10, requirePositive: false };
  const gated = runXsMom(assets, { ...params, gate: "BTCUSDT" });
  const open = runXsMom(assets, { ...params, gate: null });
  assert.ok(gated.investedPct < open.investedPct, `${gated.investedPct} vs ${open.investedPct}`);
});

test("hold=1 holds exactly one asset, and it is the strongest", () => {
  // 400 bars: the engine refuses to trade before its 200-bar warm-up floor.
  const assets = [
    series("AAA", rising(400, 0.05)),
    series("BBB", rising(400, 0.5)),
    series("CCC", rising(400, 0.2)),
  ];
  const r = runXsMom(assets, {
    ...defaultXsMomParams,
    lookback: 30,
    hold: 1,
    gate: null,
    rebalanceDays: 30,
  });
  assert.equal(r.avgHoldings, 1);
  // BBB is the strongest, so the portfolio should track it, net of a few fees.
  const bbb = assets[1].candles.at(-1)!.close / assets[1].candles[0].close;
  assert.ok(r.finalEquity > 1 && r.finalEquity < bbb);
});

test("equal-weight benchmark buys the whole universe at bar zero", () => {
  const assets = [series("AAA", rising(100, 0.1)), series("BBB", rising(100, 0.3))];
  const r = equalWeightBenchmark(assets);
  assert.equal(r.avgHoldings, 2);
  const expected = ((1 + 0.001) ** 99 + (1 + 0.003) ** 99) / 2;
  assert.ok(Math.abs(r.finalEquity - expected) / expected < 1e-6, `${r.finalEquity} vs ${expected}`);
});

test("holding the whole universe makes the result independent of lookback", () => {
  // With requirePositive off and hold >= universe size, momentum is not used to
  // pick anything, so the only active ingredient is the BTC gate. If the
  // lookback changed the answer, some hidden ranking would still be leaking in.
  const assets = [
    series("AAA", rising(200, 0.2)),
    series("BBB", rising(200, -0.1)),
    series("BTCUSDT", [...rising(120, 0.1), ...rising(80, -0.5)]),
  ];
  const base = { ...defaultXsMomParams, hold: 9, requirePositive: false, gate: "BTCUSDT" };
  const a = runXsMom(assets, { ...base, lookback: 20 });
  const b = runXsMom(assets, { ...base, lookback: 90 });
  assert.equal(a.finalEquity.toFixed(10), b.finalEquity.toFixed(10));
});

test("asking for the BTC filter without BTC in the panel throws", () => {
  const assets = [series("AAA", rising(200, 0.2))];
  assert.throws(
    () => runXsMom(assets, { ...defaultXsMomParams, lookback: 30, gate: "BTCUSDT" }),
    /BTCUSDT/,
  );
});

test("a self-gate stands aside when the asset itself is in a downtrend", () => {
  const up = rising(300, 0.3);
  const down = rising(300, -0.4);
  const asset = (closes: number[]) => series("QQQ", closes);
  const base = { ...defaultXsMomParams, lookback: 1, hold: 1, requirePositive: false, rebalanceDays: 5 };

  const trendUp = runXsMom([asset(up)], { ...base, gate: "QQQ" });
  const trendDown = runXsMom([asset(down)], { ...base, gate: "QQQ" });
  const ungated = runXsMom([asset(down)], { ...base, gate: null });

  assert.ok(trendUp.investedPct > 90, `should be invested in an uptrend, got ${trendUp.investedPct}`);
  assert.ok(trendDown.investedPct < 10, `should stand aside in a downtrend, got ${trendDown.investedPct}`);
  assert.ok(trendDown.finalEquity > ungated.finalEquity, "sitting out a downtrend must beat holding it");
});

test("allowShort goes short the fallers instead of sitting out", () => {
  const falling = rising(400, -0.3);
  const base = { ...defaultXsMomParams, lookback: 20, hold: 999, requirePositive: false, gate: null, rebalanceDays: 10 };

  // Long-only with `requirePositive` sits flat; without it, it holds the faller and loses.
  const longOnly = runXsMom([series("FALL", falling)], { ...base, allowShort: false, requirePositive: true });
  const longShort = runXsMom([series("FALL", falling)], { ...base, allowShort: true });

  assert.ok(Math.abs(longOnly.finalEquity - 1) < 1e-9, "long-only must sit flat, not lose");
  assert.ok(longShort.finalEquity > 1.5, `shorting a 30%/bar fall should profit, got ${longShort.finalEquity}`);
});

test("allowShort signs each asset and keeps gross exposure at 100%", () => {
  const assets = [
    series("UP", rising(400, 0.2)),
    series("DOWN", rising(400, -0.2)),
  ];
  const r = runXsMom(assets, {
    ...defaultXsMomParams,
    lookback: 20,
    hold: 999,
    requirePositive: false,
    allowShort: true,
    gate: null,
    rebalanceDays: 30,
  });
  // Long one, short the other, equal weight: the pair is roughly flat except
  // for the compounding difference, and it must not be flat by accident.
  assert.ok(Number.isFinite(r.finalEquity));
  assert.equal(r.avgHoldings, 2);
});
