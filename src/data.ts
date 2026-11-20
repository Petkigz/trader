/**
 * Market data helpers: paginated history download, plus a deterministic
 * synthetic generator so the backtester and the test-suite work offline.
 */

import type { MarketData } from "./exchange/types.ts";
import type { Candle, Interval } from "./types.ts";
import { DAY_MS, HOUR_MS } from "./util/num.ts";

export function intervalMs(interval: Interval): number {
  switch (interval) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "15m":
      return 15 * 60_000;
    case "1h":
      return HOUR_MS;
    case "4h":
      return 4 * HOUR_MS;
    case "1d":
    default:
      return DAY_MS;
  }
}

export interface HistoryOptions {
  symbol: string;
  interval: Interval;
  /** How many years back to go. */
  years: number;
  /** Upper bound (defaults to now). */
  endTime?: number;
  /** Safety cap on total candles. */
  maxCandles?: number;
  onProgress?: (downloaded: number, oldestOpenTime: number) => void;
}

export function periodDuration(
  interval: Interval,
): number {
  return intervalMs(interval);
}

export function syntheticCandles(opts: {
  interval: Interval;
  count: number;
  startPrice?: number;
  seed?: number;
  endTime?: number;
  /** Annualised volatility. */
  vol?: number;
  /** Annualised drift. */
  drift?: number;
}): Candle[] {
  const { interval, count } = opts;
  const startPrice = opts.startPrice ?? 60_000;
  const vol = opts.vol ?? 0.55;
  const drift = opts.drift ?? 0.35;
  const step = intervalMs(interval);
  const endTime = opts.endTime ?? Date.now();
  const rand = mulberry32(opts.seed ?? 42);

  // Volatility and trend both move slowly. A pure random walk has no
  // autocorrelation, so trend-following would look artificially flat; an AR(1)
  // momentum term with a ~1 month half-life produces realistic trends and chop
  // without the runaway drift a constant regime term would create.
  const baseVol = vol * Math.sqrt(step / (365 * DAY_MS));
  const baseDrift = (drift - vol * vol * 0.5) * (step / (365 * DAY_MS));

  const candles: Candle[] = [];
  let price = startPrice;
  let momentum = 0;
  let volMultiplier = 1;

  const start = endTime - count * step;
  for (let i = 0; i < count; i++) {
    // AR(1) momentum: half-life ~35 bars.
    momentum = momentum * 0.98 + gaussian(rand) * 0.25;
    momentum = Math.max(-1.5, Math.min(1.5, momentum));
    volMultiplier = Math.max(0.5, Math.min(2.2, volMultiplier * 0.97 + 0.03 + gaussian(rand) * 0.06));

    const barVol = baseVol * volMultiplier;
    const shock = gaussian(rand) * barVol;
    const trend = momentum * barVol * 0.35;
    price = Math.max(100, price * Math.exp(baseDrift + trend + shock));

    const open = candles.length ? candles[candles.length - 1].close : startPrice;
    const close = price;
    const wick = Math.abs(gaussian(rand)) * barVol * price * 0.5;
    const high = Math.max(open, close) + wick;
    const low = Math.max(1, Math.min(open, close) - wick);
    const openTime = start + i * step;

    candles.push({
      openTime,
      open,
      high,
      low,
      close,
      volume: 1 + rand() * 100,
      closeTime: openTime + step - 1,
    });
  }
  return candles;
}

/** Downloads history newest-first pagination, returns oldest-first, closed only. */
export async function fetchHistory(md: MarketData, opts: HistoryOptions): Promise<Candle[]> {
  const { symbol, interval, years } = opts;
  const now = opts.endTime ?? Date.now();
  const from = now - years * 365.25 * DAY_MS;
  const maxCandles = opts.maxCandles ?? 20_000;

  const collected: Candle[] = [];
  let end = now;

  while (end > from && collected.length < maxCandles) {
    const batch = await md.getCandles(symbol, interval, 1000, end);
    if (batch.length === 0) break;

    const filtered = batch.filter((c) => c.closeTime <= now && c.openTime >= from);
    collected.unshift(...filtered);

    const oldest = batch[0];
    const nextEnd = oldest.openTime - 1;
    if (nextEnd >= end) break;
    end = nextEnd;

    opts.onProgress?.(collected.length, oldest.openTime);
    if (batch.length < 1000) break;
  }

  // Deduplicate and sort defensively.
  const seen = new Set<number>();
  return collected
    .filter((c) => (seen.has(c.openTime) ? false : (seen.add(c.openTime), true)))
    .sort((a, b) => a.openTime - b.openTime);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, cached second value. */
export function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
