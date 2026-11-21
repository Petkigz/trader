import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evalPullback, evalTrend, evaluate } from "../src/strategy.ts";
import type { Candle, Position } from "../src/types.ts";
import { ONE_HOUR, linear, series, testConfig } from "./helpers.ts";

const cfg = testConfig();
const nowOf = (candles: Candle[]) => candles[candles.length - 1].closeTime + 1;

describe("trend strategy", () => {
  it("holds while it does not have enough history for the EMA", () => {
    const daily = series({ closes: linear(100, 100, 120) });
    const d = evalTrend({ daily, hourly: [], position: null, price: 120, now: nowOf(daily), cfg });
    assert.equal(d.action, "HOLD");
    assert.equal(d.reason, "warming_up");
  });

  it("enters when price is clearly above the long EMA", () => {
    const daily = series({ closes: linear(260, 100, 150) });
    const price = daily[daily.length - 1].close;
    const d = evalTrend({ daily, hourly: [], position: null, price, now: nowOf(daily), cfg });
    assert.equal(d.action, "ENTER_LONG");
    assert.equal(d.reason, "trend_up");
  });

  it("stays in cash when price is below the long EMA", () => {
    const daily = series({ closes: linear(260, 200, 120) });
    const price = daily[daily.length - 1].close;
    const d = evalTrend({ daily, hourly: [], position: null, price, now: nowOf(daily), cfg });
    assert.equal(d.action, "HOLD");
    assert.equal(d.reason, "regime_down");
  });

  it("holds an open position while the trend is intact", () => {
    const daily = series({ closes: linear(260, 100, 150) });
    const position: Position = {
      symbol: "BTCUSDT",
      qty: 0.0001,
      entryPrice: 140,
      entryAt: daily[daily.length - 1].closeTime - 1000,
      stopPrice: null,
      targetPrice: null,
    };
    const d = evalTrend({ daily, hourly: [], position, price: 150, now: nowOf(daily), cfg });
    assert.equal(d.action, "HOLD");
    assert.equal(d.reason, "trend_intact");
  });

  it("exits when price breaks below the EMA", () => {
    const closes = [...linear(220, 100, 160), 90, 85, 80];
    const daily = series({ closes });
    const position: Position = {
      symbol: "BTCUSDT",
      qty: 0.0001,
      entryPrice: 100, // crash stop sits at 75, so the trend break fires first
      entryAt: daily[daily.length - 4].closeTime,
      stopPrice: null,
      targetPrice: null,
    };
    const d = evalTrend({ daily, hourly: [], position, price: 80, now: nowOf(daily), cfg });
    assert.equal(d.action, "EXIT_LONG");
    assert.equal(d.reason, "trend_break");
  });

  it("fires the catastrophic stop before the trend break", () => {
    const daily = series({ closes: [...linear(220, 100, 160), 100] });
    const position: Position = {
      symbol: "BTCUSDT",
      qty: 0.0001,
      entryPrice: 155, // 100 is -35% from entry, beyond the 25% crash stop
      entryAt: daily[daily.length - 2].closeTime,
      stopPrice: null,
      targetPrice: null,
    };
    const d = evalTrend({ daily, hourly: [], position, price: 100, now: nowOf(daily), cfg });
    assert.equal(d.action, "EXIT_LONG");
    assert.equal(d.reason, "crash_stop");
  });

  it("ignores an incomplete final candle in favour of the last close", () => {
    const daily = series({ closes: linear(260, 100, 150) });
    const price = daily[daily.length - 1].close;
    const d = evalTrend({ daily, hourly: [], position: null, price, now: nowOf(daily), cfg });
    assert.equal(d.action, "ENTER_LONG");
    assert.ok(typeof d.meta?.ema === "number");
  });
});

describe("pullback strategy", () => {
  const cfgP = testConfig({ STRATEGY: "pullback" });

  function hourlyDip(): Candle[] {
    // Gentle uptrend then a sharp dip -> low RSI.
    const closes = [...linear(200, 100, 140), 120, 115, 110, 105, 100];
    return series({ closes, stepMs: ONE_HOUR });
  }

  function hourlyCalm(): Candle[] {
    return series({ closes: linear(200, 100, 140), stepMs: ONE_HOUR });
  }

  it("buys a dip when the daily trend is up", () => {
    const hourly = hourlyDip();
    const daily = series({ closes: linear(260, 100, 150) });
    const price = hourly[hourly.length - 1].close;
    const d = evalPullback({ daily, hourly, position: null, price, now: nowOf(hourly), cfg: cfgP });
    assert.equal(d.action, "ENTER_LONG");
    assert.equal(d.reason, "rsi_oversold");
    assert.ok((d.targetPrice ?? 0) > price);
    assert.ok((d.stopPrice ?? 0) < price);
  });

  it("refuses to buy a dip in a downtrend", () => {
    const hourly = hourlyDip();
    const daily = series({ closes: linear(260, 200, 120) });
    const price = hourly[hourly.length - 1].close;
    const d = evalPullback({ daily, hourly, position: null, price, now: nowOf(hourly), cfg: cfgP });
    assert.equal(d.action, "HOLD");
    assert.equal(d.reason, "bear_regime");
  });

  it("does nothing when there is no dip", () => {
    const hourly = hourlyCalm();
    const daily = series({ closes: linear(260, 100, 150) });
    const price = hourly[hourly.length - 1].close;
    const d = evalPullback({ daily, hourly, position: null, price, now: nowOf(hourly), cfg: cfgP });
    assert.equal(d.action, "HOLD");
    assert.equal(d.reason, "no_dip");
  });

  it("takes profit at the target", () => {
    const hourly = hourlyCalm();
    const daily = series({ closes: linear(260, 100, 150) });
    const now = nowOf(hourly);
    const position: Position = {
      symbol: "BTCUSDT",
      qty: 0.0001,
      entryPrice: 130,
      entryAt: now - ONE_HOUR,
      stopPrice: 120,
      targetPrice: 135,
    };
    const d = evalPullback({ daily, hourly, position, price: 136, now, cfg: cfgP });
    assert.equal(d.action, "EXIT_LONG");
    assert.equal(d.reason, "take_profit");
  });

  it("cuts the loss at the stop", () => {
    const hourly = hourlyCalm();
    const daily = series({ closes: linear(260, 100, 150) });
    const now = nowOf(hourly);
    const position: Position = {
      symbol: "BTCUSDT",
      qty: 0.0001,
      entryPrice: 130,
      entryAt: now - ONE_HOUR,
      stopPrice: 121,
      targetPrice: 140,
    };
    const d = evalPullback({ daily, hourly, position, price: 120, now, cfg: cfgP });
    assert.equal(d.action, "EXIT_LONG");
    assert.equal(d.reason, "stop_loss");
  });

  it("exits on the time limit when nothing else triggers", () => {
    const hourly = hourlyCalm();
    const daily = series({ closes: linear(260, 100, 150) });
    const now = nowOf(hourly);
    const position: Position = {
      symbol: "BTCUSDT",
      qty: 0.0001,
      entryPrice: 130,
      entryAt: now - 100 * ONE_HOUR,
      stopPrice: 50,
      targetPrice: 500,
    };
    const d = evalPullback({ daily, hourly, position, price: 130, now, cfg: cfgP });
    assert.equal(d.action, "EXIT_LONG");
    assert.equal(d.reason, "time_exit");
  });
});

describe("evaluate dispatch", () => {
  it("routes to the configured strategy", () => {
    const daily = series({ closes: linear(260, 100, 150) });
    const price = daily[daily.length - 1].close;
    const t = evaluate({ daily, hourly: [], position: null, price, now: nowOf(daily), cfg });
    assert.equal(t.action, "ENTER_LONG");
  });
});
