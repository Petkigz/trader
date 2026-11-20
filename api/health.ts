/**
 * GET /api/health — cheap liveness probe for an uptime monitor.
 *
 * Returns 503 if the bot has not completed a tick in the last 3 days, which is
 * the signal that a scheduler has silently died. Point a free uptime service at
 * this and you will hear about a stalled bot without checking anything.
 */

import { loadConfig } from "../src/config.ts";
import { buildStore } from "../src/runtime.ts";

export const config = { maxDuration: 20 };

interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

const STALE_AFTER_MS = 3 * 86_400_000;

export default async function handler(_req: unknown, res: MinimalResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const cfg = loadConfig();
    const state = await buildStore(cfg).getState();
    const now = Date.now();
    const ageMs = state?.lastTickAt ? now - state.lastTickAt : null;
    const healthy = ageMs !== null && ageMs < STALE_AFTER_MS;

    res.status(healthy ? 200 : 503).json({
      ok: healthy,
      mode: cfg.mode,
      symbol: cfg.symbol,
      strategy: cfg.strategy,
      lastTickAt: state?.lastTickAt ?? 0,
      lastTickAgeHours: ageMs === null ? null : Math.round((ageMs / 3_600_000) * 10) / 10,
      position: state?.position ? "open" : "flat",
      halted: (state?.haltedUntil ?? 0) > now,
      note: ageMs === null ? "no tick has ever run — is the cron scheduled?" : undefined,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
