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
// #1950 added what the first field report could not tell apart: the modifier
// flags each key carried (and whether a press of that modifier was ever seen —
// a stale Meta silences Space and letters in every pane), whether the key was
// already defaultPrevented, and which part of wmux's key handler, if any,
// declined it. See DeadInputWatchdogKey.
//
// This module NEVER mutates terminal state or attempts recovery. It only
// reports. Pure logic (timers via injected clock) so it is unit-testable
// without a DOM. Rate-limited so one dead-input episode logs once, not per key.

import {
  isPrefixTrigger,
  resolveShortcut,
  type ShortcutBinding,
  type ShortcutKeyEventLike,
} from '../../shared/keymap';

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
  // The fields below are diagnostics only (#1950). They never change whether
  // or when a report fires.
  /** `KeyboardEvent.key`. Reported only as a kind: a typed character is
   *  `char`, never its value, so the log does not carry what the user typed. */
  key?: string;
  /** The modifier flags the keydown carried, e.g. `none` or `Meta`. */
  mods?: string;
  /** Flags carried with no press of that modifier seen since focus-in
   *  (see modifierPressTracker), e.g. `Meta`; empty when none. */
  staleMods?: string;
  /** `defaultPrevented` when the keydown reached the watchdog. */
  defaultPrevented?: boolean;
  /** Which part of wmux's key handler declined the key, or `none` when the
   *  handler passed it to xterm. */
  verdict?: string;
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
  /** Distinct key kinds (`char`, or a named key such as `Dead`, `Process`). */
  keyKinds: string[];
  /** Distinct modifier sets the keys carried (`none`, `Meta`, ...). */
  mods: string[];
  /** Distinct stale modifier sets (empty when every flag had a real press). */
  staleMods: string[];
  /** How many of the keys were already defaultPrevented. */
  defaultPrevented: number;
  /** Distinct key-handler verdicts (`none` = passed to xterm). */
  verdicts: string[];
}

/**
 * xterm's own composition flags (`CompositionHelper._isComposing` /
 * `_isSendingComposition`) as `composing/sending`, e.g. `0/0`. Private API,
 * read for the log only: `?` when this xterm build does not have them.
 */
export function readXtermCompositionState(terminal: unknown): string {
  try {
    const helper = (terminal as {
      _core?: { _compositionHelper?: { _isComposing?: unknown; _isSendingComposition?: unknown } };
    })._core?._compositionHelper;
    if (!helper || typeof helper._isComposing !== 'boolean') return '?';
    return `${helper._isComposing ? 1 : 0}/${helper._isSendingComposition ? 1 : 0}`;
  } catch {
    return '?';
  }
}

export interface DeclinedKeyContext {
  /** ShortcutPressGuard.isDuplicate — stable for an event it already matched. */
  isPressDuplicate: (e: ShortcutKeyEventLike) => boolean;
  /** The effective shortcut bindings the key handler resolved against. */
  bindings: readonly ShortcutBinding[];
  /** prefixConfig.key (a KeyboardEvent.code). */
  prefixKeyCode: string;
}

/**
 * Why useTerminal's key handler most likely declined a keydown it did not
 * hand to xterm, for the dead-input log only. Mirrors the handler's
 * swallow-without-writing branches in order; everything else (a byte the
 * handler wrote itself, clipboard chords, a custom keybinding) is `handler`.
 */
export function describeDeclinedKey(e: ShortcutKeyEventLike, ctx: DeclinedKeyContext): string {
  if (ctx.isPressDuplicate(e)) return 'pressGuard';
  const shortcut = resolveShortcut(e, ctx.bindings);
  if (shortcut !== null) return `shortcut:${shortcut}`;
  if (isPrefixTrigger(e, ctx.prefixKeyCode)) return 'prefixTrigger';
  if (e.ctrlKey && e.shiftKey && e.code !== 'KeyC' && e.code !== 'KeyV') return 'ctrlShift';
  return 'handler';
}

/** A typed character is `char`; a named key keeps its name. */
export function keyKind(key: string | undefined): string {
  if (key === undefined) return 'unknown';
  return [...key].length === 1 ? 'char' : key;
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
  const keyKinds = new Set<string>();
  const mods = new Set<string>();
  const staleMods = new Set<string>();
  const verdicts = new Set<string>();
  let defaultPrevented = 0;
  let lastReportAt = -Infinity;

  const reset = (): void => {
    count = 0;
    firstAt = 0;
    keyCodes.clear();
    codes.clear();
    keyKinds.clear();
    mods.clear();
    staleMods.clear();
    verdicts.clear();
    defaultPrevented = 0;
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
      keyKinds.add(keyKind(key.key));
      if (key.mods !== undefined) mods.add(key.mods);
      if (key.staleMods) staleMods.add(key.staleMods);
      if (key.verdict !== undefined) verdicts.add(key.verdict);
      if (key.defaultPrevented) defaultPrevented += 1;
      const spanMs = t - firstAt;
      if (count >= threshold && spanMs >= windowMs && t - lastReportAt >= cooldownMs) {
        lastReportAt = t;
        const info: DeadInputReport = {
          keydownCount: count,
          keyCodes: [...keyCodes],
          codes: [...codes],
          spanMs,
          keyKinds: [...keyKinds],
          mods: [...mods],
          staleMods: [...staleMods],
          defaultPrevented,
          verdicts: [...verdicts],
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
