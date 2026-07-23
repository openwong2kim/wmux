/**
 * CostEstimator — agent run cost estimator based on PTY output
 *
 * Anthropic API pricing (2026.03):
 *   Claude Opus 4.6:  $15/M input tokens,  $75/M output tokens
 *
 * Estimation method:
 *   - PTY output 1 char ≈ 1 output token (conservative estimate)
 *   - active time (minutes) × fixed cost per minute (hybrid model)
 *
 * Accuracy: ±50% (for relative comparison only)
 */

// Claude Opus 4.6 output: $75 / 1_000_000 tokens
const COST_PER_OUTPUT_TOKEN = 75 / 1_000_000;

// 1 char ≈ 1 token (simple estimate; includes ANSI sequences so slightly high)
const CHARS_PER_TOKEN = 1;

// Estimated cost per active agent minute ($0.02/min)
const COST_PER_MINUTE_ACTIVE = 0.02;

export class CostEstimator {
  private memberCosts = new Map<string, number>();

  // ─── Accumulate cost from PTY output character count ─────────────────────

  addOutputChars(memberId: string, charCount: number): void {
    const tokens = charCount / CHARS_PER_TOKEN;
    const cost = tokens * COST_PER_OUTPUT_TOKEN;
    this.memberCosts.set(
      memberId,
      (this.memberCosts.get(memberId) ?? 0) + cost,
    );
  }

  // ─── Accumulate cost from active time (minutes) ────────────────────────────

  addActiveMinutes(memberId: string, minutes: number): void {
    const cost = minutes * COST_PER_MINUTE_ACTIVE;
    this.memberCosts.set(
      memberId,
      (this.memberCosts.get(memberId) ?? 0) + cost,
    );
  }

  // ─── Query ─────────────────────────────────────────────────────────────────

  getMemberCost(memberId: string): number {
    return this.memberCosts.get(memberId) ?? 0;
  }

  getTotalCost(): number {
    let total = 0;
    for (const cost of this.memberCosts.values()) {
      total += cost;
    }
    return total;
  }

  getDepartmentCost(memberIds: string[]): number {
    return memberIds.reduce((sum, id) => sum + this.getMemberCost(id), 0);
  }

  // ─── Reset ─────────────────────────────────────────────────────────────────

  reset(): void {
    this.memberCosts.clear();
  }

  resetMember(memberId: string): void {
    this.memberCosts.delete(memberId);
  }

  // ─── Snapshot (serialization) ──────────────────────────────────────────────

  toRecord(): Record<string, number> {
    return Object.fromEntries(this.memberCosts.entries());
  }

  loadRecord(record: Record<string, number>): void {
    this.memberCosts.clear();
    for (const [id, cost] of Object.entries(record)) {
      this.memberCosts.set(id, cost);
    }
  }
}

// App-wide singleton
export const globalCostEstimator = new CostEstimator();
