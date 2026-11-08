// DevToolsActivePort, the file a Chrome started with a debugging port writes
// into its profile: line 1 the port, line 2 its browser target's path
// (/devtools/browser/<id>). A file left by a Chrome that is gone can name a
// port another browser, or any other server, holds by now; line 2 tells the
// Chrome that wrote the file from whatever answers there today.

/** The path of a browser endpoint (`/devtools/browser/<id>`), or null when it is no URL. */
export function browserPathOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).pathname;
  } catch {
    return null;
  }
}

/** The browser path a DevToolsActivePort file records on its second line, or null. */
export function recordedBrowserPath(raw: string): string | null {
  const path = raw.split(/\r?\n/)[1]?.trim();
  return path ? path : null;
}

/**
 * True when `endpoint` (what answers on the recorded port now) is the browser
 * that recorded `browserPath`. No endpoint, or no recorded path, is not a match.
 */
export function isRecordedBrowser(browserPath: string | null, endpoint: string | null): boolean {
  return endpoint !== null && browserPath !== null && browserPathOf(endpoint) === browserPath;
}
