import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

/** Run the venue script and return its table rows as arrays of numbers/text. */
function venues(args: string[] = []): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "scripts/venues.ts", ...args], {
    encoding: "utf8",
  });
}

test("the published venue numbers are reproducible from a committed script", () => {
  const out = venues();

  // The claim in docs/ASSET.md §3, now backed by an artifact.
  assert.match(out, /P\(account dead\)\s+0\.0%\s+8[0-9]\.\d%/, "MT5 at $10 must die ~85-90% of the time");
  assert.match(out, /median after 1 year\s+\$1\d\.\d\d\s+\$0\.00/);
  // Crypto spot cannot be liquidated, so it is never "dead".
  assert.match(out, /P\(account dead\)\s+0\.0%/);
});

test("death rate falls monotonically as equity rises — the threshold is real", () => {
  // equity, leverage, 1-sigma, ruin move, death rate, median
  const rows = [
    ...venues().matchAll(/\$\s*([\d.]+)\s+([\d.]+)x\s+([\d.]+)%\s+([\d.]+)%\s+([\d.]+)%/g),
  ].map((m) => ({ equity: Number(m[1]), dead: Number(m[5]) }));
  assert.ok(rows.length >= 6, `expected the equity sweep, parsed ${rows.length} rows`);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].dead <= rows[i - 1].dead + 1, `death rate rose from ${rows[i - 1].equity} to ${rows[i].equity}`);
  }
  const at10 = rows.find((r) => r.equity === 10);
  const at276 = rows.find((r) => r.equity === 276);
  assert.ok(at10 && at10.dead > 80, "at $10 the account is gone");
  assert.ok(at276 && at276.dead < 2, "at $276 it is not");
});

test("one lot cannot reach the $1/day bar at any account size", () => {
  const out = venues();
  // The structural finding: a fixed $1,160 notional caps the annual P&L, so
  // the goal is unreachable without adding lots.
  assert.match(out, /P\(goal\) with one lot: 0\.0%/);
});

test("the simulation is deterministic, so a disagreement is inspectable", () => {
  assert.equal(venues(["--equity=100"]), venues(["--equity=100"]));
});
