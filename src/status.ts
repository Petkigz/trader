/**
 * Status snapshot for the dashboard and the CLI.
 *
 * Everything here is safe to expose: no keys, no secrets, no order payloads.
 */

import type { BotConfig } from "./config.ts";
import { goalStatus, shortfallToPeak, type Pressure } from "./goal.ts";
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
    /** Peak used by the risk rails. Re-based after a circuit breaker. */
    highWaterMark: number;
    drawdownPct: number;
    totalReturnPct: number;
    startEquity: number;
    /** Highest equity ever seen in the recorded curve — never re-based. */
    allTimeHigh: number;
    /** Dollars needed to restore that balance, and the return that implies. */
    dollarsToRegainPeak: number;
    pctToRegainPeak: number;
  };
  /**
   * Can this balance place an order at all? Below the exchange minimum the bot
   * is not paused, it is *stuck*: no signal can be acted on until someone adds
   * capital, and saying so is the difference between waiting and wasting time.
   */
  capital: {
    minNotional: number;
    minTradeableEquity: number;
    belowMinimum: boolean;
    /** Extra equity needed to place one minimum-sized order. */
    shortfall: number;
    message: string;
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
  /** Where the account is against the stated goal, and what it permits. */
  goal: {
    dailyTarget: number;
    daysElapsed: number;
    targetEquity: number;
    deficit: number;
    surplus: number;
    lastDayPnl: number | null;
    achievedPerDay: number;
    pressure: Pressure;
    verdict: string;
    /** Always false: the goal line is reported, it never blocks a trade. */
    entriesBlockedByGoal: false;
  };
  performance: LedgerSummary;
  curve: Array<{ ts: number; equity: number }>;
  recentTrades: TradeRecord[];
  recentTicks: TickRecord[];
  note?: string;
}

/**
 * The goal anchor is the first thing we know about this account: the earliest
 * equity point, else the earliest trade, else now. It is derived rather than
 * stored so that a fresh deployment does not invent a deficit it never had.
 */
function buildGoal(
  cfg: BotConfig,
  equity: number,
  state: { dayStartEquity?: number } | null,
  curve: Array<{ ts: number; equity: number }>,
  now: number,
): StatusSnapshot["goal"] {
  const startDate = curve.length > 0 ? curve[0].ts : now;
  const status = goalStatus(
    { startEquity: cfg.initialPaperUsdt, startDate, dailyTarget: cfg.goalDailyTarget },
    equity,
    now,
  );
  const dayStart = state?.dayStartEquity ?? 0;
  return {
    dailyTarget: cfg.goalDailyTarget,
    daysElapsed: status.daysElapsed,
    targetEquity: round(status.targetEquity, 2),
    deficit: round(status.deficit, 2),
    surplus: round(status.surplus, 2),
    lastDayPnl: dayStart > 0 ? round(equity - dayStart, 4) : null,
    achievedPerDay: round(status.achievedPerDay, 4),
    pressure: status.pressure,
    verdict: status.verdict,
    entriesBlockedByGoal: false,
  };
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

  // The risk rails re-base their peak after a circuit breaker, deliberately, so
  // the bot can resume. That means the rails forget a loss. This one does not:
  // the highest equity in the recorded curve is the balance to restore, and
  // re-basing is exactly the thing that would hide it.
  const allTimeHigh = Math.max(equity, ...curve.map((p) => p.equity), 0);
  const regain = shortfallToPeak(equity, allTimeHigh);

  // One minimum-sized order needs `minNotional / positionFraction` of equity,
  // because the bot never deploys the whole balance in one entry.
  const minNotional = Math.max(cfg.risk.minNotional, 1);
  const minTradeableEquity = minNotional / Math.max(cfg.risk.positionFraction, 0.01);
  const belowMinimum = equity < minTradeableEquity;
  const capitalShortfall = belowMinimum ? minTradeableEquity - equity : 0;
  const entriesBlocked = Boolean(
    (state?.haltedUntil ?? 0) > now ||
      (state?.cooldownUntil ?? 0) > now ||
      state?.killSwitch ||
      cfg.killSwitch ||
      belowMinimum,
  );

  let blockReason = "";
  if (state?.killSwitch || cfg.killSwitch) blockReason = "kill_switch";
  else if ((state?.haltedUntil ?? 0) > now) blockReason = "halted";
  else if ((state?.cooldownUntil ?? 0) > now) blockReason = "cooldown";
  else if (belowMinimum) blockReason = "below_min_notional";

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
      allTimeHigh: round(allTimeHigh, 4),
      dollarsToRegainPeak: round(regain.dollars, 4),
      pctToRegainPeak: Number.isFinite(regain.pct) ? round(regain.pct, 2) : Number.POSITIVE_INFINITY,
    },
    capital: {
      minNotional,
      minTradeableEquity: round(minTradeableEquity, 2),
      belowMinimum,
      shortfall: round(capitalShortfall, 2),
      message: belowMinimum
        ? `below the exchange minimum: ${round(equity, 2)} USDT cannot place a ${minNotional} USDT order. ` +
          `Needs ${round(capitalShortfall, 2)} more to trade again — no signal can be acted on until then.`
        : "above the exchange minimum",
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
    goal: buildGoal(cfg, equity, state, curve, now),
    performance: summariseTrades(trades),
    curve: curve.map((p) => ({ ts: p.ts, equity: round(p.equity, 4) })),
    recentTrades: trades.slice(0, 25),
    recentTicks: ticks.slice(0, 12),
  };
}
