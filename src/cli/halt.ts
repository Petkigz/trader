#!/usr/bin/env node
/**
 * Emergency controls.
 *
 *   npm run lock -- on        block all new entries (open positions are still managed)
 *   npm run lock -- off       re-enable entries
 *   npm run lock -- flatten   sell everything at market and go to cash
 *   npm run lock -- status    show the current flags
 *
 * `flatten` is the manual "get me out now" button. It takes the same lock as a
 * tick so it can never race with the scheduler.
 */

import { loadConfig } from "../config.ts";
import { createExchange } from "../exchange/index.ts";
import { buildStore } from "../runtime.ts";
import { c } from "./format.ts";
import { floorToStep } from "../util/num.ts";

async function main(): Promise<void> {
  const cmd = (process.argv[2] ?? "status").toLowerCase();
  const cfg = loadConfig();
  const store = buildStore(cfg);

  switch (cmd) {
    case "on":
    case "halt": {
      await store.setKillSwitch(true);
      console.log(c.yellow("kill switch ON — no new entries. Open positions will still be exited by the strategy."));
      return;
    }
    case "off":
    case "resume": {
      await store.setKillSwitch(false);
      console.log(c.green("kill switch OFF — entries re-enabled (subject to risk limits)."));
      return;
    }
    case "flatten": {
      const ok = await store.acquireLock(180);
      if (!ok) {
        console.error(c.red("another tick is running; try again in a few seconds"));
        process.exitCode = 1;
        return;
      }
      try {
        const state = (await store.getState()) ?? null;
        const bundle = await createExchange(cfg, { usdt: state?.paperUsdt ?? cfg.initialPaperUsdt, base: state?.paperBase ?? 0 });
        const balances = await bundle.exchange.getBalances();
        const baseBal = balances.find((b) => b.asset === bundle.symbolInfo.baseAsset);
        const qty = floorToStep(baseBal?.free ?? 0, bundle.symbolInfo.stepSize);

        if (!(qty > 0)) {
          console.log(c.grey("nothing to sell — already flat"));
          return;
        }
        const order = await bundle.exchange.marketSellBase(cfg.symbol, qty);
        console.log(c.green(`sold ${order.qty} ${bundle.symbolInfo.baseAsset} at ${order.price.toFixed(2)} (value ${order.quoteQty.toFixed(2)})`));

        if (state) {
          state.position = null;
          state.entryPrice = null;
          if (bundle.paperAccount) {
            state.paperUsdt = bundle.paperAccount.usdt;
            state.paperBase = bundle.paperAccount.base;
          }
          await store.saveState(state);
        }
        await store.recordTrade({
          id: crypto.randomUUID(),
          ts: Date.now(),
          mode: cfg.mode,
          strategy: cfg.strategy,
          symbol: cfg.symbol,
          side: "SELL",
          qty: order.qty,
          price: order.price,
          quoteQty: order.quoteQty,
          feeQuote: order.feeQuote,
          reason: "manual_flatten",
          orderId: order.id,
          realizedPnlQuote: null,
        });
        console.log(c.grey("position cleared"));
      } finally {
        await store.releaseLock();
      }
      return;
    }
    case "status":
    default: {
      const state = await store.getState();
      if (!state) {
        console.log(c.grey("no state yet — run `npm run tick` first"));
        return;
      }
      console.log(`kill switch: ${state.killSwitch ? c.red("ON") : c.green("off")}`);
      console.log(`halted: ${state.haltedUntil > Date.now() ? c.yellow(new Date(state.haltedUntil).toISOString()) + ` (${state.haltReason})` : c.green("no")}`);
      console.log(`cooldown until: ${state.cooldownUntil > Date.now() ? new Date(state.cooldownUntil).toISOString() : c.green("none")}`);
      console.log(`consecutive losses: ${state.consecutiveLosses}`);
      console.log(`position: ${state.position ? `${state.position.qty} @ ${state.position.entryPrice}` : c.grey("flat")}`);
      return;
    }
  }
}

main().catch((err) => {
  console.error(c.red(`fatal: ${(err as Error).message}`));
  process.exitCode = 1;
});
