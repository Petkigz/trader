import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function daily(args: string[] = []): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "scripts/daily.ts", ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("$1/day is an average, and most days are exactly zero", () => {
  const out = daily();
  const flat = out.match(/nothing happened \(\|change\| < 1c\)\s+([\d.]+)%/);
  assert.ok(flat, "the flat-day share must be reported");
  // The rule is in cash most of the time; that is the design, not a bug.
  assert.ok(Number(flat[1]) > 50, `expected most days flat, got ${flat[1]}%`);
  assert.match(out, /median day\s+\$0\.00/);
});

test("the daily swing dwarfs the daily goal", () => {
  const out = daily();
  const band = out.match(/10th-90th percentile\s+(-\$[\d.]+) to \$([\d.]+)/);
  assert.ok(band, "the percentile band must be reported at this capital");
  const up = Number(band[2].replace(/,/g, ""));
  assert.ok(up > 20, `a day at this capital should swing tens of dollars, got ${up}`);
  assert.match(out, /about \d+x the daily goal/);
});

test("the comparison with a deposit is stated, because it is the honest alternative", () => {
  const out = daily();
  assert.match(out, /A 4%\/yr deposit yields \$1\/day on \$9,125/);
});
