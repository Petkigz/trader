/**
 * Mean reversion: buy oversold dips, but only inside an uptrend.
 *
 * The complementary counterpart to the trend follower. Where `evalTrend` waits
 * for price to break above its long average and holds for months, this buys the
 * sharp pullback *within* an established uptrend and sells into the snap back.
 * It trades more often and holds for days rather than months, which is the
 * family you want when price chops upward rather than trending cleanly.
 *
 * Long-only and unlevered, like everything else here: the worst case is a
 * smaller balance, never a liquidation.
 *
 * The uptrend filter is not optional. Buying oversold conditions in a downtrend
 * is how dip-buyers lose money — "oversold" describes a falling market, it is
 * not a reason to buy one.
 */

import type { Decision } from "../types.ts";
// Type-only import: erased at compile time, so this cannot create a runtime cycle.
import type { StrategyInput } from "../strategy.ts";
import { ema, lastValid, rsi } from "../util/indicators.ts";
import { round } from "../util/num.ts";

/** Local rounding with a default precision, matching `strategy.ts`. */
function r2(n: number, d = 2): number {
  return round(n, d);
}

export function evalMeanRev(input: StrategyInput): Decision {
  const { daily, cfg, position } = input;
  const { rsiPeriod, rsiEntry, rsiExit } = cfg.ensemble;
  const crashStopPct = cfg.trend.crashStopPct;
  const emaPeriod = cfg.trend.emaPeriod;
  const need = Math.max(emaPeriod, rsiPeriod) + 2;

  const closes = daily.map((c) => c.close);
  if (closes.length < need) {
    return {
      action: "HOLD",
      reason: "warming_up",
      detail: `need ${need} daily closes, have ${closes.length}`,
    };
  }

  const emaNow = lastValid(ema(closes, emaPeriod));
  const rsiNow = lastValid(rsi(closes, rsiPeriod));
  if (emaNow === null || rsiNow === null) {
    return { action: "HOLD", reason: "warming_up", detail: "indicators not ready" };
  }

  const price = closes[closes.length - 1];
  const aboveTrend = price > emaNow;
  const distancePct = ((price - emaNow) / emaNow) * 100;

  const meta = {
    price: r2(price),
    ema: r2(emaNow),
    rsi: r2(rsiNow, 1),
    distancePct: r2(distancePct, 2),
  };

  if (position) {
    const crashLevel = position.entryPrice * (1 - crashStopPct);
    if (price <= crashLevel) {
      return {
        action: "EXIT_LONG",
        reason: "crash_stop",
        detail: `price ${r2(price)} fell ${r2((1 - price / position.entryPrice) * 100, 1)}% from entry — catastrophic stop`,
        meta: { ...meta, crashLevel: r2(crashLevel) },
      };
    }
    if (!aboveTrend) {
      return {
        action: "EXIT_LONG",
        reason: "trend_lost",
        detail: `close ${r2(price)} fell below EMA${emaPeriod} ${r2(emaNow)} — the uptrend this dip was bought inside is gone`,
        meta,
      };
    }
    if (rsiNow >= rsiExit) {
      return {
        action: "EXIT_LONG",
        reason: "reverted",
        detail: `RSI ${r2(rsiNow, 1)} recovered past ${rsiExit} — the dip has been bought back`,
        meta,
      };
    }
    return {
      action: "HOLD",
      reason: "waiting_reversion",
      detail: `holding: RSI ${r2(rsiNow, 1)} not yet past ${rsiExit}`,
      meta,
    };
  }

  if (aboveTrend && rsiNow <= rsiEntry) {
    return {
      action: "ENTER_LONG",
      reason: "dip_in_uptrend",
      detail: `RSI ${r2(rsiNow, 1)} <= ${rsiEntry} while ${r2(distancePct, 2)}% above EMA${emaPeriod} — oversold inside an uptrend`,
      meta,
    };
  }

  return {
    action: "HOLD",
    reason: aboveTrend ? "no_dip" : "no_uptrend",
    detail: aboveTrend
      ? `in cash: RSI ${r2(rsiNow, 1)} is above ${rsiEntry}, no dip to buy`
      : `in cash: price is ${r2(distancePct, 2)}% below EMA${emaPeriod}, no uptrend to buy into`,
    meta,
  };
}
