/**
 * Champion / challenger promotion — the only form of learning that is safe here.
 *
 * A challenger is a candidate rule or parameter set that runs in **shadow mode**
 * against its own ledger. It never touches the live position. It can only take
 * over if it clears a rule that was written down *before* its result was seen.
 *
 * The rule has three parts, and each one exists because its absence produced a
 * wrong answer somewhere in this repository:
 *
 *   1. **Pre-registration.** A challenger cannot be registered without a
 *      written hypothesis and a sample floor. `ENSEMBLE_SCORE_WINDOW=250` was
 *      chosen after seeing four windows, which is exactly what this blocks.
 *   2. **A sample floor.** Four decisions a year means a challenger accumulates
 *      decisions glacially. The floor refuses to judge on a handful of outcomes
 *      rather than pretending it can.
 *   3. **A multiplicity-aware bar.** The more challengers that have ever been
 *      tried, the higher the bar — because the best of k attempts looks good by
 *      construction. The registry's job is to remember every failed attempt so
 *      this count stays honest. A registry that forgets makes the bar a lie.
 *
 * Demotion is the mirror image: a champion that stops performing hands control
 * back to the rule it displaced, or to cash, without anyone intervening.
 */

import { expectedMaxZ } from "./walkforward.ts";

export interface ChallengerSpec {
  /** Stable identity, e.g. "meanrev-rsi35". Used as the registry key. */
  id: string;
  strategy: string;
  /** Environment overrides this challenger runs with. */
  env: Record<string, string>;
  /**
   * The claim, written at registration and never edited. A challenger without a
   * falsifiable hypothesis is not an experiment, it is a hunch with a ledger.
   */
  hypothesis: string;
  /** Minimum shadow decisions before any judgement is allowed. */
  minDecisions: number;
  registeredAt: number;
}

export interface ChallengerOutcome {
  /** Shadow decisions (round trips) observed so far. */
  decisions: number;
  /** Compounded shadow return, as a fraction (0.12 = +12%). */
  returnPct: number;
  /** Sharpe of the shadow equity curve, annualised. */
  sharpe: number;
  /** Champion's return and Sharpe over the identical window. */
  championReturnPct: number;
  championSharpe: number;
  /** Per-asset results, for the consistency requirement. */
  perAsset?: Array<{ symbol: string; returnPctDiff: number }>;
}

export interface PromotionVerdict {
  promote: boolean;
  /** Human-readable reasons, in the order they were checked. */
  reasons: string[];
  /** The bar this challenger had to clear, for the record. */
  required: { minDecisions: number; minEdgePct: number; attempts: number };
  observed: { decisions: number; edgePct: number; edgeSharpe: number };
}

export const defaultPromotion = {
  /** Default floor: 100 shadow round trips. At 4/year that is ~25 years. */
  minDecisions: 100,
  /** Fraction of assets that must show a positive difference. */
  consistency: 0.5,
  /** Hard cap so a runaway registry cannot make the bar unreachable forever. */
  maxAttemptsForBar: 500,
};

/**
 * The edge a challenger must show, given how many have been tried.
 *
 * Derived from the expected maximum of `attempts` standard normals: if you try
 * k independent candidates, the luckiest one's edge looks like `expectedMaxZ(k)`
 * standard errors even when nothing is there. Returning that in return-space
 * requires a scale, so the caller supplies the standard error of its own metric;
 * the default here is expressed in "standard errors" and converted by the
 * evaluator.
 */
export function requiredEdgeSE(attempts: number): number {
  const k = Math.max(1, Math.min(attempts, defaultPromotion.maxAttemptsForBar));
  return expectedMaxZ(k);
}

/**
 * Judge a challenger. Pure: it takes the spec, the outcome and the number of
 * attempts ever registered, and returns a verdict with its reasoning attached.
 *
 * `edgeSEPct` is the standard error of the return difference, used to convert
 * the multiplicity bar into the same units as the challenger's return.
 */
export function evaluatePromotion(
  spec: ChallengerSpec,
  outcome: ChallengerOutcome,
  attempts: number,
  edgeSEPct: number,
): PromotionVerdict {
  const reasons: string[] = [];
  const minDecisions = Math.max(1, spec.minDecisions);
  const edgePct = outcome.returnPct - outcome.championReturnPct;
  const edgeSharpe = outcome.sharpe - outcome.championSharpe;
  const minEdgePct = requiredEdgeSE(attempts) * Math.abs(edgeSEPct);

  const required = { minDecisions, minEdgePct, attempts };
  const observed = { decisions: outcome.decisions, edgePct, edgeSharpe };

  if (!spec.hypothesis || spec.hypothesis.trim().length < 20) {
    reasons.push("no pre-registered hypothesis: a trial without a claim cannot be judged");
    return { promote: false, reasons, required, observed };
  }

  if (outcome.decisions < minDecisions) {
    reasons.push(
      `insufficient sample: ${outcome.decisions} held-out round trips, floor is ${minDecisions}`,
    );
    return { promote: false, reasons, required, observed };
  }

  // The multiplicity bar: with `attempts` challengers tried, "better than the
  // champion" has to mean better than the luckiest of `attempts` coin flips.
  if (edgePct <= minEdgePct) {
    reasons.push(
      `edge ${fmt(edgePct)} is inside the luck bar ${fmt(minEdgePct)} for ${attempts} attempts`,
    );
    return { promote: false, reasons, required, observed };
  }
  reasons.push(`edge ${fmt(edgePct)} clears the luck bar ${fmt(minEdgePct)}`);

  if (edgeSharpe <= 0) {
    reasons.push(`risk-adjusted edge is not positive (ΔSharpe ${edgeSharpe.toFixed(2)})`);
    return { promote: false, reasons, required, observed };
  }
  reasons.push(`risk-adjusted edge positive (ΔSharpe ${edgeSharpe.toFixed(2)})`);

  if (outcome.perAsset && outcome.perAsset.length > 0) {
    const share =
      outcome.perAsset.filter((a) => a.returnPctDiff > 0).length / outcome.perAsset.length;
    if (share < defaultPromotion.consistency) {
      reasons.push(
        `inconsistent: only ${(share * 100).toFixed(0)}% of assets improved, need ` +
          `${(defaultPromotion.consistency * 100).toFixed(0)}%`,
      );
      return { promote: false, reasons, required, observed };
    }
    reasons.push(`${(share * 100).toFixed(0)}% of assets improved`);
  }

  reasons.push("promote: every gate cleared");
  return { promote: true, reasons, required, observed };
}

/** Should the incumbent be demoted? The mirror of promotion, with a lower bar. */
export function evaluateDemotion(
  championReturnPct: number,
  baselineReturnPct: number,
  decisions: number,
  minDecisions: number,
): { demote: boolean; reason: string } {
  if (decisions < minDecisions) {
    return { demote: false, reason: `insufficient sample (${decisions} < ${minDecisions})` };
  }
  if (championReturnPct < baselineReturnPct) {
    return {
      demote: true,
      reason: `champion ${fmt(championReturnPct)} trails its displaced rule ${fmt(baselineReturnPct)}`,
    };
  }
  return { demote: false, reason: "champion still ahead of the displaced rule" };
}

function fmt(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
}

export interface RegistryEntry {
  spec: ChallengerSpec;
  status: "shadow" | "promoted" | "rejected" | "retired";
  outcome?: ChallengerOutcome;
  verdict?: PromotionVerdict;
  updatedAt: number;
}

/**
 * The memory that keeps the luck bar honest.
 *
 * Deliberately dumb: a JSON document. Its only real job is `attempts` — the
 * count of everything ever tried, including (especially) the failures. Anything
 * that can forget a rejected challenger will eventually promote a lucky one.
 */
export class ChallengerRegistry {
  private entries = new Map<string, RegistryEntry>();

  constructor(initial: RegistryEntry[] = []) {
    for (const e of initial) this.entries.set(e.spec.id, e);
  }

  /** Register a new challenger. Refuses duplicates and unprovenanced specs. */
  register(spec: ChallengerSpec): RegistryEntry {
    if (this.entries.has(spec.id)) {
      throw new Error(`challenger "${spec.id}" is already registered`);
    }
    if (!spec.hypothesis || spec.hypothesis.trim().length < 20) {
      throw new Error(
        `challenger "${spec.id}" needs a pre-registered hypothesis (≥20 chars) written before results`,
      );
    }
    const entry: RegistryEntry = { spec, status: "shadow", updatedAt: Date.now() };
    this.entries.set(spec.id, entry);
    return entry;
  }

  /** Record an outcome and apply the promotion rule. */
  assess(
    id: string,
    outcome: ChallengerOutcome,
    edgeSEPct: number,
    now = Date.now(),
  ): PromotionVerdict {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown challenger "${id}"`);
    const verdict = evaluatePromotion(entry.spec, outcome, this.attempts, edgeSEPct);
    entry.outcome = outcome;
    entry.verdict = verdict;
    entry.status = verdict.promote ? "promoted" : "shadow";
    entry.updatedAt = now;
    return verdict;
  }

  /**
   * Withdraw a promotion after a later gate fails, and keep the reason.
   *
   * A promotion that the registry still believes in after the evidence went
   * against it is worse than no promotion at all: the next reader trusts it.
   */
  withdraw(id: string, reason: string, now = Date.now()): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown challenger "${id}"`);
    entry.status = "shadow";
    const verdict = entry.verdict;
    if (verdict) {
      entry.verdict = {
        ...verdict,
        promote: false,
        reasons: [...verdict.reasons, `promotion withdrawn: ${reason}`],
      };
    }
    entry.updatedAt = now;
  }

  /** Retire a challenger without promoting it. It still counts as an attempt. */
  retire(id: string, now = Date.now()): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`unknown challenger "${id}"`);
    entry.status = "retired";
    entry.updatedAt = now;
  }

  /** Every challenger ever registered — failed attempts included, by design. */
  get attempts(): number {
    return this.entries.size;
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.spec.registeredAt - b.spec.registeredAt);
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  /** Currently promoted challengers (more than one is allowed in principle). */
  promoted(): RegistryEntry[] {
    return this.list().filter((e) => e.status === "promoted");
  }

  toJSON(): RegistryEntry[] {
    return this.list();
  }

  static fromJSON(data: unknown): ChallengerRegistry {
    if (!Array.isArray(data)) throw new Error("registry file must be a JSON array");
    return new ChallengerRegistry(data as RegistryEntry[]);
  }
}
