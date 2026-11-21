#!/usr/bin/env node
/**
 * Deploy pre-flight: the things that break a deploy, checked rather than
 * remembered.
 *
 *   npm run deploy:check
 *
 * Three classes of finding, and the difference matters:
 *
 *   FAIL  the deploy will not work, or will work unsafely.
 *   WARN  it will deploy, but you should know what you are getting.
 *   OK    checked and fine.
 *
 * Deliberately offline: it reads the repo and calls `loadConfig`, and it talks
 * to no network. A check that needs the internet cannot be run at 2am.
 */

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../src/config.ts";

type Level = "OK" | "WARN" | "FAIL";

interface Finding {
  level: Level;
  check: string;
  detail: string;
}

const findings: Finding[] = [];
const add = (level: Level, check: string, detail: string) => findings.push({ level, check, detail });

async function main(): Promise<void> {
  await checkVercel();
  await checkImports();
  await checkBundles();
  await checkConfig();
  await checkSchema();
  await checkWorkflows();

  report();
}

/* -------------------------------------------------------------- vercel.json */

async function checkVercel(): Promise<void> {
  const path = "vercel.json";
  if (!existsSync(path)) {
    add("FAIL", "vercel.json", "missing — no crons, no function config");
    return;
  }
  let cfg: { crons?: Array<{ path: string; schedule: string }>; framework?: unknown };
  try {
    cfg = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    add("FAIL", "vercel.json", `not valid JSON: ${(err as Error).message}`);
    return;
  }

  const crons = cfg.crons ?? [];
  if (crons.length === 0) add("FAIL", "crons", "no cron registered — the bot would never tick");
  if (crons.length > 2) add("FAIL", "crons", `${crons.length} jobs; the Hobby plan allows 2`);

  for (const cron of crons) {
    const file = `api/${cron.path.replace(/^\//, "").replace(/^api\//, "")}.ts`;
    if (!existsSync(file)) add("FAIL", "crons", `${cron.path} has no handler at ${file}`);

    const fields = cron.schedule.trim().split(/\s+/);
    if (fields.length !== 5) {
      add("FAIL", "crons", `${cron.path} schedule "${cron.schedule}" is not 5-field cron`);
      continue;
    }
    if (isSubDaily(cron.schedule)) {
      add(
        "FAIL",
        "crons",
        `${cron.path} runs sub-daily ("${cron.schedule}") — Hobby rejects that at deploy time`,
      );
    }
  }
  if (crons.length > 0 && !crons.some((c) => isSubDaily(c.schedule))) {
    add("OK", "crons", `${crons.length} daily job(s), all paths present`);
  }
}

/** True when a schedule can fire more than once a day. */
function isSubDaily(schedule: string): boolean {
  const [minute, hour] = schedule.trim().split(/\s+/);
  const minuteWild = minute.includes("*") || minute.includes("/") || minute.includes(",");
  const hourWild = hour.includes("*") || hour.includes("/") || hour.includes(",");
  return hourWild || (minuteWild && !hourWild);
}

/* ----------------------------------------------------------------- imports */

async function checkImports(): Promise<void> {
  const files = await walk(["api", "src"]);
  let missing = 0;
  let tsSpecifiers = 0;

  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const spec = m[1];
      if (spec.endsWith(".ts")) tsSpecifiers++;
      const resolved = join(file, "..", spec);
      if (!existsSync(resolved)) {
        missing++;
        add("FAIL", "imports", `${file} imports ${spec}, which does not exist`);
      }
    }
  }

  if (missing === 0) {
    add(
      "OK",
      "imports",
      `${files.length} files, every relative import resolves` +
        (tsSpecifiers > 0 ? ` (${tsSpecifiers} use explicit .ts, as Node's loader requires)` : ""),
    );
  }
  if (tsSpecifiers === 0) {
    add("WARN", "imports", "no .ts specifiers found — check the loader is being exercised at all");
  }
}

async function walk(dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk([path])));
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
  }
  return out;
}

/* ----------------------------------------------------------------- bundles */

/**
 * The deploy artifact is whatever Vercel's bundler makes of `api/*.ts`, not the
 * source. Bundling every handler with esbuild — the same family @vercel/node
 * uses — catches the one class of failure that typechecking cannot: an import
 * that resolves under Node's loader but not under the bundler.
 *
 * Optional on purpose: esbuild is a devDependency, and the check should still
 * run (with a warning) on a machine that has not installed it.
 */
async function checkBundles(): Promise<void> {
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    add("WARN", "bundle", "esbuild not installed — deploy artifact not verified (npm i -D esbuild)");
    return;
  }

  const handlers = (await readdir("api")).filter((f) => f.endsWith(".ts"));
  const dir = await mkdtemp(join(tmpdir(), "deploy-check-"));
  let failed = 0;
  const built = new Map<string, string>();

  for (const file of handlers) {
    const out = join(dir, `${file.replace(/\.ts$/, "")}.mjs`);
    try {
      await esbuild.build({
        entryPoints: [join("api", file)],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: out,
        logLevel: "silent",
      });
      built.set(file, out);
    } catch (err) {
      failed++;
      add("FAIL", "bundle", `${file} does not bundle: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  if (failed === 0) {
    add("OK", "bundle", `${handlers.length} handlers bundle to ESM for node22`);
  }

  // Compiling is not running. Invoke the cheapest handler end to end.
  const health = built.get("health.ts");
  if (!health) return;
  try {
    const mod = (await import(pathToFileURL(health).href)) as {
      default: (req: unknown, res: unknown) => Promise<void>;
    };
    let code = 0;
    let body: unknown = null;
    const res = {
      status(c: number) {
        code = c;
        return res;
      },
      json(b: unknown) {
        body = b;
      },
      setHeader() {
        return res;
      },
    };
    await mod.default({ headers: {}, query: {} }, res);
    const ok = (body as { ok?: boolean } | null)?.ok;
    if (code === 200 || code === 503) {
      add("OK", "bundle runtime", `/api/health executed (HTTP ${code}, ok=${String(ok)})`);
    } else {
      add("WARN", "bundle runtime", "/api/health returned an unexpected status");
    }
  } catch (err) {
    add("FAIL", "bundle runtime", `/api/health threw when executed: ${(err as Error).message}`);
  }
}

/* ------------------------------------------------------------------ config */

async function checkConfig(): Promise<void> {
  // 1. It must start with nothing configured at all.
  try {
    const bare = loadConfig({});
    add("OK", "config", `loads with no environment: ${bare.mode} mode, ${bare.symbol}, ${bare.strategy}`);
    if (bare.mode === "paper") {
      add(
        "WARN",
        "config",
        "no environment means paper mode — it will not trade real money, and /api/status will show demo data without Supabase",
      );
    }
    if (!bare.publicBacktest) {
      add("OK", "backtest endpoint", "closed unless a token is set (PUBLIC_BACKTEST=false)");
    } else {
      add("WARN", "backtest endpoint", "PUBLIC_BACKTEST is on — anyone can spend your function quota");
    }
  } catch (err) {
    add("FAIL", "config", `does not load with an empty environment: ${(err as Error).message}`);
  }

  // 2. Live mode must refuse to start without keys.
  try {
    loadConfig({ BOT_MODE: "live" });
    add("FAIL", "live safety", "live mode started without API keys — this must throw");
  } catch {
    add("OK", "live safety", "live mode refuses to start without keys");
  }

  // 3. Live mode with keys, but no cron secret: the tick would refuse every call.
  try {
    const live = loadConfig({ BOT_MODE: "live", BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" });
    if (!live.security.cronSecret) {
      add(
        "WARN",
        "live safety",
        "live with no CRON_SECRET: /api/tick refuses unauthenticated calls, so nothing would ever trade — set it before flipping to live",
      );
    } else {
      add("OK", "live safety", "live mode has a cron secret and refuses unauthenticated ticks");
    }
  } catch (err) {
    add("FAIL", "live safety", `live config invalid: ${(err as Error).message}`);
  }

  // 4. The documented example must still cover every setting.
  const src = await readFile("src/config.ts", "utf8");
  const keys = new Set([...src.matchAll(/(?:str|num|bool|oneOf)\(\s*env,\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]));
  const example = await readFile(".env.example", "utf8");
  const documented = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const undocumented = [...keys].filter((k) => !documented.has(k));
  if (undocumented.length > 0) {
    add("FAIL", ".env.example", `undocumented settings: ${undocumented.join(", ")}`);
  } else {
    add("OK", ".env.example", `all ${keys.size} settings documented`);
  }
}

/* ------------------------------------------------------------------ schema */

async function checkSchema(): Promise<void> {
  const path = "supabase/migrations/0001_init.sql";
  if (!existsSync(path)) {
    add("FAIL", "schema", `${path} is missing — the store has nothing to read`);
    return;
  }
  const sql = await readFile(path, "utf8");
  const needed: Array<[string, RegExp]> = [
    ["bot_state table", /create table if not exists public\.bot_state/i],
    ["trades table", /create table if not exists public\.trades/i],
    ["ticks table", /create table if not exists public\.ticks/i],
    ["atomic lock function", /function public\.bot_acquire_lock/i],
    ["row level security", /enable row level security/i],
    ["singleton seed", /insert into public\.bot_state/i],
  ];
  const absent = needed.filter(([, re]) => !re.test(sql)).map(([name]) => name);
  if (absent.length > 0) {
    add("FAIL", "schema", `migration is missing: ${absent.join(", ")}`);
  } else {
    add("OK", "schema", "migration has the tables, the lock function, RLS and the seed row");
    add(
      "WARN",
      "schema",
      "the migration must actually be applied to the project — this check only reads the file",
    );
  }
}

/* --------------------------------------------------------------- workflows */

async function checkWorkflows(): Promise<void> {
  const workflows = existsSync(".github/workflows") ? await readdir(".github/workflows") : [];
  const tick = workflows.find((f) => f.startsWith("tick"));
  if (tick) {
    add("OK", "scheduler", `.github/workflows/${tick} exists as the sub-daily scheduler`);
  } else {
    add("WARN", "scheduler", "no GitHub Actions tick — STRATEGY=pullback would miss its own signals");
  }
}

/* ------------------------------------------------------------------ report */

function report(): void {
  const order: Record<Level, number> = { FAIL: 0, WARN: 1, OK: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);

  const icon = { FAIL: "FAIL", WARN: "WARN", OK: "  OK" } as const;
  for (const f of findings) {
    console.log(`[${icon[f.level]}] ${f.check.padEnd(18)} ${f.detail}`);
  }

  const fails = findings.filter((f) => f.level === "FAIL").length;
  const warns = findings.filter((f) => f.level === "WARN").length;
  console.log(
    `\n${fails === 0 ? "deployable" : "NOT deployable"}: ${fails} failure(s), ${warns} warning(s)`,
  );
  if (fails > 0) process.exitCode = 1;
}

void (async () => {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();
