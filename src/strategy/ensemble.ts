/**
 * Ensemble: let several strategy families compete, and follow the one the
 * current market is actually rewarding.
 *
 * The problem this solves is real. A trend follower and a dip buyer want
 * opposite conditions; whichever is "correct" depends on the market's current
 * character, and hard-coding one of them means being wrong for years at a time.
 *
 * Three parts:
 *
 *  1. **Classify the regime** (`regime.ts`) — volatility and directionality,
 *     both observable in advance.
 *  2. **Score each family** on how it would have done over a trailing window,
 *     by replaying its own entry/exit rule over those bars.
 *  3. **Select** — softmax over the scores, with a hard override: during a
 *     volatility storm, take cash.
 *
 * Two honest limits, both deliberate:
 *
 *  - **This selects, it does not blend.** A $10 account can hold exactly one
 *    position (Binance rejects anything under $5 notional), so running two
 *    families simultaneously is not possible. The ensemble picks one.
 *  - **The scores are rank-only.** They ignore fees and slippage because their
 *    job is to order the families, not to report performance. Never quote these
 *    numbers as a track record.
 *
 * Exits are never gated by the selection: if *either* family wants out, we are
 * out. A chooser that could trap an open position would be worse than no
 * chooser at all.
 */

import type { BotConfig } from "../config.ts";
import type { Candle, Decision } from "../types.ts";
import type { StrategyInput } from "../strategy.ts";
import { ema, lastValid, rsi } from "../util/indicators.ts";
import { classifyRegime, type Regime } from "./regime.ts";
import { evalMeanRev } from "./meanrev.ts";

export type Family = "trend" | "meanrev" | "cash";

export interface EnsembleState {
  regime: Regime;
  /** Virtual trailing return per family, in percent. Rank-only — excludes costs. */
  scores: { trend: number; meanrev: number };
  /** Softmax allocation weight per family, summing to 1. */
  /** score(meanrev) - score(trend); positive means the challenger leads. */
  edge: number;
  selected: Family;
  note: string;
}

/**
 * Replay a family's own signal over the trailing `window` bars and return the
 * compounded return of a perfectly frictionless position. Ranking only.
 */
function replay(
  closes: readonly number[],
  window: number,
  decidesIn: (i: number) => boolean,
): number {
  const from = Math.max(1, closes.length - window);
  let inPosition = false;
  let equity = 1;
  for (let i = from; i < closes.length; i++) {
    // Act on the previous bar's signal: no lookahead.
    if (!inPosition && decidesIn(i - 1)) inPosition = true;
    else if (inPosition && !decidesIn(i - 1)) inPosition = false;
    if (inPosition) {
      const prev = closes[i - 1];
      if (prev > 0) equity *= closes[i] / prev;
    }
  }
  return (equity - 1) * 100;
}

/** Virtual trailing return of each family. Rank-only; excludes fees and slippage. */
export function scoreFamilies(
  daily: readonly Candle[],
  cfg: BotConfig,
): { trend: number; meanrev: number } {
  const closes = daily.map((c) => c.close);
  const emaSeries = ema(closes, cfg.trend.emaPeriod);
  const rsiSeries = rsi(closes, cfg.ensemble.rsiPeriod);
  const window = cfg.ensemble.scoreWindow;

  const at = (series: readonly number[], i: number): number =>
    i >= 0 && i < series.length && Number.isFinite(series[i]) ? series[i] : NaN;

  const { entryBuffer, exitBuffer } = cfg.trend;
  const { rsiEntry, rsiExit } = cfg.ensemble;

  const trend = replay(closes, window, (i) => {
    const e = at(emaSeries, i);
    const px = closes[i];
    if (!(e > 0) || !(px > 0)) return false;
    const dist = (px - e) / e;
    // Hysteresis: enter above +buffer, stay until below -buffer.
    return dist > entryBuffer || (dist > -exitBuffer && dist > 0);
  });

  const meanrev = replay(closes, window, (i) => {
    const e = at(emaSeries, i);
    const r = at(rsiSeries, i);
    const px = closes[i];
    if (!(e > 0) || !(px > 0) || !Number.isFinite(r)) return false;
    return px > e && r <= rsiEntry;
  });

  return { trend, meanrev };
}

export function selectFamily(daily: readonly Candle[], cfg: BotConfig): EnsembleState {
  const regime = classifyRegime(daily, cfg);
  const scores = scoreFamilies(daily, cfg);
  // Selection is the sign of the score edge. There is deliberately no
  // temperature here: a softmax over two scores is order-preserving, so any
  // "temperature" can only relabel the confidences, never change the winner.
  // A knob that cannot change behaviour is a lie, so it was removed.
  const edge = scores.meanrev - scores.trend;
  const manager: Family = edge > 0 ? "meanrev" : "trend";
  let selected: Family = manager;

  // Hard override: a volatility storm takes precedence over any score. The
  // scores are trailing, so in a storm they describe a market that has already
  // changed character.
  if (regime.vol === "storm" && cfg.ensemble.stormBlocksEntries) {
    selected = "cash";
  }

  return {
    regime,
    scores,
    edge,
    selected,
    note:
      `${regime.note} · score trend ${(scores.trend * 100).toFixed(1)}% / ` +
      `meanrev ${(scores.meanrev * 100).toFixed(1)}% → ${selected}`,
  };
}

/** Flatten the ensemble state into decision metadata (primitives only). */
function metaOf(state: EnsembleState): Record<string, number | string | boolean> {
  return {
    regimeVol: state.regime.vol,
    regimeTrend: state.regime.trend,
    regimeStrength: Math.round(state.regime.strength * 1000) / 1000,
    scoreTrend: Math.round(state.scores.trend * 1000) / 1000,
    scoreMeanRev: Math.round(state.scores.meanrev * 1000) / 1000,
    edge: Math.round(state.edge * 1000) / 1000,
    selected: state.selected,
  };
}

export function evalEnsemble(input: StrategyInput): Decision {
  const state = selectFamily(input.daily, input.cfg);

  if (input.position) {
    // ONE family governs an open position. Taking the union of both exit rules
    // is what turned this into a 193-trade churn: the family that was *not*
    // selected kept closing trades the other one had opened, and the selected    // one re-opened them on the next bar. The manager is whoever the scores
    // currently favour; the storm override does not force an exit, because a
    // chooser must never trap a position.
    const manager: Family = state.edge > 0 ? "meanrev" : "trend";
    const decision = manager === "trend" ? evalTrendExit(input) : evalMeanRev(input);
    return {
      ...decision,
      reason: `ensemble/${manager}:${decision.reason}`,
      meta: { ...decision.meta, ...metaOf(state), manager },
    };
  }

  if (state.selected === "cash") {
    return {
      action: "HOLD",
      reason: "ensemble:cash",
      detail: `staying in cash — volatility storm; ${state.note}`,
      meta: metaOf(state),
    };
  }

  const chosen = state.selected === "trend" ? evalTrendExit(input) : evalMeanRev(input);
  return {
    ...chosen,
    reason: `ensemble/${state.selected}:${chosen.reason}`,
    meta: { ...chosen.meta, ...metaOf(state) },
  };
}

/**
 * The trend family, imported lazily to avoid a module cycle at load time
 * (`strategy.ts` imports this file to dispatch to it).
 */
function evalTrendExit(input: StrategyInput): Decision {
  return trendEvaluator(input);
}

let trendEvaluator: (input: StrategyInput) => Decision = () => ({
  action: "HOLD",
  reason: "trend_unavailable",
  detail: "trend evaluator not registered",
});

/** Wired once by `strategy.ts` at module load. */
export function registerTrendEvaluator(fn: (input: StrategyInput) => Decision): void {
  trendEvaluator = fn;
}
