/**
 * Dead-input auto-recovery for the keyCode-229 "claim storm" (field report:
 * typing and arrow keys stop reaching the PTY on v3.0.0 until the terminal is
 * remounted, e.g. by toggling multiview).
 *
 * Mechanism being defended against:
 *   Windows IMEs deliver a keydown they intend to handle with
 *   `keyCode === 229` ("Process"), and xterm's CompositionHelper drops every
 *   229 keydown. In a healthy composition the very first 229 keydown is
 *   followed within the same task by `compositionstart`, so input flows. But
 *   when the IME's TSF context desyncs from the hidden textarea (observed in
 *   the field; exact trigger machine-dependent — programmatic textarea
 *   mutation and focus moves mid-composition are the suspects), the IME keeps
 *   claiming EVERY keydown — letters, arrows, space — while never opening a
 *   composition. xterm then silently eats all of them: input is dead, output
 *   still renders, clicking doesn't help, only a remount used to recover.
 *
 * Detection signature (deliberately narrow so legit IME flows never match):
 *   N consecutive `keyCode === 229 && !isComposing` keydowns spanning at
 *   least `minDistinctCodes` physical keys, with ZERO composition events and
 *   ZERO `input` events in between. Real compositions reset the counter on
 *   the `compositionstart` that immediately follows their first keydown.
 *
 * Recovery: blur + refocus the textarea — exactly what a terminal remount
 *   does to the IME context, minus the remount. Chromium re-initializes its
 *   TSF document on focus, releasing the stale claim. Rate-limited so a
 *   recovery that does not take effect can't busy-loop.
 */

export interface ImeStormGuardTextarea {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
  blur(): void;
  focus(): void;
}

export interface ImeStormGuardTerminal {
  textarea: ImeStormGuardTextarea | undefined;
}

export interface ImeStormRecoveryInfo {
  /** How many claimed keydowns accumulated before recovery fired. */
  count: number;
  /** Distinct physical key codes observed in the storm (diagnostic). */
  codes: string[];
}

export interface ImeStormGuardOptions {
  /** Consecutive claimed keydowns before recovery. */
  threshold?: number;
  /** Distinct `event.code` values required (a single repeated key is more
   * likely a held key inside an odd-but-legit IME state). */
  minDistinctCodes?: number;
  /** Minimum gap between recoveries. */
  cooldownMs?: number;
  /** Called after a blur/refocus recovery, for logging/toast. */
  onRecover?: (info: ImeStormRecoveryInfo) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}

export const IME_STORM_THRESHOLD = 6;
export const IME_STORM_MIN_DISTINCT_CODES = 2;
export const IME_STORM_COOLDOWN_MS = 5000;

interface StormKeyEvent extends Event {
  keyCode?: number;
  isComposing?: boolean;
  code?: string;
}

export function attachImeStormGuard(
  terminal: ImeStormGuardTerminal,
  options: ImeStormGuardOptions = {},
): { dispose(): void } {
  const textarea = terminal.textarea;
  if (!textarea) {
    return { dispose: () => undefined };
  }

  const threshold = options.threshold ?? IME_STORM_THRESHOLD;
  const minDistinctCodes = options.minDistinctCodes ?? IME_STORM_MIN_DISTINCT_CODES;
  const cooldownMs = options.cooldownMs ?? IME_STORM_COOLDOWN_MS;
  const now = options.now ?? (() => Date.now());

  let count = 0;
  let codes = new Set<string>();
  let lastRecoveryAt = -Infinity;

  const reset = (): void => {
    count = 0;
    codes = new Set<string>();
  };

  const onKeyDown = (e: Event): void => {
    const ev = e as StormKeyEvent;
    if (ev.keyCode === 229 && ev.isComposing !== true) {
      count += 1;
      if (ev.code) codes.add(ev.code);
      // Escape is the interrupt key. Users mash it alone when a TUI ignores
      // them (#1152), so a single distinct code must still recover — the
      // held-letter guard would otherwise leave input dead for the rest of
      // the turn. A held letter that is not Escape still needs two codes.
      const distinctEnough = codes.size >= minDistinctCodes || ev.code === 'Escape';
      if (count >= threshold && distinctEnough && now() - lastRecoveryAt >= cooldownMs) {
        lastRecoveryAt = now();
        const info: ImeStormRecoveryInfo = { count, codes: [...codes] };
        reset();
        // Order matters: blur releases the stale TSF claim, focus opens a
        // fresh IME context on the same textarea (xterm also clears the
        // textarea value in its own blur handler, which is fine here).
        textarea.blur();
        textarea.focus();
        options.onRecover?.(info);
      }
      return;
    }
    // A normally-delivered keydown means the IME is not claiming input.
    reset();
  };

  // Any composition or input activity = the IME is working — not a storm.
  const onActivity = (): void => reset();

  textarea.addEventListener('keydown', onKeyDown);
  textarea.addEventListener('compositionstart', onActivity);
  textarea.addEventListener('compositionupdate', onActivity);
  textarea.addEventListener('compositionend', onActivity);
  textarea.addEventListener('input', onActivity);

  return {
    dispose: (): void => {
      textarea.removeEventListener('keydown', onKeyDown);
      textarea.removeEventListener('compositionstart', onActivity);
      textarea.removeEventListener('compositionupdate', onActivity);
      textarea.removeEventListener('compositionend', onActivity);
      textarea.removeEventListener('input', onActivity);
    },
  };
}
