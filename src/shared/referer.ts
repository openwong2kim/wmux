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

/** Strip the parts a Referer never carries: credentials and the fragment. */
function stripped(url: URL): URL {
  const copy = new URL(url.href);
  copy.username = '';
  copy.password = '';
  copy.hash = '';
  return copy;
}

/**
 * The value to pass as `referer` when navigating from `currentUrl` to
 * `targetUrl`, or `undefined` when the navigation should carry none.
 *
 * This follows Chrome's default referrer policy,
 * `strict-origin-when-cross-origin`, because sending anything else is itself
 * the giveaway:
 *
 *  - same origin      → the full URL, minus credentials and fragment
 *  - cross origin     → the bare origin with a trailing slash, nothing more
 *  - https → http     → nothing at all (a downgrade sends no referrer)
 *  - non-http(s) here → nothing (about:blank, chrome://, file://, data:)
 *  - a reload         → nothing; a self-referer on a reload is a signal of
 *                       its own. Compared on the normalised URLs, so a
 *                       differing fragment still counts as the same page.
 */
export function refererFor(
  currentUrl: string | undefined | null,
  targetUrl: string,
): string | undefined {
  if (!currentUrl) return undefined;

  let current: URL;
  let target: URL;
  try {
    current = new URL(currentUrl);
    target = new URL(targetUrl);
  } catch {
    // Not a pair we can reason about (empty string, a fragment, a bare path).
    return undefined;
  }

  // Only a real web document is a plausible referer.
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    return undefined;
  }

  const from = stripped(current);

  // A secure page never leaks its URL to an insecure one.
  if (from.protocol === 'https:' && target.protocol === 'http:') return undefined;

  // Same page, fragment aside: a reload, not a click-through.
  if (from.href === stripped(target).href) return undefined;

  return from.origin === target.origin ? from.href : `${from.origin}/`;
}
