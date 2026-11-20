import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { costBasisFromTrades, summariseTrades } from "../src/ledger.ts";
import type { TradeRecord } from "../src/types.ts";

function trade(partial: Partial<TradeRecord>): TradeRecord {
  return {
    id: crypto.randomUUID(),
    ts: 0,
    mode: "paper",
    strategy: "trend",
    symbol: "BTCUSDT",
    side: "BUY",
    qty: 0,
    price: 0,
    quoteQty: 0,
    feeQuote: 0,
    reason: "",
    orderId: "",
    realizedPnlQuote: null,
    ...partial,
  };
}

describe("costBasisFromTrades", () => {
  it("returns null when flat", () => {
    assert.equal(costBasisFromTrades([]), null);
  });

  it("is the buy price for a single open position", () => {
    const basis = costBasisFromTrades([trade({ side: "BUY", qty: 0.1, quoteQty: 6000 })]);
    assert.ok(basis !== null && Math.abs(basis - 60_000) < 1e-6);
  });

  it("returns null after a full exit", () => {
    const basis = costBasisFromTrades([
      trade({ side: "BUY", qty: 0.1, quoteQty: 6000 }),
      trade({ side: "SELL", qty: 0.1, quoteQty: 6600 }),
    ]);
    assert.equal(basis, null);
  });

  it("pro-rates cost on a partial exit", () => {
    const basis = costBasisFromTrades([
      trade({ side: "BUY", qty: 0.2, quoteQty: 12_000 }),
      trade({ side: "SELL", qty: 0.1, quoteQty: 6300 }),
    ]);
    // half the position remains, at the same average cost
    assert.ok(basis !== null && Math.abs(basis - 60_000) < 1e-6);
  });

  it("averages multiple buys", () => {
    const basis = costBasisFromTrades([
      trade({ side: "BUY", qty: 0.1, quoteQty: 6000 }), // 60k
      trade({ side: "BUY", qty: 0.1, quoteQty: 7000 }), // 70k
    ]);
    assert.ok(basis !== null && Math.abs(basis - 65_000) < 1e-6);
  });

  it("ignores a sell with no position", () => {
    const basis = costBasisFromTrades([trade({ side: "SELL", qty: 0.1, quoteQty: 6000 })]);
    assert.equal(basis, null);
  });
});

describe("summariseTrades", () => {
  it("counts round trips and win rate", () => {
    const s = summariseTrades([
      trade({ side: "BUY", qty: 0.1, quoteQty: 6000, feeQuote: 6 }),
      trade({ side: "SELL", qty: 0.1, quoteQty: 6600, realizedPnlQuote: 594 }),
      trade({ side: "BUY", qty: 0.1, quoteQty: 6000, feeQuote: 6 }),
      trade({ side: "SELL", qty: 0.1, quoteQty: 5400, realizedPnlQuote: -606 }),
    ]);
    assert.equal(s.roundTrips, 2);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 1);
    assert.equal(s.winRate, 0.5);
    assert.equal(s.feesPaid, 12);
    assert.equal(s.bestTrade, 594);
    assert.equal(s.worstTrade, -606);
  });

  it("is safe on an empty ledger", () => {
    const s = summariseTrades([]);
    assert.equal(s.roundTrips, 0);
    assert.equal(s.winRate, 0);
    assert.equal(s.realizedPnl, 0);
  });
});
