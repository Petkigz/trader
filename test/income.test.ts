import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function run(script: string, args: string[] = []): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", `scripts/${script}.ts`, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("$100 of capital makes about $10 a year at the realised rate", () => {
  const out = run("income", ["--capital=100"]);
  const row = out.match(/9\.9%\/yr\s+\$([\d.]+)\s+\$([\d.]+)\s+\$([\d.]+)\s+\$([\d.]+)/);
  assert.ok(row, "the 9.9% row must exist");
  assert.equal(Number(row[1]), 0.027, "per day");
  assert.ok(Math.abs(Number(row[3]) - 0.825) < 0.001, `per month, got ${row[3]}`);
  assert.equal(Number(row[4]), 9.9, "per year — the claim being checked");
});

test("income is linear in capital, so any size can be priced", () => {
  const small = run("income", ["--capital=100"]);
  const big = run("income", ["--capital=1000"]);
  const yearly = (out: string) => Number(out.match(/9\.9%\/yr.*\$([\d.]+)\s*$/m)![1]);
  assert.ok(Math.abs(yearly(big) / yearly(small) - 10) < 0.01, "10x capital must be 10x income");
});

test("the constants agree with the daily measurement they came from", () => {
  const income = run("income", ["--capital=100"]);
  const daily = run("daily");

  const flatDaily = daily.match(/nothing happened \(\|change\| < 1c\)\s+([\d.]+)%/)![1];
  const flatIncome = income.match(/days that do exactly nothing\s+([\d.]+)%/)![1];
  assert.equal(flatIncome, flatDaily, "the flat-day share must not drift from the measurement");

  // The band is asymmetric (-2.3% .. +2.4%); income quotes the downside, which
  // is the one that decides whether a plan survives.
  const sigmaDaily = daily.match(/\(-([\d.]+)% to [\d.]+% of equity\)/)![1];
  const sigmaIncome = income.match(/\(([\d.]+)% of equity\)/)![1];
  assert.equal(sigmaIncome, Number(sigmaDaily).toFixed(1), "the daily swing must match too");
});
