import type { ILinkHandler } from '@xterm/xterm';

// C0/C1 controls (Cc) and format characters (Cf), which include the bidi
// overrides/isolates (U+202A-U+202E, U+2066-U+2069) and zero-width marks.
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}]/gu;

/**
 * Canonicalize a PTY-supplied OSC 8 URI before it is shown or opened.
 *
 * The URI is attacker-controlled: bidi controls can reorder the displayed
 * text and an IDN homograph host can impersonate another domain. The WHATWG
 * parser yields an ASCII href (punycode host, percent-encoded non-ASCII), and
 * any control/format character that survives is stripped. Returns null when
 * the URI does not parse or is not http(s).
 */
export function normalizeOsc8Uri(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href.replace(INVISIBLE_OR_CONTROL, '');
}

/**
 * OSC 8 links can hide their destination behind a label, so retain xterm's
 * confirmation. Its default window.open() starts with about:blank, which
 * Electron correctly denies before the destination can be assigned. Dispatch
 * the confirmed URL through the same route as plain-text terminal links.
 */
export function createOsc8LinkHandler(
  activate: (event: MouseEvent, uri: string) => void,
): ILinkHandler {
  return {
    allowNonHttpProtocols: false,
    activate(event, uri) {
      // The dialog and the activation use the same normalized string, so what
      // the user approves is exactly what opens.
      const href = normalizeOsc8Uri(uri);
      if (href === null) return;
      if (window.confirm(`Do you want to navigate to ${href}?\n\nWARNING: This link could potentially be dangerous`)) {
        activate(event, href);
      }
    },
  };
}
