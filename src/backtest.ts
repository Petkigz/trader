/**
 * Walk-forward backtester.
 *
 * It imports the *same* `evaluate`, `refreshRisk`, `applyTradeOutcome` and
 * `sizePosition` functions the live engine uses. There is no second
 * implementation of the strategy to drift out of sync, which is the usual
 * reason backtests lie.
 *
 * Honest limitations, stated up front:
 *  - entries and exits happen at bar close, plus fee and a slippage penalty
 *  - stop/target checks are evaluated at bar close, not tick-by-tick, so a
 *    violent intrabar wick can exit worse in reality
 *  - no funding, no borrow, no partial fills (spot long-only needs none)
 */

import type { BotConfig } from "./config.ts";
import { applyTradeOutcome, realizedPnl, refreshRisk, sizePosition } from "./risk.ts";
import { adaptiveFraction } from "./strategy/adaptive.ts";
import { evaluate } from "./strategy.ts";
import type { BotState, Candle, Position, SymbolInfo, TradeRecord } from "./types.ts";
import { emptyState } from "./types.ts";
import { maxDrawdown, sharpe } from "./util/indicators.ts";
import { DAY_MS, floorToStep, round } from "./util/num.ts";

export interface BacktestOptions {
  cfg: BotConfig;
  daily: Candle[];
  hourly: Candle[];
  capital: number;
  info: SymbolInfo;
}

export interface BacktestResult {
  strategy: string;
  symbol: string;
  start: number;
  end: number;
  years: number;
  capital: number;
  finalEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  buyHoldPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  feesPaid: number;
  exposurePct: number;
  bestTradePct: number;
  worstTradePct: number;
  avgHoldDays: number;
  equityCurve: Array<{ ts: number; equity: number }>;
  monthly: Array<{ month: string; equity: number; returnPct: number }>;
  /** Most recent fills, newest first — handy for the dashboard demo view. */
  recentTrades: TradeRecord[];
  lastSignal: { action: string; reason: string; detail: string };
}

export function defaultSymbolInfo(symbol: string): SymbolInfo {
  return {
    symbol,
    baseAsset: symbol.replace(/(USDT|USDC|BUSD|BTC|ETH)$/, ""),
    quoteAsset: "USDT",
    minNotional: 5,
    stepSize: 0.00001,
    minQty: 0.00001,
    tickSize: 0.01,
  };
}

export function runBacktest(opts: BacktestOptions): BacktestResult {
  const { cfg, daily, hourly, capital, info } = opts;
  if (daily.length < 30) throw new Error(`not enough daily candles (${daily.length})`);

  const slip = cfg.slippageBps / 10_000;
  const fee = cfg.feeRate;

  let cash = capital;
  let qty = 0;
  let position: Position | null = null;
  let costBasis = 0;
  let entryAt = 0;

  let state: BotState = emptyState("paper", cfg.symbol, cfg.strategy, daily[0].openTime, capital);
  state.paperUsdt = capital;

  const trades: TradeRecord[] = [];
  const equityCurve: Array<{ ts: number; equity: number }> = [];
  const holdDays: number[] = [];
  const pnls: number[] = [];

  let feesPaid = 0;
  let barsInMarket = 0;
  let lastSignal = { action: "HOLD", reason: "n/a", detail: "" };

  const warmup = cfg.strategy === "trend" ? cfg.trend.emaPeriod + 2 : Math.max(cfg.trend.emaPeriod + 2, 30);
  let hourlyIdx = 0;

  for (let i = warmup; i < daily.length; i++) {
    const bar = daily[i];
    const now = bar.closeTime;
    const price = bar.close;

    // Advance the hourly pointer (monotonic, keeps this O(n)).
    if (cfg.strategy === "pullback") {
      while (hourlyIdx + 1 < hourly.length && hourly[hourlyIdx + 1].closeTime <= now) hourlyIdx++;
    }
    const hourlySlice = cfg.strategy === "pullback" ? hourly.slice(0, hourlyIdx + 1) : [];

    const equity = cash + qty * price;
    const risk = refreshRisk(state, equity, now, cfg);
    state = risk.state;

    const positionForEval: Position | null =
      qty > 0 && position ? { ...position, qty } : null;

    const decision = evaluate({
      daily: daily.slice(0, i + 1),
      hourly: hourlySlice,
      position: positionForEval,
      price,
      now,
      cfg,
    });
    lastSignal = { action: decision.action, reason: decision.reason, detail: decision.detail };

    if (decision.action === "EXIT_LONG" && qty > 0) {
      const fillPrice = price * (1 - slip);
      const proceeds = qty * fillPrice;
      const feeQuote = proceeds * fee;
      const pnl = realizedPnl({ quoteQty: proceeds, feeQuote }, costBasis);

      cash += proceeds - feeQuote;
      feesPaid += feeQuote;
      pnls.push(pnl);
      holdDays.push((now - entryAt) / DAY_MS);

      trades.push({
        id: `bt-${i}-sell`,
        ts: now,
        mode: "paper",
        strategy: cfg.strategy,
        symbol: cfg.symbol,
        side: "SELL",
        qty,
        price: round(fillPrice, 2),
        quoteQty: round(proceeds, 2),
        feeQuote: round(feeQuote, 4),
        reason: decision.reason,
        orderId: "",
        realizedPnlQuote: round(pnl, 4),
      });

      state = applyTradeOutcome(state, pnl, now, cfg).state;
      qty = 0;
      costBasis = 0;
      position = null;
    } else if (decision.action === "ENTER_LONG" && qty === 0 && !risk.entriesBlocked) {
      const snap = adaptiveFraction(daily.slice(0, i + 1), cfg);
      const sizing = sizePosition(cash, price, info, cfg, snap.fraction);
      if (sizing.ok) {
        // Same fill model as PaperExchange and as Binance: quantity rounds down
        // to the lot step, commission is charged in the base asset, and only the
        // quantised amount is actually spent (the dust stays as cash).
        const fillPrice = price * (1 + slip);
        const grossQty = floorToStep(sizing.notional / fillPrice, info.stepSize);
        const spend = grossQty * fillPrice;
        const feeQty = grossQty * fee;
        const bought = grossQty - feeQty;
        const feeQuote = feeQty * fillPrice;

        if (bought > 0 && spend >= info.minNotional && spend <= cash) {
          cash -= spend;
          feesPaid += feeQuote;
          qty = bought;
          costBasis = spend;
          entryAt = now;
          position = {
            symbol: cfg.symbol,
            qty,
            // What we actually paid per unit received (fee included), so the
            // crash stop and the PnL basis match the live engine exactly.
            entryPrice: spend / bought,
            entryAt: now,
            stopPrice: decision.stopPrice ?? null,
            targetPrice: decision.targetPrice ?? null,
          };

          trades.push({
            id: `bt-${i}-buy`,
            ts: now,
            mode: "paper",
            strategy: cfg.strategy,
            symbol: cfg.symbol,
            side: "BUY",
            qty: bought,
            price: round(fillPrice, 2),
            quoteQty: round(spend, 2),
            feeQuote: round(feeQuote, 4),
            reason: decision.reason,
            orderId: "",
            realizedPnlQuote: null,
          });
        }
      }
    }

    if (qty > 0) barsInMarket++;
    equityCurve.push({ ts: now, equity: round(cash + qty * price, 4) });
  }

  /* ------------------------------------------------------------- metrics */

  const equityValues = equityCurve.map((p) => p.equity);
  const finalEquity = equityValues[equityValues.length - 1] ?? capital;
  const first = daily[warmup];
  const last = daily[daily.length - 1];
  const years = Math.max((last.closeTime - first.closeTime) / (365.25 * DAY_MS), 1 / 365.25);
  const totalReturn = finalEquity / capital - 1;
  const cagr = (finalEquity / capital) ** (1 / years) - 1;
  const buyHold = (last.close / first.close - 1) * 100;

  const returns: number[] = [];
  for (let i = 1; i < equityValues.length; i++) {
    const prev = equityValues[i - 1];
    if (prev > 0) returns.push(equityValues[i] / prev - 1);
  }

  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p <= 0).length;

  const pctPnl = trades
    .filter((t) => t.side === "SELL" && t.realizedPnlQuote !== null)
    .map((t) => {
      const buy = trades.filter((x) => x.side === "BUY" && x.ts <= t.ts).pop();
      return buy ? ((t.realizedPnlQuote as number) / buy.quoteQty) * 100 : 0;
    });

  return {
    strategy: cfg.strategy,
    symbol: cfg.symbol,
    start: first.closeTime,
    end: last.closeTime,
    years: round(years, 2),
    capital,
    finalEquity: round(finalEquity, 4),
    totalReturnPct: round(totalReturn * 100, 2),
    cagrPct: round(cagr * 100, 2),
    buyHoldPct: round(buyHold, 2),
    maxDrawdownPct: round(maxDrawdown(equityValues) * 100, 2),
    sharpe: round(sharpe(returns, 365), 2),
    trades: pnls.length,
    wins,
    losses,
    winRatePct: pnls.length ? round((wins / pnls.length) * 100, 1) : 0,
    feesPaid: round(feesPaid, 4),
    exposurePct: round((barsInMarket / Math.max(equityCurve.length, 1)) * 100, 1),
    bestTradePct: pctPnl.length ? round(Math.max(...pctPnl), 2) : 0,
    worstTradePct: pctPnl.length ? round(Math.min(...pctPnl), 2) : 0,
    avgHoldDays: holdDays.length ? round(holdDays.reduce((a, b) => a + b, 0) / holdDays.length, 1) : 0,
    equityCurve: downsample(equityCurve, 400),
    monthly: monthlyReturns(equityCurve),
    // 12 is enough for a dashboard; research on loss distributions needs every
    // trade, so the cap is configurable rather than hard-coded.
    recentTrades: [...trades]
      .reverse()
      .slice(0, Math.max(0, Number(process.env.BACKTEST_TRADE_LOG ?? 12)) || 12),
    lastSignal,
  };
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

function monthlyReturns(curve: Array<{ ts: number; equity: number }>): BacktestResult["monthly"] {
  const byMonth = new Map<string, number>();
  for (const p of curve) {
    byMonth.set(new Date(p.ts).toISOString().slice(0, 7), p.equity);
  }
  const out: BacktestResult["monthly"] = [];
  let prev: number | null = null;
  for (const [month, equity] of byMonth) {
    out.push({ month, equity: round(equity, 2), returnPct: prev && prev > 0 ? round((equity / prev - 1) * 100, 2) : 0 });
    prev = equity;
  }
  return out;
}
