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
 * module comment measures. Kept lowercase and flag-free so it parses on every
 * engine — `type` is matched ASCII-case-insensitively by the HTML spec anyway,
 * and `autocomplete` tokens are spec-defined lowercase.
 */
export const PASSWORD_FIELD_SELECTOR =
  'input[type="password"], input[autocomplete~="current-password"], input[autocomplete~="new-password"]';

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
 * debuggable — over-masking would defeat the tool it protects.
 */
const PASSWORD_KEY = '[\\w.\\[\\]-]*(?:password|passwd|pwd)[\\w.\\[\\]-]*';

/** `"password": "…"` at any nesting depth of a JSON body. */
const JSON_PASSWORD = new RegExp(`("${PASSWORD_KEY}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi');

/**
 * `password=…` in a query string or an `application/x-www-form-urlencoded`
 * body. The leading `^|[?&;]` boundary is what keeps a path like
 * `/account/reset-password` untouched: a key has to actually be a key.
 */
const FORM_PASSWORD = new RegExp(`(^|[?&;])(${PASSWORD_KEY})=[^&;#\\s]*`, 'gi');

/**
 * Replace password parameter VALUES in a URL or a request/response body,
 * leaving the parameter names — and everything else — exactly as they were.
 *
 * Covers the two shapes a login actually posts (JSON and form-urlencoded) plus
 * the query string of a GET that puts a credential in the URL.
 */
export function redactPasswordParams(text: string): string {
  if (!text) return text;
  return text
    .replace(JSON_PASSWORD, `$1"${REDACTED_PASSWORD}"`)
    .replace(FORM_PASSWORD, `$1$2=${REDACTED_PASSWORD}`);
}

// ---------------------------------------------------------------------------
// CDP: DOM → a11y bridge
// ---------------------------------------------------------------------------

/** The subset of a CDP session this module needs. */
interface CdpSender {
  send: (method: string, params?: unknown) => Promise<unknown>;
}

/**
 * backendNodeIds of every password field in the document.
 *
 * `backendNodeId` is the one id space the DOM and Accessibility domains share,
 * which is what lets a DOM-side `type`/`autocomplete` test decide whether an
 * a11y node may show its value (the a11y node itself carries neither).
 *
 * Fails OPEN — an empty set on any CDP error. Redaction is a filter over the
 * a11y tree, so failing closed would mean masking every value on the page;
 * failing open degrades to exactly Chrome's own behaviour (`type=password`
 * still arrives pre-masked as bullets), which is where this started.
 */
export async function getPasswordFieldBackendIds(client: CdpSender): Promise<Set<number>> {
  const ids = new Set<number>();
  try {
    const doc = (await client.send('DOM.getDocument', { depth: 0 })) as {
      root?: { nodeId?: number };
    };
    const rootNodeId = doc?.root?.nodeId;
    if (!rootNodeId) return ids;

    const found = (await client.send('DOM.querySelectorAll', {
      nodeId: rootNodeId,
      selector: PASSWORD_FIELD_SELECTOR,
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
  }
  return ids;
}
