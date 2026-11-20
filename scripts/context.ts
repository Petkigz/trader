#!/usr/bin/env node
/**
 * "It should know some things it doesn't."
 *
 *   node --experimental-strip-types scripts/context.ts --dir=data/real
 *
 * Two halves, in this order on purpose:
 *
 *  1. **Does the knowledge contain information?** Measured directly: what does
 *     an average day look like when the market is above its long average versus
 *     below it, and does volume tell you anything at all?
 *  2. **Does it improve the strategy?** Each gate is then run through the same
 *     fill model and judged on the same terms as a challenger: months after
 *     2024-01-01, block bootstrap over a month-major panel, against a bar that
 *     rises with the number of gates tried.
 *
 * Information is not edge. Both halves are reported so the difference stays
 * visible.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultSymbolInfo, runBacktest, type OverlayCtx } from "../src/backtest.ts";
import { loadConfig } from "../src/config.ts";
import { parseCandleCsv } from "../src/data.ts";
import {
  agreementRate,
  conditionalStats,
  contextSeries,
  hasVolume,
  type ContextPoint,
} from "../src/market/context.ts";
import { gateDecision, type GateName } from "../src/market/gates.ts";
import { monthlyDiffPanel, since, type MonthlyRow } from "../src/research/panel.ts";
import { requiredEdgeSE } from "../src/research/challengers.ts";
import { blockBootstrap, mean, median } from "../src/research/stats.ts";
import type { Candle } from "../src/types.ts";

const START = Date.parse("2020-01-01");
/** Judgement window: the same one the challengers are held to. */
const JUDGE_FROM = "2024-01";
const REFERENCE = "BTCUSDT";
const GATES: GateName[] = ["market", "volume", "cost"];

async function loadPanel(dir: string): Promise<Array<{ symbol: string; candles: Candle[] }>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".csv")).sort();
  const out: Array<{ symbol: string; candles: Candle[] }> = [];
  for (const f of files) {
    const candles = parseCandleCsv(await readFile(join(dir, f), "utf8")).filter(
      (c) => c.openTime >= START,
    );
    if (candles.length < 500) continue;
    out.push({ symbol: f.replace(/\.csv$/, ""), candles });
  }
  return out;
}

interface RunOutcome {
  symbol: string;
  totalReturnPct: number;
  maxDrawdownPct: number;
  trades: number;
  monthly: Map<string, number>;
}

function run(
  symbol: string,
  candles: Candle[],
  gate: GateName,
  ctx: ContextPoint[],
): RunOutcome {
  const cfg = loadConfig({ ...process.env, SYMBOL: symbol, STRATEGY: "trend" });
  // Context points line up with bars by timestamp. The overlay fires once per
  // bar, so this is a lookup, not a calculation.
  const byTs = new Map<number, ContextPoint>();
  candles.forEach((c, i) => byTs.set(c.closeTime, ctx[i]));

  const r = runBacktest({
    cfg,
    daily: candles,
    hourly: [],
    capital: 10,
    info: defaultSymbolInfo(symbol),
    overlay:
      gate === "off"
        ? (c: OverlayCtx) => {
            void c;
            return {};
          }
        : (c: OverlayCtx) => ({ blockEntries: !gateDecision(gate, byTs.get(c.ts)).allow }),
  });

  const monthly = new Map<string, number>();
  for (const m of r.monthly) monthly.set(m.month, m.returnPct / 100);
  return {
    symbol,
    totalReturnPct: r.totalReturnPct,
    maxDrawdownPct: r.maxDrawdownPct,
    trades: r.trades,
    monthly,
  };
}

async function main(): Promise<void> {
  const dir = arg("dir") ?? "data/real";
  const panel = await loadPanel(dir);
  if (panel.length === 0) throw new Error(`no CSVs in ${dir}`);

  const refRow = panel.find((p) => p.symbol === REFERENCE);
  if (!refRow) throw new Error(`reference ${REFERENCE} not in ${dir} — market context needs it`);
  const reference = refRow.candles;

  const cfg = loadConfig(process.env);
  const opts = {
    feeRate: cfg.feeRate,
    slippage: cfg.slippageBps / 10_000,
  };

  console.log(
    `panel: ${panel.length} assets · reference ${REFERENCE} · ` +
      `round-trip cost ${(2 * (opts.feeRate + opts.slippage) * 100).toFixed(2)}%\n`,
  );

  /* ------------------------------------------------- does it contain information? */

  console.log("what the bot cannot currently see:");
  const betas: number[] = [];
  const corrs: number[] = [];
  const upDays: number[] = [];
  const downDays: number[] = [];
  const volRatios: number[] = [];
  const edgeCosts: number[] = [];
  const agreements: number[] = [];
  let volumeAvailable = false;

  for (const { symbol, candles } of panel) {
    if (hasVolume(candles)) volumeAvailable = true;
    const ctx = contextSeries(candles, reference, opts);
    const agree = agreementRate(ctx);
    if (agree !== null) agreements.push(agree);
    const stats = conditionalStats(candles, ctx);
    const last = ctx[ctx.length - 1];
    if (last.beta !== null) betas.push(last.beta);
    if (last.correlation !== null) corrs.push(last.correlation);
    if (stats.meanReturnMarketUp !== null) upDays.push(stats.meanReturnMarketUp * 100);
    if (stats.meanReturnMarketDown !== null) downDays.push(stats.meanReturnMarketDown * 100);
    if (last.volumeRatio !== null) volRatios.push(last.volumeRatio);
    if (last.edgeToCost !== null) edgeCosts.push(last.edgeToCost);
    if (symbol === REFERENCE) continue;
  }

  const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
  console.log(
    `  median beta to ${REFERENCE}      ${median(betas).toFixed(2)} ` +
      `(range ${Math.min(...betas).toFixed(2)} to ${Math.max(...betas).toFixed(2)})`,
  );
  console.log(`  median correlation         ${median(corrs).toFixed(2)}`);
  console.log(
    `  mean daily return when the market is UP    ${pct(median(upDays))}   ` +
      `vs when it is DOWN  ${pct(median(downDays))}`,
  );
  console.log(
    `  median daily range / cost  ${median(edgeCosts).toFixed(0)}x ` +
      `(below 1x a trade cannot pay for itself)`,
  );
  console.log(
    `  symbol and market trends agree on ${(median(agreements) * 100).toFixed(0)}% of days ` +
      `— so a market gate mostly re-tests what the entry rule already knows`,
  );
  console.log(
    volumeAvailable
      ? `  volume vs its own average  ${median(volRatios).toFixed(2)}x at the last bar`
      : "  volume: absent from this panel (no volume column) — the flow gate cannot be tested here",
  );
  console.log();

  /* ------------------------------------------------------ does it improve anything? */

  const reference2 = reference;
  const runs = new Map<string, RunOutcome[]>();
  for (const gate of ["off", ...GATES] as GateName[]) {
    const outs: RunOutcome[] = [];
    for (const { symbol, candles } of panel) {
      const ctx = contextSeries(candles, reference2, opts);
      outs.push(run(symbol, candles, gate, ctx));
    }
    runs.set(gate, outs);
  }

  const base = runs.get("off")!;
  const baseOos = base.map((r) => ({ symbol: r.symbol, monthly: since(r.monthly, JUDGE_FROM) }));
  const attempts = GATES.length;
  const bar = requiredEdgeSE(attempts);

  console.log(`gates judged on ${JUDGE_FROM}+ · bar for ${attempts} attempts (${bar.toFixed(2)} sigma)\n`);
  console.log(
    `${"gate".padEnd(8)} ${"entries".padStart(8)} ${"trades".padStart(7)} ${"OOS/mo".padStart(9)} ` +
      `${"edge".padStart(8)} ${"SE".padStart(7)} ${"verdict".padStart(9)}`,
  );
  console.log("-".repeat(62));

  for (const gate of GATES) {
    const variant = runs.get(gate)!;
    const variantOos: MonthlyRow[] = variant.map((r) => ({
      symbol: r.symbol,
      monthly: since(r.monthly, JUDGE_FROM),
    }));
    const panelRows = monthlyDiffPanel(variantOos, baseOos);
    const boot = blockBootstrap(panelRows, { block: 6, reps: 1000, seed: 20261120 });
    const se = Math.max((boot.hi95 - boot.lo95) / 3.92, 1e-9);

    const oosMean = mean(variantOos.map((r) => mean([...r.monthly.values()])));
    const trades = variant.reduce((a, r) => a + r.trades, 0);
    const baseTrades = base.reduce((a, r) => a + r.trades, 0);
    const edgeSigmas = boot.observed / se;
    const blocked = baseTrades - trades;
    // A gate that blocked nothing has not been tested. Saying "inside the bar"
    // would dress a missing input up as a measured result.
    const untested = blocked === 0 || (gate === "volume" && !volumeAvailable);
    const clears = !untested && boot.lo95 > 0;

    console.log(
      `${gate.padEnd(8)} ${String(baseTrades - trades).padStart(8)} ` +
        `${String(trades).padStart(7)} ` +
        `${(oosMean * 100).toFixed(2).padStart(9)} ` +
        `${(boot.observed * 100).toFixed(3).padStart(8)} ` +
        `${(se * 100).toFixed(3).padStart(7)} ` +
        `${(untested ? "UNTESTED" : clears ? "CLEARS" : "inside").padStart(9)}`,
    );
    console.log(
      untested
        ? `         ${blocked} entries blocked — nothing to measure`
        : `         ${edgeSigmas.toFixed(2)} sigma of the luck bar · ` +
          `${boot.lo95 > 0 ? "interval excludes zero" : `interval ${(boot.lo95 * 100).toFixed(2)}% to ${(boot.hi95 * 100).toFixed(2)}%`}`,
    );
  }

  console.log(
    "\nA gate is only switched on if its interval excludes zero. Information that",
  );
  console.log("cannot be turned into a better trade stays out of the decision path.");
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

void (async () => {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();
