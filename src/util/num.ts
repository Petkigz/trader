/**
 * Numeric helpers. Money-bearing values always pass through here before they
 * reach an order, so a float artefact can never produce an invalid quantity.
 */

/** Round `value` down to the nearest multiple of `step`. */
export function floorToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return 0;
  // The epsilon stops 0.3/0.1 = 2.9999999999999996 from flooring to 2.
  const steps = Math.floor(value / step + 1e-9);
  return round(steps * step, decimalsOf(step));
}

/** Round `value` to the nearest multiple of `step` (used for prices). */
export function roundToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || step <= 0) return 0;
  return round(Math.round(value / step) * step, decimalsOf(step));
}

export function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Number of decimal places implied by a step such as 0.00001. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toExponential();
  const exp = Number(s.split("e")[1] ?? 0);
  return exp < 0 ? -exp : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function pct(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return (to - from) / from;
}

/** "2024-06-01" in UTC. */
export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

export function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Percentages in this repo range from 0.0037% to billions of percent. A number
 * that large stops being information, so it gets words once it passes a million.
 */
export function formatPercent(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const abs = Math.abs(x);
  const sign = x < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)} billion%`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)} million%`;
  if (abs >= 1e4) return `${sign}${Math.round(abs).toLocaleString()}%`;
  if (abs >= 10) return `${sign}${abs.toFixed(0)}%`;
  return `${sign}${abs.toFixed(2)}%`;
}
