#!/usr/bin/env node
/**
 * Does the regime gate work outside crypto?
 *
 * This is the test that separates "a mechanism" from "a crypto artefact". The
 * same rule — hold the asset while it is above its own 200-day EMA, sit in cash
 * below it — applied to 32 back-adjusted futures series spanning equities,
 * government bonds, currencies and commodities, some of them back to 1972.
 *
 * Every instrument is compared against *itself* (gated vs ungated), so
 * instrument-specific drift, vol and contract quirks cancel. Then the same
 * comparison is repeated on the last 30% of each instrument's own history,
 * which is the part no choice in this repository was ever fitted to.
 *
 *   node --experimental-strip-types scripts/assetclass.ts --dir=data/realclass
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCandleCsv } from "../src/data.ts";
import { defaultXsMomParams, runXsMom, type PanelAsset } from "../src/portfolio/xsmom.ts";
import { mean, signTestP, tStat } from "../src/research/stats.ts";
import type { Candle } from "../src/types.ts";

const CLASSES: Record<string, string[]> = {
  equity: ["SP500", "NASDAQ", "DAX", "FTSE100", "EUROSTX", "NIKKEI", "HANG", "SMI", "AEX", "RUSSELL", "TOPIX"],
  bond: ["BUND", "US10", "US20", "GILT", "JGB", "BTP"],
  fx: ["EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD"],
  commodity: ["GOLD", "SILVER", "CRUDE_W", "COPPER", "CORN", "WHEAT", "SOYBEAN", "GAS_US"],
};

function classOf(symbol: string): string {
  for (const [cls, syms] of Object.entries(CLASSES)) if (syms.includes(symbol)) return cls;
  return "other";
}

interface Row {
  symbol: string;
  cls: string;
  bars: number;
  from: string;
  to: string;
  full: { gated: number[]; open: number[]; ddGated: number; ddOpen: number };
  oos: { gated: number[]; open: number[]; ddGated: number; ddOpen: number };
}

/** A daily move above 50% in a rolling futures series is a contract roll. */
function hasRollArtefact(candles: readonly Candle[]): boolean {
  for (let i = 1; i < candles.length; i++) {
    const r = candles[i].close / candles[i - 1].close - 1;
    if (Math.abs(r) > 0.5) return true;
  }
  return false;
}

const f = (x: number, d = 1): string => (Number.isFinite(x) ? x.toFixed(d) : "—");
const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function metrics(candles: Candle[], gate: string | null, rebalanceDays: number) {
  const panel: PanelAsset[] = [{ symbol: "X", candles }];
  const r = runXsMom(panel, {
    ...defaultXsMomParams,
    lookback: 1,
    hold: 1,
    requirePositive: false,
    rebalanceDays,
    gate: gate === null ? null : "X",
  });
  return r;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (n: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split("=").slice(1).join("=") : undefined;
  };
  const dir = get("dir") ?? "data/realclass";
  const rebalanceDays = Number(get("rebalance") ?? 30);
  const out = get("out") ?? "/tmp/assetclass.json";

  const files = (await readdir(dir)).filter((x) => x.endsWith(".csv")).sort();
  const rows: Row[] = [];

  for (const file of files) {
    const symbol = file.replace(/\.csv$/, "");
    const candles = parseCandleCsv(await readFile(join(dir, file), "utf8"));
    if (candles.length < 600) continue;
    // Some published "adjusted" series still contain raw contract rolls (a 57%
    // jump followed by a 97% collapse three days later is a roll, not a market).
    // Repairing them would be guesswork, so they are excluded and named.
    if (hasRollArtefact(candles)) {
      console.warn(`  skip ${symbol}: roll artefact in published prices`);
      continue;
    }

    const open = metrics(candles, null, rebalanceDays);
    const gated = metrics(candles, "self", rebalanceDays);

    const split = Math.floor(candles.length * 0.7);
    const tail = candles.slice(split - 250); // keep 250 bars of warm-up
    const oosOpen = metrics(tail, null, rebalanceDays);
    const oosGated = metrics(tail, "self", rebalanceDays);

    rows.push({
      symbol,
      cls: classOf(symbol),
      bars: candles.length,
      from: new Date(candles[0].openTime).toISOString().slice(0, 10),
      to: new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10),
      full: {
        gated: [gated.sharpe, gated.cagrPct],
        open: [open.sharpe, open.cagrPct],
        ddGated: gated.maxDrawdownPct,
        ddOpen: open.maxDrawdownPct,
      },
      oos: {
        gated: [oosGated.sharpe, oosGated.cagrPct],
        open: [oosOpen.sharpe, oosOpen.cagrPct],
        ddGated: oosGated.maxDrawdownPct,
        ddOpen: oosOpen.maxDrawdownPct,
      },
    });
  }

  console.log(`\n${rows.length} instruments, rebalancing every ${rebalanceDays} days\n`);
  console.log(
    `${"instrument".padEnd(10)} ${"class".padEnd(10)} ${"from".padEnd(11)} ${"bars".padStart(6)}` +
      ` ${"ShOpen".padStart(7)} ${"ShGate".padStart(7)} ${"DDopen".padStart(7)} ${"DDgate".padStart(7)}` +
      ` ${"OOSopen".padStart(8)} ${"OOSgate".padStart(8)}`,
  );
  for (const r of rows) {
    console.log(
      `${r.symbol.padEnd(10)} ${r.cls.padEnd(10)} ${r.from.padEnd(11)} ${String(r.bars).padStart(6)}` +
        ` ${f(r.full.open[0], 2).padStart(7)} ${f(r.full.gated[0], 2).padStart(7)}` +
        ` ${f(r.full.ddOpen, 0).padStart(7)} ${f(r.full.ddGated, 0).padStart(7)}` +
        ` ${f(r.oos.open[0], 2).padStart(8)} ${f(r.oos.gated[0], 2).padStart(8)}`,
    );
  }

  const report = (label: string, pick: (r: Row) => { gated: number[]; open: number[]; ddGated: number; ddOpen: number }) => {
    const dSh = rows.map((r) => pick(r).gated[0] - pick(r).open[0]);
    const dDd = rows.map((r) => pick(r).ddGated - pick(r).ddOpen);
    const wins = dSh.filter((d) => d > 0).length;
    const ddWins = dDd.filter((d) => d < 0).length;
    console.log(
      `\n${label}\n  Sharpe better on ${wins}/${rows.length} (p=${f(signTestP(wins, rows.length), 3)})` +
        ` · median Δ ${f(med(dSh), 2)} · mean Δ ${f(mean(dSh), 2)} · t=${f(tStat(dSh), 2)}` +
        `\n  drawdown better on ${ddWins}/${rows.length} · median Δ ${f(med(dDd), 1)} pts`,
    );
    for (const cls of ["equity", "bond", "fx", "commodity"]) {
      const sub = rows.filter((r) => r.cls === cls);
      if (sub.length === 0) continue;
      const w = sub.filter((r) => pick(r).gated[0] > pick(r).open[0]).length;
      const md = med(sub.map((r) => pick(r).gated[0] - pick(r).open[0]));
      console.log(`    ${cls.padEnd(10)} ${w}/${sub.length} improve · median Δ Sharpe ${f(md, 2)}`);
    }
  };

  report("FULL HISTORY (each instrument vs itself)", (r) => r.full);
  report("OUT OF SAMPLE (last 30% of each instrument's own history)", (r) => r.oos);

  await writeFile(
    out,
    JSON.stringify({ generatedAt: new Date().toISOString(), rebalanceDays, rows }, null, 2),
  );
  console.log(`\nwrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
