/**
 * Endpoint authorisation for the serverless functions.
 *
 * Rules, in order of preference:
 *  1. If a secret is configured, the request must present it (Bearer header or
 *     ?key=). Vercel's cron sends `Authorization: Bearer $CRON_SECRET` for you.
 *  2. If no secret is configured, we only allow the request in paper mode,
 *     where no money can move. Live mode refuses to run unauthenticated.
 */

export interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}

export interface AuthResult {
  ok: boolean;
  reason: string;
  status: number;
}

function headerOf(req: MinimalRequest, name: string): string | undefined {
  const raw = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function presentedToken(req: MinimalRequest): string | undefined {
  const auth = headerOf(req, "authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  const key = req.query?.key ?? req.query?.token;
  if (Array.isArray(key)) return key[0];
  return key || undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authorize(req: MinimalRequest, secret: string, opts: { allowWhenUnset: boolean }): AuthResult {
  if (secret) {
    const presented = presentedToken(req);
    if (presented && safeEqual(presented, secret)) return { ok: true, reason: "token", status: 200 };
    return { ok: false, reason: "missing or invalid token", status: 401 };
  }

  if (opts.allowWhenUnset) return { ok: true, reason: "no secret configured", status: 200 };
  return {
    ok: false,
    reason: "refusing unauthenticated request: set CRON_SECRET (or DASHBOARD_TOKEN) in the environment",
    status: 503,
  };
}
