import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTradeOutcome, realizedPnl, refreshRisk, sizePosition } from "../src/risk.ts";
import { emptyState } from "../src/types.ts";
import type { SymbolInfo } from "../src/types.ts";
import { DAY_MS } from "../src/util/num.ts";
import { testConfig } from "./helpers.ts";

const cfg = testConfig();
const NOW = Date.UTC(2026, 0, 15, 12);

const info: SymbolInfo = {
  symbol: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",
  minNotional: 5,
  stepSize: 0.00001,
  minQty: 0.00001,
  tickSize: 0.01,
};

function fresh(equity = 10) {
  const s = emptyState("paper", "BTCUSDT", "trend", NOW, equity);
  s.dayKey = "2026-01-15";
  s.dayStartEquity = equity;
  s.highWaterMark = equity;
  return s;
}

describe("refreshRisk", () => {
  it("seeds the high-water mark on the first run", () => {
    const s = emptyState("paper", "BTCUSDT", "trend", NOW, 10);
    const r = refreshRisk(s, 10, NOW, cfg);
    assert.equal(r.state.highWaterMark, 10);
    assert.equal(r.entriesBlocked, false);
  });

  it("tracks a rising high-water mark", () => {
    const r = refreshRisk(fresh(10), 12, NOW, cfg);
    assert.equal(r.state.highWaterMark, 12);
  });

  it("does not lower the high-water mark on a small dip", () => {
    const r = refreshRisk(fresh(12), 11.6, NOW, cfg);
    assert.equal(r.state.highWaterMark, 12);
    assert.equal(r.entriesBlocked, false);
  });

  it("trips the circuit breaker at the drawdown limit and re-bases", () => {
    const r = refreshRisk(fresh(10), 6.5, NOW, cfg); // -35% vs the 30% limit
    assert.equal(r.entriesBlocked, true);
    assert.equal(r.blockReason, "halted");
    assert.ok(r.state.haltedUntil > NOW);
    assert.match(r.state.haltReason, /drawdown/);
    // re-based so the bot can resume rather than stay dormant forever
    assert.equal(r.state.highWaterMark, 6.5);
    assert.ok(r.events.some((e) => e.includes("CIRCUIT BREAKER")));
  });

  it("resumes once the halt expires", () => {
    const tripped = refreshRisk(fresh(10), 6.5, NOW, cfg).state;
    const later = NOW + cfg.risk.haltDays * DAY_MS + 1000;
    const r = refreshRisk(tripped, 6.5, later, cfg);
    assert.equal(r.entriesBlocked, false);
    assert.ok(r.events.some((e) => e.includes("halt expired")));
  });

  it("stops for the rest of the day on a daily loss", () => {
    const r = refreshRisk(fresh(10), 9.0, NOW, cfg); // -10% today, limit 8%
    assert.equal(r.blockReason, "halted");
    assert.match(r.state.haltReason, /daily loss/);
    assert.ok(r.state.haltedUntil > NOW);
    assert.ok(r.state.haltedUntil - NOW <= DAY_MS);
  });

  it("respects the kill switch", () => {
    const r = refreshRisk(fresh(10), 10, NOW, testConfig({ KILL_SWITCH: "true" }));
    assert.equal(r.entriesBlocked, true);
    assert.equal(r.blockReason, "kill_switch");
  });

  it("blocks entries without equity", () => {
    const r = refreshRisk(fresh(10), 0, NOW, cfg);
    assert.equal(r.entriesBlocked, true);
  });

  it("resets the daily baseline on a new UTC day", () => {
    const s = fresh(10);
    s.dayKey = "2026-01-14";
    s.dayStartEquity = 10;
    const r = refreshRisk(s, 9.5, NOW, cfg);
    assert.equal(r.state.dayKey, "2026-01-15");
    assert.equal(r.state.dayStartEquity, 9.5);
  });
});

describe("applyTradeOutcome", () => {
  it("counts consecutive losses and halts the streak", () => {
    let s = fresh(10);
    for (let i = 0; i < cfg.risk.maxConsecutiveLosses; i++) {
      s = applyTradeOutcome(s, -0.1, NOW, cfg).state;
    }
    assert.ok(s.haltedUntil > NOW);
    assert.match(s.haltReason, /consecutive/);
  });

  it("resets the streak on a winner", () => {
    let s = fresh(10);
    s = applyTradeOutcome(s, -0.1, NOW, cfg).state;
    s = applyTradeOutcome(s, -0.1, NOW, cfg).state;
    assert.equal(s.consecutiveLosses, 2);
    s = applyTradeOutcome(s, 0.2, NOW, cfg).state;
    assert.equal(s.consecutiveLosses, 0);
  });

  it("starts a cooldown after every exit", () => {
    const s = applyTradeOutcome(fresh(10), 0.2, NOW, cfg).state;
    assert.ok(s.cooldownUntil > NOW);
  });
});

describe("sizePosition", () => {
  it("sizes a $10 account within the exchange minimum", () => {
    const r = sizePosition(10, 65_000, info, cfg);
    assert.equal(r.ok, true);
    assert.ok(r.notional >= 5);
    assert.ok(r.notional <= 10);
    assert.ok(r.qty > 0);
  });

  it("refuses an account too small to meet the minimum notional", () => {
    const r = sizePosition(4, 65_000, info, cfg);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "below_min_notional");
  });

  it("rounds down to the quantity step", () => {
    const r = sizePosition(10, 65_000, { ...info, stepSize: 0.0001 }, cfg);
    assert.equal(r.ok, true);
    const steps = r.qty / 0.0001;
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6);
  });

  it("never sizes more than the configured fraction of cash", () => {
    const r = sizePosition(10, 30_000, info, cfg);
    assert.ok(r.notional <= 10 * cfg.risk.positionFraction + 0.01);
  });

  it("refuses without a price", () => {
    assert.equal(sizePosition(10, 0, info, cfg).ok, false);
  });
});

describe("realizedPnl", () => {
  it("nets out both fees", () => {
    // sold 10 USDT worth, paid 0.01 fee, cost 9.50 -> +0.49
    assert.ok(Math.abs(realizedPnl({ quoteQty: 10, feeQuote: 0.01 }, 9.5) - 0.49) < 1e-9);
  });

  it("is negative when the position loses", () => {
    assert.ok(realizedPnl({ quoteQty: 9, feeQuote: 0.01 }, 10) < 0);
  });
});

describe("a balance below the exchange minimum", () => {
  it("is reported as stuck rather than as a normal cooldown", () => {
    const r = refreshRisk(fresh(3), 3, NOW, cfg);
    assert.equal(r.entriesBlocked, true);
    assert.equal(r.blockReason, "below_min_notional");
  });

  it("does not block a balance that can still place an order", () => {
    // $10 at 97% is $9.70, comfortably above the $5 minimum.
    const r = refreshRisk(fresh(10), 10, NOW, cfg);
    assert.notEqual(r.blockReason, "below_min_notional");
  });

  it("sizes nothing at all when the order would be too small", () => {
    const s = sizePosition(3, 100, info, testConfig());
    assert.equal(s.ok, false);
    assert.equal(s.reason, "below_min_notional");
  });
});
