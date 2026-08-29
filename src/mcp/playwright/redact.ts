/**
 * Password-value redaction for browser tool output.
 *
 * An agent driving a logged-in page needs to SEE the login form — the field,
 * its label, its name, whether it is filled — but the password itself has no
 * business reaching the model's context or the transcript. This module is the
 * single place that decides what counts as a password field and what replaces
 * its value.
 *
 * What Chrome already does, measured on Chrome 141 against a three-field form
 * (`Accessibility.getFullAXTree` after setting each `.value`):
 *
 *   input[type=password]                  AX value = "•••••••••••••"  (masked)
 *   input[type=text autocomplete=…]       AX value = "newpassSECRET"  (PLAIN)
 *   input.value read from page JS         always plaintext
 *
 * So the a11y tree covers exactly one shape, and only that one. A `type=text`
 * field carrying `autocomplete="new-password"` — what a "show password" toggle
 * and most signup forms produce — hands back the plaintext, and every DOM-side
 * path (`el.value`) hands it back regardless of type. The same measurement also
 * showed Chrome repeats the value a second time as `StaticText` descendants of
 * the input (its shadow editor's text), so redacting the a11y node's `value`
 * alone is not enough — the subtree has to go with it.
 *
 * The rule everywhere here: redact the VALUE, never the field. Role, label,
 * name, ref and the fact that the field is non-empty all survive, because
 * that is what the agent needs to fill the form at all.
 */

/** Replacement text for any redacted password value. */
export const REDACTED_PASSWORD = '[redacted:password]';

/**
 * CSS selector for password-bearing inputs, for the CDP `DOM.querySelectorAll`
 * path (snapshot.ts / dom-intelligence.ts resolve the matches to backendNodeIds
 * and redact the a11y nodes those ids index).
 *
 * `autocomplete` is in here because `type` alone misses the plaintext case the
 * module comment measures. The `i` flags matter: `type` is matched
 * ASCII-case-insensitively by the HTML spec on its own, but an attribute
 * selector is case-SENSITIVE by default, so `autocomplete="New-Password"` would
 * slip past a bare `~=`. This keeps the selector in step with
 * isPasswordFieldNode, which lowercases before comparing.
 */
export const PASSWORD_FIELD_SELECTOR =
  'input[type="password"], input[autocomplete~="current-password" i], input[autocomplete~="new-password" i]';

/**
 * Is this DOM element a password field?
 *
 * Deliberately self-contained (no imports, no closure): it is handed to
 * `ElementHandle.evaluate` and stringified into injected page scripts via
 * PASSWORD_FIELD_PREDICATE_JS, so both transports run this exact source rather
 * than a second copy of the rule that can drift.
 */
export function isPasswordFieldNode(el: unknown): boolean {
  const node = el as {
    type?: unknown;
    autocomplete?: unknown;
    getAttribute?: (name: string) => unknown;
  } | null;
  if (!node) return false;
  if (String(node.type || '').toLowerCase() === 'password') return true;
  const attr = typeof node.getAttribute === 'function' ? node.getAttribute('autocomplete') : '';
  const autocomplete = String(node.autocomplete || attr || '').toLowerCase();
  return autocomplete
    .split(/\s+/)
    .some((token: string) => token === 'current-password' || token === 'new-password');
}

/**
 * `isPasswordFieldNode` as source text, for the injected-script paths that
 * build a JS string rather than pass a function (the packaged-build RPC
 * transport). Use as `(${PASSWORD_FIELD_PREDICATE_JS})(el)`.
 */
export const PASSWORD_FIELD_PREDICATE_JS = String(isPasswordFieldNode);

// ---------------------------------------------------------------------------
// Text-level redaction (network URLs and bodies)
// ---------------------------------------------------------------------------

/**
 * Parameter names that carry a password. Narrow on purpose: `pass` alone would
 * swallow `passenger`/`passport`, and browser_network exists to make requests
 * debuggable — over-masking would defeat the tool it protects. `pass[_-]?word`
 * (rather than a bare `password`) picks up the `pass_word` / `pass-word`
 * spellings without widening the stem.
 */
const PASSWORD_KEY = '[\\w.\\[\\]-]*(?:pass[_-]?word|passwd|pwd)[\\w.\\[\\]-]*';

/**
 * `"password": <value>` at any nesting depth of a JSON body.
 *
 * The value alternation covers a quoted string and a bare number — a numeric
 * PIN posted as `{"password":123456}` is still a credential. `null`/`true`/
 * `false` are deliberately NOT matched: they carry no secret, and masking them
 * would erase the "unset" signal.
 */
const JSON_PASSWORD = new RegExp(
  `("${PASSWORD_KEY}"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|-?\\d[\\d.]*(?:[eE][-+]?\\d+)?)`,
  'gi',
);

/**
 * A JSON password value that the 256 KB capture cap cut mid-string, so it has
 * no closing quote for JSON_PASSWORD to anchor on.
 *
 * `[^"\n]*$` with the `m` flag stops at the line end, which preserves the
 * `\n... [truncated N chars]` marker the capture appends — and, because a
 * terminated value always has a closing quote before the line ends, it cannot
 * double-fire on something JSON_PASSWORD already handled.
 */
const JSON_PASSWORD_TRUNCATED = new RegExp(`("${PASSWORD_KEY}"\\s*:\\s*)"[^"\\n]*$`, 'gim');

/**
 * `password=…` in a query string, an `application/x-www-form-urlencoded` body,
 * or a free-form line of console output.
 *
 * The leading `^|[?&;\s]` boundary is what keeps a path like
 * `/account/reset-password` untouched: a key has to actually be a key.
 * Whitespace counts as a boundary because console text is prose — a page that
 * logs `auth failed for password=hunter2` puts the credential after a space,
 * not after a `&`. It cannot widen the URL cases, which have no unencoded
 * whitespace to begin with.
 *
 * A truncated tail needs no special case here: `[^&;#\s]*` ends at the input's
 * end just as happily as at the next separator.
 */
const FORM_PASSWORD = new RegExp(`(^|[?&;\\s])(${PASSWORD_KEY})=[^&;#\\s]*`, 'gi');

/**
 * The password half of a `scheme://user:password@host` URL.
 *
 * Only the credential is replaced — the username stays, because knowing WHICH
 * account a request authenticated as is exactly the kind of thing the network
 * tools exist to show. A URL with no `:` before the `@` (`https://user@host`)
 * carries no password and is left alone.
 */
const URL_USERINFO_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]+):[^\s/?#@]*@/gi;

/**
 * Replace password VALUES in a URL or a request/response body, leaving the
 * parameter names — and everything else — exactly as they were.
 *
 * Covers the shapes a login actually posts (JSON and form-urlencoded), the
 * query string of a GET that puts a credential in the URL, and URL userinfo.
 *
 * Known trade-off, accepted deliberately: these are regexes over text, not a
 * parse. A password-family key appearing INSIDE an escaped JSON string (a body
 * that embeds another JSON document as a string value) is rewritten as if it
 * were a real key. Parsing first would be exact on well-formed input but is
 * strictly worse here — the bodies most in need of masking are the ones the
 * 256 KB cap truncated, which no parser accepts — and the damage is bounded to
 * password-family keys, whose values are the one thing already being withheld.
 */
export function redactPasswordParams(text: string): string {
  if (!text) return text;
  return text
    .replace(JSON_PASSWORD, `$1"${REDACTED_PASSWORD}"`)
    .replace(JSON_PASSWORD_TRUNCATED, `$1"${REDACTED_PASSWORD}`)
    .replace(FORM_PASSWORD, `$1$2=${REDACTED_PASSWORD}`)
    .replace(URL_USERINFO_PASSWORD, `$1:${REDACTED_PASSWORD}@`);
}

// ---------------------------------------------------------------------------
// CDP: DOM → a11y bridge
// ---------------------------------------------------------------------------

/** The subset of a CDP session this module needs. */
interface CdpSender {
  send: (method: string, params?: unknown) => Promise<unknown>;
}

/**
 * backendNodeIds of every password field reachable from this target — the main
 * document, its shadow roots, and its same-process iframes.
 *
 * `backendNodeId` is the one id space the DOM and Accessibility domains share,
 * which is what lets a DOM-side `type`/`autocomplete` test decide whether an
 * a11y node may show its value (the a11y node itself carries neither).
 *
 * Uses `DOM.performSearch` — DevTools' own element search — rather than
 * `DOM.querySelectorAll`, because CSS cannot cross a shadow boundary and
 * `querySelectorAll` on the document root therefore sees only the main tree.
 * That was a real bypass, not a theoretical one: measured on Chrome 141, a
 * `<input type="text" autocomplete="new-password">` inside an open shadow root
 * IS present in `Accessibility.getFullAXTree` with its value in plaintext,
 * while the document-root `querySelectorAll` returned only the light-DOM
 * field. Same measurement: `performSearch` returns all five fields across
 * light DOM, shadow root and iframe, at 3 ms — against 37 ms and 1.25 MB for a
 * `pierce: true` full-document dump, on a tree whose AX fetch already costs
 * 172 ms and 4 MB.
 *
 * Fails OPEN — an empty set on any CDP error. Redaction is a filter over the
 * a11y tree, so failing closed would mean masking every value on the page;
 * failing open degrades to exactly Chrome's own behaviour (`type=password`
 * still arrives pre-masked as bullets), which is where this started.
 */
export async function getPasswordFieldBackendIds(client: CdpSender): Promise<Set<number>> {
  const ids = new Set<number>();
  let searchId: string | undefined;
  try {
    // DOM.performSearch searches the agent's node map, which stays EMPTY until
    // the document is requested — without this the search returns resultCount 0
    // on a page full of password fields. Verified against real Chrome: dropping
    // this call silently emptied the redaction set.
    await client.send('DOM.getDocument', { depth: 0 });

    const search = (await client.send('DOM.performSearch', {
      query: PASSWORD_FIELD_SELECTOR,
      includeUserAgentShadowDOM: false,
    })) as { searchId?: string; resultCount?: number };

    searchId = search?.searchId;
    const resultCount = search?.resultCount ?? 0;
    if (!searchId || resultCount === 0) return ids;

    const found = (await client.send('DOM.getSearchResults', {
      searchId,
      fromIndex: 0,
      toIndex: resultCount,
    })) as { nodeIds?: number[] };

    for (const nodeId of found?.nodeIds ?? []) {
      const described = (await client.send('DOM.describeNode', { nodeId })) as {
        node?: { backendNodeId?: number };
      };
      const backendNodeId = described?.node?.backendNodeId;
      if (backendNodeId !== undefined) ids.add(backendNodeId);
    }
  } catch {
    // No DOM domain / detached target — see the fail-open note above.
  } finally {
    if (searchId !== undefined) {
      // The backend holds the result set until it is discarded; the snapshot
      // path runs on every call, so leaking one per snapshot adds up.
      await client.send('DOM.discardSearchResults', { searchId }).catch(() => {
        /* best-effort cleanup */
      });
    }
  }
  return ids;
}
