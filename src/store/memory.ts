import type { BotState, TickRecord, TradeRecord } from "../types.ts";
import type { Store } from "./types.ts";

/** In-process store. Used by tests, the backtester and credential-free local runs. */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;

  private state: BotState | null = null;
  private lockExpiresAt = 0;
  private trades: TradeRecord[] = [];
  private ticks: TickRecord[] = [];

  async acquireLock(ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    if (this.lockExpiresAt > now) return false;
    this.lockExpiresAt = now + ttlSeconds * 1000;
    return true;
  }

  async releaseLock(): Promise<void> {
    this.lockExpiresAt = 0;
  }

  async getState(): Promise<BotState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async saveState(state: BotState): Promise<void> {
    this.state = structuredClone(state);
  }

  async recordTrade(trade: TradeRecord): Promise<void> {
    this.trades.push({ ...trade });
  }

  async recordTick(tick: TickRecord): Promise<void> {
    this.ticks.push({ ...tick });
  }

  async recentTrades(limit: number): Promise<TradeRecord[]> {
    return this.trades.slice(-limit).reverse().map((t) => ({ ...t }));
  }

  async recentTicks(limit: number): Promise<TickRecord[]> {
    return this.ticks.slice(-limit).reverse().map((t) => ({ ...t }));
  }

  async equityHistory(limit: number): Promise<Array<{ ts: number; equity: number }>> {
    return this.ticks.slice(-limit).map((t) => ({ ts: t.ts, equity: t.equity }));
  }

  async setKillSwitch(on: boolean): Promise<void> {
    if (this.state) this.state.killSwitch = on;
  }
}
