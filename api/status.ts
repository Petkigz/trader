/**
 * GET /api/status — read-only snapshot for the dashboard.
 *
 * Contains no secrets. Set DASHBOARD_TOKEN to require a token; otherwise the
 * numbers are public to anyone who knows the URL.
 */

import { authorize, type MinimalRequest } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { buildStore } from "../src/runtime.ts";
import { buildStatus } from "../src/status.ts";

export const config = { maxDuration: 30 };

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

  const auth = authorize(req, cfg.security.dashboardToken, { allowWhenUnset: true });
  if (!auth.ok) {
    res.status(auth.status).json({ ok: false, error: auth.reason });
    return;
  }

  try {
    const snapshot = await buildStatus(cfg, buildStore(cfg));
    res.status(200).json(snapshot);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
