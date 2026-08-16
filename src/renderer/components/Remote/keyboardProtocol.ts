/**
 * Does the remote app want enhanced key encodings?
 *
 * The mirror sends bytes to an app it never negotiated with. That is fine for
 * ordinary keys, whose encoding is fixed, and wrong for the ones wmux encodes
 * itself: `\x1b[13;2u` is the kitty form of Shift+Enter, and an app that never
 * asked for kitty reads it as ESC followed by `[13;2u` — in vim's insert mode
 * that leaves insert and runs the remainder as normal-mode input.
 *
 * xterm.js parses DECSET 2004 for us (`term.modes.bracketedPasteMode`) but
 * exposes nothing about keyboard protocols, so this watches the remote's own
 * output for the two negotiations that matter. Same idea as the bracketed-paste
 * read, one layer lower.
 *
 * Deliberately conservative: unknown state means NOT negotiated, so the mirror
 * falls back to what xterm would have encoded — the behaviour before any of
 * this existed. A missed negotiation costs a convenience; a false positive
 * corrupts an editing session.
 */

/**
 * Kitty keyboard protocol (CSI u).
 *   CSI > flags u   push
 *   CSI = flags ; mode u   set
 * Both mean the app is asking for CSI-u encodings. `CSI < u` pops back off.
 *
 * Only `progressive enhancement` flags matter to us — any non-zero flag set
 * implies the app will accept `CSI 13 ; 2 u`, which is what we send.
 */
// Built via RegExp(...) with a hex escape so the source stays pure-ASCII while
// still matching ESC at runtime — the construction DEVICE_REPLY_RE already
// uses in RemoteMirrorTerminal.tsx for the same lint rule.
/* eslint-disable no-control-regex */
const KITTY_PUSH_OR_SET = new RegExp('\\x1b\\[[>=](\\d*)(?:;\\d+)?u', 'g');
const KITTY_POP = new RegExp('\\x1b\\[<\\d*u', 'g');

/**
 * xterm's modifyOtherKeys: `CSI > 4 ; N m`, N of 1 or 2 turns it on, 0 off.
 * An app in mode 2 encodes Shift+Enter as `CSI 27 ; 2 ; 13 ~`, not as CSI-u —
 * so it is NOT counted as accepting our byte. It is tracked only so a future
 * caller can encode the form that app actually wants, and so the "negotiated
 * something" state is not silently conflated with "negotiated kitty".
 */
const MODIFY_OTHER_KEYS = new RegExp('\\x1b\\[>4;([0-2])m', 'g');
/* eslint-enable no-control-regex */

export interface RemoteKeyboardState {
  /** The remote pushed/set a non-zero kitty flag set and has not popped it. */
  kitty: boolean;
  /** The remote's modifyOtherKeys level, 0 when off. */
  modifyOtherKeys: 0 | 1 | 2;
}

export const INITIAL_REMOTE_KEYBOARD_STATE: RemoteKeyboardState = {
  kitty: false,
  modifyOtherKeys: 0,
};

/**
 * Fold one chunk of remote output into the state.
 *
 * Pure: takes the previous state, returns the next one. A chunk that says
 * nothing about keyboards returns the same object, so callers can compare by
 * reference to skip work.
 *
 * A sequence split across two chunks is missed. That is the conservative
 * direction (no negotiation seen → send the legacy byte) and the alternative
 * — carrying a partial-sequence buffer — would have to be correct about every
 * escape shape to avoid holding bytes forever.
 */
export function foldRemoteKeyboardState(
  prev: RemoteKeyboardState,
  bytes: string | Uint8Array,
): RemoteKeyboardState {
  // The mirror hands xterm raw BYTES so multi-byte UTF-8 split across the wire
  // decodes in xterm's parser rather than in a lossy JS round-trip. Every
  // sequence below is pure ASCII, so a latin1 view is exact for our purposes
  // and cannot corrupt what xterm receives — we never write this string back.
  const chunk = typeof bytes === 'string'
    ? bytes
    : Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  if (!chunk.includes('\x1b[')) return prev;

  let kitty = prev.kitty;
  let modifyOtherKeys = prev.modifyOtherKeys;
  let changed = false;

  // Walk in order so a push followed by a pop inside one chunk lands on the
  // later one rather than on whichever regex ran last.
  const events: Array<{ index: number; apply: () => void }> = [];

  KITTY_PUSH_OR_SET.lastIndex = 0;
  for (let m = KITTY_PUSH_OR_SET.exec(chunk); m; m = KITTY_PUSH_OR_SET.exec(chunk)) {
    const flags = m[1] === '' ? 0 : Number(m[1]);
    const index = m.index;
    events.push({ index, apply: () => { kitty = flags > 0; } });
  }
  KITTY_POP.lastIndex = 0;
  for (let m = KITTY_POP.exec(chunk); m; m = KITTY_POP.exec(chunk)) {
    const index = m.index;
    events.push({ index, apply: () => { kitty = false; } });
  }
  MODIFY_OTHER_KEYS.lastIndex = 0;
  for (let m = MODIFY_OTHER_KEYS.exec(chunk); m; m = MODIFY_OTHER_KEYS.exec(chunk)) {
    const level = Number(m[1]) as 0 | 1 | 2;
    const index = m.index;
    events.push({ index, apply: () => { modifyOtherKeys = level; } });
  }

  if (events.length === 0) return prev;
  events.sort((a, b) => a.index - b.index);
  for (const e of events) e.apply();

  changed = kitty !== prev.kitty || modifyOtherKeys !== prev.modifyOtherKeys;
  return changed ? { kitty, modifyOtherKeys } : prev;
}

/**
 * Whether the remote will understand the CSI-u bytes wmux encodes itself.
 *
 * Only kitty. modifyOtherKeys mode 2 wants `CSI 27 ; ... ~` instead, so
 * sending CSI-u there would be the same category of mistake this file exists
 * to prevent.
 */
export function acceptsCsiU(state: RemoteKeyboardState): boolean {
  return state.kitty;
}
