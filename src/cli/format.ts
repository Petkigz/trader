/** ANSI helpers and console renderers. No dependencies, degrades to plain text. */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("36"),
  magenta: wrap("35"),
  grey: wrap("90"),
};

export function money(n: number, digits = 2): string {
  const s = Math.abs(n).toFixed(digits);
  return `${n < 0 ? "-" : ""}${s}`;
}

export function pnlColor(n: number): (s: string) => string {
  return n > 0 ? c.green : n < 0 ? c.red : c.dim;
}

export function signed(n: number, digits = 2): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

export function formatTick(r: {
  ok: boolean;
  skipped: string | null;
  mode: string;
  symbol: string;
  action: string;
  reason: string;
  detail: string;
  price: number;
  equityBefore: number;
  equityAfter: number;
  cash: number;
  positionQty: number;
  entriesBlocked: boolean;
  changePct: number;
  events: string[];
  durationMs: number;
  error?: string;
}): string {
  if (r.skipped && r.skipped !== "stale_data") {
    return c.yellow(`skipped: ${r.skipped}`);
  }

  const lines: string[] = [];
  const arrow = r.action === "ENTER_LONG" ? c.green("▲ ENTER_LONG") : r.action === "EXIT_LONG" ? c.red("▼ EXIT_LONG") : c.dim("· HOLD");

  lines.push("");
  lines.push(`${c.bold(r.symbol)}  ${arrow}  ${c.grey(`[${r.mode}]`)}`);
  lines.push(`  ${r.detail || r.reason}`);
  lines.push("");
  lines.push(`  price          ${r.price.toFixed(2)}  ${pnlColor(r.changePct)(`${signed(r.changePct, 2)}%`)}`);
  lines.push(`  equity         ${r.equityBefore.toFixed(2)} -> ${c.bold(r.equityAfter.toFixed(2))} USDT`);
  lines.push(`  cash           ${r.cash.toFixed(2)} USDT`);
  lines.push(`  position       ${r.positionQty > 0 ? `${r.positionQty} ${r.symbol.replace(/USDT$/, "")}` : c.dim("flat")}`);
  if (r.entriesBlocked) lines.push(`  ${c.yellow("entries blocked")}`);
  for (const e of r.events) lines.push(`  ${c.yellow("•")} ${e}`);
  if (!r.ok && r.error) lines.push(`  ${c.red("error:")} ${r.error}`);
  lines.push(`  ${c.grey(`${r.durationMs}ms`)}`);
  return lines.join("\n");
}

export function table(rows: Array<[string, string]>, indent = "  "): string {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${indent}${c.grey(k.padEnd(width))}  ${v}`).join("\n");
}
