/**
 * Strategy layer.
 *
 * Two long-only strategies, both of which only ever decide "in the market" or
 * "in cash". There is deliberately no shorting and no leverage:
 *
 *   - a spot position can never be liquidated, so the worst case is a lower
 *     balance, never a zero balance and never a margin call;
 *   - that is what makes "run forever, unattended" an honest claim.
 *
 * `evaluate` is a pure function of candles + position + config. The backtester
 * and the live engine call the exact same function.
 */

import type { BotConfig } from "./config.ts";
import type { Candle, Decision, Position } from "./types.ts";
import { atr, ema, lastValid, rsi } from "./util/indicators.ts";
import { evalMeanRev } from "./strategy/meanrev.ts";
import { evalEnsemble, registerTrendEvaluator } from "./strategy/ensemble.ts";

export interface StrategyInput {
  /** Closed daily candles, oldest first. */
  daily: readonly Candle[];
  /** Closed hourly candles, oldest first. */
  hourly: readonly Candle[];
  position: Position | null;
  /** Current market price (used for live exits; falls back to last close). */
  price: number;
  now: number;
  cfg: BotConfig;
}

export function evaluate(input: StrategyInput): Decision {
  switch (input.cfg.strategy) {
    case "pullback":
      return evalPullback(input);
    case "meanrev":
      return evalMeanRev(input);
    case "ensemble":
      return evalEnsemble(input);
    default:
      return evalTrend(input);
  }
}

// The ensemble delegates entries to the trend family, so it needs a handle on
// it. Registering here keeps the dependency one-directional and cycle-free.
registerTrendEvaluator(evalTrend);

/* ------------------------------------------------------------------------- */
/* Trend: be long while the daily close is above a long EMA, otherwise cash.  */
/* ------------------------------------------------------------------------- */

export function evalTrend(input: StrategyInput): Decision {
  const { daily, cfg, position, now } = input;
  const { emaPeriod, entryBuffer, exitBuffer, crashStopPct } = cfg.trend;

  const closes = daily.map((c) => c.close);
  if (closes.length < emaPeriod + 1) {
    return {
      action: "HOLD",
      reason: "warming_up",
      detail: `need ${emaPeriod + 1} daily closes, have ${closes.length}`,
    };
  }

  const emaNow = lastValid(ema(closes, emaPeriod));
  if (emaNow === null) {
    return { action: "HOLD", reason: "warming_up", detail: "EMA not ready" };
  }

  const last = daily[daily.length - 1];
  const price = last.close;
  const above = (price - emaNow) / emaNow;

  const meta = {
    price: round(price),
    ema: round(emaNow),
    distancePct: round(above * 100, 2),
    candles: closes.length,
  };

  if (position) {
    const crashLevel = position.entryPrice * (1 - crashStopPct);
    if (price <= crashLevel) {
      return {
        action: "EXIT_LONG",
        reason: "crash_stop",
        detail: `price ${round(price)} fell ${round((1 - price / position.entryPrice) * 100, 1)}% from entry — catastrophic stop`,
        meta: { ...meta, crashLevel: round(crashLevel) },
      };
    }
    if (above < -exitBuffer) {
      return {
        action: "EXIT_LONG",
        reason: "trend_break",
        detail: `close ${round(price)} fell ${round(Math.abs(above) * 100, 2)}% below EMA${emaPeriod} ${round(emaNow)} — regime is down`,
        meta,
      };
    }
    return {
      action: "HOLD",
      reason: "trend_intact",
      detail: `holding: ${round(above * 100, 2)}% above EMA${emaPeriod}`,
      meta,
    };
  }

  if (above > entryBuffer) {
    return {
      action: "ENTER_LONG",
      reason: "trend_up",
      detail: `close ${round(price)} is ${round(above * 100, 2)}% above EMA${emaPeriod} ${round(emaNow)} — regime is up`,
      meta,
    };
  }

  return {
    action: "HOLD",
    reason: "regime_down",
    detail: `staying in cash: ${round(above * 100, 2)}% vs EMA${emaPeriod}`,
    meta,
  };
}

/* ------------------------------------------------------------------------- */
/* Pullback: buy oversold dips, but only while the daily trend is up.         */
/* ------------------------------------------------------------------------- */

export function evalPullback(input: StrategyInput): Decision {
  const { daily, hourly, cfg, position, now } = input;
  const p = cfg.pullback;

  const dailyCloses = daily.map((c) => c.close);
  const emaNow = lastValid(ema(dailyCloses, cfg.trend.emaPeriod));
  const dailyLast = daily[daily.length - 1];
  const regimeUp = emaNow !== null && dailyLast !== undefined && dailyLast.close > emaNow;

  const hourlyCloses = hourly.map((c) => c.close);
  const hourlyLast = hourly[hourly.length - 1];
  if (!hourlyLast) {
    return { action: "HOLD", reason: "warming_up", detail: "no hourly candles" };
  }
  const price = input.price > 0 ? input.price : hourlyLast.close;

  /* ---- manage an open position ---- */
  if (position) {
    const heldMs = now - position.entryAt;
    if (position.targetPrice !== null && price >= position.targetPrice) {
      return {
        action: "EXIT_LONG",
        reason: "take_profit",
        detail: `price ${round(price)} hit target ${round(position.targetPrice)} (${round(((price - position.entryPrice) / position.entryPrice) * 100, 2)}%)`,
        meta: { price: round(price), target: round(position.targetPrice) },
      };
    }
    if (position.stopPrice !== null && price <= position.stopPrice) {
      return {
        action: "EXIT_LONG",
        reason: "stop_loss",
        detail: `price ${round(price)} hit stop ${round(position.stopPrice)} (${round(((price - position.entryPrice) / position.entryPrice) * 100, 2)}%)`,
        meta: { price: round(price), stop: round(position.stopPrice) },
      };
    }
    if (heldMs >= p.maxHoldHours * 3_600_000) {
      return {
        action: "EXIT_LONG",
        reason: "time_exit",
        detail: `held ${round(heldMs / 3_600_000, 1)}h without hitting target or stop`,
        meta: { price: round(price) },
      };
    }
    return {
      action: "HOLD",
      reason: "managing",
      detail: `holding, ${round(((price - position.entryPrice) / position.entryPrice) * 100, 2)}% vs entry`,
      meta: { price: round(price) },
    };
  }

  /* ---- look for an entry ---- */
  if (!regimeUp) {
    return {
      action: "HOLD",
      reason: "bear_regime",
      detail: `daily close is below EMA${cfg.trend.emaPeriod} — no dip buying in a downtrend`,
      meta: { price: round(price) },
    };
  }

  const rsiNow = lastValid(rsi(hourlyCloses, p.rsiPeriod));
  if (rsiNow === null) {
    return { action: "HOLD", reason: "warming_up", detail: "RSI not ready" };
  }

  if (rsiNow > p.oversold) {
    return {
      action: "HOLD",
      reason: "no_dip",
      detail: `RSI ${round(rsiNow, 1)} above oversold ${p.oversold}`,
      meta: { rsi: round(rsiNow, 1), price: round(price) },
    };
  }

  const atrNow = lastValid(atr(hourly, p.atrPeriod));
  const atrPct = atrNow !== null && price > 0 ? atrNow / price : 0;
  const tpDist = Math.max(p.tpPct, atrPct * p.tpAtrMult);
  const slDist = Math.max(p.slPct, atrPct * p.slAtrMult);

  return {
    action: "ENTER_LONG",
    reason: "rsi_oversold",
    detail: `RSI ${round(rsiNow, 1)} <= ${p.oversold} while daily trend is up — buying the dip`,
    stopPrice: round(price * (1 - slDist)),
    targetPrice: round(price * (1 + tpDist)),
    meta: {
      rsi: round(rsiNow, 1),
      atrPct: round(atrPct * 100, 2),
      price: round(price),
      target: round(price * (1 + tpDist)),
      stop: round(price * (1 - slDist)),
    },
  };
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
