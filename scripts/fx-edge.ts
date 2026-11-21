#!/usr/bin/env node
/**
 * Is there an edge on currencies at all?
 *
 *   npm run fx:edge
 *
 * `docs/ASSET.md` §3 rejects MT5 at $10 for leverage reasons, and answers "when
 * is MT5 sane" with $276. But leverage is only half the question: an unlevered
 * account with no edge still earns nothing. So this measures the edge directly,
 * on the seven currency series already in `data/realclass`:
 *
 *   1. the single-asset trend rule the bot actually trades, per currency
 *   2. cross-sectional momentum across the seven, over a fixed grid
 *
 * Both are reported over full history *and* over the last 30% of each series,
 * because that is the part nothing in this repo was fitted to.
 *
 * Exploratory, and labelled as such: 12 configs, not the 40-config challenger
 * protocol, no carry, no interest on cash. It is enough to answer "roughly what
 * does this asset class pay" and not enough to promote anything.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCandleCsv } from "../src/data.ts";
import { defaultXsMomParams, runXsMom, type PanelAsset } from "../src/portfolio/xsmom.ts";
import { ema } from "../src/util/indicators.ts";
import type { Candle } from "../src/types.ts";

const FX = ["EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD"];
const DIR = "data/realclass";
const OOS_FRACTION = 0.3;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
}

/** The bot's rule, one asset at a time: long above its own 200-day EMA, else cash. */
function trendRule(candles: readonly Candle[]): { cagrPct: number; sharpe: number } {
  const closes = candles.map((c) => c.close);
  const line = ema(closes, 200);
  const rets: number[] = [];
  let equity = 1;
  for (let i = 201; i < closes.length; i++) {
    const inMarket = closes[i - 1] > line[i - 1];
    const r = closes[i] / closes[i - 1] - 1;
    const day = inMarket ? r : 0;
    equity *= 1 + day;
    rets.push(day);
  }
  const years = rets.length / 252;
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  return {
    cagrPct: (Math.pow(equity, 1 / years) - 1) * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
  };
}

function last30(candles: readonly Candle[]): readonly Candle[] {
  return candles.slice(Math.floor(candles.length * (1 - OOS_FRACTION)));
}

async function main(): Promise<void> {
  const files = (await readdir(DIR)).filter((f) => FX.includes(f.replace(/\.csv$/, "")));
  const assets: PanelAsset[] = [];
  for (const file of files.sort()) {
    assets.push({
      symbol: file.replace(/\.csv$/, ""),
      candles: parseCandleCsv(await readFile(join(DIR, file), "utf8")),
    });
  }
  if (assets.length < 5) {
    console.error(`only ${assets.length} currency series found in ${DIR}`);
    process.exitCode = 1;
    return;
  }

  console.log(`currencies: ${assets.map((a) => a.symbol).join(", ")}\n`);

  console.log("1. The bot's own rule, single asset (long above its 200-day EMA)");
  console.log("currency   years    full CAGR   full Sharpe   last-30% CAGR   last-30% Sharpe");
  const full: number[] = [];
  const oos: number[] = [];
  for (const a of assets) {
    const f = trendRule(a.candles);
    const o = trendRule(last30(a.candles));
    full.push(f.cagrPct);
    oos.push(o.cagrPct);
    const years = (a.candles.length / 252).toFixed(0);
    console.log(
      `${a.symbol.padEnd(9)}  ${years.padStart(4)}   ${f.cagrPct.toFixed(2).padStart(9)}%   ${f.sharpe.toFixed(2).padStart(11)}   ${o.cagrPct.toFixed(2).padStart(13)}%   ${o.sharpe.toFixed(2).padStart(15)}`,
    );
  }
  console.log(
    `median:              ${median(full).toFixed(2).padStart(9)}%   ` +
      `            ${median(oos).toFixed(2).padStart(13)}%`,
  );
  console.log(
    `positive in ${full.filter((x) => x > 0).length}/${full.length} currencies full history, ` +
      `${oos.filter((x) => x > 0).length}/${oos.length} in the last 30%`,
  );

  console.log("\n2. Cross-sectional momentum across the seven (fixed 4x3 grid, no gate)");
  const rows: Array<{ lookback: number; hold: number; cagrPct: number; sharpe: number }> = [];
  for (const lookback of [20, 60, 120, 250]) {
    for (const hold of [1, 2, 3]) {
      const r = runXsMom(assets, { ...defaultXsMomParams, lookback, hold, gate: null });
      rows.push({ lookback, hold, cagrPct: r.cagrPct, sharpe: r.sharpe });
    }
  }
  const oosRows = [];
  for (const lookback of [20, 60, 120, 250]) {
    for (const hold of [1, 2, 3]) {
      const trimmed = assets.map((a) => ({ symbol: a.symbol, candles: last30(a.candles) }));
      const r = runXsMom(trimmed, { ...defaultXsMomParams, lookback, hold, gate: null });
      oosRows.push({ lookback, hold, cagrPct: r.cagrPct, sharpe: r.sharpe });
    }
  }
  console.log(`configs: ${rows.length}   median CAGR ${median(rows.map((r) => r.cagrPct)).toFixed(2)}%/yr   ` +
    `median Sharpe ${median(rows.map((r) => r.sharpe)).toFixed(2)}`);
  console.log(`last 30%: median CAGR ${median(oosRows.map((r) => r.cagrPct)).toFixed(2)}%/yr   ` +
    `median Sharpe ${median(oosRows.map((r) => r.sharpe)).toFixed(2)}`);
  console.log(`best cell ${Math.max(...rows.map((r) => r.cagrPct)).toFixed(2)}%/yr — not a headline, it is the best of ${rows.length}`);

  const edge = median(rows.map((r) => r.cagrPct)) / 100;
  const needed = edge > 0 ? 365 / edge : Number.POSITIVE_INFINITY;
  console.log(
    `\nWhat that pays: at ${(edge * 100).toFixed(2)}%/yr, $1/day (+$365/yr) needs ` +
      (Number.isFinite(needed) ? `$${Math.round(needed).toLocaleString()} of equity.` : "an edge that does not exist here."),
  );
  console.log(
    "For comparison the crypto trend rule measured 23.3-30%/yr, so it needs roughly\n" +
      "$1,220-$1,570 at face value, or $3,684 with costs and drawdown realism.\n" +
      "The asset class, not the platform, is the difference.",
  );
}

void main();
