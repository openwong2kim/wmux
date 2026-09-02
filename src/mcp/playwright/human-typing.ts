import type { Page } from 'playwright-core';
import { generateKeyHolds, generateTypingDelays } from '../../shared/humanRhythm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HumanTypingOptions {
  /** Low end of the typist's band in ms (default 50) */
  minDelay?: number;
  /** High end of the typist's band in ms (default 150) */
  maxDelay?: number;
  /** Uniform [0,1) source. Defaults to `Math.random`; inject for determinism. */
  rng?: () => number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Press one character, holding the key down for `holdMs` before releasing it.
 *
 * `keyboard.press()` does the down and the up back to back, which is a ~1 ms
 * dwell time — no hand produces that. Splitting the press is what puts a real
 * hold between the two events; see `shared/humanRhythm`'s key-hold section.
 *
 * A character `keyboard.down()` cannot describe as a key (CJK, an emoji's
 * surrogate half) still has to be inserted, and `press()` is the path that
 * inserts it as text. That fallback is why this is wrapped: losing the hold on
 * those characters is the cost, dropping them entirely is not an option.
 */
async function pressWithHold(page: Page, char: string, holdMs: number): Promise<void> {
  try {
    await page.keyboard.down(char);
  } catch {
    await page.keyboard.press(char);
    return;
  }
  await sleep(holdMs);
  await page.keyboard.up(char);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an array of per-character delay values (in ms) for the given text.
 *
 * The shape comes from `shared/humanRhythm`, which the main process's
 * `HumanBehavior.generateTypingSchedule()` also uses, so the two lanes cannot
 * drift apart: log-normal around the band's midpoint, longer after punctuation
 * and word breaks, with an occasional thinking pause.
 */
export function generateDelaySchedule(
  text: string,
  options?: HumanTypingOptions,
): number[] {
  return generateTypingDelays(text, options);
}

/**
 * Per-character key hold times (in ms) for the given text — how long each key
 * stays down, as opposed to the gap after it that `generateDelaySchedule`
 * returns. Same source module, so both lanes hold keys alike.
 */
export function generateHoldSchedule(
  text: string,
  options?: HumanTypingOptions,
): number[] {
  return generateKeyHolds(text, options);
}

/**
 * Type `text` into the element identified by `selector` with randomised
 * keystroke timing that mimics human typing.
 *
 * Each character is pressed individually, held down for a randomised dwell time
 * and then released, with the pause after it drawn from the shared typing
 * rhythm — see `generateDelaySchedule`, `generateHoldSchedule` and
 * `shared/humanRhythm`.
 *
 * If `selector` is provided the element is clicked first to ensure focus.
 */
export async function typeHumanlike(
  page: Page,
  selector: string,
  text: string,
  options?: HumanTypingOptions,
): Promise<void> {
  // Focus the target element
  if (selector) {
    await page.click(selector);
  }

  const delays = generateDelaySchedule(text, options);
  const holds = generateHoldSchedule(text, options);

  for (let i = 0; i < text.length; i++) {
    await pressWithHold(page, text[i], holds[i]);
    await sleep(delays[i]);
  }
}
