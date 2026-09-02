import type { Page } from 'playwright-core';
import { generateTypingDelays } from '../../shared/humanRhythm';

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
 * Type `text` into the element identified by `selector` with randomised
 * inter-keystroke delays that mimic human typing.
 *
 * Each character is pressed individually via `page.keyboard.press()`, with the
 * pause after it drawn from the shared typing rhythm — see
 * `generateDelaySchedule` and `shared/humanRhythm`.
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

  for (let i = 0; i < text.length; i++) {
    await page.keyboard.press(text[i]);
    await sleep(delays[i]);
  }
}
