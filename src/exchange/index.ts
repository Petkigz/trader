import type { BotConfig } from "../config.ts";
import type { SymbolInfo } from "../types.ts";
import { BinanceExchange, BinanceHttp, BinanceMarketData } from "./binance.ts";
import { PaperExchange, type PaperAccount } from "./paper.ts";
import type { Exchange, MarketData } from "./types.ts";

export interface ExchangeBundle {
  exchange: Exchange;
  marketData: MarketData;
  symbolInfo: SymbolInfo;
  /** Present in paper mode only; the engine persists it at the end of a tick. */
  paperAccount?: PaperAccount;
}

/**
 * Build the venue client for this tick.
 *
 * Paper mode still uses Binance's public endpoints for candles and prices, so
 * a network outage is the only thing that can stop it — and a failed tick is
 * retried at the next scheduled run with no lost state.
 */
export async function createExchange(cfg: BotConfig, paperAccount?: PaperAccount): Promise<ExchangeBundle> {
  const http = new BinanceHttp(cfg.exchange.baseUrl, cfg.exchange.apiKey, cfg.exchange.apiSecret);
  const marketData = new BinanceMarketData(http);
  const symbolInfo = await marketData.getSymbolInfo(cfg.symbol);

  if (cfg.mode === "live") {
    return { exchange: new BinanceExchange(http), marketData, symbolInfo };
  }

  const account: PaperAccount = paperAccount ?? { usdt: cfg.initialPaperUsdt, base: 0 };
  return {
    exchange: new PaperExchange(marketData, symbolInfo, cfg, account),
    marketData,
    symbolInfo,
    paperAccount: account,
  };
}

export { BinanceExchange, BinanceHttp, BinanceMarketData, PaperExchange };
export type { Exchange, MarketData, PaperAccount };
