#!/usr/bin/env node
/**
 * Run challengers in shadow against the champion, then let the pre-registered
 * promotion rule judge them. Nothing here can touch a live position.
 *
 *   node --experimental-strip-types scripts/challenger.ts --dir=data/real
 *   node --experimental-strip-types scripts/challenger.ts --list
 *
 * The registry file (`data/challengers.json`) is the memory that keeps the luck
 * bar honest: every attempt, including the failures, stays in it forever.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultSymbolInfo, runBacktest } from "../src/backtest.ts";
import { loadConfig } from "../src/config.ts";
import { parseCandleCsv } from "../src/data.ts";
import {
  ChallengerRegistry,
  type ChallengerOutcome,
  type ChallengerSpec,
  type RegistryEntry,
} from "../src/research/challengers.ts";
import { monthlyDiffPanel } from "../src/research/panel.ts";
import { blockBootstrap, mean } from "../src/research/stats.ts";
import type { Candle, StrategyName } from "../src/types.ts";

const REGISTRY = "data/challengers.json";
/** History the hypotheses may look at. */
const START = Date.parse("2020-01-01");
/**
 * Judgement window. Challengers are assessed only on data *after* this date, so
 * a hypothesis formed while looking at 2020-2023 has not seen its own exam.
 */
const JUDGE_FROM = Date.parse("2024-01-01");

interface Candidate {
  id: string;
  strategy: StrategyName;
  env: Record<string, string>;
  hypothesis: string;
}

/**
 * Hypotheses are written here, once, before any result is computed. Editing one
 * after seeing its verdict is the exact behaviour the registry exists to stop.
 */
const CANDIDATES: Candidate[] = [
  {
    id: "meanrev-rsi35",
    strategy: "meanrev",
    env: { ENSEMBLE_RSI_ENTRY: "35", ENSEMBLE_RSI_EXIT: "55" },
    hypothesis:
      "Buying oversold RSI dips while above the long EMA beats waiting for a breakout, in the chop that follows crypto rallies.",
  },
  {
    id: "ensemble-w60",
    strategy: "ensemble",
    env: { ENSEMBLE_SCORE_WINDOW: "60" },
    hypothesis:
      "A faster 60-bar scoring window lets the ensemble rotate into mean reversion sooner than the default 120, improving returns in mixed regimes.",
  },
  {
    id: "trend-ema100",
    strategy: "trend",
    env: { TREND_EMA_PERIOD: "100" },
    hypothesis:
      "A 100-day trend filter reacts faster than 200 and captures crypto's shorter cycles, adding return without giving up much drawdown control.",
  },
];

function hasRollArtefact(candles: readonly Candle[]): boolean {
  for (let i = 1; i < candles.length; i++) {
    if (Math.abs(candles[i].close / candles[i - 1].close - 1) > 0.5) return true;
  }
  return false;
}

const meanMonthly = (rows: Array<{ monthly: Map<string, number> }>): number =>
  mean(rows.flatMap((r) => [...r.monthly.values()]));

/**
 * `rejectRolls` is for back-adjusted futures only. Crypto genuinely moves >50%
 * in a day (March 2020 did), so applying the futures roll test to spot would
 * quietly delete eight of twenty assets.
 */
const skippedRolls: string[] = [];

async function loadPanel(
  dir: string,
  rejectRolls = false,
): Promise<Array<{ symbol: string; candles: Candle[] }>> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".csv")).sort();
  const out: Array<{ symbol: string; candles: Candle[] }> = [];
  for (const f of files) {
    const symbol = f.replace(/\.csv$/, "");
    const candles = parseCandleCsv(await readFile(join(dir, f), "utf8")).filter(
      (c) => c.openTime >= START,
    );
    if (candles.length < 500) continue;
    // Same rule as scripts/assetclass.ts: a rolling futures series with a >50%
    // daily move is carrying contract-roll artefacts, not market returns.
    if (rejectRolls && hasRollArtefact(candles)) {
      skippedRolls.push(symbol);
      continue;
    }
    out.push({ symbol, candles });
  }
  return out;
}

function runOn(
  panel: Array<{ symbol: string; candles: Candle[] }>,
  strategy: StrategyName,
  env: Record<string, string>,
): Array<{ symbol: string; returnPct: number; sharpe: number; trades: number; monthly: Map<string, number> }> {
  return panel.map(({ symbol, candles }) => {
    const cfg = loadConfig({ ...process.env, ...env, SYMBOL: symbol, STRATEGY: strategy });
    const r = runBacktest({
      cfg,
      daily: candles,
      hourly: [],
      capital: 10,
      info: defaultSymbolInfo(symbol),
    });
    const monthly = new Map<string, number>();
    for (const m of r.monthly) monthly.set(m.month, m.returnPct / 100);
    return { symbol, returnPct: r.totalReturnPct / 100, sharpe: r.sharpe, trades: r.trades, monthly };
  });
}

/**
 * Month-major panel of (challenger − champion) monthly returns.
 *
 * Rows must be months so the block bootstrap resamples time, keeping cross-asset
 * correlation inside the interval. Judging happens on the arithmetic *monthly*
 * excess return because it is additive and therefore bootstrappable; it is
 * annualised (×12) only for display.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (n: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split("=").slice(1).join("=") : undefined;
  };
  const dir = get("dir") ?? "data/real";
  const replicateDir = get("replicate");

  let registry: ChallengerRegistry;
  try {
    registry = ChallengerRegistry.fromJSON(JSON.parse(await readFile(REGISTRY, "utf8")));
  } catch {
    registry = new ChallengerRegistry();
  }

  if (argv.includes("--list")) {
    const rows = registry.list();
    if (rows.length === 0) {
      console.log("registry is empty");
      return;
    }
    console.log(`${"id".padEnd(18)} ${"status".padEnd(10)} ${"tried".padStart(6)}  hypothesis`);
    for (const e of rows) {
      console.log(
        `${e.spec.id.padEnd(18)} ${e.status.padEnd(10)} ${String(registry.attempts).padStart(8)}  ` +
          `${e.spec.hypothesis.slice(0, 60)}…`,
      );
    }
    return;
  }

  const panel = await loadPanel(dir);
  // Loaded once up front so its skips are reported before, not between, results.
  const otherPanel = replicateDir ? await loadPanel(replicateDir, true) : [];
  console.log(`panel: ${panel.length} assets, from ${new Date(START).toISOString().slice(0, 10)}\n`);

  const championFull = runOn(panel, "trend", {});
  const championReturn = mean(championFull.map((r) => r.returnPct));
  const championSharpe = mean(championFull.map((r) => r.sharpe));
  console.log(
    `champion (trend), full window 2020→now: mean return ${(championReturn * 100).toFixed(1)}% · ` +
      `mean Sharpe ${championSharpe.toFixed(2)} · ${championFull.reduce((a, r) => a + r.trades, 0)} round trips`,
  );

  // Judge on the held-out window only: re-run both sides from JUDGE_FROM.
  const oosPanel = panel.map(({ symbol, candles }) => ({
    symbol,
    candles: candles.filter((c) => c.openTime >= JUDGE_FROM),
  }));
  const championRows = runOn(oosPanel, "trend", {});
  const oosReturn = mean(championRows.map((r) => r.returnPct));
  const oosSharpe = mean(championRows.map((r) => r.sharpe));
  console.log(
    `champion (trend), judgement window 2024→now: mean return ${(oosReturn * 100).toFixed(1)}% · ` +
      `mean Sharpe ${oosSharpe.toFixed(2)} · ${championRows.reduce((a, r) => a + r.trades, 0)} round trips\n`,
  );

  if (skippedRolls.length > 0) {
    console.log(
      `skipped ${skippedRolls.length} futures with roll artefacts: ${skippedRolls.join(", ")}\n`,
    );
  }

  for (const c of CANDIDATES) {
    if (!registry.get(c.id)) {
      const spec: ChallengerSpec = {
        id: c.id,
        strategy: c.strategy,
        env: c.env,
        hypothesis: c.hypothesis,
        minDecisions: 100,
        registeredAt: Date.now(),
      };
      registry.register(spec);
    }
    const rows = runOn(oosPanel, c.strategy, c.env);
    const perAsset = rows.map((r, i) => ({
      symbol: r.symbol,
      returnPctDiff: r.returnPct - championRows[i].returnPct,
    }));

    // Standard error of the edge from a **time-block bootstrap** over the
    // monthly differences. A naive sd/sqrt(n) treats 20 correlated coins as 20
    // independent trials and understates the bar by roughly the square root of
    // the correlation — which is exactly how this rule promoted two challengers
    // that earlier measurement had already shown to be worthless.
    const boot = blockBootstrap(monthlyDiffPanel(rows, championRows), {
      block: 6,
      reps: 1000,
      seed: 20261120,
    });
    // Standard error of the monthly excess return, from the bootstrap interval.
    const edgeSE = Math.max((boot.hi95 - boot.lo95) / 3.92, 1e-6);

    const outcome: ChallengerOutcome = {
      decisions: rows.reduce((a, r) => a + r.trades, 0),
      // Monthly units throughout the judgement; annualised for display only.
      returnPct: boot.observed + meanMonthly(championRows),
      sharpe: mean(rows.map((r) => r.sharpe)),
      championReturnPct: meanMonthly(championRows),
      championSharpe: oosSharpe,
      perAsset,
    };
    const edgeSEPct = edgeSE;

    let verdict = registry.assess(c.id, outcome, edgeSEPct);
    console.log(`— ${c.id}`);
    console.log(
      `  held-out: ${(outcome.returnPct * 1200).toFixed(1)}%/yr vs champion ${(oosReturn * 100).toFixed(1)}% total · ` +
        `Sharpe ${outcome.sharpe.toFixed(2)} vs ${oosSharpe.toFixed(2)} · ` +
        `${outcome.decisions} round trips`,
    );
    console.log(
      `  bar: ≥${verdict.required.minDecisions} decisions, edge > ${(verdict.required.minEdgePct * 100).toFixed(2)}% ` +
        `(for ${verdict.required.attempts} attempt${verdict.required.attempts === 1 ? "" : "s"}, monthly) · observed edge ` +
        `${(verdict.observed.edgePct * 100).toFixed(2)}%/mo (${(verdict.observed.edgePct * 1200).toFixed(0)}%/yr) ` +
        `· bootstrap SE ${(edgeSEPct * 100).toFixed(2)}%/mo`,
    );
    // Stage 6 of the promotion rule: replicate outside the asset class the
    // hypothesis was formed in. A mechanism that only exists in crypto is a
    // fitted artefact, not an edge.
    if (replicateDir) {
      if (otherPanel.length > 0) {
        const otherChampion = runOn(otherPanel, "trend", {});
        const otherRows = runOn(otherPanel, c.strategy, c.env);
        const otherBoot = blockBootstrap(monthlyDiffPanel(otherRows, otherChampion), {
          block: 6,
          reps: 1000,
          seed: 20261121,
        });
        const improved = otherRows.filter(
          (r, i) => r.returnPct > otherChampion[i].returnPct,
        ).length;
        const holds = otherBoot.observed > 0 && improved > otherRows.length / 2;
        verdict.reasons.push(
          `replication on ${otherPanel.length} non-crypto instruments: edge ` +
            `${(otherBoot.observed * 1200).toFixed(1)}%/yr, ${improved}/${otherRows.length} improved → ` +
            `${holds ? "holds" : "FAILS"}`,
        );
        if (!holds && verdict.promote) {
          verdict = { ...verdict, promote: false };
          verdict.reasons.push("promotion withdrawn: did not replicate outside crypto");
          registry.withdraw(c.id, "did not replicate outside crypto");
        }
      }
    }

    // A promotion that was never asked to replicate is not a promotion. Without
    // a second asset class the rule cannot distinguish an edge from a crypto
    // artefact, so the safer reading is the default one: still in shadow.
    if (verdict.promote && !replicateDir) {
      verdict = { ...verdict, promote: false };
      verdict.reasons.push("WITHHELD: no replication panel supplied (pass --replicate=<dir>)");
      registry.withdraw(c.id, "no replication panel supplied");
    }

    for (const r of verdict.reasons) console.log(`    · ${r}`);
    // Printed last so it reflects every gate, including a withdrawn promotion.
    console.log(`  ⇒ ${verdict.promote ? "PROMOTE" : "keep in shadow"}`);
    console.log();
  }

  await writeFile(REGISTRY, JSON.stringify(registry.toJSON(), null, 2) + "\n");
  console.log(`registry: ${registry.attempts} attempts recorded → ${REGISTRY}`);
  console.log("note: `tried` is the registry total, because that is the bar's denominator;");
  console.log("note: assets are correlated, so round-trip counts overstate independence;");
  console.log("      the per-asset consistency gate is what compensates.");
  void mean;
}

void (async () => {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();

export type { RegistryEntry };
