/**
 * Shared domain types.
 *
 * Money is always a JS `number` denominated in the quote asset (USDT).
 * With a $10 account the absolute error of float64 is many orders of
 * magnitude below the smallest exchange tick, so floats are safe here —
 * but every value that goes *to an order* is rounded down to the exchange's
 * step size first (see `quantize` in util/num.ts).
 */

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type Mode = "paper" | "live";

export type StrategyName = "trend" | "pullback" | "meanrev" | "ensemble";

export type ExchangeId = "binance";

/** A single OHLCV bar. `closeTime` is the last millisecond inside the bar. */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  /** Binance rejects orders whose notional is below this (usually 5 USDT). */
  minNotional: number;
  /** Smallest quantity increment, e.g. 0.00001 BTC. */
  stepSize: number;
  minQty: number;
  tickSize: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface Fill {
  id: string;
  ts: number;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  quoteQty: number;
  feeQuote: number;
}

export interface OrderResult {
  id: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  quoteQty: number;
  feeQuote: number;
}

/** An open long position. Long-only by design: worst case is a lower price, never liquidation. */
export interface Position {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryAt: number;
  stopPrice: number | null;
  targetPrice: number | null;
}

export type Action = "ENTER_LONG" | "EXIT_LONG" | "HOLD";

export interface Decision {
  action: Action;
  /** Short machine-readable tag, e.g. "rsi_oversold". */
  reason: string;
  /** Human sentence written into the audit log. */
  detail: string;
  /** Prices to attach to a new position (ATR-derived stops etc.). */
  stopPrice?: number;
  targetPrice?: number;
  meta?: Record<string, number | string | boolean>;
}

export interface TradeRecord {
  id: string;
  ts: number;
  mode: Mode;
  strategy: StrategyName;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  quoteQty: number;
  feeQuote: number;
  reason: string;
  orderId: string;
  /** Realised profit in quote currency; only set on sells. */
  realizedPnlQuote: number | null;
}

export interface TickRecord {
  ts: number;
  mode: Mode;
  strategy: StrategyName;
  symbol: string;
  price: number;
  equity: number;
  action: Action | "NONE";
  reason: string;
  detail: string;
  meta: Record<string, unknown>;
}

export interface BotState {
  mode: Mode;
  symbol: string;
  strategy: StrategyName;

  /* --- risk bookkeeping (all persisted so restarts are seamless) --- */
  highWaterMark: number;
  dayKey: string; // UTC "YYYY-MM-DD"
  dayStartEquity: number;
  consecutiveLosses: number;
  haltedUntil: number; // epoch ms, 0 = not halted
  haltReason: string;
  cooldownUntil: number; // epoch ms, 0 = none
  killSwitch: boolean;

  /* --- paper account (unused in live mode) --- */
  paperUsdt: number;
  paperBase: number;

  /* --- mirrored position; the exchange balance is the source of truth --- */
  position: Position | null;
  /** Average cost basis of the open position, recovered from the trade ledger. */
  entryPrice: number | null;

  /* --- liveness / idempotency telemetry --- */
  lastTickAt: number;
  lastCandleCloseTime: number;
  lockExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export function emptyState(mode: Mode, symbol: string, strategy: StrategyName, now: number, paperUsdt = 10): BotState {
  return {
    mode,
    symbol,
    strategy,
    highWaterMark: 0,
    dayKey: "",
    dayStartEquity: 0,
    consecutiveLosses: 0,
    haltedUntil: 0,
    haltReason: "",
    cooldownUntil: 0,
    killSwitch: false,
    paperUsdt,
    paperBase: 0,
    position: null,
    entryPrice: null,
    lastTickAt: 0,
    lastCandleCloseTime: 0,
    lockExpiresAt: 0,
    createdAt: now,
    updatedAt: now,
  };
}
