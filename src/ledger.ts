/**
 * Ledger helpers.
 *
 * The exchange balance is the source of truth for *whether* we hold a position;
 * the trade ledger is the source of truth for *what we paid*. Rebuilding the
 * cost basis from trades is what lets the bot survive a wiped database without
 * losing its accounting.
 */

import type { TradeRecord } from "./types.ts";

/**
 * Average cost of the currently open position, derived by replaying trades in
 * chronological order. Returns null when flat.
 */
export function costBasisFromTrades(tradesOldestFirst: readonly TradeRecord[]): number | null {
  let qty = 0;
  let cost = 0;

  for (const t of tradesOldestFirst) {
    if (t.side === "BUY") {
      qty += t.qty;
      cost += t.quoteQty;
      continue;
    }
    if (qty <= 0) continue;
    const soldFraction = Math.min(t.qty / qty, 1);
    cost -= cost * soldFraction;
    qty -= t.qty;
    if (qty <= 1e-12) {
      qty = 0;
      cost = 0;
    }
  }

  if (qty <= 1e-12 || cost <= 0) return null;
  return cost / qty;
}

export interface LedgerSummary {
  /** Number of completed round trips. */
  roundTrips: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnl: number;
  feesPaid: number;
  bestTrade: number;
  worstTrade: number;
}

export function summariseTrades(trades: readonly TradeRecord[]): LedgerSummary {
  const sells = trades.filter((t) => t.side === "SELL" && t.realizedPnlQuote !== null);
  const pnls = sells.map((t) => t.realizedPnlQuote as number);
  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p <= 0).length;

  return {
    roundTrips: sells.length,
    wins,
    losses,
    winRate: sells.length > 0 ? wins / sells.length : 0,
    realizedPnl: pnls.reduce((a, b) => a + b, 0),
    feesPaid: trades.reduce((a, t) => a + t.feeQuote, 0),
    bestTrade: pnls.length ? Math.max(...pnls) : 0,
    worstTrade: pnls.length ? Math.min(...pnls) : 0,
  };
}
