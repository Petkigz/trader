import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

function fxEdge(): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "scripts/fx-edge.ts"], {
    encoding: "utf8",
  });
}

test("the FX edge measurement is reproducible and reports the decay", () => {
  const out = fxEdge();

  // Full history: the rule is mildly positive on every currency...
  assert.match(out, /positive in 7\/7 currencies full history/);
  // ...and negative on every one in the last 30%, which is the finding that
  // matters: a venue cannot create expectancy the asset class does not have.
  assert.match(out, /0\/7 in the last 30%/);
});

test("the equity needed for $1/day is derived from the measured edge, not assumed", () => {
  const out = fxEdge();
  const match = out.match(/at \$?([\d.]+)%\/yr, \$1\/day \(\+\$365\/yr\) needs \$([\d,]+) of equity/);
  assert.ok(match, "the script must state the derived equity figure");
  const edge = Number(match[1]);
  const equity = Number(match[2].replace(/,/g, ""));
  // 365 / edge should reproduce the quoted number to within rounding.
  const derived = 365 / (edge / 100);
  assert.ok(Math.abs(derived - equity) / equity < 0.01, `${edge}%/yr implies ${derived}, quoted ${equity}`);
});
