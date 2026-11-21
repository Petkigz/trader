/**
 * POST|GET /api/tick — the heartbeat.
 *
 * Called by the Vercel cron in vercel.json, or by anything else you point at it
 * (GitHub Actions, a uptime pinger, curl). Safe to call as often as you like:
 * the Postgres lock guarantees one execution at a time, and the signals are
 * functions of closed candles so extra calls are no-ops.
 */

import { authorize } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { runTick } from "../src/engine.ts";
import { buildDeps } from "../src/runtime.ts";
import type { MinimalRequest } from "../src/auth.ts";

export const config = { maxDuration: 60 };

interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

export default async function handler(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    res.status(500).json({ ok: false, error: `configuration invalid: ${(err as Error).message}` });
    return;
  }

  // In paper mode no money can move, so an unauthenticated call is harmless.
  const auth = authorize(req, cfg.security.cronSecret, { allowWhenUnset: cfg.mode === "paper" });
  if (!auth.ok) {
    res.status(auth.status).json({ ok: false, error: auth.reason });
    return;
  }

  const startedAt = Date.now();
  try {
    const result = await runTick(buildDeps(cfg));
    result.durationMs = Date.now() - startedAt;
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
