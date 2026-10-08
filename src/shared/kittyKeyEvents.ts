/**
 * Read kitty keyboard-protocol key events the way wmux's byte-pattern readers
 * read legacy keys.
 *
 * Once an app pushes kitty flags (Claude Code pushes 5, Codex 7), xterm.js
 * encodes Escape as `CSI 27 u`, Ctrl+C as `CSI 99 ; 5 u`, and with flag 2 adds
 * a release event (`CSI 27 ; 1 : 3 u`) after every key. The readers that infer
 * intent from typed bytes (interrupt detection, the daemon's lone-Esc and
 * answer-key checks, Ctrl+C / Ctrl+U clearing a draft) match the legacy bytes.
 * This maps one written chunk back to them. The bytes written to the PTY are
 * never changed; only what these readers look at.
 */

// eslint-disable-next-line no-control-regex
const KITTY_KEY_EVENT = /^\x1b\[(\d+)(?::\d*)*(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u$/;
// eslint-disable-next-line no-control-regex
const KITTY_KEY_EVENTS = /\x1b\[\d+(?::\d*)*(?:;\d*(?::\d+)?)?(?:;[\d:]*)?u/g;

const MOD_CTRL = 4;
const KEY_ESCAPE = 27;
const KEY_ENTER = 13;

/**
 * The legacy bytes for a chunk made only of kitty key events (xterm can hand
 * over a press and its release together): `''` for a release (not a
 * keystroke), `\x1b` for an unmodified Escape, `\r` for an unmodified Enter,
 * the C0 byte for Ctrl+letter, and any other event unchanged. A chunk with
 * anything else in it, including every non-kitty one, comes back unchanged.
 */
export function kittyChunkAsLegacy(data: string): string {
  if (data.length < 4 || data.charCodeAt(0) !== 0x1b || !data.endsWith('u')) return data;
  const events = data.match(KITTY_KEY_EVENTS);
  if (!events || events.join('').length !== data.length) return data;
  return events.map(legacyEvent).join('');
}

function legacyEvent(event: string): string {
  const m = KITTY_KEY_EVENT.exec(event);
  if (!m) return event;
  if (m[3] === '3') return '';
  const code = Number(m[1]);
  const mods = (m[2] ? Number(m[2]) : 1) - 1;
  if (mods === 0 && code === KEY_ESCAPE) return '\x1b';
  if (mods === 0 && code === KEY_ENTER) return '\r';
  if (mods === MOD_CTRL && code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  return event;
}
