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
