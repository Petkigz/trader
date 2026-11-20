import type { BotState, TickRecord, TradeRecord } from "../types.ts";

/**
 * Storage contract.
 *
 * Two implementations: `MemoryStore` for local runs and tests, and
 * `SupabaseStore` for the deployed bot. The engine only ever sees this
 * interface, so it does not care where state lives.
 */
export interface Store {
  readonly kind: "memory" | "supabase";

  /**
   * Claim the right to run a tick. Must be atomic — two schedulers firing at
   * the same second must not both place an order.
   */
  acquireLock(ttlSeconds: number): Promise<boolean>;
  releaseLock(): Promise<void>;

  getState(): Promise<BotState | null>;
  saveState(state: BotState): Promise<void>;

  recordTrade(trade: TradeRecord): Promise<void>;
  recordTick(tick: TickRecord): Promise<void>;

  recentTrades(limit: number): Promise<TradeRecord[]>;
  recentTicks(limit: number): Promise<TickRecord[]>;
  equityHistory(limit: number): Promise<Array<{ ts: number; equity: number }>>;
  setKillSwitch(on: boolean): Promise<void>;
}
