/**
 * Market context: the things this bot currently cannot see.
 *
 * The strategy reads one symbol's closes and nothing else. That leaves four
 * obvious blind spots, all of them observable in advance and all of them cheap:
 *
 *  1. **What the rest of the market is doing.** An alt traded in isolation is
 *     mostly a leveraged bet on BTC. If BTC is below its own long average, the
 *     symbol's uptrend is swimming against the tide.
 *  2. **How much of the symbol's move is just that tide** — the trailing beta.
 *     A "trend" in a 1.2-beta alt during a flat market is not the same trade as
 *     the same trend in a 0.4-beta one.
 *  3. **Whether anyone is trading it.** Volume is present in every candle the
 *     bot downloads and has never been read. A breakout on collapsing volume is
 *     a different animal from one on expanding volume.
 *  4. **Whether the move on offer pays for its own friction.** Fees plus
 *     slippage are a known number; the daily range is a known number. If the
 *     move is not several times the cost, the trade needs to be right far more
 *     often than the evidence supports.
 *
 * Everything here is a pure function of candles that have already closed, so it
 * can be computed identically in the backtester and in the tick. Nothing in this
 * file decides anything — `gates.ts` does that, and every gate has to earn its
 * place in `npm run context`.
 */

import type { Candle } from "../types.ts";
import { ema } from "../util/indicators.ts";

export interface ContextPoint {
  /** Reference market (e.g. BTC) is above its long average. Null when unknown. */
  marketAboveEma: boolean | null;
  /** How far the reference is from its average, as a fraction. */
  marketDistancePct: number | null;
  /** The symbol itself is above its long average. */
  symbolAboveEma: boolean | null;
  /** Trailing beta of the symbol's daily returns against the reference. */
  beta: number | null;
  /** Trailing correlation, same window. */
  correlation: number | null;
  /** Today's volume against its trailing average (1 = normal). */
  volumeRatio: number | null;
  /**
   * Today's true range against its trailing average (1 = normal).
   *
   * The participation proxy. When a panel has no volume column — which is true
   * of every CSV in this repo — this is the only observable hint of whether a
   * move had anything behind it. It is *not* volume, and it is never reported as
   * if it were.
   */
  rangeExpansion: number | null;
  /** Average daily true range as a fraction of price. */
  atrPct: number | null;
  /** Round-trip friction as a fraction: 2 × fee + 2 × slippage. */
  costPct: number;
  /** atrPct / costPct. Below ~1 the trade cannot pay for itself. */
  edgeToCost: number | null;
}

export interface ContextOptions {
  /** EMA length used for both the symbol and the reference. */
  emaPeriod?: number;
  /** Bars for beta / correlation. */
  betaWindow?: number;
  /** Bars for the volume average. */
  volumeWindow?: number;
  /** Bars for ATR. */
  atrWindow?: number;
  /** Fee per side, e.g. 0.001. */
  feeRate: number;
  /** Slippage per side as a fraction, e.g. 0.0002. */
  slippage: number;
}

const DEFAULTS = { emaPeriod: 200, betaWindow: 60, volumeWindow: 30, atrWindow: 14 };

/**
 * Precompute the context for every bar, once.
 *
 * Deliberately an array rather than a function of `i`: computing EMAs per bar
 * would be O(n²) over an eight-year panel, and the backtester calls the gate on
 * every entry.
 */
export function contextSeries(
  symbol: readonly Candle[],
  reference: readonly Candle[] | null,
  opts: ContextOptions,
): ContextPoint[] {
  const o = { ...DEFAULTS, ...opts };
  const costPct = 2 * (opts.feeRate + opts.slippage);

  const symEma = ema(symbol.map((c) => c.close), o.emaPeriod);
  const refEma = reference ? ema(reference.map((c) => c.close), o.emaPeriod) : null;

  // Reference bars are looked up by close time so a misaligned or shorter
  // history degrades to "unknown" instead of silently pairing the wrong days.
  const refIndex = new Map<number, number>();
  if (reference) reference.forEach((c, i) => refIndex.set(c.closeTime, i));

  const out: ContextPoint[] = [];
  let refLastKnown: number | null = null;

  for (let i = 0; i < symbol.length; i++) {
    const bar = symbol[i];
    const price = bar.close;

    const e = symEma[i];
    const symbolAboveEma = e === null ? null : price > e;

    let marketAboveEma: boolean | null = null;
    let marketDistancePct: number | null = null;
    let refIdx: number | null = null;
    if (reference && refEma) {
      const idx = refIndex.get(bar.closeTime);
      if (idx !== undefined) {
        refIdx = idx;
        refLastKnown = idx;
        const re = refEma[idx];
        if (re !== null && re > 0) {
          marketAboveEma = reference[idx].close > re;
          marketDistancePct = reference[idx].close / re - 1;
        }
      } else if (refLastKnown !== null) {
        // A holiday or a gap in the reference: carry the last reading rather
        // than declaring the market unknown, but never look forward.
        const re = refEma[refLastKnown];
        if (re !== null && re > 0) {
          marketAboveEma = reference[refLastKnown].close > re;
          marketDistancePct = reference[refLastKnown].close / re - 1;
        }
        refIdx = refLastKnown;
      }
    }

    const { beta, correlation } = refIdx === null ? { beta: null, correlation: null } : trailingBeta(symbol, reference!, i, refIdx, o.betaWindow);

    out.push({
      marketAboveEma,
      marketDistancePct,
      symbolAboveEma,
      beta,
      correlation,
      volumeRatio: volumeRatioAt(symbol, i, o.volumeWindow),
      rangeExpansion: rangeExpansionAt(symbol, i, o.volumeWindow),
      atrPct: atrPctAt(symbol, i, o.atrWindow),
      costPct,
      edgeToCost: null, // filled below, once atrPct is known
    });

    const last = out[out.length - 1];
    last.edgeToCost = last.atrPct !== null && costPct > 0 ? last.atrPct / costPct : null;
  }

  return out;
}

/** Daily true range as a fraction of price, averaged over `window` bars. */
function atrPctAt(candles: readonly Candle[], i: number, window: number): number | null {
  if (i < window) return null;
  let sum = 0;
  for (let k = i - window + 1; k <= i; k++) {
    const c = candles[k];
    const prev = candles[k - 1]?.close ?? c.open;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    if (!(c.close > 0)) return null;
    sum += tr / c.close;
  }
  return sum / window;
}

function rangeExpansionAt(candles: readonly Candle[], i: number, window: number): number | null {
  if (i < window) return null;
  const today = trueRangePct(candles, i);
  if (today === null) return null;
  let sum = 0;
  for (let k = i - window; k < i; k++) {
    const tr = trueRangePct(candles, k);
    if (tr === null) return null;
    sum += tr;
  }
  const avg = sum / window;
  return avg > 0 ? today / avg : null;
}

function trueRangePct(candles: readonly Candle[], i: number): number | null {
  const c = candles[i];
  const prev = candles[i - 1]?.close ?? c.open;
  if (!(c.close > 0)) return null;
  return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)) / c.close;
}

function volumeRatioAt(candles: readonly Candle[], i: number, window: number): number | null {
  if (i < window) return null;
  let sum = 0;
  for (let k = i - window; k < i; k++) sum += candles[k].volume;
  const avg = sum / window;
  if (!(avg > 0)) return null;
  return candles[i].volume / avg;
}

/**
 * Beta and correlation of daily returns against the reference over `window`.
 *
 * Uses trailing bars only: bar `i` is compared with bars before it, so this
 * cannot peek at the move it is about to judge.
 */
function trailingBeta(
  symbol: readonly Candle[],
  reference: readonly Candle[],
  i: number,
  refIdx: number,
  window: number,
): { beta: number | null; correlation: number | null } {
  if (i < window || refIdx < window) return { beta: null, correlation: null };

  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = window; k >= 1; k--) {
    const s0 = symbol[i - k].close;
    const s1 = symbol[i - k + 1].close;
    const r0 = reference[refIdx - k].close;
    const r1 = reference[refIdx - k + 1].close;
    if (!(s0 > 0 && r0 > 0)) continue;
    xs.push(r1 / r0 - 1);
    ys.push(s1 / s0 - 1);
  }
  if (xs.length < 10) return { beta: null, correlation: null };

  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let k = 0; k < xs.length; k++) {
    const dx = xs[k] - meanX;
    const dy = ys[k] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX <= 0 || varY <= 0) return { beta: null, correlation: null };
  return {
    beta: cov / varX,
    correlation: cov / Math.sqrt(varX * varY),
  };
}

/**
 * How often the symbol's own trend agrees with the market's.
 *
 * The number that decides whether market context can add anything: if the
 * symbol is already above its own average whenever the market is, then a gate
 * built on the market is measuring the same thing twice — and the strategy's
 * own exit rule already acts on it.
 */
export function agreementRate(points: readonly ContextPoint[]): number | null {
  let both = 0;
  let agree = 0;
  for (const p of points) {
    if (p.symbolAboveEma === null || p.marketAboveEma === null) continue;
    both++;
    if (p.symbolAboveEma === p.marketAboveEma) agree++;
  }
  return both === 0 ? null : agree / both;
}

/** Does this panel carry usable volume at all? */
export function hasVolume(candles: readonly Candle[]): boolean {
  return candles.some((c) => c.volume > 0);
}

/**
 * How the symbol has behaved when the market was in each state.
 *
 * This is the difference between "the market is down" and "the market being
 * down matters for *this* symbol": an asset with no relationship to the
 * reference should not be filtered on it, and only its own history can say.
 */
export function conditionalStats(
  symbol: readonly Candle[],
  points: readonly ContextPoint[],
): {
  barsMarketUp: number;
  barsMarketDown: number;
  meanReturnMarketUp: number | null;
  meanReturnMarketDown: number | null;
} {
  let up = 0;
  let down = 0;
  let sumUp = 0;
  let sumDown = 0;
  for (let i = 1; i < symbol.length && i < points.length; i++) {
    const ctx = points[i];
    if (ctx.marketAboveEma === null) continue;
    const prev = symbol[i - 1].close;
    if (!(prev > 0)) continue;
    const r = symbol[i].close / prev - 1;
    if (ctx.marketAboveEma) {
      up++;
      sumUp += r;
    } else {
      down++;
      sumDown += r;
    }
  }
  return {
    barsMarketUp: up,
    barsMarketDown: down,
    meanReturnMarketUp: up > 0 ? sumUp / up : null,
    meanReturnMarketDown: down > 0 ? sumDown / down : null,
  };
}
