#!/usr/bin/env node
/**
 * Cross-sectional momentum, tested the way it has to be tested: a grid, a
 * split, and no choosing the winner after the fact.
 *
 * The protocol is fixed before the numbers are seen:
 *   - 40 parameter combinations (lookback × holdings × BTC filter)
 *   - in-sample 2019-01-01 → 2022-12-31, out-of-sample 2023-01-01 → end
 *   - the headline is the **median across the whole grid**, not the best cell
 *   - plus the one number that matters for a real decision: what the
 *     best-in-sample configuration then did out of sample
 *
 *   node --experimental-strip-types scripts/xsmom.ts --dir=data/real
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCandleCsv } from "../src/data.ts";
import {
  defaultXsMomParams,
  equalWeightBenchmark,
  runXsMom,
  type PanelAsset,
  type XsMomParams,
  type XsMomResult,
} from "../src/portfolio/xsmom.ts";
import { DAY_MS } from "../src/util/num.ts";
import type { Candle } from "../src/types.ts";

interface Flags {
  dir: string;
  lookbacks: number[];
  holds: number[];
  out: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (n: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.split("=").slice(1).join("=") : undefined;
  };
  const list = (s: string | undefined, fallback: number[]): number[] =>
    s ? s.split(",").map(Number).filter((v) => Number.isFinite(v)) : fallback;
  return {
    dir: get("dir") ?? "data/real",
    lookbacks: list(get("lookbacks"), [30, 60, 90, 120, 180]),
    holds: list(get("holds"), [1, 2, 3, 5, 99]),
    out: get("out") ?? "/tmp/xsmom.json",
  };
}

const IS_START = Date.UTC(2019, 0, 1);
const IS_END = Date.UTC(2022, 11, 31);
const OOS_START = Date.UTC(2023, 0, 1);

async function loadPanel(dir: string): Promise<PanelAsset[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".csv")).sort();
  const out: PanelAsset[] = [];
  for (const f of files) {
    const candles: Candle[] = parseCandleCsv(await readFile(join(dir, f), "utf8"));
    if (candles.length > 0) out.push({ symbol: f.replace(/\.csv$/, ""), candles });
  }
  return out;
}

function slice(panel: readonly PanelAsset[], from: number, to: number): PanelAsset[] {
  return panel.map((a) => ({
    symbol: a.symbol,
    candles: a.candles.filter((c) => c.openTime >= from && c.openTime <= to),
  }));
}

const fmt = (x: number, d = 1): string => (Number.isFinite(x) ? x.toFixed(d) : "—");
const pad = (s: string, n: number): string => s.padStart(n);

function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function line(r: XsMomResult): string {
  return (
    `${pad(fmt(r.cagrPct), 9)}% ${pad(fmt(r.sharpe, 2), 7)} ${pad(fmt(r.maxDrawdownPct, 0), 7)}%` +
    ` ${pad(fmt(r.investedPct, 0), 6)}% ${pad(fmt(r.feesPaid, 2), 7)}`
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const panel = await loadPanel(flags.dir);
  if (panel.length < 5) throw new Error(`need a panel, found ${panel.length} assets`);
  const end = Math.min(...panel.map((a) => a.candles[a.candles.length - 1].openTime));
  const symbols = panel.map((a) => a.symbol);
  console.log(`panel: ${panel.length} assets — ${symbols.join(", ")}`);

  const full = slice(panel, IS_START, end);
  const is = slice(panel, IS_START, IS_END);
  const oos = slice(panel, OOS_START, end);

  const grid: Array<{ params: XsMomParams; is: XsMomResult; oos: XsMomResult; full: XsMomResult }> = [];
  for (const lookback of flags.lookbacks) {
    for (const hold of flags.holds) {
      for (const btcFilter of [false, true]) {
        const params: XsMomParams = { ...defaultXsMomParams, lookback, hold, btcFilter };
        grid.push({
          params,
          is: runXsMom(is, params),
          oos: runXsMom(oos, params),
          full: runXsMom(full, params),
        });
      }
    }
  }

  const ewFull = equalWeightBenchmark(full);
  const ewOos = equalWeightBenchmark(oos);
  const btcFull = runBtcHold(full);
  const btcOos = runBtcHold(oos);

  console.log(`\nwindow ${new Date(IS_START).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`);
  console.log(`benchmarks       full: equal-weight ${fmt(ewFull.cagrPct)}%/yr Sh ${fmt(ewFull.sharpe, 2)} · BTC ${fmt(btcFull.cagrPct)}%/yr Sh ${fmt(btcFull.sharpe, 2)}`);
  console.log(`                 oos:  equal-weight ${fmt(ewOos.cagrPct)}%/yr Sh ${fmt(ewOos.sharpe, 2)} · BTC ${fmt(btcOos.cagrPct)}%/yr Sh ${fmt(btcOos.sharpe, 2)}`);

  console.log(`\n--- full grid, ${grid.length} configurations (lookback × holdings × BTC filter) ---`);
  console.log(`"all" = hold the whole universe equally, which makes the BTC filter a pure market-timing ablation`);
  console.log(`${"lk".padStart(4)} ${"hold".padStart(5)} ${"btc".padStart(4)}   ${"cagr".padStart(10)} ${"sharpe".padStart(7)} ${"maxDD".padStart(8)} ${"invest".padStart(7)} ${"fees".padStart(7)}`);
  for (const g of grid) {
    console.log(
      `${pad(String(g.params.lookback), 4)} ${pad(g.params.hold >= panel.length ? "all" : String(g.params.hold), 5)} ${pad(g.params.btcFilter ? "on" : "off", 4)}   ${line(g.full)}`,
    );
  }

  const fullCagr = grid.map((g) => g.full.cagrPct);
  const oosCagr = grid.map((g) => g.oos.cagrPct);
  const isCagr = grid.map((g) => g.is.cagrPct);
  const oosSharpe = grid.map((g) => g.oos.sharpe);

  const bestInSample = grid.reduce((a, b) => (b.is.cagrPct > a.is.cagrPct ? b : a));

  console.log(`\n--- summary across the grid (no cherry-picking) ---`);
  console.log(`median CAGR       full ${fmt(median(fullCagr))}%   IS ${fmt(median(isCagr))}%   OOS ${fmt(median(oosCagr))}%`);
  console.log(`median Sharpe     OOS ${fmt(median(oosSharpe), 2)}   (equal-weight OOS ${fmt(ewOos.sharpe, 2)})`);
  console.log(`configs with positive OOS CAGR: ${oosCagr.filter((c) => c > 0).length}/${grid.length}`);
  console.log(`configs beating equal-weight on OOS CAGR: ${grid.filter((g) => g.oos.cagrPct > ewOos.cagrPct).length}/${grid.length}`);
  console.log(`configs beating BTC buy-and-hold on OOS CAGR: ${grid.filter((g) => g.oos.cagrPct > btcOos.cagrPct).length}/${grid.length}`);
  console.log(
    `\nbest in-sample: lookback ${bestInSample.params.lookback}, hold ${bestInSample.params.hold}, ` +
      `btc filter ${bestInSample.params.btcFilter ? "on" : "off"} → IS ${fmt(bestInSample.is.cagrPct)}%/yr, ` +
      `then OOS ${fmt(bestInSample.oos.cagrPct)}%/yr (equal-weight ${fmt(ewOos.cagrPct)}%)`,
  );

  await writeFile(
    flags.out,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        assets: symbols,
        end: new Date(end).toISOString().slice(0, 10),
        benchmarks: { equalWeightFull: ewFull, equalWeightOos: ewOos, btcFull, btcOos },
        grid: grid.map((g) => ({
          params: g.params,
          is: strip(g.is),
          oos: strip(g.oos),
          full: strip(g.full),
        })),
        summary: {
          medianFullCagr: median(fullCagr),
          medianIsCagr: median(isCagr),
          medianOosCagr: median(oosCagr),
          medianOosSharpe: median(oosSharpe),
          positiveOos: oosCagr.filter((c) => c > 0).length,
          beatEqualWeightOos: grid.filter((g) => g.oos.cagrPct > ewOos.cagrPct).length,
          bestInSample: {
            params: bestInSample.params,
            isCagrPct: bestInSample.is.cagrPct,
            oosCagrPct: bestInSample.oos.cagrPct,
          },
        },
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${flags.out}`);
}

function runBtcHold(panel: readonly PanelAsset[]): XsMomResult {
  const btc = panel.find((a) => a.symbol === "BTCUSDT");
  if (!btc) throw new Error("BTCUSDT missing from panel");
  return equalWeightBenchmark([btc]);
}

function strip(r: XsMomResult): Omit<XsMomResult, "equityCurve"> {
  const { equityCurve: _curve, ...rest } = r;
  return rest;
}

void DAY_MS;
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
