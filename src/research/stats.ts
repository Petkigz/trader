/**
 * Cross-sectional statistics.
 *
 * The single-asset problem in this repo is that a 34-trade backtest cannot
 * distinguish an edge from luck. Pooling many assets fixes the sample size but
 * creates a subtler problem: crypto assets are highly correlated, so treating
 * 20 coins as 20 independent observations overstates significance by a wide
 * margin.
 *
 * The honest tool for that is a **time-block bootstrap over the panel**: months
 * are resampled as contiguous blocks, and every asset's value for a given month
 * moves together. That preserves both serial dependence and cross-asset
 * dependence, so the confidence interval is the one that would survive a
 * colleague asking "but aren't they all just BTC with extra steps?".
 */

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n − 1). */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

/**
 * One-sample t statistic for the mean being zero.
 *
 * Reported for completeness, but on a correlated cross-section it is
 * **optimistic** — use `blockBootstrap` for anything that has to hold up.
 */
export function tStat(xs: readonly number[]): number {
  if (xs.length < 2) return Number.NaN;
  const s = sd(xs);
  if (!(s > 0)) return Number.NaN;
  return mean(xs) / (s / Math.sqrt(xs.length));
}

/**
 * **One-sided** binomial p-value for "better than a coin flip": P(X ≥ wins).
 *
 * One-sided on purpose — the hypothesis here is directional ("the ensemble is
 * better"), so the two-sided doubling would be answering a question nobody
 * asked. 4 wins out of 6 is p = 0.344, not a finding.
 */
export function signTestP(wins: number, n: number): number {
  if (n <= 0 || wins < 0) return Number.NaN;
  const choose = (nn: number, k: number): number => {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (nn - k + i)) / i;
    return r;
  };
  let tail = 0;
  for (let k = wins; k <= n; k++) tail += choose(n, k);
  return Math.min(1, tail / 2 ** n);
}

export interface BootstrapResult {
  /** Observed mean of every cell, unmetresampled. */
  observed: number;
  lo95: number;
  hi95: number;
  reps: number;
  block: number;
  /** Fraction of resamples with the wrong sign — a bootstrap "p" in plain words. */
  wrongSign: number;
  /** Mean of the resampled statistics; a bootstrap should centre here. */
  drawsMean: number;
}

/**
 * Block bootstrap over a panel of monthly values.
 *
 * `panel[i]` is one month; its entries are that month's value for every asset
 * (aligned, same order). Contiguous blocks of months are drawn with replacement
 * and every asset moves with its month, so cross-asset correlation is inside
 * the interval instead of being assumed away.
 */
export function blockBootstrap(
  panel: ReadonlyArray<readonly number[]>,
  opts: { block?: number; reps?: number; seed?: number } = {},
): BootstrapResult {
  const block = Math.max(1, opts.block ?? 6);
  const reps = Math.max(1, opts.reps ?? 2000);
  let seed = (opts.seed ?? 12345) >>> 0;

  const cells = panel.flat();
  const observed = mean(cells);
  if (panel.length === 0 || cells.length === 0) {
    return {
      observed,
      lo95: Number.NaN,
      hi95: Number.NaN,
      reps,
      block,
      wrongSign: Number.NaN,
      drawsMean: Number.NaN,
    };
  }

  // Contiguous slices — the whole block, not just its first row. Pushing only
  // panel[start] would resample months 0, 6, 12, ... and quietly bias every
  // interval towards whatever those months happened to do.
  const blocks: Array<Array<readonly number[]>> = [];
  for (let start = 0; start < panel.length; start += block) {
    blocks.push(panel.slice(start, start + block));
  }
  const nBlocks = Math.ceil(panel.length / block);

  const draws: number[] = [];
  for (let r = 0; r < reps; r++) {
    let acc = 0;
    let n = 0;
    for (let b = 0; b < nBlocks; b++) {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      const idx = Math.min(blocks.length - 1, Math.floor(u * blocks.length));
      for (const row of blocks[idx]) {
        for (const v of row) {
          acc += v;
          n += 1;
        }
      }
    }
    draws.push(acc / n);
  }

  draws.sort((a, b) => a - b);
  const at = (q: number): number => draws[Math.min(draws.length - 1, Math.floor(q * draws.length))];
  const sign = Math.sign(observed) || 1;
  const wrongSign = draws.filter((d) => Math.sign(d) !== sign).length / draws.length;
  return {
    observed,
    lo95: at(0.025),
    hi95: at(0.975),
    reps,
    block,
    wrongSign,
    drawsMean: mean(draws),
  };
}

/** Annualise a monthly return. */
export function annualise(monthlyReturn: number): number {
  return (1 + monthlyReturn) ** 12 - 1;
}

/** Annualised Sharpe from monthly returns (risk-free 0). */
export function sharpeFromMonthly(monthly: readonly number[]): number {
  const s = sd(monthly);
  if (!(s > 0)) return Number.NaN;
  return (mean(monthly) / s) * Math.sqrt(12);
}
