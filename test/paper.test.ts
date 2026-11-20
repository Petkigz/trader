import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaperExchange } from "../src/exchange/paper.ts";
import { ExchangeError } from "../src/exchange/types.ts";
import { StubMarketData, testConfig } from "./helpers.ts";

async function paper(opts: { usdt?: number; base?: number; price?: number; feeRate?: number; slippageBps?: number } = {}) {
  const cfg = testConfig({
    FEE_RATE: String(opts.feeRate ?? 0.001),
    SLIPPAGE_BPS: String(opts.slippageBps ?? 0),
  });
  const md = new StubMarketData(opts.price ?? 60_000);
  const info = await md.getSymbolInfo();
  const account = { usdt: opts.usdt ?? 10, base: opts.base ?? 0 };
  return { ex: new PaperExchange(md, info, cfg, account), account, md };
}

describe("PaperExchange", () => {
  it("charges commission in the base asset and leaves rounding dust as cash", async () => {
    const { ex, account } = await paper({ usdt: 10, feeRate: 0.001 });
    const order = await ex.marketBuyQuote("BTCUSDT", 10);

    assert.equal(order.side, "BUY");
    // 10 / 60000 = 0.00016666 floors to the 0.00001 lot step -> 0.00016 BTC
    const grossQty = 0.00016;
    const spend = grossQty * 60_000;
    const feeQty = grossQty * 0.001;

    assert.ok(Math.abs(order.quoteQty - spend) < 1e-6, `spent ${order.quoteQty}`);
    assert.ok(Math.abs(order.qty - (grossQty - feeQty)) < 1e-12, "receive gross minus commission");
    assert.ok(Math.abs(account.usdt - (10 - spend)) < 1e-6, "unspent dust stays as cash");
    assert.equal(account.base, order.qty);
    // total value only drops by the fee (+ slippage)
    const equity = account.usdt + account.base * 60_000;
    assert.ok(Math.abs(equity - (10 - 0.0096)) < 1e-3, `equity ${equity}`);
  });

  it("applies slippage against the trader", async () => {
    const { ex } = await paper({ usdt: 10, slippageBps: 10 }); // 0.10%
    const buy = await ex.marketBuyQuote("BTCUSDT", 10);
    assert.ok(buy.price > 60_000, "buys fill above mid");
  });

  it("returns cash minus fees on a sell", async () => {
    const { ex, account } = await paper({ usdt: 0, base: 0.001, price: 60_000, feeRate: 0.001 });
    const order = await ex.marketSellBase("BTCUSDT", 0.001);

    const gross = 0.001 * 60_000;
    assert.ok(Math.abs(order.quoteQty - gross) < 1e-6);
    assert.ok(Math.abs(order.feeQuote - gross * 0.001) < 1e-6);
    assert.ok(Math.abs(account.usdt - (gross - gross * 0.001)) < 1e-6);
    assert.equal(account.base, 0);
  });

  it("costs roughly two fees to round-trip with no price move", async () => {
    const { ex, account } = await paper({ usdt: 10, feeRate: 0.001 });
    await ex.marketBuyQuote("BTCUSDT", 10);
    await ex.marketSellBase("BTCUSDT", account.base);
    // ~0.2% of the traded notional, i.e. about 2 cents on $10.
    assert.ok(account.usdt < 10, "must not be free");
    assert.ok(account.usdt > 9.96, `lost too much: ${account.usdt}`);
  });

  it("rejects a buy larger than the balance", async () => {
    const { ex } = await paper({ usdt: 5 });
    await assert.rejects(() => ex.marketBuyQuote("BTCUSDT", 10), ExchangeError);
  });

  it("rejects a buy below the exchange minimum notional", async () => {
    const { ex } = await paper({ usdt: 100 });
    await assert.rejects(() => ex.marketBuyQuote("BTCUSDT", 1), /min notional/);
  });

  it("rejects a sell with nothing to sell", async () => {
    const { ex } = await paper({ base: 0 });
    await assert.rejects(() => ex.marketSellBase("BTCUSDT", 0.001), /nothing to sell/);
  });

  it("never sells more than the balance", async () => {
    const { ex, account } = await paper({ base: 0.0005, price: 60_000 });
    const order = await ex.marketSellBase("BTCUSDT", 1);
    assert.ok(Math.abs(order.qty - 0.0005) < 1e-12);
    assert.equal(account.base, 0);
  });

  it("reports balances using the symbol's assets", async () => {
    const { ex } = await paper({ usdt: 7.5, base: 0.0001 });
    const bal = await ex.getBalances();
    assert.equal(bal.find((b) => b.asset === "USDT")?.free, 7.5);
    assert.equal(bal.find((b) => b.asset === "BTC")?.free, 0.0001);
  });
});
