/**
 * Optional Telegram notifications.
 *
 * "No maintenance" should not mean "no visibility". If credentials are set the
 * bot messages you when it trades, hits a circuit breaker, or errors — then you
 * can ignore it for months and still know what happened.
 *
 * Failures here are swallowed on purpose: a broken notification channel must
 * never stop a trade.
 */

import type { BotConfig } from "../config.ts";
import type { Logger } from "./logger.ts";

export type Notifier = (text: string) => Promise<void>;

export function createNotifier(cfg: BotConfig, log: Logger): Notifier | undefined {
  const { telegramToken, telegramChatId } = cfg.notifications;
  if (!telegramToken || !telegramChatId) return undefined;

  return async (text: string) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) log.warn("telegram notification failed", { status: res.status });
    } catch (err) {
      log.warn("telegram notification error", { error: (err as Error).message });
    }
  };
}

export function formatTradeMessage(opts: {
  mode: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  quoteQty: number;
  realizedPnl: number | null;
  equity: number;
  reason: string;
  detail: string;
}): string {
  const arrow = opts.side === "BUY" ? "🟢 BUY" : "🔴 SELL";
  const pnl = opts.realizedPnl === null ? "" : `\nPnL: <b>${opts.realizedPnl >= 0 ? "+" : ""}${opts.realizedPnl.toFixed(2)}</b> USDT`;
  return (
    `${arrow} ${opts.symbol} <i>(${opts.mode})</i>\n` +
    `${opts.detail}\n` +
    `Qty: ${opts.qty}\n` +
    `Price: ${opts.price.toFixed(2)}\n` +
    `Value: ${opts.quoteQty.toFixed(2)} USDT${pnl}\n` +
    `Equity: <b>${opts.equity.toFixed(2)}</b> USDT\n` +
    `<i>${opts.reason}</i>`
  );
}
