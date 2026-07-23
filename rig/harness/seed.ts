// Verification rig — deterministic seed utilities (design §4 / G7)
//
// Seed-based PRNG for deterministic persona behavior. G7: scenarios run on deterministic seeds,
// and failures print the seed for replay. S1 is fine with PipeClient directly (no persona.ts),
// but S2~S8 benefit from a shared seed utility (design §9 delegation), so it lives here.
// persona.ts framework is a follow-up PR.
//
// mulberry32 — small fast deterministic PRNG with 32-bit state. Not cryptographically secure;
// goal is reproducibility (same seed = same sequence).

/** Deterministic RNG initialized from one seed. */
export class SeededRng {
  private state: number;

  constructor(readonly seed: number) {
    // Normalize to non-zero — seed 0 kills the sequence.
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }
}

/**
 * Pick the default seed for this run. Uses `WMUX_RIG_SEED` env if set (failure replay),
 * otherwise draws a time-based seed. Either way, tests must print the seed for reproducibility.
 */
export function pickSeed(): number {
  const fromEnv = process.env.WMUX_RIG_SEED;
  if (fromEnv && /^\d+$/.test(fromEnv)) {
    return Number(fromEnv) >>> 0;
  }
  return (Date.now() ^ (process.pid << 16)) >>> 0;
}
