/**
 * The tick engine.
 *
 * One call = one complete, self-contained decision cycle:
 *
 *   lock -> load state -> read exchange -> reconcile -> risk -> signal ->
 *   execute -> persist -> unlock
 *
 * Design rules that make "unattended for years" true rather than aspirational:
 *
 *  1. **Stateless between ticks.** Everything needed survives in the store and
 *     on the exchange. A crashed, timed-out or skipped tick costs nothing:
 *     the next tick simply re-evaluates from scratch.
 *  2. **The exchange is the source of truth.** The position is derived from the
 *     actual balance, not from a local flag. If the database is wiped, the bot
 *     rebuilds its cost basis from the trade ledger and carries on.
 *  3. **Idempotent.** Signals are functions of *closed* candles, so running
 *     twice for the same candle produces a hold, not a second order.
 *  4. **Exits are never blocked.** Risk controls only ever prevent *new* risk.
 *  5. **Failures are survivable.** A thrown error is logged, recorded and
 *     retried on the next schedule; nothing is left half-applied.
 */

import type { BotConfig } from "./config.ts";
import type { ExchangeBundle, PaperAccount } from "./exchange/index.ts";
import type { Exchange } from "./exchange/types.ts";
import { costBasisFromTrades } from "./ledger.ts";
import { applyTradeOutcome, realizedPnl, refreshRisk, sizePosition } from "./risk.ts";
import { adaptiveFraction } from "./strategy/adaptive.ts";
import type { Store } from "./store/types.ts";
import { evaluate } from "./strategy.ts";
import { emptyState } from "./types.ts";
import type { Action, BotState, Candle, Interval, Position, TickRecord, TradeRecord } from "./types.ts";
import { silentLogger, type Logger } from "./util/logger.ts";
import { formatTradeMessage, type Notifier } from "./util/notify.ts";
import { DAY_MS, HOUR_MS, floorToStep, round } from "./util/num.ts";

const LOCK_TTL_SECONDS = 180;

export interface EngineDeps {
  cfg: BotConfig;
  store: Store;
  createExchange: (paperAccount?: PaperAccount) => Promise<ExchangeBundle>;
  clock?: () => number;
  log?: Logger;
  notify?: Notifier;
}

export interface TickResult {
  ok: boolean;
  skipped: string | null;
  mode: string;
  symbol: string;
  strategy: string;
  action: Action | "NONE";
  reason: string;
  detail: string;
  price: number;
  equityBefore: number;
  equityAfter: number;
  cash: number;
  positionQty: number;
  entriesBlocked: boolean;
  changePct: number;
  events: string[];
  durationMs: number;
  ts: number;
  error?: string;
}

export async function runTick(deps: EngineDeps): Promise<TickResult> {
  const cfg = deps.cfg;
  const log = deps.log ?? silentLogger;
  const clock = deps.clock ?? (() => Date.now());
  const now = clock();

  const result: TickResult = {
    ok: true,
    skipped: null,
    mode: cfg.mode,
    symbol: cfg.symbol,
    strategy: cfg.strategy,
    action: "NONE",
    reason: "",
    detail: "",
    price: 0,
    equityBefore: 0,
    equityAfter: 0,
    cash: 0,
    positionQty: 0,
    entriesBlocked: false,
    changePct: 0,
    events: [],
    durationMs: 0,
    ts: now,
  };

  /* ------------------------------------------------------------------ lock */

  let locked = false;
  try {
    locked = await deps.store.acquireLock(LOCK_TTL_SECONDS);
  } catch (err) {
    const message = (err as Error).message;
    log.error("lock acquisition failed", { error: message });
    return { ...result, ok: false, skipped: "lock_error", error: message };
  }
  if (!locked) {
    log.info("tick skipped: another tick holds the lock");
    return { ...result, skipped: "locked" };
  }

  let state: BotState | null = null;
  let price = 0;
  let quoteTotal = 0;
  let baseQty = 0;
  let cashAvailable = 0;
  let position: Position | null = null;
  let action: Action | "NONE" = "NONE";
  let reason = "";
  let detail = "";
  let events: string[] = [];
  let meta: Record<string, unknown> = {};
  let entriesBlocked = false;
  let changePct = 0;
  const equityOf = () => quoteTotal + baseQty * price;

  try {
    /* ---------------------------------------------------------------- state */

    state = (await deps.store.getState()) ?? emptyState(cfg.mode, cfg.symbol, cfg.strategy, now, cfg.initialPaperUsdt);

    if (state.symbol !== cfg.symbol || state.strategy !== cfg.strategy) {
      log.warn("config changed since last tick", {
        from: `${state.symbol}/${state.strategy}`,
        to: `${cfg.symbol}/${cfg.strategy}`,
      });
      state.position = null;
      state.entryPrice = null;
    }
    state.mode = cfg.mode;
    state.symbol = cfg.symbol;
    state.strategy = cfg.strategy;
    if (state.lastTickAt === 0 && !(state.paperUsdt > 0) && !(state.paperBase > 0)) {
      state.paperUsdt = cfg.initialPaperUsdt;
    }

    /* ------------------------------------------------------------- exchange */

    const bundle = await deps.createExchange({ usdt: state.paperUsdt, base: state.paperBase });
    const exchange: Exchange = bundle.exchange;
    const info = bundle.symbolInfo;

    price = await exchange.getPrice(cfg.symbol);
    const balances = await exchange.getBalances();

    const quoteBal = balances.find((b) => b.asset === info.quoteAsset);
    const baseBal = balances.find((b) => b.asset === info.baseAsset);

    quoteTotal = (quoteBal?.free ?? 0) + (quoteBal?.locked ?? 0);
    baseQty = (baseBal?.free ?? 0) + (baseBal?.locked ?? 0);
    cashAvailable = quoteBal?.free ?? 0;

    result.equityBefore = round(equityOf(), 8);

    /* --------------------------------------------------------- reconciliation */

    position = await reconcilePosition({ state, info, baseQty, price, now, store: deps.store, log });

    /* ------------------------------------------------------------------ risk */

    const risk = refreshRisk(state, equityOf(), now, cfg);
    state = risk.state;
    entriesBlocked = risk.entriesBlocked;
    events = [...risk.events];

    /* --------------------------------------------------------------- candles */

    const { daily, hourly } = await loadCandles(exchange, cfg, now);

    const lastDaily = daily[daily.length - 1];
    if (!lastDaily) {
      throw new Error("exchange returned no daily candles");
    }
    const maxStaleness = cfg.strategy === "trend" ? 4 * DAY_MS : 6 * HOUR_MS;
    if (now - lastDaily.closeTime > maxStaleness) {
      const age = round((now - lastDaily.closeTime) / HOUR_MS, 1);
      log.warn("market data is stale, skipping this tick", { ageHours: age });
      result.skipped = "stale_data";
      result.reason = "stale_data";
      result.detail = `newest daily candle is ${age}h old`;
      await deps.store.recordTick({
        ts: now,
        mode: cfg.mode,
        strategy: cfg.strategy,
        symbol: cfg.symbol,
        price: round(price, 8),
        equity: round(equityOf(), 8),
        action: "NONE",
        reason: "stale_data",
        detail: `newest daily candle is ${age}h old`,
        meta: {},
      });
      return { ...result, price: round(price, 8), equityAfter: round(equityOf(), 8), durationMs: clock() - now };
    }

    state.lastCandleCloseTime = lastDaily.closeTime;
    const prevClose = daily.length > 1 ? daily[daily.length - 2].close : price;
    changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

    /* ---------------------------------------------------------------- signal */

    const decision = evaluate({ daily, hourly, position, price, now, cfg });
    action = decision.action;
    reason = decision.reason;
    detail = decision.detail;
    meta = { ...(decision.meta ?? {}), equity: round(equityOf(), 4), drawdown: round(risk.drawdown, 4) };

    /* --------------------------------------------------------------- execute */

    if (decision.action === "EXIT_LONG" && position) {
      await executeExit({
        cfg, deps, log, now, exchange, info, position, decision, price,
        get: () => ({ quoteTotal, baseQty, cashAvailable }),
        set: (v) => { quoteTotal = v.quoteTotal; baseQty = v.baseQty; cashAvailable = v.cashAvailable; },
        getState: () => state as BotState,
        setState: (s) => { state = s; },
        onFlat: () => { position = null; action = "EXIT_LONG"; },
        onDust: () => { position = null; action = "HOLD"; reason = "dust_position"; detail = "position below exchange minimum, written off"; },
        events,
      });
    } else if (decision.action === "ENTER_LONG" && !position) {
      if (entriesBlocked) {
        action = "HOLD";
        reason = `blocked:${risk.blockReason}`;
        detail = `signal "${decision.reason}" ignored: entries blocked by ${risk.blockReason}`;
      } else {
        const snap = adaptiveFraction(daily, cfg);
        const sizing = sizePosition(cashAvailable, price, info, cfg, snap.fraction);
        if (!sizing.ok) {
          action = "HOLD";
          reason = sizing.reason;
          detail = `cannot size an order: ${sizing.reason} (cash ${round(cashAvailable, 2)}, min notional ${info.minNotional})`;
          log.warn("sizing refused", { reason: sizing.reason, cash: cashAvailable, minNotional: info.minNotional });
        } else {
          const order = await exchange.marketBuyQuote(cfg.symbol, sizing.notional);
          const fillPrice = order.qty > 0 ? order.quoteQty / order.qty : price;

          position = {
            symbol: cfg.symbol,
            qty: order.qty,
            entryPrice: fillPrice,
            entryAt: now,
            stopPrice: decision.stopPrice ?? null,
            targetPrice: decision.targetPrice ?? null,
          };
          state.entryPrice = fillPrice;

          quoteTotal -= order.quoteQty;
          cashAvailable = Math.max(0, cashAvailable - order.quoteQty);
          baseQty += order.qty;

          const trade = buildTrade(cfg, now, "BUY", order, decision.reason, null);
          await deps.store.recordTrade(trade);
          await notifyTrade(deps, log, trade, equityOf());

          log.info("bought", {
            qty: order.qty,
            price: order.price,
            notional: order.quoteQty,
            reason: decision.reason,
            equity: round(equityOf(), 4),
          });
        }
      }
    }

    /* ---------------------------------------------------------------- commit */

    state.position = position;
    if (bundle.paperAccount) {
      state.paperUsdt = round(bundle.paperAccount.usdt, 8);
      state.paperBase = round(bundle.paperAccount.base, 8);
    }
    state.lastTickAt = now;
    state.updatedAt = now;

    const tick: TickRecord = {
      ts: now,
      mode: cfg.mode,
      strategy: cfg.strategy,
      symbol: cfg.symbol,
      price: round(price, 8),
      equity: round(equityOf(), 8),
      action,
      reason,
      detail,
      meta,
    };

    await deps.store.saveState(state);
    await deps.store.recordTick(tick);

    if (events.length > 0 && deps.notify) {
      await deps.notify(`⚠️ <b>${cfg.symbol}</b> risk event\n${events.join("\n")}`);
    }

    log.info("tick complete", { action, reason, equity: round(equityOf(), 4), blocked: entriesBlocked });

    return {
      ...result,
      ok: true,
      action,
      reason,
      detail,
      price: round(price, 8),
      equityAfter: round(equityOf(), 8),
      cash: round(cashAvailable, 8),
      positionQty: position?.qty ?? 0,
      entriesBlocked,
      changePct: round(changePct, 4),
      events,
      durationMs: clock() - now,
      ts: now,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("tick failed", { error: message, stack: err instanceof Error ? err.stack : undefined });

    try {
      if (state) {
        state.lastTickAt = now;
        state.updatedAt = now;
        await deps.store.saveState(state);
      }
      await deps.store.recordTick({
        ts: now,
        mode: cfg.mode,
        strategy: cfg.strategy,
        symbol: cfg.symbol,
        price: round(price, 8),
        equity: round(equityOf(), 8),
        action: "NONE",
        reason: "error",
        detail: message,
        meta,
      });
    } catch (inner) {
      log.error("failed to record failed tick", { error: (inner as Error).message });
    }

    if (deps.notify) {
      await deps.notify(`❌ <b>Tick failed</b> (${cfg.symbol})\n${message}\n\nRetrying on the next schedule.`);
    }

    return {
      ...result,
      ok: false,
      action: "NONE",
      reason: "error",
      detail: message,
      price,
      equityAfter: round(equityOf(), 8),
      error: message,
      durationMs: clock() - now,
    };
  } finally {
    try {
      await deps.store.releaseLock();
    } catch (err) {
      log.warn("lock release failed (expires by TTL)", { error: (err as Error).message });
    }
  }
}

/* ------------------------------------------------------------------ helpers */

interface ExecuteExitArgs {
  cfg: BotConfig;
  deps: EngineDeps;
  log: Logger;
  now: number;
  exchange: Exchange;
  info: ExchangeBundle["symbolInfo"];
  position: Position;
  decision: { reason: string; detail: string };
  price: number;
  get: () => { quoteTotal: number; baseQty: number; cashAvailable: number };
  set: (v: { quoteTotal: number; baseQty: number; cashAvailable: number }) => void;
  getState: () => BotState;
  setState: (s: BotState) => void;
  onFlat: () => void;
  onDust: () => void;
  events: string[];
}

async function executeExit(a: ExecuteExitArgs): Promise<void> {
  const { cfg, deps, log, now, exchange, info, position, decision } = a;
  const { baseQty } = a.get();

  const sellable = floorToStep(baseQty, info.stepSize);
  if (!(sellable > 0) || sellable * a.price < info.minNotional) {
    log.warn("position below exchange minimum, treating as flat", { qty: baseQty });
    a.events.push(`dust position written off (${baseQty} ${info.baseAsset})`);
    a.onDust();
    return;
  }

  const order = await exchange.marketSellBase(cfg.symbol, sellable);
  const state = a.getState();
  const costBasis = (state.entryPrice ?? position.entryPrice) * order.qty;
  const pnl = realizedPnl(order, costBasis);

  const trade = buildTrade(cfg, now, "SELL", order, decision.reason, round(pnl, 8));
  await deps.store.recordTrade(trade);

  const outcome = applyTradeOutcome(state, pnl, now, cfg);
  a.setState(outcome.state);
  a.events.push(...outcome.events);

  const balances = a.get();
  a.set({
    quoteTotal: balances.quoteTotal + order.quoteQty - order.feeQuote,
    baseQty: Math.max(0, balances.baseQty - order.qty),
    cashAvailable: balances.cashAvailable + order.quoteQty - order.feeQuote,
  });
  a.setState({ ...a.getState(), position: null, entryPrice: null });

  await notifyTrade(deps, log, trade, a.get().quoteTotal + a.get().baseQty * a.price);
  a.onFlat();

  log.info("sold", { qty: order.qty, price: order.price, pnl: round(pnl, 4), reason: decision.reason });
}

function buildTrade(
  cfg: BotConfig,
  now: number,
  side: "BUY" | "SELL",
  order: { id: string; qty: number; price: number; quoteQty: number; feeQuote: number },
  reason: string,
  realizedPnlQuote: number | null,
): TradeRecord {
  return {
    id: crypto.randomUUID(),
    ts: now,
    mode: cfg.mode,
    strategy: cfg.strategy,
    symbol: cfg.symbol,
    side,
    qty: order.qty,
    price: order.price,
    quoteQty: order.quoteQty,
    feeQuote: order.feeQuote,
    reason,
    orderId: order.id,
    realizedPnlQuote,
  };
}

interface ReconcileArgs {
  state: BotState;
  info: ExchangeBundle["symbolInfo"];
  baseQty: number;
  price: number;
  now: number;
  store: Store;
  log: Logger;
}

/**
 * Work out what we actually own: the exchange balance is the truth, the ledger
 * supplies the cost basis. This is what makes a database loss non-fatal.
 */
async function reconcilePosition(args: ReconcileArgs): Promise<Position | null> {
  const { state, info, baseQty, price, now, store, log } = args;

  const sellable = floorToStep(baseQty, info.stepSize);
  if (!(sellable > 0) || sellable < info.minQty) return null;

  if (state.position && state.position.qty > 0) {
    const drift = Math.abs(state.position.qty - sellable) / Math.max(sellable, 1e-12);
    if (drift > 0.01) {
      log.warn("position mirror drifted from exchange balance", { mirrored: state.position.qty, actual: baseQty });
    }
    return { ...state.position, qty: sellable };
  }

  let entryPrice = state.entryPrice;
  if (!(entryPrice && entryPrice > 0)) {
    const recent = await store.recentTrades(200);
    entryPrice = costBasisFromTrades([...recent].reverse());
    if (!entryPrice) {
      log.warn("holding base asset with no cost basis; assuming current price", { qty: baseQty, price });
      entryPrice = price;
    } else {
      log.info("recovered cost basis from trade ledger", { entryPrice });
    }
  }
  state.entryPrice = entryPrice;

  return {
    symbol: info.symbol,
    qty: sellable,
    entryPrice,
    entryAt: now,
    stopPrice: null,
    targetPrice: null,
  };
}

async function loadCandles(
  exchange: Exchange,
  cfg: BotConfig,
  now: number,
): Promise<{ daily: Candle[]; hourly: Candle[] }> {
  const needDaily = Math.min(Math.max(cfg.trend.emaPeriod + 10, 60), 1000);
  const daily = await fetchClosedCandles(exchange, cfg.symbol, "1d", needDaily, now);

  if (cfg.strategy !== "pullback") return { daily, hourly: [] };

  const needHourly = Math.min(Math.max(cfg.pullback.rsiPeriod, cfg.pullback.atrPeriod) + 120, 500);
  const hourly = await fetchClosedCandles(exchange, cfg.symbol, "1h", needHourly, now);
  return { daily, hourly };
}

/** Candles whose close time has passed; the still-forming bar is dropped. */
async function fetchClosedCandles(
  exchange: Exchange,
  symbol: string,
  interval: Interval,
  limit: number,
  now: number,
): Promise<Candle[]> {
  const raw = await exchange.getCandles(symbol, interval, limit + 1);
  const closed = raw.filter((c) => c.closeTime <= now);
  if (closed.length > 0) return closed;
  return raw.slice(0, -1);
}

async function notifyTrade(deps: EngineDeps, log: Logger, trade: TradeRecord, equity: number): Promise<void> {
  if (!deps.notify) return;
  try {
    await deps.notify(
      formatTradeMessage({
        mode: trade.mode,
        symbol: trade.symbol,
        side: trade.side,
        qty: trade.qty,
        price: trade.price,
        quoteQty: trade.quoteQty,
        realizedPnl: trade.realizedPnlQuote,
        equity,
        reason: trade.reason,
        detail: `${trade.strategy} signal`,
      }),
    );
  } catch (err) {
    log.warn("notification failed", { error: (err as Error).message });
  }
}
