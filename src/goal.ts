/**
 * Goal ledger: where the account is against the goal line, and what that
 * permits.
 *
 * The goal line is deliberately linear, not compounding:
 *
 *   targetEquity = startEquity + dailyTarget * daysElapsed
 *
 * A daily target is a promise about *time*, not about *returns*. Writing it as
 * "1.05^days" would quietly turn a $1/day goal into a demand for a ~4,000%/yr
 * compound return, which is the sort of arithmetic that makes people increase
 * position size until the account is gone.
 *
 * The division of labour in this module is the whole point:
 *
 *   - the ledger is allowed to change what we *know* and what we *report*;
 *   - it is never allowed to change how much is risked per trade.
 *
 * `plannedRiskMultiplier` returns 1 unconditionally. That is not an oversight;
 * a test asserts it. Recovering a deficit with bigger positions is a martingale,
 * and a martingale on a $10 spot account is a scheduled ruin. `npm run catchup`
 * measures exactly how fast.
 */

import { DAY_MS } from "./util/num.ts";

export interface GoalConfig {
  /** Equity the goal line was anchored on. */
  startEquity: number;
  /** Anchor time (ms). Normalised to UTC midnight by the ledger. */
  startDate: number;
  /** USDT per day the line rises. */
  dailyTarget: number;
}

export type Pressure = "ahead" | "on-track" | "behind" | "deep-behind" | "unreachable";

export interface GoalStatus {
  daysElapsed: number;
  /** Equity the goal line demands today. */
  targetEquity: number;
  equity: number;
  /** targetEquity - equity, floored at 0. */
  deficit: number;
  /** equity - targetEquity, floored at 0. */
  surplus: number;
  /** Most recent day's change in equity, when the caller supplies it. */
  lastDayPnl: number | null;
  /** Average USDT gained per day since the anchor. Negative means losing. */
  achievedPerDay: number;
  /** Realised compound rate since the anchor, annualised. Null when too short. */
  achievedCagr: number | null;
  /** Required daily return over the next 30 days to close the gap. Null if no gap. */
  requiredDailyReturn30d: number | null;
  /** Days to close the gap at the achieved rate. Null when never / no gap. */
  daysToCloseAtAchievedRate: number | null;
  pressure: Pressure;
  /** Plain-language read on the arithmetic, for the dashboard. */
  verdict: string;
}

export function utcMidnight(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Where the account stands against the goal line.
 *
 * `lastDayPnl` is optional; when supplied the status carries it so the
 * dashboard can say "lost $0.90 today" next to "deficit $12.40".
 */
export function goalStatus(
  cfg: GoalConfig,
  equity: number,
  now: number,
  lastDayPnl: number | null = null,
): GoalStatus {
  const start = utcMidnight(cfg.startDate);
  const today = utcMidnight(now);
  const daysElapsed = Math.max(0, Math.round((today - start) / DAY_MS));
  const targetEquity = cfg.startEquity + cfg.dailyTarget * daysElapsed;

  const eq = Number.isFinite(equity) ? equity : 0;
  const deficit = Math.max(0, targetEquity - eq);
  const surplus = Math.max(0, eq - targetEquity);

  const gained = eq - cfg.startEquity;
  const achievedPerDay = daysElapsed > 0 ? gained / daysElapsed : 0;

  const achievedCagr =
    daysElapsed >= 30 && cfg.startEquity > 0 && eq > 0
      ? Math.pow(eq / cfg.startEquity, 365.25 / daysElapsed) - 1
      : null;

  const requiredDailyReturn30d = deficit > 0 && eq > 0 ? deficit / (eq * 30) : null;
  const daysToCloseAtAchievedRate =
    deficit > 0 && achievedPerDay > 0 ? deficit / achievedPerDay : deficit > 0 ? null : 0;

  const pressure = classify(deficit, surplus, eq, requiredDailyReturn30d);

  return {
    daysElapsed,
    targetEquity,
    equity: eq,
    deficit,
    surplus,
    lastDayPnl,
    achievedPerDay,
    achievedCagr,
    requiredDailyReturn30d,
    daysToCloseAtAchievedRate,
    pressure,
    verdict: explain({
      pressure,
      deficit,
      equity: eq,
      achievedPerDay,
      requiredDailyReturn30d,
      daysToCloseAtAchievedRate,
      daysElapsed,
    }),
  };
}

/**
 * The fastest compound rate any of this is allowed to call plausible: 100%/yr.
 *
 * Beyond that, "behind" stops being a description of the account and becomes a
 * description of a wish. Real strategies here measure 30%/yr on the full window
 * and roughly flat since 2024, so 100% is already generous.
 */
export const MAX_CREDIBLE_CAGR = 1.0;

function classify(
  deficit: number,
  surplus: number,
  equity: number,
  required30d: number | null,
): Pressure {
  if (deficit <= 0 && surplus > 0) return "ahead";
  if (equity <= 0) return "unreachable";
  // A gap whose required rate is not survivable is not "behind", it is
  // arithmetic telling you the target is wrong for this balance.
  if (required30d !== null && required30d * 365.25 > MAX_CREDIBLE_CAGR) {
    return "unreachable";
  }
  const ratio = deficit / equity;
  if (ratio <= 0.05) return "on-track";
  if (ratio <= 0.5) return "behind";
  return "deep-behind";
}

function explain(ctx: {
  pressure: Pressure;
  deficit: number;
  equity: number;
  achievedPerDay: number;
  requiredDailyReturn30d: number | null;
  daysToCloseAtAchievedRate: number | null;
  daysElapsed: number;
}): string {
  const money = (x: number) => `$${x.toFixed(2)}`;
  if (ctx.pressure === "ahead") {
    return `ahead of the line — nothing to catch up`;
  }
  if (ctx.equity <= 0) return "no equity left; the goal line is moot";
  // Report the direction of travel first: "the gap is growing" is more useful
  // news than "the target is unreachable", and often the reason it is.
  if (ctx.deficit > 0 && ctx.achievedPerDay <= 0) {
    return `behind ${money(ctx.deficit)} and not currently gaining — the gap grows, not shrinks`;
  }
  if (ctx.pressure === "unreachable") {
    const r = ctx.requiredDailyReturn30d ?? 0;
    return (
      `needs ${(r * 100).toFixed(1)}%/day for a month to close ${money(ctx.deficit)} — ` +
      `that is not a strategy, it is a lottery ticket. Target is wrong for this balance.`
    );
  }
  if (ctx.daysToCloseAtAchievedRate === null) {
    return `behind ${money(ctx.deficit)}`;
  }
  return (
    `behind ${money(ctx.deficit)}; at the rate achieved so far that is ` +
    `${Math.round(ctx.daysToCloseAtAchievedRate)} more days`
  );
}

/* ------------------------------------------------------------------------- */
/* Participation: opportunities decide, the goal line does not               */
/* ------------------------------------------------------------------------- */

export interface ParticipationInput {
  status: GoalStatus;
  /** Is there a signal right now that the strategy wants to act on? */
  opportunity: boolean;
  /** Risk rails already say no (halt, kill switch, drawdown). */
  entriesBlocked: boolean;
  /** Already holding the only position this bot takes. */
  inPosition: boolean;
}

export interface ParticipationDecision {
  allow: boolean;
  /** Always 1. Present so callers cannot quietly multiply risk by deficit. */
  riskMultiplier: 1;
  reason: string;
}

/**
 * Should the bot take this entry?
 *
 * Note what is absent: there is no branch on `status.deficit`, and none on
 * `surplus`. Being behind does not buy a bigger position and being ahead does
 * not earn a day off. The goal line is information; the signal and the risk
 * rails are the decision.
 */
export function planParticipation(input: ParticipationInput): ParticipationDecision {
  const deny = (reason: string): ParticipationDecision => ({ allow: false, riskMultiplier: 1, reason });
  if (input.entriesBlocked) return deny("risk rails are blocking entries");
  if (input.inPosition) return deny("already positioned");
  if (!input.opportunity) return deny("no signal; waiting for an opportunity, not for a quota");
  return {
    allow: true,
    riskMultiplier: 1,
    reason: `signal present — taking it (${input.status.pressure})`,
  };
}

/**
 * The cap on catch-up sizing, for research use.
 *
 * Production never calls this. It exists so the experiment can state its own
 * assumption in one place: whatever multiple the deficit "deserves", this bot
 * has no leverage, so the position is bounded by cash anyway.
 */
export function chaseMultiplier(deficit: number, equity: number, cap: number): number {
  if (!(equity > 0) || deficit <= 0) return 1;
  return Math.min(cap, 1 + deficit / equity);
}

/** Expected USDT per day for a given balance at a given compound rate. */
export function expectedPerDay(equity: number, cagr: number): number {
  return (equity * cagr) / 365.25;
}

/** Capital needed to earn `perDay` at `cagr` — the honest answer to "$1/day". */
export function capitalFor(perDay: number, cagr: number): number {
  return cagr <= 0 ? Infinity : (perDay * 365.25) / cagr;
}
