/**
 * Adaptive sizing.
 *
 * This is the system changing its own behaviour in response to what the market
 * is doing, rather than a human changing a configuration file.
 *
 * The mechanism is volatility targeting, which is what real funds actually do:
 * keep the *risk* of a position roughly constant instead of its *dollar size*.
 * A fixed fraction commits the same money whether the market is quiet or
 * violent, so on a violent week the account takes far more risk than intended.
 * Measuring recent volatility and scaling the position against it keeps the
 * expected daily swing stable — the position gets smaller exactly when the
 * market gets dangerous.
 *
 * Two deliberate constraints, because adaptation is where trading systems hurt
 * themselves:
 *
 *  - **It can only reduce risk by default.** `maxScale` defaults to 1, so the
 *    adaptive layer can shrink a position but never enlarge one beyond the
 *    configured fraction. Leaning in is how a drawdown becomes a wipeout.
 *  - **It reads volatility, not performance.** Volatility is a fairly stable
 *    property of a market. Recent *profit* is mostly noise, and sizing up
 *    because the last three trades won is the behaviour that kills accounts.
 *
 * Nothing here rewrites the entry or exit rules. Those stay fixed and
 * backtestable; only how much is committed to a given signal adapts.
 */

import type { BotConfig } from "../config.ts";
import type { Candle } from "../types.ts";
import { clamp } from "../util/num.ts";

export type Regime = "calm" | "normal" | "storm" | "unknown";

export interface AdaptiveSnapshot {
  /** Position fraction to actually use, after adaptation. */
  fraction: number;
  /** Recent annualised volatility, e.g. 0.42 for 42%. */
  realisedVol: number;
  /** Longer-run annualised volatility used as the reference. */
  baselineVol: number;
  /** Multiplier applied to the configured fraction. */
  scale: number;
  regime: Regime;
  /** Short human-readable explanation, surfaced in logs and the dashboard. */
  note: string;
}

const TRADING_DAYS = 365;

/** Annualised standard deviation of daily log returns over the last `window` bars. */
export function realisedVol(closes: readonly number[], window: number): number {
  if (closes.length < window + 1) return NaN;
  const slice = closes.slice(closes.length - (window + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1];
    const b = slice[i];
    if (!(a > 0) || !(b > 0)) return NaN;
    rets.push(Math.log(b / a));
  }
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const variance = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

/**
 * Decide how much of the available cash to commit, given recent market state.
 * Pure function of candles + config, so the backtester and the live engine see
 * exactly the same answer.
 */
export function adaptiveFraction(daily: readonly Candle[], cfg: BotConfig): AdaptiveSnapshot {
  const base = cfg.risk.positionFraction;
  const a = cfg.adaptive;

  if (!a.enabled) {
    return {
      fraction: base,
      realisedVol: NaN,
      baselineVol: NaN,
      scale: 1,
      regime: "unknown",
      note: "adaptive sizing off",
    };
  }

  const closes = daily.map((c) => c.close);
  const recent = realisedVol(closes, a.volWindow);
  const baseline = realisedVol(closes, Math.min(a.baselineWindow, Math.max(a.volWindow + 1, closes.length - 1)));

  if (!Number.isFinite(recent) || recent <= 0) {
    return {
      fraction: base,
      realisedVol: recent,
      baselineVol: baseline,
      scale: 1,
      regime: "unknown",
      note: `not enough history for a ${a.volWindow}-day volatility read`,
    };
  }

  // Target a stable risk level: halve the position when volatility doubles.
  let scale = clamp(a.targetVol / recent, a.minScale, a.maxScale);

  let regime: Regime = "normal";
  if (Number.isFinite(baseline) && baseline > 0) {
    const ratio = recent / baseline;
    if (ratio >= a.stormMultiple) {
      regime = "storm";
      scale *= a.stormScale;
    } else if (ratio <= a.calmMultiple) {
      regime = "calm";
    }
  }

  scale = clamp(scale, a.minScale, a.maxScale);
  // `maxScale` is the real ceiling. It defaults to 1 (de-risk only), but a
  // caller who raises it gets the full volatility-targeting behaviour, bounded
  // by the fact that an unlevered spot position cannot exceed 100% of cash.
  const ceiling = Math.min(1, base * a.maxScale);
  const fraction = clamp(base * scale, 0, ceiling);

  return {
    fraction,
    realisedVol: recent,
    baselineVol: baseline,
    scale,
    regime,
    note:
      `vol ${(recent * 100).toFixed(0)}% vs target ${(a.targetVol * 100).toFixed(0)}% ` +
      `→ ${(scale * 100).toFixed(0)}% of normal size (${regime})`,
  };
}
