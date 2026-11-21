/**
 * Paper exchange.
 *
 * This is not a toy mock. It consumes the *live* order book price and live
 * candles from the same venue the live mode uses, and it charges the real taker
 * fee plus a configurable slippage penalty. The only thing missing is the
 * counterparty.
 *
 * That matters for the $10 requirement: you can let this run for weeks and see
 * exactly what the live bot would have done, without risking a cent and
 * without supplying API keys.
 */

import type { BotConfig } from "../config.ts";
import type { Balance, Candle, ExchangeId, Fill, Interval, OrderResult, SymbolInfo } from "../types.ts";
import { floorToStep, round } from "../util/num.ts";
import { ExchangeError, type Exchange, type MarketData } from "./types.ts";

export interface PaperAccount {
  usdt: number;
  base: number;
}

export class PaperExchange implements Exchange {
  readonly id: ExchangeId = "binance";
  readonly isPaper = true;

  private readonly md: MarketData;
  private readonly info: SymbolInfo;
  private readonly cfg: BotConfig;
  /** Mutated in place by fills; the engine persists it after the tick. */
  account: PaperAccount;

  constructor(md: MarketData, info: SymbolInfo, cfg: BotConfig, account: PaperAccount) {
    this.md = md;
    this.info = info;
    this.cfg = cfg;
    this.account = account;
  }

  getCandles(symbol: string, interval: Interval, limit: number, endTime?: number): Promise<Candle[]> {
    return this.md.getCandles(symbol, interval, limit, endTime);
  }

  getPrice(symbol: string): Promise<number> {
    return this.md.getPrice(symbol);
  }

  getSymbolInfo(): Promise<SymbolInfo> {
    return Promise.resolve(this.info);
  }

  async getBalances(): Promise<Balance[]> {
    return [
      { asset: this.info.quoteAsset, free: this.account.usdt, locked: 0 },
      { asset: this.info.baseAsset, free: this.account.base, locked: 0 },
    ];
  }

  async marketBuyQuote(symbol: string, quoteAmount: number): Promise<OrderResult> {
    const last = await this.md.getPrice(symbol);
    const fillPrice = last * (1 + this.cfg.slippageBps / 10_000);

    // Binance rounds the executed quantity down to the lot step, then charges
    // commission in the *base* asset. Modelling it the same way means the only
    // value lost on a $10 order is the fee — not the rounding dust, which stays
    // in your account as unspent cash.
    const grossQty = floorToStep(quoteAmount / fillPrice, this.info.stepSize);
    const spend = grossQty * fillPrice;

    if (!(grossQty > 0) || spend < this.info.minNotional) {
      throw new ExchangeError(
        `paper order rejected: ${round(spend, 4)} below min notional ${this.info.minNotional}`,
        "below_min_notional",
      );
    }
    if (spend > this.account.usdt + 1e-9) {
      throw new ExchangeError(`paper order rejected: insufficient USDT (${this.account.usdt})`, "insufficient_funds");
    }

    const feeQty = grossQty * this.cfg.feeRate;
    const netQty = grossQty - feeQty;

    this.account.usdt = round(this.account.usdt - spend, 8);
    this.account.base = round(this.account.base + netQty, 8);

    return {
      id: `paper-${Date.now()}`,
      side: "BUY",
      qty: round(netQty, 8),
      price: round(fillPrice, 8),
      quoteQty: round(spend, 8),
      feeQuote: round(feeQty * fillPrice, 8),
    };
  }

  async marketSellBase(symbol: string, qty: number): Promise<OrderResult> {
    const last = await this.md.getPrice(symbol);
    const fillPrice = last * (1 - this.cfg.slippageBps / 10_000);
    const sellQty = Math.min(qty, this.account.base);

    if (!(sellQty > 0)) {
      throw new ExchangeError("paper order rejected: nothing to sell", "zero_qty");
    }

    const quoteQty = sellQty * fillPrice;
    const feeQuote = quoteQty * this.cfg.feeRate;

    this.account.base = round(this.account.base - sellQty, 8);
    this.account.usdt = round(this.account.usdt + quoteQty - feeQuote, 8);

    return {
      id: `paper-${Date.now()}`,
      side: "SELL",
      qty: round(sellQty, 8),
      price: round(fillPrice, 8),
      quoteQty: round(quoteQty, 8),
      feeQuote: round(feeQuote, 8),
    };
  }

  async getFills(): Promise<Fill[]> {
    return [];
  }

  async getApiRestrictions() {
    return null;
  }
}
