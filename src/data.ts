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

/**
 * Parse candle CSV rows — `time,open,high,low,close[,volume]`.
 *
 * `time` may be epoch seconds, epoch milliseconds, or an ISO date/timestamp
 * (`2026-11-14`). Unparseable rows are skipped, which is what makes a header
 * line harmless and what lets `data/btc_1d.csv` stay human-readable.
 */
export function parseCandleCsv(text: string): Candle[] {
  const out: Candle[] = [];
  for (const row of text.trim().split(/\r?\n/)) {
    const parts = row.split(",");
    if (parts.length < 5) continue;
    const raw = parts[0].trim();
    const asNumber = Number(raw);
    let openTime = Number.NaN;
    if (raw !== "" && Number.isFinite(asNumber)) {
      openTime = asNumber > 1e12 ? asNumber : asNumber * 1000;
    } else {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) openTime = parsed;
    }
    if (!Number.isFinite(openTime)) continue;
    const ohlc = parts.slice(1, 5).map((v) => Number(v));
    if (ohlc.some((v) => !Number.isFinite(v))) continue;
    out.push({
      openTime,
      open: ohlc[0],
      high: ohlc[1],
      low: ohlc[2],
      close: ohlc[3],
      volume: Number(parts[5] ?? 0) || 0,
      closeTime: openTime + intervalMs("1d") - 1,
    });
  }
  return out.sort((a, b) => a.openTime - b.openTime);
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

/* -------------------------------------------------------------------------- */
/* Volume enrichment                                                          */
/* -------------------------------------------------------------------------- */

export interface CsvRow {
  /** The date exactly as it appears in the file, so rewriting is lossless. */
  date: string;
  /** Open/high/low/close as written, untouched. */
  prices: string[];
  /** Volume field if the file already has one. */
  volume: string | null;
}

/** Split a candle CSV into rows without interpreting the price columns. */
export function parseCsvRows(text: string): { header: string | null; rows: CsvRow[] } {
  const lines = text.trim().split(/\r?\n/);
  const first = lines[0]?.split(",") ?? [];
  const hasHeader = first.length > 0 && !Number.isFinite(Number(first[1]));
  const header = hasHeader ? lines[0] : null;

  const rows: CsvRow[] = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    rows.push({
      date: parts[0].trim(),
      prices: parts.slice(1, 5).map((p) => p.trim()),
      volume: parts.length > 5 ? parts[5].trim() : null,
    });
  }
  return { header, rows };
}

/**
 * Merge volume into an existing price file, leaving every price digit alone.
 *
 * The OHLC in `data/` is the research baseline: rewriting it would silently
 * invalidate every number in the docs. So this only ever *adds* a column, keyed
 * by date, and reports how many rows it could not match rather than guessing.
 */
export function mergeVolumeCsv(
  text: string,
  volumeByDate: ReadonlyMap<string, number>,
): { csv: string; matched: number; unmatched: number; alreadyHadVolume: boolean } {
  const { header, rows } = parseCsvRows(text);
  const alreadyHadVolume = rows.some((r) => r.volume !== null && r.volume !== "");

  let matched = 0;
  let unmatched = 0;
  const out: string[] = [];
  const outHeader = header ?? "date,open,high,low,close,volume";
  const headerHasVolume = outHeader.toLowerCase().includes("volume");
  out.push(headerHasVolume ? outHeader : `${outHeader},volume`);

  for (const row of rows) {
    const v = volumeByDate.get(normaliseDate(row.date));
    if (v === undefined) unmatched++;
    else matched++;
    // An unmatched row keeps its place with an empty volume field rather than
    // a fabricated zero, so a later pass can fill it and no one mistakes a gap
    // for "nobody traded".
    out.push([row.date, ...row.prices, v === undefined ? "" : formatVolume(v)].join(","));
  }

  return { csv: out.join("\n") + "\n", matched, unmatched, alreadyHadVolume };
}

function normaliseDate(date: string): string {
  const ms = Number.isFinite(Number(date)) ? Number(date) * 1000 : Date.parse(date);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : date;
}

function formatVolume(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "";
  return Number(v.toFixed(2)).toString();
}
