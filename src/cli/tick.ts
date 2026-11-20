#!/usr/bin/env node
/**
 * Run exactly one tick, locally.
 *
 *   npm run tick
 *
 * In paper mode this needs no credentials at all. It is the same code path the
 * deployed cron uses, so if this works, the deployed bot works.
 */

import { loadConfig } from "../config.ts";
import { runTick } from "../engine.ts";
import { buildDeps } from "../runtime.ts";
import { c, formatTick } from "./format.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const deps = buildDeps(cfg);

  console.log(c.dim(`tick · ${cfg.mode} · ${cfg.symbol} · ${cfg.strategy}`));
  const result = await runTick(deps);
  console.log(formatTick(result));

  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(c.red(`fatal: ${(err as Error).message}`));
  process.exitCode = 1;
});
