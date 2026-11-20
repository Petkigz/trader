import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTick, type EngineDeps } from "../src/engine.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { emptyState } from "../src/types.ts";
import type { Candle } from "../src/types.ts";
import { silentLogger } from "../src/util/logger.ts";
import { DAY_MS } from "../src/util/num.ts";
import { FakeExchange, linear, series, testConfig } from "./helpers.ts";

const cfg = testConfig();

function risingCandles(): Candle[] {
  return series({ closes: linear(260, 100, 150) });
}
function crashingCandles(): Candle[] {
  return series({ closes: [...linear(220, 100, 160), 100, 95, 90] });
}

function makeDeps(exchange: FakeExchange, store: MemoryStore, now: number, overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    cfg,
    store,
    createExchange: async () => ({
      exchange,
      marketData: exchange,
      symbolInfo: await exchange.getSymbolInfo(),
    }),
    clock: () => now,
    log: silentLogger,
    ...overrides,
  };
}

describe("runTick — entry", () => {
  it("buys when the trend signal fires", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 150, daily });
    const store = new MemoryStore();

    const res = await runTick(makeDeps(exchange, store, now));

    assert.equal(res.ok, true);
    assert.equal(res.action, "ENTER_LONG");
    assert.equal(exchange.orders.length, 1);
    assert.equal(exchange.orders[0].side, "BUY");
    assert.ok(res.positionQty > 0);
    assert.ok(res.equityAfter > 9.9 && res.equityAfter <= 10.0001, `equity ${res.equityAfter}`);

    const state = await store.getState();
    assert.ok(state?.position);
    assert.ok(state?.entryPrice && state.entryPrice > 0);

    const trades = await store.recentTrades(10);
    assert.equal(trades.length, 1);
    assert.equal(trades[0].side, "BUY");
  });

  it("is idempotent: a second tick on the same candle does not buy again", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 150, daily });
    const store = new MemoryStore();

    await runTick(makeDeps(exchange, store, now));
    const second = await runTick(makeDeps(exchange, store, now));

    assert.equal(second.action, "HOLD");
    assert.equal(exchange.orders.length, 1);
    assert.equal((await store.recentTrades(10)).length, 1);
  });

  it("stays in cash in a downtrend", async () => {
    const daily = series({ closes: linear(260, 200, 120) });
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 120, daily });
    const store = new MemoryStore();

    const res = await runTick(makeDeps(exchange, store, now));
    assert.equal(res.action, "HOLD");
    assert.equal(exchange.orders.length, 0);
  });

  it("refuses to buy without enough cash for the exchange minimum", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 4, price: 150, daily });
    const store = new MemoryStore();

    const res = await runTick(makeDeps(exchange, store, now));
    assert.equal(res.action, "HOLD");
    // The rail now blocks before sizing is even attempted, so the reason names
    // the cause rather than a failed calculation: $4 cannot fund a $5 order.
    assert.equal(res.reason, "blocked:below_min_notional");
    assert.match(res.detail, /below_min_notional/);
    assert.equal(exchange.orders.length, 0);
  });

  it("respects the kill switch but still reports the signal", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 150, daily });
    const store = new MemoryStore();

    const res = await runTick(makeDeps(exchange, store, now, { cfg: testConfig({ KILL_SWITCH: "true" }) }));
    assert.equal(res.action, "HOLD");
    assert.equal(res.reason, "blocked:kill_switch");
    assert.equal(exchange.orders.length, 0);
    assert.match(res.detail, /blocked/);
  });
});

describe("runTick — exit", () => {
  it("sells when the trend breaks and books the PnL", async () => {
    const up = risingCandles();
    const now1 = up[up.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 150, daily: up });
    const store = new MemoryStore();

    await runTick(makeDeps(exchange, store, now1));
    const bought = exchange.base;
    assert.ok(bought > 0);

    // Trend collapses.
    const down = crashingCandles();
    const now2 = down[down.length - 1].closeTime + 1;
    exchange.daily = down;
    exchange.price = 105;

    const res = await runTick(makeDeps(exchange, store, now2));

    assert.equal(res.action, "EXIT_LONG");
    assert.equal(exchange.orders.filter((o) => o.side === "SELL").length, 1);
    assert.equal(exchange.base, 0);

    const trades = await store.recentTrades(10);
    const sell = trades.find((t) => t.side === "SELL");
    assert.ok(sell);
    assert.ok(sell.realizedPnlQuote !== null);
    assert.ok(sell.realizedPnlQuote < 0, "exit at a lower price must realise a loss");

    const state = await store.getState();
    assert.equal(state?.position, null);
    assert.equal(state?.entryPrice, null);
    // cash reflects the sale
    assert.ok(Math.abs(exchange.usdt - res.cash) < 1e-6);
  });

  it("does not sell when there is no position", async () => {
    const down = crashingCandles();
    const now = down[down.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 90, daily: down });
    const store = new MemoryStore();

    const res = await runTick(makeDeps(exchange, store, now));
    assert.equal(res.action, "HOLD");
    assert.equal(exchange.orders.length, 0);
  });
});

describe("runTick — resilience", () => {
  it("skips the tick when another tick holds the lock", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 150, daily });
    const store = new MemoryStore();

    assert.equal(await store.acquireLock(180), true);
    const res = await runTick(makeDeps(exchange, store, now));
    assert.equal(res.skipped, "locked");
    assert.equal(exchange.orders.length, 0);
  });

  it("releases the lock after a successful tick", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 150, daily });
    const store = new MemoryStore();

    await runTick(makeDeps(exchange, store, now));
    assert.equal(await store.acquireLock(180), true, "lock must be free again");
  });

  it("releases the lock even when the tick throws", async () => {
    const store = new MemoryStore();
    const deps = makeDeps(new FakeExchange({ usdt: 10, price: 150, daily: [] }), store, Date.now());
    deps.createExchange = async () => {
      throw new Error("boom");
    };

    const res = await runTick(deps);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /boom/);
    assert.equal(await store.acquireLock(180), true);
  });

  it("records an error tick instead of losing the event", async () => {
    const store = new MemoryStore();
    const deps = makeDeps(new FakeExchange({ usdt: 10, price: 150, daily: [] }), store, Date.now());
    deps.createExchange = async () => {
      throw new Error("network down");
    };

    await runTick(deps);
    const ticks = await store.recentTicks(5);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].reason, "error");
  });

  it("recovers a position that exists on the exchange but not in the database", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 0.3, base: 0.06466, price: 150, daily });
    const store = new MemoryStore();

    const res = await runTick(makeDeps(exchange, store, now));

    assert.equal(res.ok, true);
    assert.ok(res.positionQty > 0, "should see the exchange position");
    // A rising trend with an existing position is a hold, not a second buy.
    assert.equal(res.action, "HOLD");
    assert.equal(exchange.orders.length, 0);

    const state = await store.getState();
    assert.ok(state?.position);
    assert.ok(state?.entryPrice && state.entryPrice > 0, "cost basis must be reconstructed");
  });

  it("writes a tick record on every run", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 150, daily });
    const store = new MemoryStore();

    await runTick(makeDeps(exchange, store, now));
    await runTick(makeDeps(exchange, store, now + DAY_MS));

    const ticks = await store.recentTicks(10);
    assert.equal(ticks.length, 2);
  });

  it("skips stale market data rather than trading on it", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 10 * DAY_MS;
    const exchange = new FakeExchange({ usdt: 10, price: 150, daily });
    const store = new MemoryStore();

    const res = await runTick(makeDeps(exchange, store, now));
    assert.equal(res.skipped, "stale_data");
    assert.equal(exchange.orders.length, 0);
  });

  it("adopts a changed symbol by clearing the mirrored position", async () => {
    const daily = risingCandles();
    const now = daily[daily.length - 1].closeTime + 1;
    const exchange = new FakeExchange({ usdt: 10, price: 150, daily });
    const store = new MemoryStore();

    const stale = emptyState("paper", "ETHUSDT", "trend", now, 10);
    stale.position = { symbol: "ETHUSDT", qty: 1, entryPrice: 3000, entryAt: now, stopPrice: null, targetPrice: null };
    await store.saveState(stale);

    const res = await runTick(makeDeps(exchange, store, now));
    assert.equal(res.ok, true);
    const state = await store.getState();
    assert.equal(state?.symbol, "BTCUSDT");
  });
});
