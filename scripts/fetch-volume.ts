#!/usr/bin/env node
/**
 * Give the panels a volume column, without touching a single price.
 *
 *   node --experimental-strip-types scripts/fetch-volume.ts --check
 *   node --experimental-strip-types scripts/fetch-volume.ts --write
 *
 * Why this exists: every CSV in `data/` is `date,open,high,low,close`, so the
 * backtester has never seen volume, and the flow gate in `src/market/gates.ts`
 * could not be judged. This fetches daily klines from the exchange and merges
 * *volume only* into the existing files.
 *
 * Rules it follows, because the price files are the research baseline:
 *
 *  - OHLC digits are never rewritten. Only a sixth column is added.
 *  - A date the exchange cannot supply is left blank, not zero. A blank can be
 *    filled by a later run; a zero would read as "nobody traded".
 *  - `--check` (the default) reports what would change and writes nothing.
 *
 * Requires outbound access to the exchange. In a sandbox with no egress it will
 * fail on the first request, which is why the merge itself is unit-tested
 * separately and needs no network.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { mergeVolumeCsv, parseCsvRows } from "../src/data.ts";
import { BinanceHttp, BinanceMarketData } from "../src/exchange/binance.ts";
import { loadConfig } from "../src/config.ts";

interface PanelTarget {
  dir: string;
  /** Exchange symbol for a file name, or null when the venue cannot supply it. */
  symbolFor: (fileSymbol: string) => string | null;
}

/**
 * Crypto files map straight to Binance symbols. The non-crypto panel is
 * back-adjusted continuous futures from pysystemtrade — Binance has no series
 * for those, so they are reported as unsupported rather than silently skipped.
 */
const PANELS: PanelTarget[] = [
  { dir: "data/real", symbolFor: (s) => s },
  { dir: "data/realclass", symbolFor: () => null },
];

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const dirArg = arg("dir");
  const cfg = loadConfig(process.env);
  const md = new BinanceMarketData(new BinanceHttp(cfg.exchange.baseUrl));

  for (const panel of PANELS) {
    if (dirArg && !panel.dir.endsWith(dirArg)) continue;
    const files = (await readdir(panel.dir)).filter((f) => f.endsWith(".csv")).sort();
    console.log(`\n${panel.dir}: ${files.length} files ${write ? "(writing)" : "(check only)"}`);

    let filled = 0;
    let blank = 0;
    let unsupported = 0;

    for (const file of files) {
      const symbol = panel.symbolFor(file.replace(/\.csv$/, ""));
      const path = join(panel.dir, file);
      const text = await readFile(path, "utf8");

      if (symbol === null) {
        unsupported++;
        continue;
      }

      const rows = parseCsvRows(text).rows;
      const first = rows[0]?.date;
      const last = rows[rows.length - 1]?.date;
      const byDate = await fetchVolumeByDate(md, symbol, first, last);

      const merged = mergeVolumeCsv(text, byDate);
      filled += merged.matched;
      blank += merged.unmatched;

      const before = merged.alreadyHadVolume ? "had volume" : "no volume";
      console.log(
        `  ${file.padEnd(16)} ${String(merged.matched).padStart(5)} matched, ` +
          `${String(merged.unmatched).padStart(4)} blank  (${before})`,
      );

      if (write && merged.matched > 0) await writeFile(path, merged.csv);
    }

    console.log(
      `  totals: ${filled} rows enriched, ${blank} left blank` +
        (unsupported > 0 ? `, ${unsupported} unsupported on this venue` : ""),
    );
  }

  if (!write) {
    console.log("\nNothing written. Re-run with --write to update the files.");
  } else {
    console.log("\nDone. Re-run `npm run context` — the flow gate switches from proxy to volume by itself.");
  }
}

async function fetchVolumeByDate(
  md: BinanceMarketData,
  symbol: string,
  from: string | undefined,
  to: string | undefined,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const startMs = from ? Date.parse(from) : Number.NaN;
  const endMs = to ? Date.parse(to) : Date.now();

  // 1000 bars per request, walking backwards from the end of the file.
  let cursor = Number.isFinite(endMs) ? endMs + 86_400_000 : Date.now();
  const floor = Number.isFinite(startMs) ? startMs : 0;

  for (let page = 0; page < 40; page++) {
    const candles = await md.getCandles(symbol, "1d", 1000, cursor);
    if (candles.length === 0) break;
    for (const c of candles) {
      out.set(new Date(c.openTime).toISOString().slice(0, 10), c.volume);
    }
    const firstOpen = candles[0].openTime;
    if (firstOpen <= floor) break;
    cursor = firstOpen - 1;
  }
  return out;
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
    console.error(
      "\nThis needs network access to the exchange. If it failed on the first request,\n" +
        "run it somewhere with outbound access — the merge itself is tested offline.",
    );
    process.exitCode = 1;
  }
})();
