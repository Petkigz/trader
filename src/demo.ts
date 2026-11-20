/**
 * Demo snapshot for local previews.
 *
 * Only used by scripts/dev-server.ts when no database is configured. It runs
 * the real backtester against a deterministic synthetic market and shapes the
 * output like a live status snapshot, so you can see exactly how the dashboard
 * will look and behave before you deploy anything.
 *
 * Every response is tagged `demo: true` and the UI shows a banner, so this can
 * never be mistaken for live figures.
 */

import { defaultSymbolInfo, runBacktest } from "./backtest.ts";
import type { BotConfig } from "./config.ts";
import { syntheticCandles } from "./data.ts";
import type { StatusSnapshot } from "./status.ts";
import type { TickRecord, TradeRecord } from "./types.ts";
import { targetPlan } from "./goal.ts";
import { summariseTrades } from "./ledger.ts";
import { round } from "./util/num.ts";

export function buildDemoSnapshot(cfg: BotConfig, now = Date.now()): StatusSnapshot {
  const daily = syntheticCandles({ interval: "1d", count: 1600, seed: 21, endTime: now });
  const result = runBacktest({
    cfg,
    daily,
    hourly: [],
    capital: cfg.initialPaperUsdt,
    info: defaultSymbolInfo(cfg.symbol),
  });

  const curve = result.equityCurve.slice(-240);
  const last = curve[curve.length - 1];
  const equity = last?.equity ?? cfg.initialPaperUsdt;
  const markPrice = round(daily[daily.length - 1].close, 2);

  const recentTrades: TradeRecord[] = result.recentTrades;
  const lastTrade = recentTrades[0];

  const ticks: TickRecord[] = curve.slice(-10).reverse().map((p, i) => ({
    ts: p.ts,
    mode: cfg.mode,
    strategy: cfg.strategy,
    symbol: cfg.symbol,
    price: markPrice,
    equity: p.equity,
    action: "HOLD",
    reason: i === 0 ? "trend_intact" : "trend_break",
    detail:
      i === 0
        ? `holding: ${markPrice.toFixed(0)} vs EMA200 — regime up, nothing to do`
        : `close fell below EMA200 — regime is down, moved to cash`,
    meta: {},
  }));

  return {
    ok: true,
    generatedAt: now,
    bot: {
      mode: cfg.mode,
      strategy: cfg.strategy,
      symbol: cfg.symbol,
      exchange: cfg.exchangeId,
      feesPerSide: `${(cfg.feeRate * 100).toFixed(3)}% + ${cfg.slippageBps}bps slippage`,
      updatedAt: now,
      lastTickAt: now - 42 * 60_000,
      lastTickAgeMinutes: 42,
    },
    account: {
      equity: round(equity, 4),
      cash: round(equity, 4),
      highWaterMark: round(Math.max(...curve.map((c) => c.equity)), 4),
      drawdownPct: result.maxDrawdownPct,
      totalReturnPct: result.totalReturnPct,
      startEquity: cfg.initialPaperUsdt,
      allTimeHigh: round(Math.max(...curve.map((p) => p.equity), equity), 4),
      dollarsToRegainPeak: round(Math.max(0, Math.max(...curve.map((p) => p.equity), equity) - equity), 4),
      pctToRegainPeak: round(Math.max(0, (Math.max(...curve.map((p) => p.equity), equity) / Math.max(equity, 1e-9) - 1) * 100), 2),
    },
    capital: {
      minNotional: cfg.risk.minNotional,
      minTradeableEquity: round(cfg.risk.minNotional / cfg.risk.positionFraction, 2),
      belowMinimum: equity < cfg.risk.minNotional / cfg.risk.positionFraction,
      shortfall: round(Math.max(0, cfg.risk.minNotional / cfg.risk.positionFraction - equity), 2),
      message: "demo data",
    },
    position: null,
    risk: {
      entriesBlocked: false,
      frozen: false,
      blockReason: "",
      haltedUntil: 0,
      haltReason: "",
      cooldownUntil: 0,
      consecutiveLosses: 0,
      killSwitch: false,
    },
    goal: {
      dailyTarget: cfg.goalDailyTarget,
      daysElapsed: 0,
      targetEquity: round(cfg.initialPaperUsdt + cfg.goalDailyTarget * (curve.length || 1), 2),
      deficit: 0,
      surplus: round(Math.max(0, equity - cfg.initialPaperUsdt), 2),
      lastDayPnl: null,
      achievedPerDay: 0,
      pressure: "ahead",
      verdict: "demo data — the goal ledger is not simulated",
      target: targetPlan({
        monthlyTarget: cfg.goalMonthlyTarget > 0 ? cfg.goalMonthlyTarget : cfg.goalDailyTarget * 30,
        equity,
        achievedCagr: null,
      }),
      entriesBlockedByGoal: false,
    },
    performance: summariseTrades(recentTrades),
    curve,
    recentTrades,
    recentTicks: ticks,
    note: lastTrade ? `last fill: ${lastTrade.side} @ ${lastTrade.price}` : "no fills in this window",
  };
}
