/**
 * Runtime wiring: turn a config into ready-to-run engine dependencies.
 *
 * Called from the Vercel function, the CLI and the health check. Keeping this
 * in one place means there is exactly one way the bot is assembled, which is
 * one fewer thing to get subtly wrong at 3am.
 */

import { type BotConfig, hasStore, hasTelegram } from "./config.ts";
import type { EngineDeps } from "./engine.ts";
import { createExchange } from "./exchange/index.ts";
import type { PaperAccount } from "./exchange/index.ts";
import { MemoryStore } from "./store/memory.ts";
import { SupabaseStore } from "./store/supabase.ts";
import type { Store } from "./store/types.ts";
import { createLogger, type Logger } from "./util/logger.ts";
import { createNotifier } from "./util/notify.ts";

export function buildStore(cfg: BotConfig): Store {
  if (!hasStore(cfg)) return new MemoryStore();
  return new SupabaseStore(cfg.store.supabaseUrl, cfg.store.serviceRoleKey);
}

export function buildDeps(cfg: BotConfig, overrides: Partial<EngineDeps> = {}): EngineDeps {
  const log: Logger = overrides.log ?? createLogger(cfg.logLevel, { bot: "autopilot", mode: cfg.mode });

  if (!hasStore(cfg)) {
    log.warn("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using in-memory store (state will not persist)");
  }
  if (cfg.mode === "live" && !hasTelegram(cfg)) {
    log.warn("live mode without Telegram notifications — you will not hear about trades");
  }

  return {
    cfg,
    store: overrides.store ?? buildStore(cfg),
    createExchange: overrides.createExchange ?? ((paperAccount?: PaperAccount) => createExchange(cfg, paperAccount)),
    log,
    notify: overrides.notify ?? createNotifier(cfg, log),
    clock: overrides.clock,
  };
}
