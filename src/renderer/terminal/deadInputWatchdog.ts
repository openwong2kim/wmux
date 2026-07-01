// Diagnostic-only watchdog for the intermittent "input dead until remount" bug
// (field report: typing stops reaching the PTY; only a terminal remount, e.g.
// toggling multiview, recovers it). The bug is machine/IME-dependent and has not
// reproduced locally, so instead of a blind fix this instrument captures the
// discriminating evidence the NEXT time it happens in the wild.
//
// Signal: the user pressed several *input* keys into the focused xterm textarea,
// but ZERO of them produced `terminal.onData` (xterm's "send this to the shell"
// event) within a time window. That is "keys pressed, nothing reached the app" —
// dead input. The caller logs the report with `document.activeElement` so we
// also learn WHERE focus sat (the xterm textarea vs. something else), which
// tells orphaned-focus apart from an IME-layer death.
//
// What is deliberately NOT counted, so healthy input never self-reports:
//   - Keydowns during an IME composition (`isComposing === true`). A live
//     composition means input IS being processed; healthy CJK typing otherwise
//     looks identical to the storm (229 keydowns, no onData until the candidate
//     commits). The storm we hunt keeps isComposing=false the whole time (it
//     never opens a composition), so it still accumulates. Composing keydowns
//     reset the accumulator (they are activity).
//   - Modifier / lock / function keys (Shift/Ctrl/Alt/Meta/CapsLock/F-keys),
//     which never produce shell input and so are not evidence of dead input.
//
// This module NEVER mutates terminal state or attempts recovery. It only
// reports. Pure logic (timers via injected clock) so it is unit-testable
// without a DOM. Rate-limited so one dead-input episode logs once, not per key.

/** Keys that never produce shell input, so their keydowns are not dead-input
 *  evidence: the modifier/lock keys and the function row. Arrow/Tab/Enter DO
 *  produce data in a terminal and are intentionally NOT excluded. */
const NON_INPUT_KEY = /^(?:Shift|Control|Alt|Meta)(?:Left|Right)$|^(?:CapsLock|NumLock|ScrollLock)$|^F\d+$/;

export function isNonInputKey(code: string): boolean {
  return NON_INPUT_KEY.test(code);
}

export interface DeadInputWatchdogKey {
  /** Legacy keyCode. 229 ("Process") means the IME claimed the key. */
  keyCode: number;
  /** Whether an IME composition was active for this keydown. */
  isComposing: boolean;
  /** Physical key code (diagnostic + non-input-key filter). */
  code: string;
}

export interface DeadInputReport {
  /** Input keydowns observed since the last input actually reached the app. */
  keydownCount: number;
  /** Distinct legacy keyCodes seen (all 229 = IME claim storm). */
  keyCodes: number[];
  /** Distinct physical codes seen (diagnostic). */
  codes: string[];
  /** Span from the first unanswered keydown to the report, in ms. */
  spanMs: number;
}

export interface DeadInputWatchdogOptions {
  /** Called once per episode when dead input is detected. */
  report: (info: DeadInputReport) => void;
  /** Unanswered input keydowns required before a report fires. Default 4. */
  threshold?: number;
  /** The unanswered keydowns must span at least this long. Guards against a
   *  fast burst that legitimately produces one onData for many keys. Default 400ms. */
  windowMs?: number;
  /** Minimum gap between reports so one stuck episode logs once. Default 10s. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const DEAD_INPUT_THRESHOLD_DEFAULT = 4;
export const DEAD_INPUT_WINDOW_MS_DEFAULT = 400;
export const DEAD_INPUT_COOLDOWN_MS_DEFAULT = 10_000;

export interface DeadInputWatchdog {
  /** A keydown reached the focused terminal textarea. */
  onKeyDown(key: DeadInputWatchdogKey): void;
  /** xterm emitted data to the shell — input is flowing, so reset. */
  onData(): void;
  /** Drop all state (no-op after). */
  dispose(): void;
}

export function createDeadInputWatchdog(options: DeadInputWatchdogOptions): DeadInputWatchdog {
  const {
    report,
    threshold = DEAD_INPUT_THRESHOLD_DEFAULT,
    windowMs = DEAD_INPUT_WINDOW_MS_DEFAULT,
    cooldownMs = DEAD_INPUT_COOLDOWN_MS_DEFAULT,
    now = Date.now,
  } = options;

  let disposed = false;
  let count = 0;
  let firstAt = 0;
  const keyCodes = new Set<number>();
  const codes = new Set<string>();
  let lastReportAt = -Infinity;

  const reset = (): void => {
    count = 0;
    firstAt = 0;
    keyCodes.clear();
    codes.clear();
  };

  return {
    onKeyDown(key: DeadInputWatchdogKey): void {
      if (disposed) return;
      // A live composition = the IME is processing input. Treat as activity and
      // reset so healthy CJK typing never self-reports (the storm stays
      // isComposing=false and still accumulates).
      if (key.isComposing) { reset(); return; }
      // Modifier/lock/function keys produce no shell input — not dead-input
      // evidence, so ignore without counting or resetting.
      if (isNonInputKey(key.code)) return;
      const t = now();
      if (count === 0) firstAt = t;
      count += 1;
      keyCodes.add(key.keyCode);
      codes.add(key.code);
      const spanMs = t - firstAt;
      if (count >= threshold && spanMs >= windowMs && t - lastReportAt >= cooldownMs) {
        lastReportAt = t;
        const info: DeadInputReport = {
          keydownCount: count,
          keyCodes: [...keyCodes],
          codes: [...codes],
          spanMs,
        };
        // Keep lastReportAt (do not clear it in reset) so a still-stuck episode
        // does not re-log every key — only after the cooldown.
        reset();
        report(info);
      }
    },

    onData(): void {
      if (disposed) return;
      // Input reached the app — whatever the user pressed got through, so this
      // is not a dead-input episode. Clear the accumulator.
      reset();
    },

    dispose(): void {
      disposed = true;
      reset();
    },
  };
}
