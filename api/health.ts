/**
 * GET /api/health — cheap liveness probe for an uptime monitor.
 *
 * Two different failures matter, and an uptime monitor should hear about both:
 *
 *  1. **Nothing is running.** No tick for three days means the scheduler died.
 *  2. **Everything is failing.** A tick that throws still writes `lastTickAt` and
 *     records an `error` tick, so a "recent tick" check alone reports healthy
 *     while the bot has been broken for a week. The record says otherwise, so
 *     this endpoint reads the records instead of the timestamp.
 *
 * Returns 503 in both cases. Point a free uptime service at this and a stalled
 * or broken bot is something you hear about, not something you notice.
 */

import { loadConfig } from "../src/config.ts";
import { buildStore } from "../src/runtime.ts";
import type { BotConfig } from "../src/config.ts";
import type { Store } from "../src/store/types.ts";

export const config = { maxDuration: 20 };

interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

const STALE_AFTER_MS = 3 * 86_400_000;
/** How many consecutive failed ticks before we call it broken, not unlucky. */
const ERROR_STREAK_LIMIT = 3;

export interface HealthReport {
  ok: boolean;
  mode: string;
  symbol: string;
  strategy: string;
  lastTickAt: number;
  lastTickAgeHours: number | null;
  position: "open" | "flat";
  halted: boolean;
  /** Outcome of the most recent tick. */
  lastOutcome: string | null;
  consecutiveErrors: number;
  lastError: string | null;
  problems: string[];
  note?: string;
}

/**
 * Pure read of the store, so the rule can be tested without a HTTP server.
 */
export async function healthReport(store: Store, cfg: BotConfig, now: number): Promise<HealthReport> {
  const [state, ticks] = await Promise.all([
    store.getState().catch(() => null),
    store.recentTicks(ERROR_STREAK_LIMIT + 2).catch(() => []),
  ]);

  const ageMs = state?.lastTickAt ? now - state.lastTickAt : null;
  const stale = ageMs === null || ageMs >= STALE_AFTER_MS;

  // Ticks come back newest first.
  const consecutiveErrors = ticks.findIndex((t) => t.reason !== "error");
  const errorStreak = consecutiveErrors === -1 ? ticks.length : consecutiveErrors;
  const lastErrorTick = ticks.find((t) => t.reason === "error");
  const broken = errorStreak >= ERROR_STREAK_LIMIT;

  const problems: string[] = [];
  if (ageMs === null) problems.push("no tick has ever run — is the cron scheduled?");
  else if (stale) problems.push(`no tick for ${Math.round(ageMs / 3_600_000)}h — the scheduler may be dead`);
  if (broken) problems.push(`${errorStreak} consecutive ticks failed — the bot is running but not working`);
  if (state?.haltedUntil && state.haltedUntil > now) {
    problems.push(`halted until ${new Date(state.haltedUntil).toISOString()}: ${state.haltReason || "unknown"}`);
  }

  // A halt is a legitimate state, not a failure: the bot is working correctly.
  const ok = !stale && !broken;

  return {
    ok,
    mode: cfg.mode,
    symbol: cfg.symbol,
    strategy: cfg.strategy,
    lastTickAt: state?.lastTickAt ?? 0,
    lastTickAgeHours: ageMs === null ? null : Math.round((ageMs / 3_600_000) * 10) / 10,
    position: state?.position ? "open" : "flat",
    halted: Boolean(state?.haltedUntil && state.haltedUntil > now),
    lastOutcome: ticks[0]?.reason ?? null,
    consecutiveErrors: errorStreak,
    lastError: broken ? (lastErrorTick?.detail ?? "unknown error") : null,
    problems,
    note: stale ? "no tick has ever run — is the cron scheduled?" : undefined,
  };
}

export default async function handler(_req: unknown, res: MinimalResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const cfg = loadConfig();
    const report = await healthReport(buildStore(cfg), cfg, Date.now());
    res.status(report.ok ? 200 : 503).json(report);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
