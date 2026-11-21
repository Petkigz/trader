import test from "node:test";
import assert from "node:assert/strict";

import { parseCandleCsv } from "../src/data.ts";

const header = "date,open,high,low,close\n";

test("parses ISO dates, the format data/btc_1d.csv uses", () => {
  const candles = parseCandleCsv(header + "2026-11-13,71460.00,71514.01,67568.00,68314.00\n" +
    "2026-11-14,68314.01,68446.21,63320.00,64150.00\n");
  assert.equal(candles.length, 2);
  assert.equal(candles[0].openTime, Date.UTC(2026, 10, 13));
  assert.equal(candles[1].close, 64150);
  assert.equal(candles[1].volume, 0);
});

test("parses epoch seconds, epoch milliseconds and ISO timestamps alike", () => {
  const body = [
    "1704067200,42283.58,42298.62,42261.02,42298.61",
    "1704067200000,42283.58,42298.62,42261.02,42298.61",
    "2024-01-01T00:00:00Z,42283.58,42298.62,42261.02,42298.61",
  ].join("\n");
  const candles = parseCandleCsv(body);
  assert.equal(candles.length, 3);
  assert.equal(new Set(candles.map((c) => c.openTime)).size, 1);
  assert.equal(candles[0].openTime, Date.UTC(2024, 0, 1));
});

test("skips headers and malformed rows instead of throwing", () => {
  const candles = parseCandleCsv(
    header + "not-a-date,1,2,3,4\n" + "\n" + "2026-11-14,68314.01,68446.21,63320.00,64150.00\n",
  );
  assert.equal(candles.length, 1);
});

test("sorts out-of-order rows", () => {
  const candles = parseCandleCsv(
    "2026-11-14,1,2,0.5,1.5\n2026-11-13,1,2,0.5,1.5\n",
  );
  assert.ok(candles[0].openTime < candles[1].openTime);
});

test("volume is merged without touching a single price digit", async () => {
  const { mergeVolumeCsv } = await import("../src/data.ts");
  const original = [
    "date,open,high,low,close",
    "2024-01-01,100.123,110.456,99.999,105.500",
    "2024-01-02,105.500,107.000,104.000,106.250",
  ].join("\n");

  const volume = new Map([
    ["2024-01-01", 1234.5678],
    ["2024-01-02", 987.6543],
  ]);
  const merged = mergeVolumeCsv(original, volume);

  assert.equal(merged.matched, 2);
  assert.equal(merged.unmatched, 0);
  const lines = merged.csv.trim().split("\n");
  assert.equal(lines[0], "date,open,high,low,close,volume");
  // Every original digit survives exactly.
  assert.ok(lines[1].startsWith("2024-01-01,100.123,110.456,99.999,105.500,"), lines[1]);
  assert.ok(lines[1].endsWith("1234.57"), lines[1]);
});

test("a date the exchange cannot supply stays blank, not zero", async () => {
  const { mergeVolumeCsv } = await import("../src/data.ts");
  const original = ["2024-01-01,100,110,99,105", "2024-01-02,105,107,104,106"].join("\n");
  const merged = mergeVolumeCsv(original, new Map([["2024-01-01", 500]]));

  const lines = merged.csv.trim().split("\n");
  assert.equal(merged.unmatched, 1);
  assert.equal(lines[2], "2024-01-02,105,107,104,106,", "blank, so a later run can fill it");
  assert.ok(!lines[2].endsWith(",0"), "a zero would read as 'nobody traded'");
});

test("re-running the merge is idempotent and keeps an existing volume column", async () => {
  const { mergeVolumeCsv } = await import("../src/data.ts");
  const once = mergeVolumeCsv("2024-01-01,100,110,99,105", new Map([["2024-01-01", 500]])).csv;
  const twice = mergeVolumeCsv(once, new Map([["2024-01-01", 500]]));

  assert.equal(twice.alreadyHadVolume, true);
  assert.equal(twice.csv, once, "merging the same data twice must change nothing");
  assert.equal(twice.csv.trim().split("\n")[0], "date,open,high,low,close,volume", "one volume column, not two");
});
