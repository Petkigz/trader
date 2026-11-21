#!/usr/bin/env node
/** Pretty-print the current bot status from the store. */

import { loadConfig } from "../config.ts";
import { buildStore } from "../runtime.ts";
import { buildStatus } from "../status.ts";
import { c, pnlColor, signed, table } from "./format.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = buildStore(cfg);
  const s = await buildStatus(cfg, store);

  const lines: string[] = [];
  lines.push("");
  lines.push(c.bold(`  AUTOPILOT TRADER · ${s.bot.symbol} · ${s.bot.strategy} · ${s.bot.mode.toUpperCase()}`));
  lines.push("");

  lines.push(
    table([
      ["equity", `${c.bold(s.account.equity.toFixed(2))} USDT`],
      ["return", pnlColor(s.account.totalReturnPct)(`${signed(s.account.totalReturnPct)}%`) + c.grey(` from ${s.account.startEquity.toFixed(2)}`)],
      ["drawdown", `${s.account.drawdownPct.toFixed(2)}% ${c.grey(`(peak ${s.account.highWaterMark.toFixed(2)})`)}`],
      ["last tick", s.bot.lastTickAgeMinutes === null ? c.grey("never") : `${s.bot.lastTickAgeMinutes} min ago`],
      ["status", s.risk.entriesBlocked ? c.yellow(`blocked (${s.risk.blockReason})`) : c.green("active")],
    ]),
  );

  lines.push("");
  if (s.position) {
    const p = s.position;
    lines.push(c.bold("  POSITION"));
    lines.push(
      table([
        ["qty", `${p.qty}`],
        ["entry", `${p.entryPrice}`],
        ["mark", `${p.markPrice}`],
        ["unrealised", pnlColor(p.unrealizedPnl)(`${signed(p.unrealizedPnl)} USDT (${signed(p.unrealizedPct)}%)`)],
        ["stop / target", `${p.stopPrice ?? "—"} / ${p.targetPrice ?? "—"}`],
        ["held", `${p.heldHours}h`],
      ]),
    );
    lines.push("");
  } else {
    lines.push(c.grey("  POSITION  flat — waiting in cash"));
    lines.push("");
  }

  const perf = s.performance;
  lines.push(c.bold("  PERFORMANCE"));
  lines.push(
    table([
      ["round trips", `${perf.roundTrips}`],
      ["win rate", `${perf.winRate > 0 ? (perf.winRate * 100).toFixed(0) : "—"}%`],
      ["realised", pnlColor(perf.realizedPnl)(`${signed(perf.realizedPnl)} USDT`)],
      ["fees paid", `${perf.feesPaid.toFixed(4)} USDT`],
    ]),
  );

  if (s.recentTrades.length) {
    lines.push("");
    lines.push(c.bold("  RECENT TRADES"));
    for (const t of s.recentTrades.slice(0, 10)) {
      const side = t.side === "BUY" ? c.green("BUY ") : c.red("SELL");
      const when = new Date(t.ts).toISOString().slice(0, 16).replace("T", " ");
      const pnl = t.realizedPnlQuote === null ? "" : pnlColor(t.realizedPnlQuote)(` ${signed(t.realizedPnlQuote)}`);
      lines.push(`  ${c.grey(when)}  ${side} ${t.qty} @ ${t.price.toFixed(2)}${pnl}  ${c.grey(t.reason)}`);
    }
  }

  lines.push("");
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(c.red(`fatal: ${(err as Error).message}`));
  process.exitCode = 1;
});
