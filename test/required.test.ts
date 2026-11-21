import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function required(args: string[] = []): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "scripts/required.ts", ...args], {
    encoding: "utf8",
  });
}

test("$1/day from $10 is 10% a day, and the script says so without softening it", () => {
  const out = required();
  assert.match(out, /that is\s+10% per day/);
  assert.match(out, /2520% per year, simple/);
  // The reductio: a year of it exceeds every asset on earth.
  assert.match(out, /after one year\s+\$269\.7 billion/);
  assert.match(out, /the world economy/);
});

test("$10/day from $100 is the same rate, so the same impossibility", () => {
  const out = required(["--capital=100", "--per-day=10"]);
  assert.match(out, /10% per day/, "the rate must be identical at 10x the size");
  assert.match(out, /after one year\s+\$2\.7 trillion/);
});

test("the comparison against real track records is included", () => {
  const out = required();
  assert.match(out, /Buffett.*0\.07%\/day.*139x larger/);
  assert.match(out, /Medallion.*0\.20%\/day.*50x larger/);
});

test("the boundary is a line, not a preference — everything above it is unrecorded", () => {
  const out = required(["--capital=10", "--per-day=0.5"]);
  const rows = [...out.matchAll(/^\s+([\d.]+)%\s+[\d,]+\%\s+\$[\d.]+\s+([\d.]+)x\s+(.+)$/gm)].map((m) => ({
    perDay: Number(m[1]),
    ratio: Number(m[2]),
    status: m[3].trim(),
  }));
  assert.ok(rows.length >= 5, `expected the ladder, parsed ${rows.length} rows`);
  for (const row of rows.filter((r) => r.ratio > 1.2)) {
    assert.match(row.status, /never sustained|beyond every long-run record/);
  }
  // 5%/day is 25x the best fund in existence, and the script must say so.
  const five = rows.find((r) => r.perDay === 5);
  assert.ok(five && five.ratio > 24 && five.ratio < 26, `got ${five?.ratio}`);
});

test("halving the rate does not move what the income costs", () => {
  const out = required(["--capital=10", "--per-day=0.5"]);
  // $0.50/day = $182.50/yr; at 9.9% that is ~$1,843 of capital, not $10.
  assert.match(out, /9\.9%\/yr -> \$1,843 of capital \(184x what you have\)/);
});
