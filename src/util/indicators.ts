/**
 * Technical indicators.
 *
 * All are pure and side-effect free, which is what lets the exact same code
 * run in a backtest, a paper tick and a live tick — the strategy you test is
 * literally the strategy that trades.
 *
 * Series functions return an array the same length as the input, padded with
 * NaN until the indicator has enough history. Use `lastValid` to read the most
 * recent real value.
 */

import type { Candle } from "../types.ts";

/** Most recent non-NaN value, or null if the series never warmed up. */
export function lastValid(series: readonly number[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (Number.isFinite(v)) return v;
  }
  return null;
}

export function sma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function ema(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/** Relative Strength Index with Wilder smoothing. */
export function rsi(values: readonly number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** True Range series (first bar = high - low). */
export function trueRange(candles: readonly Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out[i] = c.high - c.low;
      continue;
    }
    const prevClose = candles[i - 1].close;
    out[i] = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  return out;
}

/** Average True Range with Wilder smoothing. */
export function atr(candles: readonly Candle[], period = 14): number[] {
  const tr = trueRange(candles);
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function stdev(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  for (let i = period - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += values[j];
    mean /= period;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

export function bollinger(values: readonly number[], period = 20, mult = 2) {
  const mid = sma(values, period);
  const sd = stdev(values, period);
  const upper = mid.map((m, i) => (Number.isFinite(m) && Number.isFinite(sd[i]) ? m + mult * sd[i] : NaN));
  const lower = mid.map((m, i) => (Number.isFinite(m) && Number.isFinite(sd[i]) ? m - mult * sd[i] : NaN));
  return { mid, upper, lower };
}

export function maxDrawdown(equity: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Annualised Sharpe ratio from a per-period return series.
 * `periodsPerYear` is 365 for daily bars, 8760 for hourly.
 */
export function sharpe(returns: readonly number[], periodsPerYear: number, riskFree = 0): number {
  const n = returns.length;
  if (n < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  const excess = mean - riskFree / periodsPerYear;
  return (excess / sd) * Math.sqrt(periodsPerYear);
}
