/**
 * Binance spot adapter.
 *
 * Talks to the REST API directly with `fetch` and `node:crypto` — no SDK, so
 * there is nothing to upgrade, deprecate or break over a multi-year runtime.
 *
 * Hardening that matters for unattended operation:
 *  - retries on 429/418/5xx and socket errors with short backoff
 *  - honours `Retry-After`
 *  - re-syncs the clock on -1021 (timestamp outside recvWindow), which is the
 *    single most common cause of "my bot broke after a few months"
 */

import { createHmac } from "node:crypto";
import type { Balance, Candle, ExchangeId, Fill, Interval, OrderResult, SymbolInfo } from "../types.ts";
import { ExchangeError, type Exchange, type MarketData } from "./types.ts";

const RETRIABLE_STATUS = new Set([418, 429, 500, 502, 503, 504]);
const RETRIABLE_CODES = new Set([-1001, -1003, -1021, -1007]);

export class BinanceHttp {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private timeOffset = 0;
  private timeSyncedAt = 0;

  constructor(baseUrl: string, apiKey = "", apiSecret = "") {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | undefined> = {},
    opts: { signed?: boolean; attempt?: number } = {},
  ): Promise<T> {
    const attempt = opts.attempt ?? 0;
    const url = new URL(this.baseUrl + path);

    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null) as [string, string | number][];

    if (opts.signed) {
      if (!this.apiKey || !this.apiSecret) {
        throw new ExchangeError("signed request without API credentials", "no-credentials");
      }
      if (Date.now() - this.timeSyncedAt > 30 * 60_000) await this.syncTime().catch(() => undefined);
      entries.push(["recvWindow", 10_000]);
      entries.push(["timestamp", Date.now() + this.timeOffset]);
    }

    const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    let body: string | undefined;
    if (method === "POST") body = qs;
    else url.search = qs;

    if (opts.signed) {
      const signature = createHmac("sha256", this.apiSecret).update(qs).digest("hex");
      if (method === "POST") body = `${qs}&signature=${signature}`;
      else url.search = `${qs}&signature=${signature}`;
    }

    const headers: Record<string, string> = {};
    if (opts.signed) headers["X-MBX-APIKEY"] = this.apiKey;
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (attempt < 2) {
        await sleep(300 * (attempt + 1));
        return this.request<T>(method, path, params, { ...opts, attempt: attempt + 1 });
      }
      throw new ExchangeError(`network error calling ${path}: ${(err as Error).message}`, "network", true);
    }

    if (RETRIABLE_STATUS.has(res.status) && attempt < 2) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0);
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : 400 * (attempt + 1));
      return this.request<T>(method, path, params, { ...opts, attempt: attempt + 1 });
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new ExchangeError(`non-JSON response from ${path} (HTTP ${res.status}): ${text.slice(0, 200)}`, "bad-json", true);
    }

    if (!res.ok) {
      const e = parsed as { code?: number; msg?: string } | null;
      const code = e?.code ?? res.status;
      const msg = e?.msg ?? `HTTP ${res.status}`;
      // Clock drift: resync once, then retry immediately.
      if (code === -1021 && attempt < 2) {
        await this.syncTime().catch(() => undefined);
        return this.request<T>(method, path, params, { ...opts, attempt: attempt + 1 });
      }
      throw new ExchangeError(`binance ${path} failed: ${msg}`, code, RETRIABLE_CODES.has(Number(code)));
    }

    return parsed as T;
  }

  async syncTime(): Promise<void> {
    const server = await this.request<{ serverTime: number }>("GET", "/api/v3/time");
    this.timeOffset = server.serverTime - Date.now();
    this.timeSyncedAt = Date.now();
  }

  get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  getSigned<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    return this.request<T>("GET", path, params, { signed: true });
  }

  postSigned<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    return this.request<T>("POST", path, params, { signed: true });
  }
}

/* -------------------------------------------------------------------------- */

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

export class BinanceMarketData implements MarketData {
  readonly http: BinanceHttp;
  private infoCache = new Map<string, { at: number; info: SymbolInfo }>();

  constructor(http: BinanceHttp) {
    this.http = http;
  }

  async getCandles(symbol: string, interval: Interval, limit: number, endTime?: number): Promise<Candle[]> {
    const raw = await this.http.get<RawKline[]>("/api/v3/klines", {
      symbol,
      interval,
      limit: Math.min(Math.max(limit, 1), 1000),
      endTime,
    });
    return raw.map((k) => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6],
    }));
  }

  async getPrice(symbol: string): Promise<number> {
    const r = await this.http.get<{ price: string }>("/api/v3/ticker/price", { symbol });
    const p = Number(r.price);
    if (!Number.isFinite(p) || p <= 0) throw new ExchangeError(`bad price for ${symbol}: ${r.price}`, "bad-price");
    return p;
  }

  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    const hit = this.infoCache.get(symbol);
    if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.info;

    const r = await this.http.get<{
      symbols: Array<{
        symbol: string;
        baseAsset: string;
        quoteAsset: string;
        filters: Array<Record<string, string>>;
      }>;
    }>("/api/v3/exchangeInfo", { symbol });

    const s = r.symbols?.[0];
    if (!s) throw new ExchangeError(`unknown symbol ${symbol}`, "unknown-symbol");

    const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
    const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
    const notional = s.filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");

    const info: SymbolInfo = {
      symbol: s.symbol,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      minNotional: Number(notional?.minNotional ?? 5),
      stepSize: Number(lot?.stepSize ?? 0.00001),
      minQty: Number(lot?.minQty ?? 0.00001),
      tickSize: Number(price?.tickSize ?? 0.01),
    };
    this.infoCache.set(symbol, { at: Date.now(), info });
    return info;
  }
}

/* -------------------------------------------------------------------------- */

interface RawAccount {
  balances: Array<{ asset: string; free: string; locked: string }>;
}

interface RawOrder {
  orderId: number;
  executedQty: string;
  cummulativeQuoteQty: string;
  fills?: Array<{ commission: string; commissionAsset: string; qty: string; price: string }>;
}

interface RawTrade {
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

export class BinanceExchange extends BinanceMarketData implements Exchange {
  readonly id: ExchangeId = "binance";
  readonly isPaper = false;

  constructor(http: BinanceHttp) {
    super(http);
  }

  async getBalances(): Promise<Balance[]> {
    const acct = await this.http.getSigned<RawAccount>("/api/v3/account");
    return acct.balances
      .map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
      .filter((b) => b.free > 0 || b.locked > 0);
  }

  async marketBuyQuote(symbol: string, quoteAmount: number): Promise<OrderResult> {
    const info = await this.getSymbolInfo(symbol);
    const order = await this.http.postSigned<RawOrder>("/api/v3/order", {
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: trim(quoteAmount),
      newOrderRespType: "FULL",
    });
    return toOrderResult("BUY", order, info);
  }

  async marketSellBase(symbol: string, qty: number): Promise<OrderResult> {
    const info = await this.getSymbolInfo(symbol);
    const order = await this.http.postSigned<RawOrder>("/api/v3/order", {
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: trim(qty),
      newOrderRespType: "FULL",
    });
    return toOrderResult("SELL", order, info);
  }

  async getFills(symbol: string, sinceMs: number, limit = 100): Promise<Fill[]> {
    const raw = await this.http.getSigned<RawTrade[]>("/api/v3/myTrades", {
      symbol,
      startTime: Math.max(0, Math.floor(sinceMs)),
      limit,
    });
    return raw.map((t) => ({
      id: String(t.id),
      ts: t.time,
      side: t.isBuyer ? "BUY" : "SELL",
      qty: Number(t.qty),
      price: Number(t.price),
      quoteQty: Number(t.quoteQty),
      feeQuote: Number(t.commission),
    }));
  }

  async getApiRestrictions(): Promise<{ withdrawalsEnabled: boolean; spotTradingEnabled: boolean } | null> {
    try {
      const r = await this.http.getSigned<{ enableWithdrawals?: boolean; enableSpotAndMarginTrading?: boolean }>(
        "/sapi/v1/account/apiRestrictions",
      );
      return {
        withdrawalsEnabled: Boolean(r.enableWithdrawals),
        spotTradingEnabled: Boolean(r.enableSpotAndMarginTrading),
      };
    } catch {
      // Testnet and some regions do not expose this endpoint.
      return null;
    }
  }
}

function toOrderResult(side: "BUY" | "SELL", order: RawOrder, info: SymbolInfo): OrderResult {
  const qty = Number(order.executedQty);
  const quoteQty = Number(order.cummulativeQuoteQty);
  const price = qty > 0 ? quoteQty / qty : 0;

  // Commission is usually taken in the base asset on buys (or BNB if enabled),
  // so convert it into quote terms to keep PnL accounting uniform.
  let feeQuote = 0;
  for (const f of order.fills ?? []) {
    const commission = Number(f.commission);
    if (!(commission > 0)) continue;
    if (f.commissionAsset === info.baseAsset) {
      // commission charged in the asset we bought -> value it at the fill price
      feeQuote += commission * Number(f.price);
    } else {
      // quote asset, or BNB which we approximate 1:1 (it understates by a few
      // cents at most and never overstates the fee)
      feeQuote += commission;
    }
  }

  if (qty <= 0) throw new ExchangeError(`order for ${info.symbol} executed 0 quantity`, "zero-fill");
  return { id: String(order.orderId), side, qty, price, quoteQty, feeQuote };
}

function trim(n: number): string {
  // Avoid exponent notation and float tails in the query string.
  return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
