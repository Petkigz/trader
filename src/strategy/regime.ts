/**
 * Regime classification.
 *
 * A single rule set cannot be right in every market. A trend follower is the
 * correct tool while price is trending and a slow bleed while price chops; a
 * dip buyer is the reverse. Rather than pick one and hope, this module reads
 * the market's current character and says which kind of market it is.
 *
 * Two axes, both observable in advance and cheap to compute:
 *
 *  - **Volatility regime** — recent volatility measured against its own
 *    longer-run baseline. Calm / normal / storm.
 *  - **Trend regime** — where price sits relative to its long moving average,
 *    plus how fast that average is moving. Up / flat / down, with a strength
 *    score for how directional it really is.
 *
 * Pure function of candles + config: same inputs, same answer, so the
 * backtester and the live engine cannot drift apart.
 */

import type { BotConfig } from "../config.ts";
import type { Candle } from "../types.ts";
import { ema, lastValid } from "../util/indicators.ts";
import { clamp } from "../util/num.ts";
import { realisedVol } from "./adaptive.ts";

export type VolRegime = "calm" | "normal" | "storm";
export type TrendRegime = "up" | "flat" | "down";

export interface Regime {
  vol: VolRegime;
  trend: TrendRegime;
  /** Recent annualised volatility, e.g. 0.42. NaN when there is not enough history. */
  volPct: number;
  /** Recent volatility divided by its longer-run baseline. */
  volRatio: number;
  /** Price relative to the long EMA, as a fraction (0.05 = 5% above). */
  distancePct: number;
  /** Annualised slope of the long EMA, as a fraction. */
  slopePct: number;
  /** 0..1 — how directional the market currently looks. */
  strength: number;
  /** True when there is not enough history to classify. */
  warmingUp: boolean;
  note: string;
}

const UNKNOWN: Omit<Regime, "note"> = {
  vol: "normal",
  trend: "flat",
  volPct: NaN,
  volRatio: 1,
  distancePct: 0,
  slopePct: 0,
  strength: 0,
  warmingUp: true,
};

/** Bars used to estimate the EMA slope. */
const SLOPE_LOOKBACK = 20;

export function classifyRegime(daily: readonly Candle[], cfg: BotConfig): Regime {
  const period = cfg.trend.emaPeriod;
  const closes = daily.map((c) => c.close);

  if (closes.length < period + SLOPE_LOOKBACK) {
    return { ...UNKNOWN, note: `need ${period + SLOPE_LOOKBACK} closes, have ${closes.length}` };
  }

  const series = ema(closes, period);
  const emaNow = lastValid(series);
  const emaThen = series[series.length - SLOPE_LOOKBACK];
  if (emaNow === null || emaThen === null || !(emaNow > 0) || !(emaThen > 0)) {
    return { ...UNKNOWN, note: "EMA not ready" };
  }

  const price = closes[closes.length - 1];
  const distance = (price - emaNow) / emaNow;

  // Annualise the average's slope so it is comparable across assets.
  const perBar = (emaNow - emaThen) / emaThen / SLOPE_LOOKBACK;
  const slopeAnnual = perBar * 365;

  const recent = realisedVol(closes, cfg.adaptive.volWindow);
  const baseline = realisedVol(
    closes,
    Math.min(cfg.adaptive.baselineWindow, closes.length - 1),
  );

  let vol: VolRegime = "normal";
  let ratio = 1;
  if (Number.isFinite(recent) && Number.isFinite(baseline) && baseline > 0) {
    ratio = recent / baseline;
    if (ratio >= cfg.adaptive.stormMultiple) vol = "storm";
    else if (ratio <= cfg.adaptive.calmMultiple) vol = "calm";
  }

  const { entryBuffer, exitBuffer } = cfg.trend;
  const trend: TrendRegime =
    distance > entryBuffer ? "up" : distance < -exitBuffer ? "down" : "flat";

  // Directionality: a slope of 50%/yr is considered maximally directional.
  const strength = clamp(Math.abs(slopeAnnual) / 0.5, 0, 1);

  return {
    vol,
    trend,
    volPct: recent,
    volRatio: ratio,
    distancePct: distance,
    slopePct: slopeAnnual,
    strength,
    warmingUp: false,
    note:
      `${trend} trend (${(distance * 100).toFixed(1)}% vs EMA${period}, ` +
      `slope ${(slopeAnnual * 100).toFixed(0)}%/yr) · ${vol} vol ` +
      `(${(recent * 100).toFixed(0)}%, ${ratio.toFixed(2)}x baseline)`,
  };
}
