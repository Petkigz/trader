/** Tiny structured logger. One JSON line per event, which Vercel captures verbatim. */

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(level: LogLevel = "info", bindings: Record<string, unknown> = {}): Logger {
  const min = RANK[level] ?? RANK.info;

  const emit = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (RANK[lvl] < min) return;
    const line = { lvl, t: new Date().toISOString(), msg, ...bindings, ...data };
    const out = lvl === "error" ? console.error : lvl === "warn" ? console.warn : console.log;
    try {
      out(JSON.stringify(line));
    } catch {
      out(`${lvl} ${msg}`);
    }
  };

  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
    child: (b) => createLogger(level, { ...bindings, ...b }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
