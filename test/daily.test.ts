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

test("a good day clears the daily target by a lot, and a bad day undoes it", () => {
  const out = daily();
  // Not a thin tail: being fully invested means an ordinary up-day beats $1.
  const row = (t: number) => {
    const m = out.match(new RegExp(`gained \\$${t}\\s+or more\\s+(\\d+)\\s+([\\d.]+)%`));
    assert.ok(m, `threshold $${t} must be reported`);
    return { days: Number(m[1]), share: Number(m[2]) };
  };
  assert.ok(row(1).share > 15, "many days clear $1");
  assert.ok(row(100).share > 5, "an ordinary up-day at this capital clears $100");
  assert.ok(row(365).share > 0.5, "a whole year's target in one day is not rare");

  // The edge is the small difference between two large totals — that is why
  // daily results look like noise and the target only shows up over years.
  const up = out.match(/all up-days in total\s+\$([\d,]+)/);
  const down = out.match(/all down-days in total\s+-\$([\d,]+)/);
  assert.ok(up && down, "both totals must be reported");
  assert.ok(Number(up[1].replace(/,/g, "")) > Number(down[1].replace(/,/g, "")), "profit is positive overall");
});
