import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadConfig } from "../src/config.ts";

/**
 * Every setting the code reads must be documented, or the .env.example stops
 * being the list of things you can turn and becomes a partial memory of them.
 */
test(".env.example documents every variable loadConfig reads", () => {
  const src = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const keys = new Set<string>();
  for (const m of src.matchAll(/(?:str|num|bool|oneOf)\(\s*env,\s*"([A-Z0-9_]+)"/g)) keys.add(m[1]);

  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const documented = new Set(
    [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]),
  );

  const missing = [...keys].filter((k) => !documented.has(k)).sort();
  assert.deepEqual(missing, [], `undocumented settings: ${missing.join(", ")}`);
  assert.ok(keys.size > 30, "the scan should find the real settings, not nothing");
});

test("the documented defaults actually load", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const m of example.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)) {
    if (m[2].trim() !== "") env[m[1]] = m[2].trim();
  }
  const cfg = loadConfig(env);
  assert.equal(cfg.mode, "paper", "the example must not ship in live mode");
  assert.ok(cfg.risk.minNotional > 0);
});

test("the expensive backtest endpoint is closed by default", async () => {
  const { authorize } = await import("../src/auth.ts");
  const { loadConfig: load } = await import("../src/config.ts");
  const cfg = load({ BOT_MODE: "paper" });
  assert.equal(cfg.publicBacktest, false);
  // No secret configured, opt-in not set: refuse. Paper mode is not a licence
  // to spend somebody else's function quota.
  const res = authorize({ headers: {} }, "", { allowWhenUnset: cfg.publicBacktest });
  assert.equal(res.ok, false);
});
