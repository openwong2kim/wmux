/**
 * The Content-Security-Policy the browser terminal is served under (M3 §6).
 *
 * WHY IT IS A PREREQUISITE, NOT A POLISH: the security review rated "no CSP"
 * LOW **because the web token died on every daemon restart** — an XSS could
 * only ever steal a secret that was about to expire. M3 made credentials
 * durable and individually long-lived, which invalidates that rating: an XSS on
 * this page now steals a device credential that works until somebody revokes
 * it. `script-src` restricted to the exact hashes of the three blocks the build
 * inlined is what stops that, and it is the load-bearing directive here.
 *
 * WHY THE HASHES ARE DERIVED FROM THE SERVED BYTES rather than read from a file
 * the build wrote: a header and a page that disagree fail CLOSED — the page
 * blocks its own code and the terminal is a blank screen. Deriving the policy
 * from `terminal.html` itself means the two cannot drift by construction, in
 * dev, in a packaged build, or after a partial copy. `scripts/build-daemon-web.mjs`
 * computes the same hashes and fails the BUILD when the page it just wrote
 * cannot be hashed cleanly, so a broken page never reaches the server at all.
 */
import { createHash } from 'node:crypto';

/** The inline blocks of one built page, in document order. */
export interface InlineBlocks {
  /** Bodies of every `<script>` with no `src` — what `script-src` must allow. */
  scripts: string[];
  /** Bodies of every inline `<style>`. */
  styles: string[];
  /**
   * External sub-resources the page references from a `src`/stylesheet `href`.
   * Under `default-src 'none'` every one of these is a resource the browser
   * will refuse to load, so the build treats a non-empty list as a failure
   * rather than shipping a page with a hole in it.
   */
  externalRefs: string[];
}

const BLOCK_RE = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
const SCRIPT_SRC_ATTR = /\bsrc\s*=/i;
const STYLESHEET_LINK_RE = /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi;

/**
 * Newline normalization, and the single reason a naive byte hash of the file
 * does NOT match what the browser computes.
 *
 * The HTML parser preprocesses its input stream by rewriting every CRLF and
 * every lone CR to a single LF *before* the tokenizer ever sees it, so the text
 * a `<script>` element ends up holding — and therefore the text the CSP hash is
 * taken over — has LF endings no matter what the file on disk contains.
 * `terminal.html` is assembled from sources with BOTH conventions (our own
 * frontend files come out of a Windows checkout as CRLF, the vendored xterm
 * bundle is LF), so hashing the raw bytes produces a header that blocks every
 * block it was meant to allow. Verified against real Chromium: without this,
 * all four blocks are refused with `script-src-elem`/`style-src-elem`.
 */
export function normalizeForHash(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}

/** One CSP `'sha256-…'` source expression for an inline block's body. */
export function cspHash(source: string): string {
  const digest = createHash('sha256').update(normalizeForHash(source), 'utf8').digest('base64');
  return `'sha256-${digest}'`;
}

/** Split a built page into the inline blocks a hash-based policy has to name. */
export function extractInlineBlocks(html: string): InlineBlocks {
  const scripts: string[] = [];
  const styles: string[] = [];
  const externalRefs: string[] = [];

  BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLOCK_RE.exec(html)) !== null) {
    const [, tag, attrs, body] = match;
    if (tag.toLowerCase() === 'script') {
      if (SCRIPT_SRC_ATTR.test(attrs)) externalRefs.push(`<script${attrs}>`);
      else scripts.push(body);
    } else {
      styles.push(body);
    }
  }
  STYLESHEET_LINK_RE.lastIndex = 0;
  for (const link of html.match(STYLESHEET_LINK_RE) ?? []) externalRefs.push(link);

  return { scripts, styles, externalRefs };
}

/**
 * `style-src` — the one directive that is NOT hash-pinned, deliberately, with
 * the reason recorded here rather than hidden in a commit message.
 *
 * xterm 6.0.0 creates three `<style>` elements at runtime (the theme block, the
 * cell-dimension block, and the shared-stylesheet helper) and fills them with
 * values it computes from the measured font — px sizes and theme colours that
 * differ per device and per zoom level. Their content cannot be enumerated at
 * build time, so no hash can name them, and xterm exposes no nonce option
 * (`grep -c nonce node_modules/@xterm/xterm/lib/xterm.js` → 0). Under a
 * hash-only `style-src` a real Chromium refuses all three
 * (`effectiveDirective: 'style-src-elem'`, `blockedURI: 'inline'`) and the
 * terminal renders with no cell metrics and no theme — a blank screen, not a
 * degraded one. Adding the page's own hash alongside `'unsafe-inline'` would be
 * worse than useless: per CSP3 a hash present in a directive makes
 * `'unsafe-inline'` be IGNORED, so that spelling is the broken one.
 *
 * What that costs is bounded by the directives around it: CSS cannot exfiltrate
 * anything here because `default-src 'none'` and `img-src 'self' data:` leave a
 * stylesheet no outbound URL to load. What it does NOT cost is `script-src`,
 * which stays pinned to exact hashes — that is the directive standing between
 * an injected `<script>` and a durable device credential.
 *
 * The fix is upstream: an `ITerminalOptions.nonce` in xterm would let this
 * become `style-src 'nonce-…'`. Until then this is the honest spelling.
 */
const STYLE_SRC = "'unsafe-inline'";

/**
 * Build the policy for a page.
 *
 * `null` means the assets are missing and the server is answering 503 in plain
 * text: pin `script-src` to `'none'` rather than emitting a policy that allows
 * whatever the last good page allowed.
 *
 * `worker-src` and `manifest-src` are here because `default-src 'none'` would
 * otherwise take two shipped features with it — CSP falls `worker-src` back to
 * `script-src`, so a hash-pinned `script-src` refuses `navigator.serviceWorker
 * .register('/sw.js')` ("Note that 'worker-src' was not explicitly set, so
 * 'script-src' is used as a fallback"), and `manifest-src` falls all the way
 * back to `default-src`, which would refuse `/manifest.webmanifest` and with it
 * add-to-home-screen. Both are same-origin and nothing else.
 */
export function buildWebCsp(html: string | null): string {
  const blocks = html ? extractInlineBlocks(html) : null;
  const scriptSrc = blocks && blocks.scripts.length > 0
    ? blocks.scripts.map(cspHash).join(' ')
    : "'none'";
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${STYLE_SRC}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
