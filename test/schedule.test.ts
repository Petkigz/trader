import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function schedule(args: string[] = []): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "scripts/schedule.ts", ...args], {
    encoding: "utf8",
  });
}

test("the realised rate is the one the schedule leads with", () => {
  const out = schedule();
  // 9.9%/yr comes from catchup (costs, drawdowns, busts), not from the best cell.
  assert.match(out, /9\.9%\/yr/);
  assert.match(out, /\$3,636 at 9\.9%\/yr/);
});

test("$1/day and $300/month are ten apart, and land decades apart from $10", () => {
  const out = schedule();
  const row = out.match(/\$10\.00\s+(\d+)y → \d+\s+(\d+)y → \d+\s+(\d+)y/);
  assert.ok(row, "the $10 row must exist");
  const [atRealised, atMeasured] = [Number(row[1]), Number(row[2])];

  // At the realised 9.9%, $1/day from $10 is a 60-year project, not a monthly one.
  assert.ok(atRealised >= 60, `$1/day from $10 at 9.9% should be ~62 years, got ${atRealised}`);
  // At the headline backtest it is still decades.
  assert.ok(atMeasured >= 20, `should be ~24 years, got ${atMeasured}`);

  // $300/month needs ten times the capital of $1/day, so strictly longer.
  const big = out.split("$300/mo")[1].match(/\$10\.00\s+(\d+)y/);
  assert.ok(big && Number(big[1]) > atRealised, "the larger target must take longer");
});

test("the scale claim is answered with a measurement, not an opinion", () => {
  const out = schedule();
  assert.match(out, /\$10\s+→ \$18\.17 median\s+1\.82x\s+= 9\.9%\/yr/);
  assert.match(out, /\$100 → \$185\.00 median\s+1\.85x\s+= 10\.1%\/yr/);
});
