/**
 * Gates: the places where market context is allowed to veto a trade.
 *
 * Each gate answers one question about one blind spot, and each is off unless
 * switched on. A gate may only ever *refuse* an entry — never create one, never
 * resize one, never block an exit. That asymmetry is the whole safety argument:
 * the worst a bad gate can do is cost opportunity, not capital.
 *
 * `npm run context` measures what each gate is worth before any of them is
 * switched on in the bot.
 */

import type { ContextPoint } from "./context.ts";

export type GateName = "off" | "market" | "volume" | "participation" | "cost" | "all";

export interface GateDecision {
  allow: boolean;
  /** Empty when allowed; otherwise the reason, for the audit log. */
  reason: string;
}

export interface GateOptions {
  /**
   * Volume ratio below which an entry is refused. 0.5 means "volume is less
   * than half its recent average".
   */
  minVolumeRatio?: number;
  /**
   * How many times the round-trip cost the daily range must cover. 10 means
   * "the average day is ten times the friction".
   */
  minEdgeToCost?: number;
  /** Floor for the range-expansion proxy, when no volume series is available. */
  minRangeExpansion?: number;
}

const DEFAULTS = { minVolumeRatio: 0.5, minEdgeToCost: 10, minRangeExpansion: 0.7 };

export function gateDecision(
  name: GateName,
  ctx: ContextPoint | undefined,
  opts: GateOptions = {},
): GateDecision {
  if (name === "off") return { allow: true, reason: "" };
  if (!ctx) return { allow: true, reason: "" };
  const o = { ...DEFAULTS, ...opts };

  if (name === "market") return marketGate(ctx);
  if (name === "volume") return volumeGate(ctx, o.minVolumeRatio);
  if (name === "participation") return participationGate(ctx, o.minRangeExpansion);
  if (name === "cost") return costGate(ctx, o.minEdgeToCost);

  // "all": every gate must pass, and the reason names the first that did not.
  for (const g of ["market", "volume", "participation", "cost"] as const) {
    const d = gateDecision(g, ctx, opts);
    if (!d.allow) return d;
  }
  return { allow: true, reason: "" };
}

/**
 * Trade with the market, not against it.
 *
 * An alt below its own average while the market is above its own is a different
 * proposition from the reverse: the first is an idiosyncratic bet, the second is
 * a bet against a rising tide. Unknown context (no reference series, or a bar
 * the reference does not cover) is allowed — a missing input must not silently
 * become a permanent veto.
 */
function marketGate(ctx: ContextPoint): GateDecision {
  if (ctx.marketAboveEma === null) return { allow: true, reason: "" };
  if (ctx.marketAboveEma) return { allow: true, reason: "" };
  return {
    allow: false,
    reason: `market below its long average (${((ctx.marketDistancePct ?? 0) * 100).toFixed(1)}%)`,
  };
}

/** A breakout on collapsing volume is a different trade from one on real flow. */
function volumeGate(ctx: ContextPoint, min: number): GateDecision {
  if (ctx.volumeRatio === null) return { allow: true, reason: "" };
  if (ctx.volumeRatio >= min) return { allow: true, reason: "" };
  return {
    allow: false,
    reason: `volume at ${ctx.volumeRatio.toFixed(2)}x its average (floor ${min})`,
  };
}

/**
 * The participation proxy, for a panel with no volume.
 *
 * A breakout on a bar whose range is *contracting* is a quieter claim than one
 * on an expanding bar: nobody moved much, and price drifted over its average.
 * Range is not volume — it says how far price went, not how much money went
 * with it — but it is the closest thing observable in OHLC, and the alternative
 * is deciding with nothing.
 */
function participationGate(ctx: ContextPoint, min: number): GateDecision {
  if (ctx.rangeExpansion === null) return { allow: true, reason: "" };
  if (ctx.rangeExpansion >= min) return { allow: true, reason: "" };
  return {
    allow: false,
    reason: `range at ${ctx.rangeExpansion.toFixed(2)}x its average (floor ${min}) — a quiet bar`,
  };
}

/**
 * The move has to pay for its own friction.
 *
 * Fees and slippage are known in advance. If the average daily range is not many
 * times that number, the strategy is trying to earn a fraction of a percent
 * after paying a fraction of a percent, and needs an accuracy nobody has.
 */
function costGate(ctx: ContextPoint, minMultiple: number): GateDecision {
  if (ctx.edgeToCost === null) return { allow: true, reason: "" };
  if (ctx.edgeToCost >= minMultiple) return { allow: true, reason: "" };
  return {
    allow: false,
    reason:
      `daily range ${((ctx.atrPct ?? 0) * 100).toFixed(2)}% is only ` +
      `${ctx.edgeToCost.toFixed(1)}x the ${(ctx.costPct * 100).toFixed(2)}% round-trip cost`,
  };
}

/** Machine tag for the tick record, so a veto is visible rather than mysterious. */
export function gateTag(name: GateName): string {
  return name === "off" ? "" : `gate:${name}`;
}
