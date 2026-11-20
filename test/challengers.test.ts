import test from "node:test";
import assert from "node:assert/strict";

import {
  ChallengerRegistry,
  evaluateDemotion,
  evaluatePromotion,
  requiredEdgeSE,
  type ChallengerOutcome,
  type ChallengerSpec,
} from "../src/research/challengers.ts";

const spec = (over: Partial<ChallengerSpec> = {}): ChallengerSpec => ({
  id: "meanrev-1",
  strategy: "meanrev",
  env: { ENSEMBLE_RSI_ENTRY: "35" },
  hypothesis: "Buying RSI dips inside an uptrend beats holding cash in chop.",
  minDecisions: 100,
  registeredAt: 1_700_000_000_000,
  ...over,
});

const outcome = (over: Partial<ChallengerOutcome> = {}): ChallengerOutcome => ({
  decisions: 120,
  returnPct: 0.35,
  sharpe: 0.9,
  championReturnPct: 0.2,
  championSharpe: 0.7,
  ...over,
});

test("a challenger with no written hypothesis cannot even be registered", () => {
  const reg = new ChallengerRegistry();
  assert.throws(() => reg.register(spec({ hypothesis: "" })), /pre-registered hypothesis/);
  assert.throws(() => reg.register(spec({ hypothesis: "looks good" })), /pre-registered hypothesis/);
  assert.equal(reg.attempts, 0, "a rejected registration must not inflate the attempt count");
});

test("duplicate ids are refused so a failed attempt cannot be overwritten", () => {
  const reg = new ChallengerRegistry();
  reg.register(spec());
  assert.throws(() => reg.register(spec()), /already registered/);
});

test("the sample floor refuses to judge on a handful of decisions", () => {
  const v = evaluatePromotion(spec(), outcome({ decisions: 12 }), 1, 0.05);
  assert.equal(v.promote, false);
  assert.match(v.reasons[0], /insufficient sample/);
});

test("the bar rises with the number of attempts", () => {
  const one = requiredEdgeSE(1);
  const ten = requiredEdgeSE(10);
  const hundred = requiredEdgeSE(100);
  assert.ok(one < ten && ten < hundred, `${one} < ${ten} < ${hundred}`);
  assert.equal(one, 0, "a single attempt carries no multiplicity cost");

  // Same 4-point edge: passes as the only attempt, fails once 100 have been
  // tried, because the luckiest of 100 coin flips is worth about 2.5 s.e.
  const alone = evaluatePromotion(spec(), outcome({ returnPct: 0.24 }), 1, 0.02);
  const crowded = evaluatePromotion(spec(), outcome({ returnPct: 0.24 }), 100, 0.02);
  assert.equal(alone.promote, true, alone.reasons.join("; "));
  assert.equal(crowded.promote, false, crowded.reasons.join("; "));
  assert.match(crowded.reasons.join("; "), /luck bar/);
});

test("a big edge with worse risk is rejected", () => {
  const v = evaluatePromotion(spec(), outcome({ returnPct: 0.9, sharpe: 0.4 }), 1, 0.05);
  assert.equal(v.promote, false);
  assert.match(v.reasons.join("; "), /risk-adjusted/);
});

test("an edge concentrated in a minority of assets is rejected", () => {
  const perAsset = [
    { symbol: "AAA", returnPctDiff: 0.4 },
    { symbol: "BBB", returnPctDiff: -0.1 },
    { symbol: "CCC", returnPctDiff: -0.2 },
  ];
  const v = evaluatePromotion(spec(), outcome({ perAsset }), 1, 0.02);
  assert.equal(v.promote, false);
  assert.match(v.reasons.join("; "), /inconsistent/);
});

test("a challenger that clears everything is promoted, with its working shown", () => {
  const perAsset = [
    { symbol: "AAA", returnPctDiff: 0.4 },
    { symbol: "BBB", returnPctDiff: 0.1 },
  ];
  const v = evaluatePromotion(spec(), outcome({ perAsset }), 1, 0.02);
  assert.equal(v.promote, true, v.reasons.join("; "));
  assert.ok(v.reasons.length >= 4, "every gate should leave a trace");
  assert.equal(v.required.attempts, 1);
});

test("the registry counts rejected and retired challengers as attempts forever", () => {
  const reg = new ChallengerRegistry();
  reg.register(spec({ id: "a" }));
  reg.register(spec({ id: "b" }));
  reg.register(spec({ id: "c" }));
  reg.retire("b");
  assert.equal(reg.attempts, 3, "retiring must not erase the attempt");

  // Round-tripping through JSON must preserve the count, or the bar drifts down.
  const back = ChallengerRegistry.fromJSON(JSON.parse(JSON.stringify(reg.toJSON())));
  assert.equal(back.attempts, 3);
  assert.equal(back.get("b")?.status, "retired");
});

test("assessment promotes through the registry and records the verdict", () => {
  const reg = new ChallengerRegistry();
  reg.register(spec());
  const v = reg.assess("meanrev-1", outcome(), 0.02, 1_700_000_001_000);
  assert.equal(v.promote, true, v.reasons.join("; "));
  assert.equal(reg.promoted().length, 1);
  assert.deepEqual(reg.get("meanrev-1")?.verdict?.observed.decisions, 120);
});

test("demotion is symmetric and needs the same sample floor", () => {
  assert.equal(evaluateDemotion(0.1, 0.2, 10, 100).demote, false);
  assert.equal(evaluateDemotion(0.1, 0.2, 120, 100).demote, true);
  assert.equal(evaluateDemotion(0.3, 0.2, 120, 100).demote, false);
});

test("a withdrawn promotion is recorded as shadow, reason and all", () => {
  const registry = new ChallengerRegistry();
  registry.register(spec({ id: "ema100" }));
  const perAsset = [
    { symbol: "AAA", returnPctDiff: 0.4 },
    { symbol: "BBB", returnPctDiff: 0.1 },
  ];
  const verdict = registry.assess("ema100", outcome({ perAsset }), 0.01);
  assert.equal(verdict.promote, true);
  assert.equal(registry.get("ema100")!.status, "promoted");

  registry.withdraw("ema100", "did not replicate outside crypto");

  const entry = registry.get("ema100")!;
  assert.equal(entry.status, "shadow");
  assert.equal(entry.verdict!.promote, false);
  assert.ok(
    entry.verdict!.reasons.some((r) => r.includes("did not replicate outside crypto")),
    "the withdrawal reason must survive in the record",
  );
  assert.equal(registry.attempts, 1, "a withdrawn challenger still counts as an attempt");
});

test("withdrawing an unknown challenger throws", () => {
  assert.throws(() => new ChallengerRegistry().withdraw("nope", "why"), /unknown challenger/);
});
