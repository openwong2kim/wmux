// ---------------------------------------------------------------------------
// Referer on agent navigations.
//
// Every navigation the agent issued arrived with no `Referer` header, because
// `page.goto()` sends none unless it is given one. A person reaching page B
// from page A arrives with A in the header; a stream of refererless requests
// from inside a session is not what browsing looks like.
//
// So: when the page we are leaving is a real http(s) document and we are going
// somewhere else, send it as the referer — exactly what following a link would
// have produced. A first navigation, or one leaving about:blank or a browser
// internal page, still sends nothing, because a real click-through from those
// sends nothing either.
// ---------------------------------------------------------------------------

/**
 * The value to pass as `referer` when navigating from `currentUrl` to
 * `targetUrl`, or `undefined` when the navigation should carry none.
 */
export function refererFor(
  currentUrl: string | undefined | null,
  targetUrl: string,
): string | undefined {
  if (!currentUrl) return undefined;

  let current: URL;
  try {
    current = new URL(currentUrl);
  } catch {
    // Not a URL we can reason about (empty string, a fragment, a bare path).
    return undefined;
  }

  // Only a real web document is a plausible referer. about:blank, chrome://,
  // devtools://, file:// and data: are not places a link is followed from.
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    return undefined;
  }

  // Reloading the same URL is not a click-through, and a self-referer on a
  // reload is a signal of its own.
  if (currentUrl === targetUrl) return undefined;

  return currentUrl;
}
