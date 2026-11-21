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
 * The separation is structural rather than a matter of discipline: nothing on
 * the trading path imports this module. Only `status.ts` and `demo.ts` do — the
 * engine, the strategy and the risk rails never see it — and a test asserts
 * exactly that, so a future edit cannot quietly wire the deficit into position
 * sizing. Recovering a deficit with bigger positions is a martingale, and a
 * martingale on a $10 spot account is a scheduled ruin. `npm run catchup`
 * measures how fast.
 */

import { DAY_MS, formatPercent } from "./util/num.ts";

export interface GoalConfig {
  /** Equity the goal line was anchored on. */
  startEquity: number;
  /** Anchor time (ms). Normalised to UTC midnight by the ledger. */
  startDate: number;
  /** USDT per day the line rises. Ignored when `dailyRate` is set. */
  dailyTarget: number;
  /**
   * Optional proportional target instead of a dollar one, e.g. 0.0008 for
   * ~0.08%/day (~34%/yr). A proportional line is self-covering: a loss shrinks
   * the base, so tomorrow's demand shrinks with it. A dollar line is not.
   */
  dailyRate?: number;
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
  /**
   * Days to close the gap if the account compounds at the rate it has actually
   * achieved. Null when the gap never closes at that rate — which is the normal
   * case for a dollar target, see `escapeVelocity`.
   */
  daysToCloseAtAchievedRate: number | null;
  /** Equity at which growth alone out-earns the daily target. */
  escapeVelocity: number;
  /** True when equity is past that threshold, so surplus can compound. */
  aboveEscapeVelocity: boolean;
  /** Years to reach the threshold at the achieved rate. Null if never. */
  yearsToEscapeVelocity: number | null;
  pressure: Pressure;
  /** Set when the goal is proportional (e.g. 5%/day) rather than a dollar amount. */
  dailyRate: number | null;
  /** The rate target as a yearly return, for comparison with measured edges. */
  rateAnnualised: number | null;
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

  // A proportional target compounds off the anchor; a dollar target does not.
  // Both are supported because they answer different questions: "$1 a day" is a
  // promise about time, "5% a day" is a promise about returns — and the second
  // one is only meaningful as a ratio.
  const rateTarget = (cfg.dailyRate ?? 0) > 0;
  const targetEquity = rateTarget
    ? cfg.startEquity * Math.pow(1 + (cfg.dailyRate ?? 0), daysElapsed)
    : cfg.startEquity + cfg.dailyTarget * daysElapsed;

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
  const rateAnnualised = rateTarget ? Math.pow(1 + (cfg.dailyRate ?? 0), 365.25) - 1 : null;

  // The threshold that decides whether a *dollar* target can ever be caught up:
  // growth per day is equity × r, so the line only stops outrunning you once
  // equity × r > dailyTarget.
  const dailyR = achievedCagr !== null ? Math.pow(1 + achievedCagr, 1 / 365.25) - 1 : null;
  const escape = dailyR !== null && dailyR > 0 ? cfg.dailyTarget / dailyR : Infinity;
  const aboveEscape = Number.isFinite(escape) && eq >= escape;
  const yearsToEscape =
    dailyR !== null && dailyR > 0 && eq > 0 && !aboveEscape && achievedCagr !== null
      ? Math.log(escape / eq) / Math.log(1 + achievedCagr)
      : aboveEscape
        ? 0
        : null;

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
    escapeVelocity: escape,
    aboveEscapeVelocity: aboveEscape,
    yearsToEscapeVelocity: yearsToEscape,
    pressure,
    /** Set when the goal is proportional rather than a dollar amount. */
    dailyRate: rateTarget ? (cfg.dailyRate ?? 0) : null,
    /** The rate target expressed as a yearly return, for comparison. */
    rateAnnualised,
    verdict: explain({
      pressure,
      deficit,
      equity: eq,
      achievedPerDay,
      requiredDailyReturn30d,
      daysToCloseAtAchievedRate,
      daysElapsed,
      escape,
      aboveEscape,
      yearsToEscape,
      dailyTarget: cfg.dailyTarget,
      dailyRate: rateTarget ? (cfg.dailyRate ?? 0) : null,
      rateAnnualised,
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
  escape: number;
  aboveEscape: boolean;
  dailyRate?: number | null;
  rateAnnualised?: number | null;
  yearsToEscape: number | null;
  dailyTarget: number;
}): string {
  const money = (x: number) => `$${x.toFixed(2)}`;
  if (ctx.pressure === "ahead") return "ahead of the line — nothing to catch up";
  if (ctx.equity <= 0) return "no equity left; the goal line is moot";

  // A proportional target is a claim about returns, so it is answered in those
  // terms rather than in dollars: the only question is whether the rate exists.
  if (ctx.dailyRate !== null && ctx.dailyRate !== undefined && ctx.dailyRate > 0) {
    const annual = ctx.rateAnnualised ?? Math.pow(1 + ctx.dailyRate, 365.25) - 1;
    if (ctx.deficit > 0) {
      return (
        `target is ${(ctx.dailyRate * 100).toFixed(2)}%/day — ${formatPercent(annual * 100)}/yr compounded — and the ` +
        `account is ${money(ctx.deficit)} behind it. No measured edge reaches that rate ` +
        `(this repo's best is 30%/yr), so the line runs away by design: this is a test harness. ` +
        `Capital is what closes it, not risk.`
      );
    }
    return (
      `ahead of a ${(ctx.dailyRate * 100).toFixed(2)}%/day line (${formatPercent(annual * 100)}/yr compounded) — ` +
      `a rate no strategy here has ever sustained`
    );
  }

  // "The gap is growing" is more useful news than "the target is unreachable",
  // and is usually the reason it is.
  if (ctx.deficit > 0 && ctx.achievedPerDay <= 0) {
    return `behind ${money(ctx.deficit)} and not currently gaining — the gap grows, not shrinks`;
  }

  // The structural fact about a dollar target: below the escape threshold,
  // growth per day is smaller than the daily demand, so the line outruns the
  // account no matter how patient it is.
  if (!ctx.aboveEscape && Number.isFinite(ctx.escape)) {
    const years = ctx.yearsToEscape;
    const when =
      years === null || years > 30
        ? "not within 30 years at the rate achieved so far"
        : years < 1
          ? `about ${Math.round(years * 12)} months at the rate achieved so far`
          : `about ${years.toFixed(0)} years at the rate achieved so far`;
    return (
      `below escape velocity: +$${ctx.dailyTarget}/day needs ${money(ctx.escape)} of equity before ` +
      `growth alone can out-earn the line. Reaching it: ${when}.`
    );
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
    `behind ${money(ctx.deficit)}; compounding at the achieved rate closes it in ` +
    `${Math.round(ctx.daysToCloseAtAchievedRate)} days`
  );
}

/* ------------------------------------------------------------------------- */
/* Covering losses: can a dollar line ever be caught, and how long underwater */
/* ------------------------------------------------------------------------- */

/**
 * Equity at which one day's growth equals the daily target.
 *
 * Below it, the goal line advances faster than the account does, so every loss
 * is permanent and the deficit only widens with time. Above it, the surplus
 * compounds and the line becomes irrelevant. This is the whole arithmetic of
 * "cover the losses later", and it is a property of the balance, not of nerve.
 */
export function escapeVelocity(dailyTarget: number, cagr: number): number {
  if (!(cagr > 0)) return Infinity;
  const dailyRate = Math.pow(1 + cagr, 1 / 365.25) - 1;
  return dailyTarget / dailyRate;
}

/**
 * How long a dollar line takes to be caught up, compounding at `cagr`.
 *
 * Note that a positive compound rate *always* beats a linear line eventually —
 * the honest question is whether "eventually" is inside a human horizon. The
 * default cut-off is 30 years; beyond that the answer is reported as null, and
 * the caller says "not within 30 years" rather than "never".
 */
export function daysToCloseGap(
  cfg: GoalConfig,
  equity: number,
  daysElapsed: number,
  cagr: number | null,
  horizonDays = 10958, // 30 years
): number | null {
  if (cagr === null || !(cagr > 0) || !(equity > 0)) return null;
  const daily = Math.pow(1 + cagr, 1 / 365.25) - 1;
  let eq = equity;
  for (let d = 1; d <= horizonDays; d++) {
    eq *= 1 + daily;
    if (eq >= cfg.startEquity + cfg.dailyTarget * (daysElapsed + d)) return d;
  }
  return null;
}

export interface RecoveryStats {
  /** Share of days spent below a previous peak. */
  daysUnderwaterPct: number;
  /** Distinct drawdown episodes (a new high ends one). */
  episodes: number;
  recoveredWithin30: number;
  recoveredWithin90: number;
  recoveredWithin365: number;
  neverRecovered: number;
  /** Median days from the trough of an episode to the old peak. Null if none. */
  medianRecoveryDays: number | null;
  longestUnderwaterDays: number;
}

/**
 * Did the account actually cover its own losses?
 *
 * Every dip below a previous peak is an episode, and an episode is only
 * "recovered" when the old peak is regained — not when the day is green. This is
 * the empirical answer to "it can continue tomorrow and make the loss back",
 * measured on what the strategy really did rather than on what it should.
 */
export function recoveryStats(
  curve: readonly { ts: number; equity: number }[],
  opts: { minDrawdownPct?: number } = {},
): RecoveryStats {
  // Without a floor, every one-day wobble counts as a drawdown and the median
  // "recovery time" becomes a measure of daily noise. 5% is the smallest dip a
  // person would actually call a loss.
  const minDrawdown = (opts.minDrawdownPct ?? 0) / 100;
  if (curve.length === 0) {
    return {
      daysUnderwaterPct: 0,
      episodes: 0,
      recoveredWithin30: 0,
      recoveredWithin90: 0,
      recoveredWithin365: 0,
      neverRecovered: 0,
      medianRecoveryDays: null,
      longestUnderwaterDays: 0,
    };
  }

  let peak = curve[0].equity;
  let underwater = 0;   // bars at least `minDrawdown` below a previous high
  let deep = 0;
  let troughEquity = peak;
  let troughTs: number | null = null;
  let inEpisode = false;

  let episodes = 0;
  let r30 = 0;
  let r90 = 0;
  let r365 = 0;
  let never = 0;
  let longest = 0;
  const recoveryDays: number[] = [];

  for (const p of curve) {
    if (p.equity >= peak) {
      if (inEpisode && troughTs !== null) {
        episodes++;
        const days = (p.ts - troughTs) / DAY_MS;
        recoveryDays.push(days);
        longest = Math.max(longest, days);
        if (days <= 30) r30++;
        if (days <= 90) r90++;
        if (days <= 365) r365++;
      }
      peak = p.equity;
      troughEquity = peak;
      troughTs = null;
      inEpisode = false;
    } else {
      underwater++;
      if (peak > 0 && (peak - p.equity) / peak >= minDrawdown) deep++;
      if (p.equity < troughEquity) {
        troughEquity = p.equity;
        troughTs = p.ts;
      }
      const deepEnough = peak > 0 && (peak - p.equity) / peak >= minDrawdown;
      if (deepEnough) inEpisode = true;
    }
  }
  if (inEpisode) {
    // Still under water at the end of the record: count it as unrecovered, and
    // measure it from the trough so "how long so far" is honest.
    never++;
    episodes++;
    if (troughTs !== null) longest = Math.max(longest, (curve[curve.length - 1].ts - troughTs) / DAY_MS);
  }

  recoveryDays.sort((a, b) => a - b);
  const mid = recoveryDays.length >> 1;
  return {
    daysUnderwaterPct: (deep / curve.length) * 100,
    episodes,
    recoveredWithin30: r30,
    recoveredWithin90: r90,
    recoveredWithin365: r365,
    neverRecovered: never,
    medianRecoveryDays:
      recoveryDays.length === 0
        ? null
        : recoveryDays.length % 2 === 0
          ? (recoveryDays[mid - 1] + recoveryDays[mid]) / 2
          : recoveryDays[mid],
    longestUnderwaterDays: longest,
  };
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

/**
 * The dollar gap back to a previous balance, and what it costs in return terms.
 *
 * These are two very different numbers and both matter: "you need $12" sounds
 * like one good week, and "+400%" says what that week would have to be. A loss
 * is cheap to describe and expensive to undo, and the second number is the one
 * that should decide anything.
 */
export function shortfallToPeak(
  equity: number,
  peak: number,
): { dollars: number; pct: number; recoverable: boolean } {
  if (!(peak > equity)) return { dollars: 0, pct: 0, recoverable: true };
  const dollars = peak - equity;
  return {
    dollars,
    // Return needed on what is left, i.e. how steep the climb actually is.
    pct: equity > 0 ? (peak / equity - 1) * 100 : Infinity,
    recoverable: equity > 0,
  };
}

/** Expected USDT per day for a given balance at a given compound rate. */
export function expectedPerDay(equity: number, cagr: number): number {
  return (equity * cagr) / 365.25;
}

/** Capital needed to earn `perDay` at `cagr` — the honest answer to "$1/day". */
export function capitalFor(perDay: number, cagr: number): number {
  return cagr <= 0 ? Infinity : (perDay * 365.25) / cagr;
}

/* -------------------------------------------------------------------------- */
/* What the target actually costs                                             */
/* -------------------------------------------------------------------------- */

export interface TargetRow {
  /** Annual return assumed. */
  rate: number;
  label: string;
  /** Capital that would throw off the monthly target at this rate. */
  capitalRequired: number;
  /** How far the current equity is, 0-100. */
  progressPct: number;
  /** Years to get there at the account's own achieved rate. Null if never. */
  yearsToReach: number | null;
}

export interface TargetPlan {
  monthlyTarget: number;
  annualTarget: number;
  equity: number;
  /** What the current equity pays per day at the measured rate, not the wish. */
  paysPerDayNow: number;
  rows: TargetRow[];
  /** One sentence a human can act on. */
  summary: string;
}

/** Rates this repo has measured, best first. Nothing here is aspirational. */
const PLAN_RATES: Array<{ rate: number; label: string }> = [
  { rate: 0.3, label: "30%/yr — best re-measurement" },
  { rate: 0.233, label: "23.3%/yr — measured average" },
  { rate: 0.1, label: "10%/yr — with costs and drawdowns" },
];

/**
 * The honest accounting of a monthly income target.
 *
 * A monthly target is a statement about *capital*, not about effort: at a given
 * return, the income is fixed by equity. So this reports the capital the target
 * needs at each measured rate, how far the account is, and how long its own
 * achieved rate would take to close the gap.
 *
 * Report-only, like the rest of the ledger. It cannot resize a position, and a
 * test asserts that the plan never influences risk.
 */
export function targetPlan(opts: {
  monthlyTarget: number;
  equity: number;
  achievedCagr: number | null;
}): TargetPlan {
  const monthlyTarget = Math.max(0, opts.monthlyTarget);
  const annualTarget = monthlyTarget * 12;
  const equity = Number.isFinite(opts.equity) && opts.equity > 0 ? opts.equity : 0;

  const rows: TargetRow[] = PLAN_RATES.map(({ rate, label }) => {
    const capitalRequired = rate > 0 ? annualTarget / rate : Number.POSITIVE_INFINITY;
    const progressPct = capitalRequired > 0 ? Math.min(100, (equity / capitalRequired) * 100) : 0;
    let yearsToReach: number | null = null;
    if (equity > 0) {
      if (equity >= capitalRequired) yearsToReach = 0;
      else if (opts.achievedCagr !== null && opts.achievedCagr > 0) {
        yearsToReach = Math.log(capitalRequired / equity) / Math.log(1 + opts.achievedCagr);
      }
    }
    return { rate, label, capitalRequired, progressPct, yearsToReach };
  });

  const paysPerDayNow = (equity * PLAN_RATES[1].rate) / 365;
  const base = rows[1];

  const summary =
    monthlyTarget <= 0
      ? "No income target set."
      : equity >= base.capitalRequired
        ? `$${monthlyTarget.toFixed(0)}/month is funded: ${fmtUsd(equity)} at ${(base.rate * 100).toFixed(1)}%/yr pays ${fmtUsd((equity * base.rate) / 12)}/month.`
        : `$${monthlyTarget.toFixed(0)}/month needs ${fmtUsd(base.capitalRequired)} at ${(base.rate * 100).toFixed(1)}%/yr. ` +
          `You hold ${fmtUsd(equity)} (${base.progressPct.toFixed(2)}% of the way), which pays ${fmtUsd(paysPerDayNow)}/day` +
          (base.yearsToReach === null
            ? " — and your achieved rate does not close the gap at all."
            : `; at your achieved rate it takes ${base.yearsToReach < 1 ? "under a year" : `${Math.round(base.yearsToReach)} years`}.`);

  return { monthlyTarget, annualTarget, equity, paysPerDayNow, rows, summary };
}

function fmtUsd(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (Math.abs(x) >= 1000) return `$${Math.round(x).toLocaleString()}`;
  return `$${x.toFixed(2)}`;
}
