// ---------------------------------------------------------------------------
// Typing rhythm shared by both browser lanes.
//
// Both typing paths used to draw inter-keystroke delays from a uniform
// distribution (`Math.random() * (max - min) + min`). Real inter-key intervals
// are not uniform: they are right-skewed — a tight cluster around the typist's
// median with a long tail — and they lengthen after sentence punctuation and
// word breaks, with the occasional much longer pause while the person thinks.
//
// This module is the one place that shape is defined, so the MCP lane
// (`src/mcp/playwright/human-typing.ts`) and the main-process lane
// (`src/main/browser-session/HumanBehavior.ts`) cannot drift apart.
//
// The RNG is injectable so callers — tests above all — can make a schedule
// deterministic. It defaults to `Math.random`.
// ---------------------------------------------------------------------------

/** Fraction of keystrokes followed by a longer "thinking" pause. */
const PAUSE_PROBABILITY = 0.04;
/** Bounds of that pause, in ms, added on top of the base delay. */
const PAUSE_MIN_MS = 300;
const PAUSE_MAX_MS = 700;

/** Spread of the log-normal base delay. Larger = longer tail. */
const LOG_SIGMA = 0.35;

/** Extra delay after a character that ends a thought, in ms. */
const AFTER_SENTENCE_MS = 120;
/** Extra delay after a character that breaks a clause, in ms. */
const AFTER_CLAUSE_MS = 60;
/** Extra delay after a word break, in ms. */
const AFTER_WORD_MS = 40;

/** The base delay is clamped to this multiple of `minDelay` at the low end… */
const CLAMP_LOW_FACTOR = 0.6;
/** …and this multiple of `maxDelay` at the high end. */
const CLAMP_HIGH_FACTOR = 5;

export interface TypingRhythmOptions {
  /** Low end of the typist's band in ms (default 50). Also sets the clamp floor. */
  minDelay?: number;
  /** High end of the typist's band in ms (default 150). Also sets the clamp ceiling. */
  maxDelay?: number;
  /** Uniform [0,1) source. Defaults to `Math.random`; inject for determinism. */
  rng?: () => number;
}

export const DEFAULT_MIN_DELAY = 50;
export const DEFAULT_MAX_DELAY = 150;

/**
 * One standard normal sample, Box-Muller. `rng()` can return exactly 0, which
 * would make `Math.log` diverge, so the first draw is nudged off zero.
 */
function gaussian(rng: () => number): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Extra delay owed to the character that was just typed. */
function punctuationExtra(char: string | undefined): number {
  if (!char) return 0;
  if (char === '.' || char === '!' || char === '?') return AFTER_SENTENCE_MS;
  if (char === ',' || char === ';' || char === ':') return AFTER_CLAUSE_MS;
  if (char === ' ' || char === '\n' || char === '\t') return AFTER_WORD_MS;
  return 0;
}

/**
 * The delay to wait *after* typing `char`, in ms.
 *
 * Base delay is log-normal around the midpoint of [minDelay, maxDelay], which
 * puts the median where the old uniform draw put its mean while giving the
 * distribution the right skew (mean > median). On top of that sits the
 * punctuation allowance and, occasionally, a thinking pause.
 */
export function typingDelayFor(
  char: string | undefined,
  options?: TypingRhythmOptions,
): number {
  const min = options?.minDelay ?? DEFAULT_MIN_DELAY;
  const max = options?.maxDelay ?? DEFAULT_MAX_DELAY;
  const rng = options?.rng ?? Math.random;

  const median = (min + max) / 2;
  const base = median * Math.exp(LOG_SIGMA * gaussian(rng));
  const clamped = Math.min(
    Math.max(base, min * CLAMP_LOW_FACTOR),
    max * CLAMP_HIGH_FACTOR,
  );

  const pause =
    rng() < PAUSE_PROBABILITY
      ? PAUSE_MIN_MS + rng() * (PAUSE_MAX_MS - PAUSE_MIN_MS)
      : 0;

  return clamped + punctuationExtra(char) + pause;
}

/** Per-character delays for `text`, index i being the wait after `text[i]`. */
export function generateTypingDelays(
  text: string,
  options?: TypingRhythmOptions,
): number[] {
  return Array.from({ length: text.length }, (_unused, i) =>
    typingDelayFor(text[i], options),
  );
}
