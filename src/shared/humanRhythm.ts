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

/**
 * Ceiling on a whole schedule: this much per character, plus fixed slack so a
 * short string is not squeezed by one unlucky pause.
 */
const BUDGET_PER_CHAR_MS = 120;
const BUDGET_SLACK_MS = 1500;

/**
 * Per-character delays for `text`, index i being the wait after `text[i]`.
 *
 * The draws are independent, so a long string can accumulate enough pauses to
 * take absurdly long — a 2,000-character paste has no business sitting in a
 * multi-minute typing loop. When a schedule exceeds its budget every delay is
 * scaled down by the same factor, which shortens the schedule without
 * flattening its shape: the tail, the pauses and the punctuation allowances
 * all stay proportionally where they were.
 */
export function generateTypingDelays(
  text: string,
  options?: TypingRhythmOptions,
): number[] {
  const delays = Array.from({ length: text.length }, (_unused, i) =>
    typingDelayFor(text[i], options),
  );

  const budget = text.length * BUDGET_PER_CHAR_MS + BUDGET_SLACK_MS;
  const total = delays.reduce((sum, d) => sum + d, 0);
  if (total <= budget) return delays;

  const scale = budget / total;
  return delays.map((d) => d * scale);
}

// ---------------------------------------------------------------------------
// Key hold (dwell time)
// ---------------------------------------------------------------------------
//
// The inter-key delay above says how long to wait BETWEEN keystrokes. It says
// nothing about how long each key is held, and both lanes used to press and
// release in the same breath: keydown → keyup in about a millisecond. A person
// holds a key for tens of milliseconds, and dwell time is a standard input of
// keystroke-dynamics biometrics — a stream of ~1 ms holds is as distinctive as
// a stream of perfectly uniform gaps was.
//
// Same shape as the inter-key draw (log-normal, injectable RNG) around a
// median in the middle of the range people actually produce.

/** Median hold, in ms — the middle of the 40–120 ms band typists produce. */
export const KEY_HOLD_MEDIAN_MS = 70;
/** Spread of the log-normal hold. Matches the inter-key draw's skew. */
const HOLD_SIGMA = 0.35;
/** A hold never falls below this… */
export const KEY_HOLD_MIN_MS = 30;
/** …nor above this. The tail is long, but not "leaning on the key" long. */
export const KEY_HOLD_MAX_MS = 150;

/**
 * How long to hold one key down, in ms.
 *
 * Only `rng` is read from `options`: the hold is a property of the hand, not of
 * the typist's chosen speed band, so it does not scale with min/maxDelay.
 */
export function keyHoldFor(options?: TypingRhythmOptions): number {
  const rng = options?.rng ?? Math.random;
  const base = KEY_HOLD_MEDIAN_MS * Math.exp(HOLD_SIGMA * gaussian(rng));
  return Math.min(Math.max(base, KEY_HOLD_MIN_MS), KEY_HOLD_MAX_MS);
}

/** Per-character hold times for `text`, index i being the hold of `text[i]`. */
export function generateKeyHolds(
  text: string,
  options?: TypingRhythmOptions,
): number[] {
  return Array.from({ length: text.length }, () => keyHoldFor(options));
}
