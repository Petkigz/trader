#!/usr/bin/env node
/**
 * Local development server.
 *
 *   node scripts/dev-server.ts        # http://localhost:3000
 *
 * Serves ./public and routes /api/* to the real Vercel handlers, so what you
 * see locally is what runs in production. If no Supabase credentials are set,
 * /api/status falls back to a clearly-labelled demo snapshot so the dashboard
 * is not an empty page on a fresh clone.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { hasStore, loadConfig } from "../src/config.ts";
import { buildDemoSnapshot } from "../src/demo.ts";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = join(import.meta.dirname, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function loadHandler(name: string) {
  const mod = await import(`../api/${name}.ts`);
  return mod.default as (req: unknown, res: unknown) => Promise<void>;
}

function makeRes(raw: import("node:http").ServerResponse) {
  return {
    status(code: number) {
      raw.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      raw.setHeader(name, value);
    },
    json(body: unknown) {
      raw.setHeader("Content-Type", "application/json; charset=utf-8");
      raw.end(JSON.stringify(body, null, 2));
    },
    end(chunk?: string) {
      raw.end(chunk);
    },
  };
}

// The local dev server keeps the dashboard's backtest panel usable without
// configuration, because it only ever listens on localhost. Production
// (/api/backtest on Vercel) stays closed unless it is opted into — see
// PUBLIC_BACKTEST in .env.example.
if (!process.env.PUBLIC_BACKTEST) process.env.PUBLIC_BACKTEST = "true";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith("/api/")) {
      const name = pathname.slice(5).replace(/[^a-z0-9-]/gi, "");
      const query: Record<string, string> = Object.fromEntries(url.searchParams.entries());

      // Demo fallback so the dashboard has something to show without a database.
      if (name === "status" && !hasStore(loadConfig())) {
        const cfg = loadConfig();
        const demo = buildDemoSnapshot(cfg);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify(
            { ...demo, demo: true, note: "DEMO DATA — simulated market, no Supabase configured" },
            null,
            2,
          ),
        );
        return;
      }

      const handler = await loadHandler(name);
      await handler({ method: req.method, headers: req.headers, query }, makeRes(res));
      return;
    }

    const clean = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const file = clean === "/" || clean === "" ? join(ROOT, "index.html") : join(ROOT, clean);
    const body = await readFile(file);
    res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(body);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 500;
    res.end(`error: ${e.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`dev server listening on http://0.0.0.0:${PORT}`);
});
