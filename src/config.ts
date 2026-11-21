/**
 * Configuration.
 *
 * Every knob is an environment variable with a safe default, so the bot is
 * fully operational with an empty environment (paper mode, $10, BTCUSDT,
 * daily trend strategy). Nothing here throws at import time; `loadConfig`
 * validates eagerly and loudly instead.
 */

import type { ExchangeId, Interval, Mode, StrategyName } from "./types.ts";
import { formatPercent } from "./util/num.ts";

export interface TrendParams {
  /** EMA length on the daily chart. */
  emaPeriod: number;
  /** Buy only once price is this far above the EMA (fraction). */
  entryBuffer: number;
  /** Sell once price is this far below the EMA (fraction). */
  exitBuffer: number;
  /** Catastrophic stop: never let a single position lose more than this. */
  crashStopPct: number;
}

export interface PullbackParams {
  rsiPeriod: number;
  oversold: number;
  atrPeriod: number;
  /** Minimum take-profit distance (fraction). */
  tpPct: number;
  tpAtrMult: number;
  /** Minimum stop distance (fraction). */
  slPct: number;
  slAtrMult: number;
  maxHoldHours: number;
}

export interface RiskParams {
  positionFraction: number;
  maxDrawdown: number;
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  haltDays: number;
  cooldownHours: number;
  /** Exchange minimum order size, used to report whether trading is possible. */
  minNotional: number;
}

/**
 * Adaptive sizing (see `src/strategy/adaptive.ts`). Off by default so the
 * documented backtest stays exactly reproducible; switch on with
 * `ADAPTIVE_SIZING=1` and compare with `npm run backtest`.
 */
export interface AdaptiveParams {
  enabled: boolean;
  /** Annualised volatility to target, e.g. 0.40. */
  targetVol: number;
  /** Days used to measure current volatility. */
  volWindow: number;
  /** Days used as the longer-run reference. */
  baselineWindow: number;
  /** Never shrink below this multiple of the configured fraction. */
  minScale: number;
  /** Never grow beyond this multiple. Defaults to 1 — adaptation only de-risks. */
  maxScale: number;
  /** Recent vol / baseline vol at which the market is considered a storm. */
  stormMultiple: number;
  /** Extra size cut applied in a storm. */
  stormScale: number;
  /** Recent vol / baseline vol below which the market is considered calm. */
  calmMultiple: number;
}

/**
 * Ensemble settings: regime classification plus competition between the trend
 * and mean-reversion families (`src/strategy/ensemble.ts`).
 */
export interface EnsembleParams {
  /** Trailing bars of virtual history used to rank the families. */
  scoreWindow: number;
  /** RSI period for the mean-reversion family. */
  rsiPeriod: number;
  /** RSI at or below which a dip is bought. */
  rsiEntry: number;
  /** RSI at or above which the reversion is taken. */
  rsiExit: number;
  /** Take cash during a volatility storm, regardless of scores. */
  stormBlocksEntries: boolean;
}

export interface BotConfig {
  mode: Mode;
  strategy: StrategyName;
  exchangeId: ExchangeId;
  symbol: string;
  interval: Interval;
  candleLimit: number;

  exchange: {
    baseUrl: string;
    apiKey: string;
    apiSecret: string;
  };

  /** Taker fee per side used by the paper simulator. */
  feeRate: number;
  /** Extra adverse bps applied to paper fills so results are not flattering. */
  slippageBps: number;

  risk: RiskParams;
  adaptive: AdaptiveParams;
  ensemble: EnsembleParams;
  trend: TrendParams;
  pullback: PullbackParams;

  store: {
    supabaseUrl: string;
    serviceRoleKey: string;
  };

  notifications: {
    telegramToken: string;
    telegramChatId: string;
  };

  security: {
    cronSecret: string;
    dashboardToken: string;
  };

  killSwitch: boolean;
  initialPaperUsdt: number;
  /**
   * Allow the unauthenticated `/api/backtest` in paper mode.
   *
   * Off by default: the endpoint downloads years of candles from the exchange
   * and simulates them, which is expensive, rate-limited upstream, and cheap to
   * abuse by anyone who finds the URL. Turn it on for a demo, or set
   * DASHBOARD_TOKEN and use that instead.
   */
  publicBacktest: boolean;
  /**
   * The stated goal, USDT per day. Reported against, never traded toward:
   * see src/goal.ts for why the ledger cannot be allowed to size positions.
   */
  goalDailyTarget: number;
  /** Monthly income target in USDT, 0 when unset. Overrides `goalDailyTarget`. */
  goalMonthlyTarget: number;
  /**
   * Proportional target, 0.05 = "5% a day". Overrides both of the above, and is
   * the only way to express a target as a rate rather than a dollar figure.
   */
  goalDailyRate: number;
  /** Symbol the tick lock is scoped to (defaults to symbol). */
  logLevel: "debug" | "info" | "warn" | "error";
}

export type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${key} must be a number, got "${raw}"`);
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`env ${key} must be a boolean, got "${raw}"`);
}

function str(env: Env, key: string, fallback = ""): string {
  const raw = env[key];
  return raw === undefined ? fallback : raw.trim();
}

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = str(env, key).toLowerCase();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`env ${key} must be one of ${allowed.join("|")}, got "${raw}"`);
  }
  return raw as T;
}

/**
 * The ceiling above which a target stops being ambitious and becomes fictional:
 * 0.5%/day is ~250%/yr. Everything in this repo measures below 31%/yr, and the
 * best long-run fund in history is ~66%/yr.
 */
export const MAX_PLAUSIBLE_DAILY_RATE = 0.005;

export function loadConfig(env: Env = process.env): BotConfig {
  const mode = oneOf(env, "BOT_MODE", ["paper", "live"] as const, "paper");
  /** Monthly income target, 0 when unset. GOAL_DAILY_TARGET is the fallback. */
  const goalMonthly = num(env, "GOAL_MONTHLY_TARGET", 0);
  /**
   * Proportional target, e.g. 0.05 for "5% a day". Highest precedence: it is the
   * only form in which a rate like 5%/day can be stated, since as a dollar
   * target it would depend on the balance it is measured against.
   */
  const goalDailyRate = num(env, "GOAL_DAILY_RATE", 0);
  const strategy = oneOf(env, "STRATEGY", ["trend", "pullback", "meanrev", "ensemble"] as const, "trend");

  const cfg: BotConfig = {
    mode,
    strategy,
    exchangeId: "binance",
    symbol: str(env, "SYMBOL", "BTCUSDT").toUpperCase(),
    interval: strategy === "pullback" ? "1h" : "1d",
    candleLimit: 1000,

    exchange: {
      baseUrl: str(env, "BINANCE_BASE_URL", "https://api.binance.com").replace(/\/+$/, ""),
      apiKey: str(env, "BINANCE_API_KEY"),
      apiSecret: str(env, "BINANCE_API_SECRET"),
    },

    feeRate: num(env, "FEE_RATE", 0.001),
    slippageBps: num(env, "SLIPPAGE_BPS", 2),

    risk: {
      positionFraction: num(env, "POSITION_FRACTION", 0.97),
      maxDrawdown: num(env, "MAX_DRAWDOWN", 0.3),
      maxDailyLoss: num(env, "MAX_DAILY_LOSS", 0.08),
      maxConsecutiveLosses: num(env, "MAX_CONSECUTIVE_LOSSES", 5),
      haltDays: num(env, "HALT_DAYS", 7),
      cooldownHours: num(env, "COOLDOWN_HOURS", 4),
      /**
       * Exchange minimum order size, used for *reporting* whether the balance
       * can trade at all. Real orders use the exchange's live symbol info; this
       * is the number the status page reasons about, and it is configurable so
       * it can match a venue that is stricter.
       */
      minNotional: num(env, "MIN_NOTIONAL", 5),
    },

    adaptive: {
      enabled: bool(env, "ADAPTIVE_SIZING", false),
      targetVol: num(env, "TARGET_VOL", 0.4),
      volWindow: num(env, "VOL_WINDOW", 20),
      baselineWindow: num(env, "VOL_BASELINE_WINDOW", 200),
      minScale: num(env, "ADAPTIVE_MIN_SCALE", 0.25),
      maxScale: num(env, "ADAPTIVE_MAX_SCALE", 1),
      stormMultiple: num(env, "STORM_VOL_MULTIPLE", 2),
      stormScale: num(env, "STORM_SCALE", 0.5),
      calmMultiple: num(env, "CALM_VOL_MULTIPLE", 0.7),
    },

    ensemble: {
      scoreWindow: num(env, "ENSEMBLE_SCORE_WINDOW", 120),
      rsiPeriod: num(env, "ENSEMBLE_RSI_PERIOD", 14),
      rsiEntry: num(env, "ENSEMBLE_RSI_ENTRY", 35),
      rsiExit: num(env, "ENSEMBLE_RSI_EXIT", 55),
      stormBlocksEntries: bool(env, "ENSEMBLE_STORM_BLOCKS", true),
    },

    trend: {
      emaPeriod: num(env, "TREND_EMA_PERIOD", 200),
      entryBuffer: num(env, "TREND_ENTRY_BUFFER", 0.005),
      exitBuffer: num(env, "TREND_EXIT_BUFFER", 0.005),
      crashStopPct: num(env, "TREND_CRASH_STOP", 0.25),
    },

    pullback: {
      rsiPeriod: num(env, "PULLBACK_RSI_PERIOD", 14),
      oversold: num(env, "PULLBACK_OVERSOLD", 30),
      atrPeriod: num(env, "PULLBACK_ATR_PERIOD", 14),
      tpPct: num(env, "PULLBACK_TP_PCT", 0.02),
      tpAtrMult: num(env, "PULLBACK_TP_ATR_MULT", 1.0),
      slPct: num(env, "PULLBACK_SL_PCT", 0.03),
      slAtrMult: num(env, "PULLBACK_SL_ATR_MULT", 1.5),
      maxHoldHours: num(env, "PULLBACK_MAX_HOLD_HOURS", 72),
    },

    store: {
      supabaseUrl: str(env, "SUPABASE_URL").replace(/\/+$/, ""),
      serviceRoleKey: str(env, "SUPABASE_SERVICE_ROLE_KEY"),
    },

    notifications: {
      telegramToken: str(env, "TELEGRAM_BOT_TOKEN"),
      telegramChatId: str(env, "TELEGRAM_CHAT_ID"),
    },

    security: {
      cronSecret: str(env, "CRON_SECRET"),
      dashboardToken: str(env, "DASHBOARD_TOKEN"),
    },

    killSwitch: bool(env, "KILL_SWITCH", false),
    initialPaperUsdt: num(env, "PAPER_START_USDT", 10),
    publicBacktest: bool(env, "PUBLIC_BACKTEST", false),
    goalDailyTarget: goalMonthly > 0 ? goalMonthly / 30 : num(env, "GOAL_DAILY_TARGET", 1),
    /**
     * Monthly income target. When set it wins over GOAL_DAILY_TARGET, because
     * "I want $300/month" is a statement a person makes about a month, and
     * silently converting it to a different daily number is how targets drift.
     */
    goalMonthlyTarget: goalMonthly,
    goalDailyRate,
    logLevel: oneOf(env, "LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  };

  if (cfg.goalMonthlyTarget < 0) {
    throw new Error("env GOAL_MONTHLY_TARGET must be zero (unset) or positive");
  }
  if (!(cfg.goalDailyRate >= 0) || cfg.goalDailyRate >= 1) {
    throw new Error("env GOAL_DAILY_RATE must be zero (unset) or a fraction below 1, e.g. 0.05 for 5%/day");
  }
  // The target is reported, never traded — so an impossible one is allowed in
  // paper mode, where its whole purpose is to be watched failing. In live mode
  // it is a promise about money that has no mechanism behind it, and the honest
  // response is to refuse until the operator says they know.
  if (
    cfg.mode === "live" &&
    cfg.goalDailyRate > MAX_PLAUSIBLE_DAILY_RATE &&
    !bool(env, "ALLOW_UNREACHABLE_TARGET", false)
  ) {
    throw new Error(
      `GOAL_DAILY_RATE=${cfg.goalDailyRate} is ${formatPercent((Math.pow(1 + cfg.goalDailyRate, 365.25) - 1) * 100)}/yr compounded, ` +
        `far beyond any measured edge (30%/yr best). Live mode refuses to run real money against it. ` +
        `Set ALLOW_UNREACHABLE_TARGET=true to override, or run BOT_MODE=paper to test it safely.`,
    );
  }
  validate(cfg);
  return cfg;
}

export function validate(cfg: BotConfig): void {
  if (!(cfg.adaptive.targetVol > 0)) throw new Error("adaptive.targetVol must be > 0");
  if (!(cfg.adaptive.volWindow >= 2)) throw new Error("adaptive.volWindow must be >= 2");
  if (!(cfg.adaptive.minScale > 0 && cfg.adaptive.minScale <= 1)) {
    throw new Error("adaptive.minScale must be in (0, 1]");
  }
  if (!(cfg.adaptive.maxScale >= 1)) {
    throw new Error("adaptive.maxScale must be >= 1 (adaptation may not de-lever only by shrinking)");
  }
  if (!(cfg.adaptive.maxScale >= cfg.adaptive.minScale)) {
    throw new Error("adaptive.maxScale must be >= adaptive.minScale");
  }

  if (!(cfg.goalDailyTarget >= 0)) throw new Error("goalDailyTarget must be >= 0");
  if (!(cfg.risk.minNotional > 0)) throw new Error("risk.minNotional must be > 0");
  // Entry above +buffer and exit below -buffer must not overlap: if they did, a
  // single candle could satisfy both, and the bot would exit and re-enter on
  // the same bar — churn paid for twice.
  if (!(cfg.trend.entryBuffer >= 0)) throw new Error("trend.entryBuffer must be >= 0");
  if (!(cfg.trend.exitBuffer >= 0)) throw new Error("trend.exitBuffer must be >= 0");
  if (!(cfg.risk.positionFraction > 0 && cfg.risk.positionFraction <= 1)) {
    throw new Error("risk.positionFraction must be in (0, 1]");
  }
  if (!(cfg.risk.maxDrawdown > 0 && cfg.risk.maxDrawdown < 1)) {
    throw new Error("risk.maxDrawdown must be in (0, 1)");
  }
  if (!(cfg.risk.maxDailyLoss > 0 && cfg.risk.maxDailyLoss < 1)) {
    throw new Error("risk.maxDailyLoss must be in (0, 1)");
  }
  if (cfg.trend.emaPeriod < 20) throw new Error("trend.emaPeriod must be >= 20");
  if (cfg.pullback.rsiPeriod < 2) throw new Error("pullback.rsiPeriod must be >= 2");
  if (!(cfg.ensemble.scoreWindow >= 10)) throw new Error("ensemble.scoreWindow must be >= 10");
  if (!(cfg.ensemble.rsiEntry > 0 && cfg.ensemble.rsiEntry < cfg.ensemble.rsiExit)) {
    throw new Error("ensemble.rsiEntry must be below ensemble.rsiExit");
  }
  if (cfg.ensemble.rsiExit > 100) throw new Error("ensemble.rsiExit must be <= 100");
  if (cfg.feeRate < 0 || cfg.feeRate > 0.01) throw new Error("feeRate looks wrong (expected 0..0.01)");

  if (cfg.mode === "live") {
    if (!cfg.exchange.apiKey || !cfg.exchange.apiSecret) {
      throw new Error("BOT_MODE=live requires BINANCE_API_KEY and BINANCE_API_SECRET");
    }
  }
  if (!cfg.store.supabaseUrl || !cfg.store.serviceRoleKey) {
    // Not fatal — MemoryStore is used — but the caller should know.
    // Emitting here would require a logger dependency, so the CLI warns instead.
  }
}

export function hasStore(cfg: BotConfig): boolean {
  return Boolean(cfg.store.supabaseUrl && cfg.store.serviceRoleKey);
}

export function hasTelegram(cfg: BotConfig): boolean {
  return Boolean(cfg.notifications.telegramToken && cfg.notifications.telegramChatId);
}
