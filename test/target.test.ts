import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function target(args: string[] = []): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "scripts/target.ts", ...args], {
    encoding: "utf8",
  });
}

test("$300/month at $10 or $100 is a rate the strategy has never approached", () => {
  const out = target(["--income=300"]);

  // 3,600/yr at $10 and 3,600% at $100, against a best-ever year of 59.8%.
  const rows = [...out.matchAll(/\$\s*([\d,]+)\s+([\d,]+)%\s+([\d.]+)x/g)].map((m) => ({
    capital: Number(m[1].replace(/,/g, "")),
    needed: Number(m[2].replace(/,/g, "")),
    ratio: Number(m[3]),
  }));
  const at10 = rows.find((r) => r.capital === 10);
  const at100 = rows.find((r) => r.capital === 100);
  assert.ok(at10 && at10.needed === 36_000, `at $10 the requirement is 36,000%/yr, got ${at10?.needed}`);
  assert.ok(at100 && at100.needed === 3_600, `at $100 it is 3,600%/yr, got ${at100?.needed}`);
  assert.ok(at10 && at100 && at100.ratio > 50 && at10.ratio > 500, "the multiples must be 60x and 602x");
});

test("the $1/day and $300/month targets differ by exactly 10x", () => {
  const daily = target();
  const big = target(["--income=300"]);
  const capital = (out: string) => Number(out.match(/23\.3%\/yr\s+\$([\d,]+)/)![1].replace(/,/g, ""));
  // Rounding to whole dollars makes this 10.0 rather than exactly 10.
  assert.ok(Math.abs(capital(big) / capital(daily) - 10) < 0.01, `${capital(big)} / ${capital(daily)}`);
});

test("the precedent quoted in the docs is the one in the data", () => {
  const out = target();
  assert.match(out, /best 30 calendar days\s+DOGEUSDT\s+\+1,074%/);
  assert.match(out, /best measured year \+59\.8%/);
});
