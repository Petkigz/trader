/**
 * Status snapshot for the dashboard and the CLI.
 *
 * Everything here is safe to expose: no keys, no secrets, no order payloads.
 */

import type { BotConfig } from "./config.ts";
import { summariseTrades, type LedgerSummary } from "./ledger.ts";
import type { Store } from "./store/types.ts";
import type { BotState, TickRecord, TradeRecord } from "./types.ts";
import { round } from "./util/num.ts";

export interface StatusSnapshot {
  ok: boolean;
  generatedAt: number;
  bot: {
    mode: string;
    strategy: string;
    symbol: string;
    exchange: string;
    feesPerSide: string;
    updatedAt: number;
    lastTickAt: number;
    lastTickAgeMinutes: number | null;
  };
  account: {
    equity: number;
    cash: number;
    highWaterMark: number;
    drawdownPct: number;
    totalReturnPct: number;
    startEquity: number;
  };
  position: {
    open: boolean;
    symbol: string;
    qty: number;
    entryPrice: number;
    markPrice: number;
    notional: number;
    unrealizedPnl: number;
    unrealizedPct: number;
    stopPrice: number | null;
    targetPrice: number | null;
    heldHours: number;
  } | null;
  risk: {
    entriesBlocked: boolean;
    frozen: boolean;
    blockReason: string;
    haltedUntil: number;
    haltReason: string;
    cooldownUntil: number;
    consecutiveLosses: number;
    killSwitch: boolean;
  };
  performance: LedgerSummary;
  curve: Array<{ ts: number; equity: number }>;
  recentTrades: TradeRecord[];
  recentTicks: TickRecord[];
  note?: string;
}

export async function buildStatus(cfg: BotConfig, store: Store, now = Date.now()): Promise<StatusSnapshot> {
  const [state, trades, ticks, curve] = await Promise.all([
    store.getState().catch(() => null),
    store.recentTrades(100).catch(() => [] as TradeRecord[]),
    store.recentTicks(30).catch(() => [] as TickRecord[]),
    store.equityHistory(500).catch(() => []),
  ]);

  const latestTick = ticks[0];
  const equity = latestTick?.equity ?? state?.paperUsdt ?? 0;
  const markPrice = latestTick?.price ?? 0;
  const position = state?.position ?? null;

  const startEquity = cfg.initialPaperUsdt;
  const hwm = state?.highWaterMark ?? equity;
  const entriesBlocked = Boolean(
    (state?.haltedUntil ?? 0) > now || (state?.cooldownUntil ?? 0) > now || state?.killSwitch || cfg.killSwitch,
  );

  let blockReason = "";
  if (state?.killSwitch || cfg.killSwitch) blockReason = "kill_switch";
  else if ((state?.haltedUntil ?? 0) > now) blockReason = "halted";
  else if ((state?.cooldownUntil ?? 0) > now) blockReason = "cooldown";

  return {
    ok: true,
    generatedAt: now,
    bot: {
      mode: cfg.mode,
      strategy: cfg.strategy,
      symbol: cfg.symbol,
      exchange: cfg.exchangeId,
      feesPerSide: `${(cfg.feeRate * 100).toFixed(3)}% + ${cfg.slippageBps}bps slippage`,
      updatedAt: state?.updatedAt ?? 0,
      lastTickAt: state?.lastTickAt ?? 0,
      lastTickAgeMinutes: state?.lastTickAt ? round((now - state.lastTickAt) / 60_000, 1) : null,
    },
    account: {
      equity: round(equity, 4),
      // Cash is derived: equity minus what the open position is worth.
      cash: round(equity - (position ? position.qty * markPrice : 0), 4),
      highWaterMark: round(hwm, 4),
      drawdownPct: hwm > 0 ? round(((hwm - equity) / hwm) * 100, 2) : 0,
      totalReturnPct: startEquity > 0 ? round(((equity - startEquity) / startEquity) * 100, 2) : 0,
      startEquity,
    },
    position:
      position && position.qty > 0
        ? {
            open: true,
            symbol: position.symbol,
            qty: position.qty,
            entryPrice: round(position.entryPrice, 2),
            markPrice: round(markPrice, 2),
            notional: round(position.qty * markPrice, 4),
            unrealizedPnl: round(position.qty * (markPrice - position.entryPrice), 4),
            unrealizedPct: position.entryPrice > 0 ? round(((markPrice - position.entryPrice) / position.entryPrice) * 100, 2) : 0,
            stopPrice: position.stopPrice,
            targetPrice: position.targetPrice,
            heldHours: round((now - position.entryAt) / 3_600_000, 1),
          }
        : null,
    risk: {
      entriesBlocked,
      frozen: (state?.haltedUntil ?? 0) > now,
      blockReason,
      haltedUntil: state?.haltedUntil ?? 0,
      haltReason: state?.haltReason ?? "",
      cooldownUntil: state?.cooldownUntil ?? 0,
      consecutiveLosses: state?.consecutiveLosses ?? 0,
      killSwitch: Boolean(state?.killSwitch || cfg.killSwitch),
    },
    performance: summariseTrades(trades),
    curve: curve.map((p) => ({ ts: p.ts, equity: round(p.equity, 4) })),
    recentTrades: trades.slice(0, 25),
    recentTicks: ticks.slice(0, 12),
  };
}
