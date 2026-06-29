/**
 * OSC 52 clipboard-write decode + security policy (pure).
 *
 * Background:
 * Full-screen TUI apps (Claude Code, vim, tmux, neovim, …) take over the mouse
 * (mouse tracking mode), so a drag no longer lands an xterm-native selection.
 * When the user copies, those apps don't touch the OS clipboard directly — they
 * can't, they run sandboxed inside the terminal — they emit an OSC 52 escape
 * sequence (`ESC ] 52 ; Pc ; Pd ST`) asking the *terminal* to do it. xterm.js
 * disables OSC 52 by default (its read half leaks clipboard contents to any
 * program that asks), so without an explicit handler wmux silently drops the
 * request: the app shows "copied", the system clipboard never changes.
 *
 * This module is the pure decode + policy core. `useTerminal` registers the
 * thin xterm OSC-52 handler that feeds it the raw payload and writes the result
 * through the existing clipboard IPC (which already enforces a 1 MB cap and
 * surfaces lock failures). Kept DOM-free so it unit-tests in the node vitest env.
 *
 * Security policy — we open the WRITE half only:
 *   • READ requests (`Pd === '?'`) are REFUSED — never let an app exfiltrate the
 *     user's clipboard. This read leak is the whole reason xterm ships OSC 52 off.
 *   • CLEAR requests (empty `Pd`) are REFUSED — an app should not be able to
 *     silently wipe the clipboard.
 *   • Oversized payloads are REFUSED before decode — a multi-megabyte base64
 *     blob shouldn't be allocated/decoded on the main thread (DoS). The clipboard
 *     IPC's 1 MB cap is the second line of defense on the decoded text.
 *   • Malformed / non-base64 payloads are REFUSED.
 * Writing the system clipboard is allowed: the app is something the user ran,
 * and a clipboard write (unlike a read) leaks nothing.
 */

// OSC 52 payload is `Pc;Pd`. 1 MB of text is ~1.4 M base64 chars; allow some
// headroom, then let the clipboard IPC's 1 MB cap reject the decoded text. Past
// this we refuse before allocating/decoding.
const MAX_OSC52_BASE64_LEN = 2_000_000;

/**
 * Decode an OSC 52 payload into the text to place on the clipboard, or return
 * null to REFUSE (read request, clear request, oversized, or malformed). The
 * caller should consume the sequence either way (return true to xterm) so a
 * refused request doesn't fall through to any other handler.
 *
 * @param payload the raw OSC 52 data xterm hands the `52` handler: `Pc;Pd`
 *   (everything between `ESC ] 52 ;` and the terminator).
 */
export function decodeOsc52Write(payload: string): string | null {
  // `Pc;Pd` — split on the FIRST ';'. Pc is selection chars (c/p/q/s/0-7), Pd is
  // base64 or '?'. Neither contains ';', so a single split is unambiguous.
  const semi = payload.indexOf(';');
  if (semi === -1) return null; // no `Pc;Pd` shape → malformed

  const pd = payload.slice(semi + 1);

  if (pd === '?') return null; // read request — refuse (no clipboard exfiltration)
  if (pd === '') return null; // clear request — refuse (no silent wipe)
  if (pd.length > MAX_OSC52_BASE64_LEN) return null; // oversized — refuse before decode

  try {
    return decodeBase64Utf8(pd);
  } catch {
    return null; // not valid base64 → refuse
  }
}

/**
 * Decode standard base64 into a UTF-8 string. `atob` yields one Latin-1 char
 * per byte, so naively returning it mangles any multi-byte UTF-8 (Korean,
 * emoji). Re-read the bytes and decode as UTF-8 so `복사`/😀 survive the round
 * trip. Throws (caught above) on invalid base64.
 */
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
