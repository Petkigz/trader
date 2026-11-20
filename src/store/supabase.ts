/**
 * Supabase store, implemented over the PostgREST HTTP API with plain `fetch`.
 * No `@supabase/supabase-js` dependency: one less thing that can break.
 *
 * Uses the service_role key, which bypasses RLS. That key must never reach a
 * browser — the dashboard talks to /api/status instead.
 */

import type { BotState, Mode, Position, StrategyName, TickRecord, TradeRecord } from "../types.ts";
import type { Store } from "./types.ts";

type Row = Record<string, unknown>;

export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;

  private readonly url: string;
  private readonly key: string;

  constructor(url: string, key: string) {
    this.url = url;
    this.key = key;
  }

  /* ------------------------------------------------------------------ HTTP */

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`supabase ${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    return this.call<T>(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  }

  private async insert(table: string, row: Row): Promise<void> {
    await this.call(`/rest/v1/${table}`, {
      method: "POST",
      body: JSON.stringify(row),
      headers: { Prefer: "return=minimal" },
    });
  }

  /* ------------------------------------------------------------------ lock */

  acquireLock(ttlSeconds: number): Promise<boolean> {
    return this.rpc<boolean>("bot_acquire_lock", { ttl_seconds: ttlSeconds });
  }

  async releaseLock(): Promise<void> {
    await this.call("/rest/v1/bot_state?id=eq.1", {
      method: "PATCH",
      body: JSON.stringify({ lock_expires_at: 0 }),
      headers: { Prefer: "return=minimal" },
    });
  }

  /* ----------------------------------------------------------------- state */

  async getState(): Promise<BotState | null> {
    const rows = await this.call<Row[]>("/rest/v1/bot_state?id=eq.1&select=*");
    const row = rows?.[0];
    return row ? rowToState(row) : null;
  }

  async saveState(state: BotState): Promise<void> {
    const row = stateToRow(state);
    // Never write the lock column from here: the lock is owned by
    // acquireLock/releaseLock and clobbering it could release a live tick.
    delete row.lock_expires_at;
    await this.call("/rest/v1/bot_state?on_conflict=id", {
      method: "POST",
      body: JSON.stringify([row]),
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    });
  }

  /* ------------------------------------------------------------------- log */

  recordTrade(t: TradeRecord): Promise<void> {
    return this.insert("trades", {
      id: t.id,
      ts: t.ts,
      mode: t.mode,
      strategy: t.strategy,
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      price: t.price,
      quote_qty: t.quoteQty,
      fee_quote: t.feeQuote,
      reason: t.reason,
      order_id: t.orderId,
      realized_pnl_quote: t.realizedPnlQuote,
    });
  }

  recordTick(t: TickRecord): Promise<void> {
    return this.insert("ticks", {
      ts: t.ts,
      mode: t.mode,
      strategy: t.strategy,
      symbol: t.symbol,
      price: t.price,
      equity: t.equity,
      action: t.action,
      reason: t.reason,
      detail: t.detail,
      meta: t.meta,
    });
  }

  async recentTrades(limit: number): Promise<TradeRecord[]> {
    const rows = await this.call<Row[]>(`/rest/v1/trades?select=*&order=ts.desc&limit=${Math.max(1, limit)}`);
    return (rows ?? []).map((r) => ({
      id: String(r.id),
      ts: num(r.ts),
      mode: String(r.mode) as Mode,
      strategy: String(r.strategy) as StrategyName,
      symbol: String(r.symbol),
      side: String(r.side) === "SELL" ? "SELL" : "BUY",
      qty: num(r.qty),
      price: num(r.price),
      quoteQty: num(r.quote_qty),
      feeQuote: num(r.fee_quote),
      reason: String(r.reason ?? ""),
      orderId: String(r.order_id ?? ""),
      realizedPnlQuote: r.realized_pnl_quote === null || r.realized_pnl_quote === undefined ? null : num(r.realized_pnl_quote),
    }));
  }

  async recentTicks(limit: number): Promise<TickRecord[]> {
    const rows = await this.call<Row[]>(`/rest/v1/ticks?select=*&order=ts.desc&limit=${Math.max(1, limit)}`);
    return (rows ?? []).map((r) => ({
      ts: num(r.ts),
      mode: String(r.mode) as Mode,
      strategy: String(r.strategy) as StrategyName,
      symbol: String(r.symbol),
      price: num(r.price),
      equity: num(r.equity),
      action: String(r.action) as TickRecord["action"],
      reason: String(r.reason ?? ""),
      detail: String(r.detail ?? ""),
      meta: (r.meta as Record<string, unknown>) ?? {},
    }));
  }

  async equityHistory(limit: number): Promise<Array<{ ts: number; equity: number }>> {
    const rows = await this.call<Row[]>(`/rest/v1/ticks?select=ts,equity&order=ts.desc&limit=${Math.max(1, limit)}`);
    return (rows ?? []).map((r) => ({ ts: num(r.ts), equity: num(r.equity) })).reverse();
  }

  async setKillSwitch(on: boolean): Promise<void> {
    await this.call("/rest/v1/bot_state?id=eq.1", {
      method: "PATCH",
      body: JSON.stringify({ kill_switch: on }),
      headers: { Prefer: "return=minimal" },
    });
  }
}

/* ---------------------------------------------------------------- mapping */

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function optNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToState(r: Row): BotState {
  return {
    mode: String(r.mode) as Mode,
    symbol: String(r.symbol),
    strategy: String(r.strategy) as StrategyName,
    highWaterMark: num(r.high_water_mark),
    dayKey: String(r.day_key ?? ""),
    dayStartEquity: num(r.day_start_equity),
    consecutiveLosses: Math.trunc(num(r.consecutive_losses)),
    haltedUntil: num(r.halted_until),
    haltReason: String(r.halt_reason ?? ""),
    cooldownUntil: num(r.cooldown_until),
    killSwitch: Boolean(r.kill_switch),
    paperUsdt: num(r.paper_usdt),
    paperBase: num(r.paper_base),
    position: (r.position as Position | null) ?? null,
    entryPrice: optNum(r.entry_price),
    lastTickAt: num(r.last_tick_at),
    lastCandleCloseTime: num(r.last_candle_close_time),
    lockExpiresAt: num(r.lock_expires_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

function stateToRow(s: BotState): Row {
  return {
    id: 1,
    mode: s.mode,
    symbol: s.symbol,
    strategy: s.strategy,
    high_water_mark: s.highWaterMark,
    day_key: s.dayKey,
    day_start_equity: s.dayStartEquity,
    consecutive_losses: s.consecutiveLosses,
    halted_until: s.haltedUntil,
    halt_reason: s.haltReason,
    cooldown_until: s.cooldownUntil,
    kill_switch: s.killSwitch,
    paper_usdt: s.paperUsdt,
    paper_base: s.paperBase,
    position: s.position,
    entry_price: s.entryPrice,
    last_tick_at: s.lastTickAt,
    last_candle_close_time: s.lastCandleCloseTime,
    lock_expires_at: s.lockExpiresAt,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}
