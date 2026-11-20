import assert from "node:assert/strict";
import test from "node:test";

import {
  agreementRate,
  conditionalStats,
  contextSeries,
  hasVolume,
  type ContextPoint,
} from "../src/market/context.ts";
import { gateDecision } from "../src/market/gates.ts";
import { DAY_MS } from "../src/util/num.ts";
import type { Candle } from "../src/types.ts";

const OPTS = { feeRate: 0.001, slippage: 0.0002 }; // 0.24% round trip
const START = Date.UTC(2024, 0, 1);

function bars(closes: number[], opts: { volume?: number; range?: number } = {}): Candle[] {
  return closes.map((close, i) => {
    const range = opts.range ?? close * 0.02;
    return {
      openTime: START + i * DAY_MS,
      open: close,
      high: close + range / 2,
      low: close - range / 2,
      close,
      volume: opts.volume ?? 0,
      closeTime: START + i * DAY_MS + DAY_MS - 1,
    };
  });
}

/** A slow uptrend, then a slow downtrend — enough to move a 20-bar EMA. */
function ramp(n: number, from: number, step: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i * step);
}

test("the market reading follows the reference, not the symbol", () => {
  const ref = bars([...ramp(60, 100, 1), ...ramp(60, 160, -1)]);
  const sym = bars([...ramp(60, 10, 0.1), ...ramp(60, 16, -0.05)]);
  const ctx = contextSeries(sym, ref, { ...OPTS, emaPeriod: 20 });

  const early = ctx[50];
  const late = ctx[ctx.length - 1];
  assert.equal(early.marketAboveEma, true, "reference still above its average");
  assert.equal(late.marketAboveEma, false, "reference has rolled over");
  assert.ok((early.marketDistancePct ?? 0) > 0);
});

test("without a reference the market is unknown, not bearish", () => {
  // Wide bars so the cost gate has nothing to object to: this test is about a
  // missing *reference*, not about friction.
  const sym = bars(ramp(80, 100, 1), { range: 5 });
  const ctx = contextSeries(sym, null, { ...OPTS, emaPeriod: 20 });
  assert.equal(ctx[ctx.length - 1].marketAboveEma, null);
  assert.equal(ctx[ctx.length - 1].beta, null);

  // Unknown must allow: a missing input is not a permanent veto.
  for (const gate of ["market", "volume", "cost", "all"] as const) {
    const d = gateDecision(gate, ctx[ctx.length - 1]);
    assert.equal(d.allow, true, `${gate} vetoed on no data: ${d.reason}`);
  }
  assert.equal(gateDecision("market", ctx[ctx.length - 1]).reason, "", "absence is not a bearish signal");
});

test("beta is measured, not assumed", () => {
  // Symbol returns are twice the reference's, day for day.
  const refCloses = ramp(120, 100, 1).map((c, i) => c + Math.sin(i / 3) * 2);
  const symCloses = refCloses.map((c, i) => 50 * Math.pow(c / 100, 2) * (i === 0 ? 1 : 1));
  const ctx = contextSeries(bars(symCloses), bars(refCloses), { ...OPTS, emaPeriod: 20, betaWindow: 60 });
  const last = ctx[ctx.length - 1];
  assert.ok(last.beta !== null && Math.abs(last.beta - 2) < 0.25, `beta ${last.beta}`);
  assert.ok(last.correlation !== null && last.correlation > 0.9, `corr ${last.correlation}`);
});

test("the range-to-cost ratio knows when a move cannot pay for itself", () => {
  const tight = contextSeries(bars(ramp(40, 100, 0.1), { range: 0.05 }), null, OPTS);
  const wide = contextSeries(bars(ramp(40, 100, 0.1), { range: 5 }), null, OPTS);

  const tightLast = tight[tight.length - 1];
  const wideLast = wide[wide.length - 1];
  assert.ok(tightLast.edgeToCost !== null && tightLast.edgeToCost < 1);
  assert.ok(wideLast.edgeToCost !== null && wideLast.edgeToCost > 10);

  assert.equal(gateDecision("cost", tightLast).allow, false, "a 0.05% day cannot pay 0.24%");
  assert.equal(gateDecision("cost", wideLast).allow, true);
});

test("the volume gate reads flow when it exists and abstains when it does not", () => {
  const quiet = bars(ramp(60, 100, 1), { volume: 100 });
  // Last bar trades on a tenth of the usual volume.
  quiet[quiet.length - 1].volume = 10;
  const quietCtx = contextSeries(quiet, null, { ...OPTS, volumeWindow: 30 });
  const lastQuiet = quietCtx[quietCtx.length - 1];
  assert.ok(lastQuiet.volumeRatio !== null && lastQuiet.volumeRatio < 0.5);
  assert.equal(gateDecision("volume", lastQuiet).allow, false);

  const noVolume = contextSeries(bars(ramp(60, 100, 1)), null, { ...OPTS, volumeWindow: 30 });
  const lastNoVol = noVolume[noVolume.length - 1];
  assert.equal(lastNoVol.volumeRatio, null, "a panel without volume reports null, not zero");
  assert.equal(gateDecision("volume", lastNoVol).allow, true, "and does not veto on it");
  assert.equal(hasVolume(bars(ramp(5, 100, 1))), false);
  assert.equal(hasVolume(quiet), true);
});

test("the market gate refuses entries when the reference is below its average", () => {
  const ref = bars([...ramp(60, 100, 1), ...ramp(40, 160, -1.5)]);
  const sym = bars([...ramp(60, 10, 0.1), ...ramp(40, 16, 0.05)]);
  const ctx = contextSeries(sym, ref, { ...OPTS, emaPeriod: 20 });
  const last = ctx[ctx.length - 1];
  assert.equal(last.marketAboveEma, false);
  const d = gateDecision("market", last);
  assert.equal(d.allow, false);
  assert.match(d.reason, /market below its long average/);
});

test("a gate can only ever refuse, never create or resize", () => {
  const point: ContextPoint = {
    marketAboveEma: false,
    marketDistancePct: -0.2,
    symbolAboveEma: true,
    beta: 1.4,
    correlation: 0.8,
    volumeRatio: 0.1,
    atrPct: 0.001,
    costPct: 0.0024,
    edgeToCost: 0.4,
  };
  for (const gate of ["off", "market", "volume", "cost", "all"] as const) {
    const d = gateDecision(gate, point);
    assert.equal(typeof d.allow, "boolean");
    assert.deepEqual(Object.keys(d).sort(), ["allow", "reason"], "no size, no action, just a veto");
  }
  assert.equal(gateDecision("off", point).allow, true, "the default changes nothing");
});

test("agreement measures redundancy between the symbol's trend and the market's", () => {
  const same = contextSeries(
    bars(ramp(80, 100, 1)),
    bars(ramp(80, 100, 1)),
    { ...OPTS, emaPeriod: 20 },
  );
  assert.ok((agreementRate(same) ?? 0) > 0.99, "identical series must agree almost always");

  const opposite = contextSeries(
    bars(ramp(80, 100, 1)),
    bars(ramp(80, 200, -1)),
    { ...OPTS, emaPeriod: 20 },
  );
  const rate = agreementRate(opposite) ?? 0;
  assert.ok(rate < 0.6, `disagreeing trends should not agree (${rate})`);
});

test("conditional stats split the symbol's days by what the market was doing", () => {
  const ref = bars([...ramp(70, 100, 1), ...ramp(70, 170, -1)]);
  const sym = bars([...ramp(70, 10, 0.2), ...ramp(70, 24, -0.2)]);
  const ctx = contextSeries(sym, ref, { ...OPTS, emaPeriod: 20 });
  const stats = conditionalStats(sym, ctx);
  assert.ok(stats.barsMarketUp > 0 && stats.barsMarketDown > 0);
  assert.ok((stats.meanReturnMarketUp ?? 0) > 0, "up-market days were up days");
  assert.ok((stats.meanReturnMarketDown ?? 0) < 0, "down-market days were down days");
});
