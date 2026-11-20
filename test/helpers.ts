/** Shared fixtures: scripted exchanges and candle builders. */

import type { ConfigOverrides } from "./types.ts";
import { loadConfig, type BotConfig } from "../src/config.ts";
import type { Balance, Candle, ExchangeId, Fill, Interval, OrderResult, SymbolInfo } from "../src/types.ts";
import type { Exchange, MarketData } from "../src/exchange/types.ts";
import { DAY_MS, HOUR_MS } from "../src/util/num.ts";

export function testConfig(overrides: Record<string, string> = {}): BotConfig {
  return loadConfig({
    BOT_MODE: "paper",
    SYMBOL: "BTCUSDT",
    STRATEGY: "trend",
    POSITION_FRACTION: "0.97",
    SLIPPAGE_BPS: "0",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    ...overrides,
  } as ConfigOverrides);
}

export function makeCandle(close: number, closeTime: number, stepMs = DAY_MS): Candle {
  return {
    openTime: closeTime - stepMs + 1,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 100,
    closeTime,
  };
}

/** Linear series ending `endTime`, useful for trend tests. */
export function series(opts: {
  closes: number[];
  stepMs?: number;
  endTime?: number;
}): Candle[] {
  const step = opts.stepMs ?? DAY_MS;
  const end = opts.endTime ?? Date.UTC(2026, 0, 1);
  const start = end - opts.closes.length * step;
  return opts.closes.map((c, i) => makeCandle(c, start + (i + 1) * step - 1, step));
}

export function linear(count: number, from: number, to: number): number[] {
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / Math.max(count - 1, 1));
}

export interface FakeExchangeOptions {
  usdt?: number;
  base?: number;
  price: number;
  daily: Candle[];
  hourly?: Candle[];
  feeRate?: number;
  minNotional?: number;
  stepSize?: number;
}

/** A deterministic venue with scripted candles and an in-memory balance. */
export class FakeExchange implements Exchange {
  readonly id: ExchangeId = "binance";
  readonly isPaper = true;

  usdt: number;
  base: number;
  price: number;
  daily: Candle[];
  hourly: Candle[];
  feeRate: number;
  orders: OrderResult[] = [];

  private readonly info: SymbolInfo;

  constructor(opts: FakeExchangeOptions) {
    this.usdt = opts.usdt ?? 10;
    this.base = opts.base ?? 0;
    this.price = opts.price;
    this.daily = opts.daily;
    this.hourly = opts.hourly ?? [];
    this.feeRate = opts.feeRate ?? 0;
    this.info = {
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      minNotional: opts.minNotional ?? 5,
      stepSize: opts.stepSize ?? 0.00001,
      minQty: opts.stepSize ?? 0.00001,
      tickSize: 0.01,
    };
  }

  async getCandles(_symbol: string, interval: Interval): Promise<Candle[]> {
    return interval === "1d" ? this.daily : this.hourly;
  }

  async getPrice(): Promise<number> {
    return this.price;
  }

  async getSymbolInfo(): Promise<SymbolInfo> {
    return this.info;
  }

  async getBalances(): Promise<Balance[]> {
    return [
      { asset: "USDT", free: this.usdt, locked: 0 },
      { asset: "BTC", free: this.base, locked: 0 },
    ];
  }

  async marketBuyQuote(_symbol: string, quoteAmount: number): Promise<OrderResult> {
    if (quoteAmount > this.usdt + 1e-9) throw new Error("insufficient funds");
    const fee = quoteAmount * this.feeRate;
    const qty = (quoteAmount - fee) / this.price;
    this.usdt -= quoteAmount;
    this.base += qty;
    const order: OrderResult = {
      id: `fake-${this.orders.length}`,
      side: "BUY",
      qty,
      price: this.price,
      quoteQty: quoteAmount,
      feeQuote: fee,
    };
    this.orders.push(order);
    return order;
  }

  async marketSellBase(_symbol: string, qty: number): Promise<OrderResult> {
    const sellQty = Math.min(qty, this.base);
    const quote = sellQty * this.price;
    const fee = quote * this.feeRate;
    this.base -= sellQty;
    this.usdt += quote - fee;
    const order: OrderResult = {
      id: `fake-${this.orders.length}`,
      side: "SELL",
      qty: sellQty,
      price: this.price,
      quoteQty: quote,
      feeQuote: fee,
    };
    this.orders.push(order);
    return order;
  }

  async getFills(): Promise<Fill[]> {
    return [];
  }

  /** Set `restrictions` on the instance to simulate a live key's permissions. */
  restrictions: { withdrawalsEnabled: boolean; spotTradingEnabled: boolean } | null = null;

  async getApiRestrictions() {
    return this.restrictions;
  }
}

/** Minimal market data stub for paper-exchange tests. */
export class StubMarketData implements MarketData {
  price: number;
  candles: Candle[];

  constructor(price: number, candles: Candle[] = []) {
    this.price = price;
    this.candles = candles;
  }

  async getCandles(): Promise<Candle[]> {
    return this.candles;
  }

  async getPrice(): Promise<number> {
    return this.price;
  }

  async getSymbolInfo(): Promise<SymbolInfo> {
    return {
      symbol: "BTCUSDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      minNotional: 5,
      stepSize: 0.00001,
      minQty: 0.00001,
      tickSize: 0.01,
    };
  }
}

export const ONE_DAY = DAY_MS;
export const ONE_HOUR = HOUR_MS;
