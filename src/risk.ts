/**
 * Risk manager.
 *
 * This is the part that makes "runs forever without me" defensible. Every
 * rule below degrades the bot gracefully instead of killing it, because a bot
 * that stops permanently has failed the core requirement:
 *
 *   drawdown > MAX_DRAWDOWN  -> pause for HALT_DAYS, then re-base the peak
 *                               and resume at normal size ("circuit breaker")
 *   daily loss > MAX_DAILY_LOSS -> pause until the next UTC day
 *   consecutive losers >= N  -> pause for HALT_DAYS
 *   KILL_SWITCH=true         -> block new entries, still allow exits
 *
 * All functions are pure: they take state and return new state plus the
 * reasons why, which are written to the audit log.
 */

import type { BotConfig } from "./config.ts";
import type { BotState, SymbolInfo } from "./types.ts";
import { DAY_MS, floorToStep, utcDayKey } from "./util/num.ts";

export interface RiskOutcome {
  state: BotState;
  /** True when new entries are forbidden right now. */
  entriesBlocked: boolean;
  /** Machine tag explaining a block, empty when not blocked. */
  blockReason: string;
  /** Human-readable notes for the audit log. */
  events: string[];
  drawdown: number;
  dailyLoss: number;
}

/**
 * Bring risk bookkeeping up to date for `now` and `equity`.
 * Call once per tick, before deciding anything.
 */
export function refreshRisk(state: BotState, equity: number, now: number, cfg: BotConfig): RiskOutcome {
  const s: BotState = { ...state };
  const events: string[] = [];

  const day = utcDayKey(now);
  if (s.dayKey !== day) {
    s.dayKey = day;
    s.dayStartEquity = equity;
    if (s.dayStartEquity <= 0) s.dayStartEquity = equity;
  }
  if (!(s.dayStartEquity > 0)) s.dayStartEquity = equity > 0 ? equity : cfg.initialPaperUsdt;

  if (!(s.highWaterMark > 0)) {
    // Seed from the real balance, not from the configured starting capital:
    // a user who funds $4 must not be treated as already 60% down.
    s.highWaterMark = equity > 0 ? equity : cfg.initialPaperUsdt;
  } else if (equity > s.highWaterMark) {
    s.highWaterMark = equity;
  }

  // Expire time-based halts.
  if (s.haltedUntil > 0 && now >= s.haltedUntil) {
    events.push(`halt expired (was: ${s.haltReason || "unknown"}) — resuming`);
    s.haltedUntil = 0;
    s.haltReason = "";
  }

  const drawdown = s.highWaterMark > 0 ? (s.highWaterMark - equity) / s.highWaterMark : 0;
  const dailyLoss = s.dayStartEquity > 0 ? (s.dayStartEquity - equity) / s.dayStartEquity : 0;

  // Circuit breaker: deep drawdown -> stand down, then re-base and resume.
  if (drawdown >= cfg.risk.maxDrawdown && s.haltedUntil <= now) {
    s.haltedUntil = now + cfg.risk.haltDays * DAY_MS;
    s.haltReason = `drawdown ${(drawdown * 100).toFixed(1)}% >= ${(cfg.risk.maxDrawdown * 100).toFixed(0)}%`;
    // Re-base the peak so the bot can actually resume after the cool-off
    // instead of instantly re-tripping and staying dormant forever.
    s.highWaterMark = Math.max(equity, 1e-9);
    events.push(`CIRCUIT BREAKER: ${s.haltReason} — paused ${cfg.risk.haltDays}d and re-based peak to ${equity.toFixed(2)}`);
  } else if (dailyLoss >= cfg.risk.maxDailyLoss && s.haltedUntil <= now) {
    s.haltedUntil = nextUtcMidnight(now);
    s.haltReason = `daily loss ${(dailyLoss * 100).toFixed(1)}% >= ${(cfg.risk.maxDailyLoss * 100).toFixed(0)}%`;
    events.push(`DAILY STOP: ${s.haltReason} — paused until 00:00 UTC`);
  }

  let entriesBlocked = false;
  let blockReason = "";

  if (cfg.killSwitch || s.killSwitch) {
    entriesBlocked = true;
    blockReason = "kill_switch";
  } else if (s.haltedUntil > now) {
    entriesBlocked = true;
    blockReason = "halted";
  } else if (s.cooldownUntil > now) {
    entriesBlocked = true;
    blockReason = "cooldown";
  } else if (!(equity > 0)) {
    entriesBlocked = true;
    blockReason = "no_equity";
  }

  return { state: s, entriesBlocked, blockReason, events, drawdown, dailyLoss };
}

/** Apply the after-effects of a closed round trip. */
export function applyTradeOutcome(
  state: BotState,
  realizedPnl: number,
  now: number,
  cfg: BotConfig,
): { state: BotState; events: string[] } {
  const s: BotState = { ...state };
  const events: string[] = [];

  if (realizedPnl < 0) {
    s.consecutiveLosses += 1;
    if (s.consecutiveLosses >= cfg.risk.maxConsecutiveLosses && s.haltedUntil <= now) {
      s.haltedUntil = now + cfg.risk.haltDays * DAY_MS;
      s.haltReason = `${s.consecutiveLosses} consecutive losing trades`;
      s.consecutiveLosses = 0;
      events.push(`STREAK STOP: ${s.haltReason} — paused ${cfg.risk.haltDays}d`);
    }
  } else {
    s.consecutiveLosses = 0;
  }

  s.cooldownUntil = now + cfg.risk.cooldownHours * 3_600_000;
  return { state: s, events };
}

export interface SizingResult {
  ok: boolean;
  reason: string;
  /** Quote currency to spend. */
  notional: number;
  /** Base quantity to buy after rounding to the exchange step. */
  qty: number;
}

/**
 * Size a new position. This is where a $10 account actually meets exchange
 * reality: Binance rejects anything under 5 USDT notional, so we round *down*
 * to the step and refuse to send an order we know will be refused.
 */
export function sizePosition(
  cash: number,
  price: number,
  info: SymbolInfo,
  cfg: BotConfig,
  /**
   * Fraction of cash to commit, overriding `cfg.risk.positionFraction`.
   * Supplied by the adaptive layer; omitted means use the static setting.
   */
  fractionOverride?: number,
): SizingResult {
  const frac =
    fractionOverride !== undefined && Number.isFinite(fractionOverride)
      ? Math.min(Math.max(fractionOverride, 0), 1)
      : cfg.risk.positionFraction;
  const equitySlice = cash * frac;
  const notional = floorToStep(equitySlice, 0.01);
  const minNotional = Math.max(info.minNotional, 1);

  if (!(price > 0)) return { ok: false, reason: "no_price", notional: 0, qty: 0 };
  if (notional < minNotional) {
    return { ok: false, reason: "below_min_notional", notional, qty: 0 };
  }

  const qty = floorToStep(notional / price, info.stepSize);
  if (!(qty > 0) || qty < info.minQty) {
    return { ok: false, reason: "below_min_qty", notional, qty: 0 };
  }
  if (qty * price < minNotional) {
    return { ok: false, reason: "below_min_notional", notional, qty: 0 };
  }

  return { ok: true, reason: "ok", notional: qty * price, qty };
}

/** Realised PnL of a sell, net of both fees. */
export function realizedPnl(sell: { quoteQty: number; feeQuote: number }, costBasisQuote: number): number {
  return sell.quoteQty - sell.feeQuote - costBasisQuote;
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}
