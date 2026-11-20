/**
 * Cross-sectional momentum — the one strategy family that *needs* a panel.
 *
 * Every layer built so far looks at one asset at a time. That is why the
 * evidence kept collapsing: a single series gives you 30 trades in eight years,
 * and 30 trades cannot distinguish an edge from luck. Cross-sectional momentum
 * asks a different question — "which of these assets is strongest right now?" —
 * and that question has ~20 times more data behind it because every month
 * ranks the whole universe.
 *
 * The rule is deliberately boring, because the point is to test a mechanism,
 * not to tune a knob:
 *
 *   every `rebalanceDays`, hold the `hold` assets with the highest trailing
 *   return; skip assets whose momentum is negative; optionally stand aside
 *   entirely while BTC is below its 200-day EMA.
 *
 * Ranking uses only closes at or before the rebalance bar, and trades are priced
 * at that same close, so there is no lookahead. Fees and slippage are charged on
 * turnover, which is what actually kills rotation strategies.
 */

import type { Candle } from "../types.ts";
import { ema } from "../util/indicators.ts";
import { maxDrawdown, sharpe } from "../util/indicators.ts";
import { DAY_MS } from "../util/num.ts";

export interface PanelAsset {
  symbol: string;
  candles: readonly Candle[];
}

export interface XsMomParams {
  /** Trailing days used to rank momentum. */
  lookback: number;
  /** How many assets to hold at once. */
  hold: number;
  /**
   * Regime gate: the symbol whose EMA200 decides whether anything may be held.
   * `null` disables the gate. For a single-asset run pass that asset's own
   * symbol (the classic 200-day rule); for a crypto basket pass "BTCUSDT".
   */
  gate: string | null;
  /** Rebalance every N trading days. */
  rebalanceDays: number;
  /** Only hold assets with positive trailing return. */
  requirePositive: boolean;
  /**
   * Take short positions on negative-momentum assets instead of ignoring them.
   * With `hold` >= the universe this is classic time-series momentum: equal
   * weight, sign of the trailing return, long and short.
   */
  allowShort: boolean;
  feeRate: number;
  slippageBps: number;
}

export interface XsMomResult {
  start: number;
  end: number;
  years: number;
  finalEquity: number;
  cagrPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  /** Fraction of rebalances in which something was held. */
  investedPct: number;
  /** Sum of |weight changes| per rebalance — rotation cost driver. */
  turnover: number;
  feesPaid: number;
  rebalances: number;
  avgHoldings: number;
  equityCurve: Array<{ ts: number; equity: number }>;
}

export const defaultXsMomParams: XsMomParams = {
  lookback: 90,
  hold: 1,
  gate: "BTCUSDT",
  rebalanceDays: 30,
  requirePositive: true,
  allowShort: false,
  feeRate: 0.001,
  slippageBps: 2,
};

interface Aligned {
  /** Union of trading days across the panel, ascending. */
  days: number[];
  /** symbol → close aligned to `days`, forward-filled, NaN before first print. */
  closes: Map<string, number[]>;
  /** symbol → did this bar have a real print (not a forward fill)? */
  fresh: Map<string, boolean[]>;
}

/** An asset with no real print for this many bars is treated as not trading. */
const MAX_STALE_BARS = 7;

/**
 * Align every asset onto one calendar.
 *
 * Forward filling is the honest choice here: a stale price means the last known
 * price, not a gap you can conjure a return out of. Assets that have not listed
 * yet hold NaN, so they are neither rankable nor purchasable.
 */
export function alignPanel(assets: readonly PanelAsset[]): Aligned {
  const seen = new Set<number>();
  for (const a of assets) for (const c of a.candles) seen.add(dayStart(c.openTime));
  const days = [...seen].sort((a, b) => a - b);
  const index = new Map<number, number>();
  days.forEach((d, i) => index.set(d, i));

  const closes = new Map<string, number[]>();
  const fresh = new Map<string, boolean[]>();
  for (const asset of assets) {
    const series = new Array<number>(days.length).fill(Number.NaN);
    const printed = new Array<boolean>(days.length).fill(false);
    for (const c of asset.candles) {
      const i = index.get(dayStart(c.openTime));
      if (i !== undefined) {
        series[i] = c.close;
        printed[i] = true;
      }
    }
    let last = Number.NaN;
    for (let i = 0; i < series.length; i++) {
      if (Number.isFinite(series[i])) last = series[i];
      else series[i] = last;
    }
    closes.set(asset.symbol, series);
    fresh.set(asset.symbol, printed);
  }
  return { days, closes, fresh };
}

function dayStart(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

/**
 * Momentum of every asset at bar `i`, highest first, using only bars ≤ i.
 * Assets without `lookback` bars of history are excluded — never ranked on a
 * short window, which would quietly favour newly listed coins.
 */
export function rankMomentum(
  aligned: Aligned,
  i: number,
  lookback: number,
): Array<{ symbol: string; momentum: number }> {
  const out: Array<{ symbol: string; momentum: number }> = [];
  for (const [symbol, series] of aligned.closes) {
    const now = series[i];
    const then = series[i - lookback];
    if (!Number.isFinite(now) || !Number.isFinite(then) || !(then > 0)) continue;
    // Forward fills make a dead asset look flat, which would rank it as
    // "low volatility" rather than "gone". Require a real print, recently.
    if (!isTrading(aligned, symbol, i)) continue;
    out.push({ symbol, momentum: now / then - 1 });
  }
  out.sort((a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));
  return out;
}

/** Has this asset produced a real print within the last `MAX_STALE_BARS`? */
export function isTrading(aligned: Aligned, symbol: string, i: number): boolean {
  const printed = aligned.fresh.get(symbol);
  if (!printed) return false;
  for (let k = Math.max(0, i - MAX_STALE_BARS + 1); k <= i; k++) {
    if (printed[k]) return true;
  }
  return false;
}

export function runXsMom(assets: readonly PanelAsset[], params: XsMomParams): XsMomResult {
  const aligned = alignPanel(assets);
  const { days, closes } = aligned;
  const gateSeries = params.gate === null ? undefined : closes.get(params.gate);
  // A gate that silently does nothing because its reference asset is absent
  // would look like evidence the gate doesn't work. Fail loudly instead.
  if (params.gate !== null && gateSeries === undefined) {
    throw new Error(`gate "${params.gate}" is not in the panel`);
  }
  const gateEma = gateSeries
    ? ema(gateSeries.map((v) => (Number.isFinite(v) ? v : 0)), 200)
    : [];
  const slip = params.slippageBps / 10_000;
  const costPerUnitTurnover = params.feeRate + slip;

  let equity = 1;
  let cash = 1;
  const units = new Map<string, number>();
  let feesPaid = 0;
  let turnover = 0;
  let rebalances = 0;
  let investedRebalances = 0;
  let holdingsSum = 0;

  const curve: Array<{ ts: number; equity: number }> = [];

  // Warm-up must cover everything the rule reads: the momentum lookback and the
  // 200-bar EMA behind the gate (the old code traded before that EMA existed, so
  // early "gated" trades were not gated at all). The 200-bar floor applies to
  // gated and ungated runs alike — otherwise the two arms start on different
  // dates and the comparison silently becomes "different history" vs "gate".
  const warmup = Math.max(params.lookback, params.gate === null ? 0 : 200);
  const period = Math.max(1, params.rebalanceDays);

  for (let i = 0; i < days.length; i++) {
    // A fixed calendar grid, not `(i - lookback) % period`: deriving the
    // schedule from the lookback made every result depend on a parameter that
    // the portfolio was not actually using.
    const rebalanceNow = i >= warmup && i % period === 0;

    if (rebalanceNow) {
      // Mark to market at today's close before deciding anything.
      let value = cash;
      for (const [symbol, qty] of units) {
        const px = closes.get(symbol)?.[i];
        if (Number.isFinite(px as number)) value += qty * (px as number);
      }

      const targetWeights = new Map<string, number>();
      const blocked =
        gateSeries !== undefined &&
        Number.isFinite(gateSeries[i]) &&
        Number.isFinite(gateEma[i]) &&
        gateSeries[i] < gateEma[i];
      if (!blocked) {
        const rankedAll = rankMomentum(aligned, i, params.lookback);
        if (params.allowShort) {
          // Equal weight (1/N of the universe) with the sign of momentum:
          // long the risers, short the fallers, in one pass.
          const n = Math.max(rankedAll.length, 1);
          for (const r of rankedAll) {
            if (r.momentum > 0) targetWeights.set(r.symbol, 1 / n);
            else if (r.momentum < 0) targetWeights.set(r.symbol, -1 / n);
          }
        } else {
          const ranked = rankedAll.filter((r) => !params.requirePositive || r.momentum > 0);
          const picked = ranked.slice(0, params.hold);
          for (const r of picked) targetWeights.set(r.symbol, 1 / picked.length);
        }
      }

      const currentValue = new Map<string, number>();
      for (const [symbol, qty] of units) {
        const px = closes.get(symbol)?.[i];
        currentValue.set(symbol, Number.isFinite(px as number) ? qty * (px as number) : 0);
      }

      const allSymbols = new Set([...units.keys(), ...targetWeights.keys()]);
      let traded = 0;
      for (const symbol of allSymbols) {
        const want = (targetWeights.get(symbol) ?? 0) * value;
        traded += Math.abs(want - (currentValue.get(symbol) ?? 0));
      }
      const cost = traded * costPerUnitTurnover;
      feesPaid += cost;
      turnover += value > 0 ? traded / value : 0;
      equity = value - cost;
      cash = equity;
      units.clear();

      for (const [symbol, weight] of targetWeights) {
        const px = closes.get(symbol)?.[i];
        if (!Number.isFinite(px as number) || !((px as number) > 0)) continue;
        if (!isTrading(aligned, symbol, i)) continue;
        const notional = weight * equity;
        units.set(symbol, notional / (px as number));
        cash -= notional;
      }

      rebalances += 1;
      if (targetWeights.size > 0) investedRebalances += 1;
      holdingsSum += targetWeights.size;
    }

    // Daily mark to market (the last bar of the loop sets the final equity).
    let value = cash;
    for (const [symbol, qty] of units) {
      const px = closes.get(symbol)?.[i];
      if (Number.isFinite(px as number)) value += qty * (px as number);
    }
    equity = value;
    curve.push({ ts: days[i], equity });
  }

  const first = curve[0]?.equity ?? 1;
  const last = curve[curve.length - 1]?.equity ?? 1;
  const years = (days[days.length - 1] - days[0]) / (365.25 * DAY_MS);
  const rets: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    if (prev > 0) rets.push(curve[i].equity / prev - 1);
  }

  return {
    start: days[0] ?? 0,
    end: days[days.length - 1] ?? 0,
    years,
    finalEquity: last,
    cagrPct: ((last / first) ** (1 / Math.max(years, 1e-9)) - 1) * 100,
    sharpe: sharpe(rets, 365),
    maxDrawdownPct: maxDrawdown(curve.map((p) => p.equity)) * 100,
    investedPct: rebalances > 0 ? (investedRebalances / rebalances) * 100 : 0,
    turnover,
    feesPaid,
    rebalances,
    avgHoldings: rebalances > 0 ? holdingsSum / rebalances : 0,
    equityCurve: curve,
  };
}

/** Equal-weight, monthly-rebalanced buy-and-hold of the whole universe. */
export function equalWeightBenchmark(assets: readonly PanelAsset[]): XsMomResult {
  const aligned = alignPanel(assets);
  const live = assets.map((a) => a.symbol).filter((s) => aligned.closes.has(s));
  const weight = live.length > 0 ? 1 / live.length : 0;
  const units = new Map<string, number>();
  const curve: Array<{ ts: number; equity: number }> = [];
  for (let i = 0; i < aligned.days.length; i++) {
    if (i === 0) {
      const base = 1;
      for (const s of live) {
        const px = aligned.closes.get(s)?.[0];
        if (Number.isFinite(px as number) && (px as number) > 0) {
          units.set(s, (weight * base) / (px as number));
        }
      }
    }
    let value = 0;
    for (const [s, qty] of units) {
      const px = aligned.closes.get(s)?.[i];
      if (Number.isFinite(px as number)) value += qty * (px as number);
    }
    curve.push({ ts: aligned.days[i], equity: value });
  }
  const last = curve[curve.length - 1]?.equity ?? 1;
  const years = (aligned.days[aligned.days.length - 1] - aligned.days[0]) / (365.25 * DAY_MS);
  const rets: number[] = [];
  for (let i = 1; i < curve.length; i++) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  return {
    start: aligned.days[0] ?? 0,
    end: aligned.days[aligned.days.length - 1] ?? 0,
    years,
    finalEquity: last,
    cagrPct: (last ** (1 / Math.max(years, 1e-9)) - 1) * 100,
    sharpe: sharpe(rets, 365),
    maxDrawdownPct: maxDrawdown(curve.map((p) => p.equity)) * 100,
    investedPct: 100,
    turnover: 0,
    feesPaid: 0,
    rebalances: 0,
    avgHoldings: live.length,
    equityCurve: curve,
  };
}
