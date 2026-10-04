// The GitHub connect flow's contract: reading `gh auth login --web` output
// (the one-time device code, the "press Enter" prompt, success and failure)
// and the events main sends the Git page while it runs.
//
// gh prints, roughly:
//   ! First copy your one-time code: ABCD-1234
//   Press Enter to open https://github.com/login/device in your browser...
//   ✓ Authentication complete.
//   ✓ Logged in as octocat
// The reader tolerates ANSI colours, CRLF line ends (Windows), other wording
// and other languages: the code is recognised by its shape, not its label.

export const GH_DEVICE_URL = 'https://github.com/login/device';

/** Strip ANSI escape sequences and normalise line ends. Pure. */
export function cleanGhOutput(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g, '').replace(/\r\n?/g, '\n');
}

/** The one-time device code in gh's output (XXXX-XXXX, letters and digits), or null. */
export function parseDeviceCode(raw: string): string | null {
  const text = cleanGhOutput(raw);
  // Prefer a code on a line that talks about a code; fall back to the shape alone.
  const lines = text.split('\n');
  const shape = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
  for (const line of lines) {
    if (/code|코드|代码|kod/i.test(line)) {
      const m = line.match(shape);
      if (m) return m[1];
    }
  }
  const m = text.match(shape);
  return m ? m[1] : null;
}

/** gh is waiting for Enter (to open the browser, or to continue). */
export function asksForEnter(raw: string): boolean {
  return /press\s+enter|enter\s+(?:키|를)|按\s*enter|naciśnij\s+enter/i.test(cleanGhOutput(raw));
}

/** gh reported a finished login. */
export function loginSucceeded(raw: string): boolean {
  return /authentication complete|logged in (?:to [\w.-]+ )?(?:account |as )/i.test(cleanGhOutput(raw));
}

/** Events main sends the page while a login runs. */
export type GhLoginEvent =
  | { kind: 'code'; code: string; url: string }
  | { kind: 'waiting' }
  | { kind: 'done' }
  | { kind: 'timeout' }
  /** `fallback`: the code could not be read; offer the terminal-tab login instead. */
  | { kind: 'failed'; message: string; fallback: boolean };

export type GhLoginStartResult = { ok: true } | { ok: false; message: string; fallback: boolean };

/** How long a login is polled before it gives up. */
export const GH_LOGIN_TIMEOUT_MS = 10 * 60_000;
