import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function ceiling(): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "scripts/ceiling.ts"], {
    encoding: "utf8",
  });
}

test("the growth-optimal leverage is drift over variance, not a preference", () => {
  const out = ceiling();
  assert.match(out, /Kelly leverage = drift \/ variance = 1\.32x/);
});

test("pushing past the optimum raises ruin and cuts the typical outcome", () => {
  const out = ceiling();
  const row = (lev: string) => {
    const m = out.match(new RegExp(`\\s${lev}\\s+(-?[\\d.]+)%\\s+.*?\\s([\\d.]+)%\\s*$`, "m"));
    assert.ok(m, `row for ${lev} not found`);
    return { median: Number(m[1]), ruin: Number(m[2]) };
  };
  const one = row("1\\.0x");
  const ten = row("10\\.0x");
  assert.ok(one.ruin < 1, `unlevered ruin should be ~0, got ${one.ruin}%`);
  assert.ok(ten.ruin > 50, `10x should be a coin flip on liquidation, got ${ten.ruin}%`);
  assert.equal(ten.median, -100, "the median 10x path is a wiped account");
});

test("the requirement has almost no precedent in the data", () => {
  const out = ceiling();
  const m = out.match(/reached the 36\.5x requirement: ([\d.]+)%/);
  assert.ok(m, "the precedent share must be reported");
  assert.ok(Number(m[1]) < 1, `requirement occurred in ${m[1]}% of asset-years — must be rare`);
});
