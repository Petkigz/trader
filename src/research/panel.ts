/**
 * Shared panel plumbing for the research scripts.
 *
 * A month-major matrix of (variant − baseline) returns is what makes a pooled
 * cross-section bootstrappable: rows are months, so resampling blocks of rows
 * keeps both serial dependence and the cross-asset correlation that would
 * otherwise make twenty altcoins look like twenty independent observations.
 */

export interface MonthlyRow {
  symbol: string;
  monthly: Map<string, number>;
}

/** Restrict a monthly map to months at or after `from` (e.g. "2024-01"). */
export function since(monthly: Map<string, number>, from: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of monthly) if (k >= from) out.set(k, v);
  return out;
}

/**
 * Month-major panel of `variant − baseline` monthly returns.
 *
 * Months with no data on either side are skipped rather than filled with zero:
 * a zero would claim "no difference" for a month the asset did not trade.
 */
export function monthlyDiffPanel(variant: readonly MonthlyRow[], baseline: readonly MonthlyRow[]): number[][] {
  const months = new Set<string>();
  for (const r of baseline) for (const k of r.monthly.keys()) months.add(k);

  const rows: number[][] = [];
  for (const month of [...months].sort()) {
    const cells: number[] = [];
    for (let i = 0; i < variant.length; i++) {
      const a = variant[i].monthly.get(month);
      const b = baseline[i].monthly.get(month);
      if (a !== undefined && b !== undefined) cells.push(a - b);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}
