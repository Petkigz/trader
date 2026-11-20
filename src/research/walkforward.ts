/**
 * Walk-forward validation.
 *
 * This is the honest engine behind "can I find a better formula?".
 *
 * The naive way to search for parameters is to backtest a grid over all the
 * history and keep the winner. That procedure is guaranteed to produce a
 * winner and guaranteed to tell you nothing, because the winner is selected
 * using the same data it is scored on. Test enough variants and one of them
 * will look brilliant by pure chance.
 *
 * This module does the two things that make the search meaningful:
 *
 *  1. **Out-of-sample scoring.** Parameters are chosen on one window and
 *     scored on the *next*, unseen window. Only the out-of-sample result is
 *     reported as performance.
 *
 *  2. **A luck floor.** Every parameter set tested is counted, and the module
 *     reports what the best in-sample score *would* have been from that many
 *     random draws. If the observed winner does not beat its own luck floor,
 *     the search found noise.
 *
 * Indicator warm-up: each out-of-sample slice is prefixed with `warmupBars`
 * of preceding history so a 200-period EMA is valid at the start of the
 * window. The reported out-of-sample return therefore covers the warm-up span
 * too, and consecutive windows overlap by that much. This is the standard
 * trade-off; it is stated here rather than hidden.
 */

import type { BotConfig } from "../config.ts";
import type { Candle, SymbolInfo } from "../types.ts";
import { runBacktest } from "../backtest.ts";

export interface ParamSet {
  emaPeriod: number;
  entryBuffer: number;
  exitBuffer: number;
  crashStopPct: number;
}

/** The shipped configuration, for reference in comparisons. */
export const BASELINE: ParamSet = {
  emaPeriod: 200,
  entryBuffer: 0.005,
  exitBuffer: 0.005,
  crashStopPct: 0.25,
};

/**
 * A deliberately modest grid. The point is to demonstrate the method, not to
 * exhaustively mine history — a huge grid makes the luck floor worse and is
 * the exact behaviour this module exists to discourage.
 */
export function defaultGrid(): ParamSet[] {
  const out: ParamSet[] = [];
  for (const emaPeriod of [50, 100, 150, 200, 250]) {
    for (const buffer of [0, 0.005, 0.02]) {
      out.push({ emaPeriod, entryBuffer: buffer, exitBuffer: buffer, crashStopPct: 0.25 });
    }
  }
  return out;
}

export interface WalkForwardOptions {
  daily: Candle[];
  hourly: Candle[];
  baseCfg: BotConfig;
  capital: number;
  info: SymbolInfo;
  grid?: ParamSet[];
  /** Bars used to choose parameters each window. */
  inSampleBars?: number;
  /** Bars scored out of sample. */
  outSampleBars?: number;
  /** Bars advanced per window (defaults to `outSampleBars`). */
  stepBars?: number;
  /** History prepended to each out-of-sample slice so indicators are valid. */
  warmupBars?: number;
}

export interface WalkForwardWindow {
  index: number;
  /** Timestamps bounding the out-of-sample span actually scored. */
  oosFrom: number;
  oosTo: number;
  /** Parameters chosen on the preceding in-sample window. */
  chosen: ParamSet;
  isReturnPct: number;
  oosReturnPct: number;
  oosBuyHoldPct: number;
  oosTrades: number;
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[];
  gridSize: number;
  /** Total backtests executed = windows × grid size. */
  testsRun: number;
  /** Mean and spread of every in-sample score observed. */
  inSampleMeanPct: number;
  inSampleSdPct: number;
  /**
   * Best in-sample score actually achieved, averaged across windows. The
   * average (rather than the single luckiest window) is what the luck floor
   * below is comparable to.
   */
  inSampleBestPct: number;
  /**
   * The in-sample score you would expect the best of `gridSize` parameter sets
   * to reach by chance alone, averaged across windows.
   *
   * The correction is applied *within* each window — that is where the
   * selection actually happens, since one grid is searched per window and the
   * winner is then carried forward. Uses the spread of that window's own
   * scores, so a window where every candidate scored the same contributes no
   * inflation.
   */
  luckFloorPct: number;
  /** Out-of-sample performance, compounded across windows. */
  oosCompoundedPct: number;
  oosMedianPct: number;
  /** Share of windows that were profitable out of sample, 0..100. */
  oosPositivePct: number;
  /** inSampleBest − oosMedian. Large positive values mean the edge evaporated. */
  degradationPct: number;
  /** Did the search beat its own luck floor out of sample? */
  edgeFound: boolean;
}

/** Expected maximum of `n` independent standard normals (Blom's approximation). */
export function expectedMaxZ(n: number): number {
  if (n <= 1) return 0;
  const a = Math.sqrt(2 * Math.log(n));
  return a - (Math.log(Math.log(n)) + Math.log(4 * Math.PI)) / (2 * a);
}

function withParams(cfg: BotConfig, p: ParamSet): BotConfig {
  return {
    ...cfg,
    trend: {
      emaPeriod: p.emaPeriod,
      entryBuffer: p.entryBuffer,
      exitBuffer: p.exitBuffer,
      crashStopPct: p.crashStopPct,
    },
  };
}

function within(candles: Candle[], from: number, to: number): Candle[] {
  return candles.filter((c) => c.openTime >= from && c.closeTime <= to);
}

export function walkForward(opts: WalkForwardOptions): WalkForwardResult {
  const grid = opts.grid ?? defaultGrid();
  const isBars = opts.inSampleBars ?? 600;
  const oosBars = opts.outSampleBars ?? 400;
  const step = opts.stepBars ?? oosBars;
  const warmup = opts.warmupBars ?? Math.max(...grid.map((g) => g.emaPeriod)) + 10;

  const { daily, hourly, baseCfg, capital, info } = opts;

  if (!Array.isArray(grid) || grid.length === 0) throw new Error("grid must be non-empty");
  if (isBars < warmup + 30) {
    throw new Error(`inSampleBars (${isBars}) must exceed warmup (${warmup}) + 30`);
  }

  const windows: WalkForwardWindow[] = [];
  /** Every in-sample score, one inner array per window. */
  const perWindow: number[][] = [];
  let compounded = 1;
  let start = 0;
  let index = 0;

  while (start + isBars + oosBars <= daily.length) {
    const isSlice = daily.slice(start, start + isBars);
    const oosStartIdx = start + isBars;
    const oosEndIdx = oosStartIdx + oosBars;

    // Score every candidate on the in-sample window.
    let bestSet = grid[0];
    let bestReturn = -Infinity;
    const scores: number[] = [];
    for (const p of grid) {
      const r = runBacktest({
        cfg: withParams(baseCfg, p),
        daily: isSlice,
        hourly: within(
          hourly,
          isSlice[0].openTime,
          isSlice[isSlice.length - 1].closeTime,
        ),
        capital,
        info,
      });
      scores.push(r.totalReturnPct);
      if (r.totalReturnPct > bestReturn) {
        bestReturn = r.totalReturnPct;
        bestSet = p;
      }
    }

    perWindow.push(scores);

    // Score the winner on data it has never seen, with indicator warm-up.
    const warmFrom = Math.max(0, oosStartIdx - warmup);
    const oosSlice = daily.slice(warmFrom, oosEndIdx);
    const oos = runBacktest({
      cfg: withParams(baseCfg, bestSet),
      daily: oosSlice,
      hourly: within(hourly, oosSlice[0].openTime, oosSlice[oosSlice.length - 1].closeTime),
      capital,
      info,
    });

    compounded *= 1 + oos.totalReturnPct / 100;

    windows.push({
      index,
      oosFrom: oosSlice[0].openTime,
      oosTo: oosSlice[oosSlice.length - 1].closeTime,
      chosen: bestSet,
      isReturnPct: bestReturn,
      oosReturnPct: oos.totalReturnPct,
      oosBuyHoldPct: oos.buyHoldPct,
      oosTrades: oos.trades,
    });

    start += step;
    index += 1;
  }

  if (windows.length === 0) {
    throw new Error(
      `not enough history for one window: ${daily.length} bars, need ${isBars + oosBars}`,
    );
  }

  const all = perWindow.flat();
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const variance = all.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, all.length - 1);
  const sd = Math.sqrt(variance);

  // Selection happens inside a window, so the multiplicity correction is
  // applied window by window and then averaged.
  const z = expectedMaxZ(grid.length);
  const windowBests: number[] = [];
  const windowFloors: number[] = [];
  for (const scores of perWindow) {
    const m = scores.reduce((a, b) => a + b, 0) / scores.length;
    const v =
      scores.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, scores.length - 1);
    windowBests.push(Math.max(...scores));
    windowFloors.push(m + z * Math.sqrt(v));
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const sortedOos = windows.map((w) => w.oosReturnPct).sort((a, b) => a - b);
  const medianOos = sortedOos[Math.floor(sortedOos.length / 2)];
  const positive = windows.filter((w) => w.oosReturnPct > 0).length;

  const inSampleBest = avg(windowBests);
  const luckFloor = avg(windowFloors);
  const oosCompounded = (compounded - 1) * 100;

  return {
    windows,
    gridSize: grid.length,
    testsRun: windows.length * grid.length,
    inSampleMeanPct: mean,
    inSampleSdPct: sd,
    inSampleBestPct: inSampleBest,
    luckFloorPct: luckFloor,
    oosCompoundedPct: oosCompounded,
    oosMedianPct: medianOos,
    oosPositivePct: (positive / windows.length) * 100,
    degradationPct: inSampleBest - medianOos,
    // The bar: the winner must beat chance AND actually make money untouched.
    edgeFound: inSampleBest > luckFloor && oosCompounded > 0 && medianOos > 0,
  };
}
