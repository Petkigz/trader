import type { Balance, Candle, ExchangeId, Fill, Interval, OrderResult, SymbolInfo } from "../types.ts";

/** Read-only market data. Works without any credentials. */
export interface MarketData {
  /** Up to `limit` candles ending at `endTime` (default: now). Oldest first. */
  getCandles(symbol: string, interval: Interval, limit: number, endTime?: number): Promise<Candle[]>;
  getPrice(symbol: string): Promise<number>;
  getSymbolInfo(symbol: string): Promise<SymbolInfo>;
}

/**
 * Everything the engine needs from a venue. Implemented twice:
 *
 *  - `BinanceExchange`  — real orders, needs API keys
 *  - `PaperExchange`    — real market data, simulated fills, needs nothing
 *
 * The engine cannot tell them apart, so the code path you test in paper mode
 * is the code path that trades real money.
 */
export interface Exchange extends MarketData {
  readonly id: ExchangeId;
  readonly isPaper: boolean;

  getBalances(): Promise<Balance[]>;
  /** Spend `quoteAmount` of the quote asset. */
  marketBuyQuote(symbol: string, quoteAmount: number): Promise<OrderResult>;
  /** Sell `qty` of the base asset. */
  marketSellBase(symbol: string, qty: number): Promise<OrderResult>;
  getFills(symbol: string, sinceMs: number, limit?: number): Promise<Fill[]>;

  /**
   * Live-mode safety probe. Returns null when the venue cannot answer.
   * Used to refuse trading with a key that can withdraw funds.
   */
  getApiRestrictions(): Promise<{ withdrawalsEnabled: boolean; spotTradingEnabled: boolean } | null>;
}

export class ExchangeError extends Error {
  readonly code: number | string;
  readonly retriable: boolean;

  constructor(message: string, code: number | string = "unknown", retriable = false) {
    super(message);
    this.name = "ExchangeError";
    this.code = code;
    this.retriable = retriable;
  }
}
