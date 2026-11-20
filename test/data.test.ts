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
