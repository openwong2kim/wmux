import type { Locator, Page } from 'playwright-core';
import type { JsonEvaluator } from './page-eval';
import { getConnectionScope } from '../connectionScope';
import {
  PASSWORD_FIELD_PREDICATE_JS,
  REDACTED_PASSWORD,
  getPasswordFieldBackendIds,
} from './redact';

// ---------------------------------------------------------------------------
// Shared interactive-element selector
// ---------------------------------------------------------------------------

/**
 * CSS selector for "interactive" elements that get a ref number in DOM-based
 * (RPC) snapshots. Shared between browser_snapshot's RPC fallback (inspection.ts)
 * and getSmartSnapshotViaEval so both tools tag the SAME elements with
 * data-wmux-ref. The numbering BASE differs by design (browser_snapshot is
 * 0-based; smart snapshot is 1-based to match getSmartSnapshot / getLocatorByRef),
 * so refs are not interchangeable across the two tools — only the element set is.
 */
export const INTERACTIVE_SELECTOR =
  'a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="tab"], [contenteditable="true"]';

/**
 * DOM-based snapshot expression (single source of truth).
 *
 * Returns a self-contained IIFE string that, run in the page, tags every
 * INTERACTIVE_SELECTOR match with a 0-based `data-wmux-ref` and returns a text
 * listing (`[ref=N] tag "text"`). Two call sites share it:
 *   - browser_snapshot's RPC fallback (inspection.ts) — no Playwright Page.
 *   - generateSnapshot()'s root-only fallthrough (snapshot.ts) — via
 *     page.evaluate, when the a11y tree collapses on a background surface.
 *
 * The listing needs no layout (selector queries work on `display:none`
 * documents), which is exactly why it covers background surfaces where the
 * CDP accessibility tree returns root-only.
 *
 * `rootSelector` (optional) scopes the interactive query and heading listing
 * to the first matching element — the 100-element cap then applies within that
 * scope, which is the point: a scoped snapshot of a busy page surfaces the
 * region the agent cares about instead of the first 100 elements site-wide.
 * The stale-ref wipe stays document-wide so an out-of-scope element can never
 * retain a stale ref that collides with the fresh numbering.
 *
 * Stale-tag hygiene: prior `data-wmux-ref` attributes are removed before
 * re-numbering from 0. Without this, a shrunk interactive set between two
 * snapshots would leave two elements sharing one ref, and resolveRef's
 * `.first()` data-attr fallback (snapshot.ts) could pick the wrong one.
 *
 * `filter: 'interactive'` drops the heading (h1–h3) listing so the output is
 * the ref listing alone — the DOM-path equivalent of stripNonInteractive on
 * the a11y path (issue #1066: the param used to be dropped silently here).
 * The `Page:`/`URL:` header always stays: the auto-diff URL guard in
 * inspection.ts parses the `URL: …` line out of this text.
 */
export function buildDomSnapshotExpression(
  rootSelector?: string,
  opts?: { filter?: 'interactive' },
): string {
  return `(() => {
    const sel = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    const rootSel = ${JSON.stringify(rootSelector ?? null)};
    const interactiveOnly = ${JSON.stringify(opts?.filter === 'interactive')};
    const root = rootSel ? document.querySelector(rootSel) : document;
    if (!root) return 'No element matches selector: ' + rootSel;
    document.querySelectorAll('[data-wmux-ref]').forEach(el => el.removeAttribute('data-wmux-ref'));
    const interactives = [...root.querySelectorAll(sel)].slice(0, 100);
    interactives.forEach((el, i) => el.setAttribute('data-wmux-ref', String(i)));
    const title = document.title;
    const url = location.href;
    const lines = ['Page: ' + title, 'URL: ' + url, ''];
    if (rootSel) lines.push('Scope: ' + rootSel, '');
    if (!interactiveOnly) root.querySelectorAll('h1,h2,h3').forEach(h => {
      lines.push(h.tagName + ': ' + (h.textContent || '').trim().substring(0, 80));
    });
    lines.push('', 'Interactive elements (use ref number for click/fill/type):');
    interactives.forEach((el, i) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || '';
      const text = (el.textContent || '').trim().substring(0, 60);
      const label = el.getAttribute('aria-label') || '';
      const name = el.getAttribute('name') || '';
      const type = el.getAttribute('type') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const href = el.getAttribute('href') || '';
      let desc = '  [ref=' + i + '] ' + tag;
      if (type) desc += '[type=' + type + ']';
      if (role) desc += '[role=' + role + ']';
      if (name) desc += ' name="' + name + '"';
      if (label) desc += ' "' + label + '"';
      else if (text) desc += ' "' + text + '"';
      if (placeholder) desc += ' placeholder="' + placeholder + '"';
      if (href) desc += ' -> ' + href.substring(0, 60);
      lines.push(desc);
    });
    return lines.join('\\n');
  })()`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexedElement {
  /**
   * Stable 1-based ref. On the Playwright/CDP lane the number is keyed on the
   * element's DOM node, so it survives insertions above it (see
   * SmartRefIdentity); on the RPC lane it is still the walk position.
   */
  ref: number;
  /** Accessibility role: button, link, textbox, etc. */
  role: string;
  /** Visible text or label */
  name: string;
  /** Current value for inputs */
  value?: string;
  /** aria-description if available */
  description?: string;
  /** Playwright locator string to find this element */
  locator: string;
  /**
   * Position of this element among the same role+name population the snapshot
   * saw, so `getByRole(role, { name }).nth(i)` picks the instance the ref was
   * numbered against. Absent on the RPC lane, whose locator is a CSS selector
   * that already names one element.
   */
  sameNameIndex?: number;
}

export interface SmartSnapshot {
  url: string;
  title: string;
  elements: IndexedElement[];
  /** Truncated page text content */
  content: string;
}

export interface SmartSnapshotOptions {
  /** Maximum length for the page text content (default 3000) */
  maxContentLength?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONTENT_LENGTH = 3000;

/** Roles considered interactive — elements with these roles get indexed */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
]);

// ---------------------------------------------------------------------------
// CDP Accessibility types (subset of fields we use)
// ---------------------------------------------------------------------------

interface CdpAXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  value?: { type: string; value: string };
  description?: { type: string; value: string };
  childIds?: string[];
  ignored?: boolean;
}

// ---------------------------------------------------------------------------
// Element cache — stores indexed elements from the last snapshot
// ---------------------------------------------------------------------------

// Fallback store for single-child mode (no connection scope active). Under the
// broker each connection keeps its OWN cache on its AsyncLocalStorage scope so
// concurrent agents' smart refs never collide — see getElementCache/setElementCache.
let moduleElementCache: IndexedElement[] = [];

function getElementCache(): IndexedElement[] {
  const scope = getConnectionScope();
  if (scope) return (scope.elementCache as IndexedElement[] | undefined) ?? [];
  return moduleElementCache;
}

function setElementCache(elements: IndexedElement[]): void {
  const scope = getConnectionScope();
  if (scope) scope.elementCache = elements;
  else moduleElementCache = elements;
}

// ---------------------------------------------------------------------------
// Smart-ref identity — refs keyed on the DOM node, not on the walk position
// ---------------------------------------------------------------------------

/**
 * Smart refs used to be a running 1-based count over the accessibility walk,
 * so one node inserted above an element renumbered it and everything after it:
 * replaying a ref from the previous smart snapshot clicked the neighbour, with
 * nothing to notice. It also kept browser_smart_snapshot from ever diffing —
 * a renumber rewrites near enough every line.
 *
 * Numbering off `backendDOMNodeId` — the id CDP keeps stable for a DOM node's
 * lifetime — makes an unchanged node keep its ref. This mirrors RefIdentity in
 * snapshot.ts, kept separate because the two number spaces are distinct (smart
 * refs are 1-based, browser_snapshot's are 0-based) and were never
 * interchangeable.
 *
 * Numbers are only ever handed out, never recycled, so a ref that named a
 * removed element can never come back pointing at a different one.
 */
interface SmartRefIdentity {
  /** backendDOMNodeId → the smart ref that node was given. */
  byBackendId: Map<number, number>;
  /** Next unused ref number (1-based). */
  next: number;
  /** URL the number space belongs to; a different document restarts it. */
  url: string | undefined;
}

/**
 * Above this many remembered nodes the identity map is dropped (an SPA that
 * churns nodes forever would otherwise grow it without bound). `next` is NOT
 * rewound with it — recycling a number is the confusion this exists to
 * prevent — so the cost of hitting the cap is one renumbering of live nodes.
 */
const SMART_REF_IDENTITY_CAP = 5000;

const pageSmartRefIdentity = new WeakMap<Page, SmartRefIdentity>();

/**
 * The part of the URL that decides whether this is still the same document.
 *
 * Fragment dropped for the same reason as snapshot.ts's documentKey: a docs
 * page rewrites `location.hash` as you scroll, and counting that as a
 * navigation would retire every ref mid-flow. Kept local rather than imported
 * because snapshot.ts already imports this module — the reverse edge would
 * close a cycle.
 */
function smartDocumentKey(page: Page): string | undefined {
  let url: string | undefined;
  try {
    const raw = (page as { url?: () => string }).url?.();
    url = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
  if (url === undefined) return undefined;
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * Open a snapshot's number space, resetting it when the page has moved to a
 * different document (its backendDOMNodeIds mean nothing there). `next` is not
 * rewound on a document change: an agent still holding a ref from the old
 * document must not be handed whatever now sits at that number.
 */
function beginSmartRefGeneration(page: Page): SmartRefIdentity {
  const url = smartDocumentKey(page);
  let identity = pageSmartRefIdentity.get(page);
  if (!identity) {
    identity = { byBackendId: new Map(), next: 1, url };
    pageSmartRefIdentity.set(page, identity);
  } else if (identity.url !== undefined && url !== undefined && identity.url !== url) {
    identity.byBackendId.clear();
  }
  if (identity.byBackendId.size > SMART_REF_IDENTITY_CAP) identity.byBackendId.clear();
  identity.url = url;
  return identity;
}

/** The smart ref for this node, minting one the first time we see it. */
function assignSmartRef(identity: SmartRefIdentity, backendDOMNodeId?: number): number {
  if (backendDOMNodeId === undefined) return identity.next++;
  const existing = identity.byBackendId.get(backendDOMNodeId);
  if (existing !== undefined) return existing;
  const ref = identity.next++;
  identity.byBackendId.set(backendDOMNodeId, ref);
  return ref;
}

/**
 * Record, per element, its position among the same role+name population.
 *
 * resolveSmartRefLocator locates through `getByRole(...).nth(i)`, which is only
 * sound against the population the snapshot saw — and a stable ref number says
 * nothing about where the element now sits in that population.
 */
function finalizeSameNameIndices(elements: IndexedElement[]): void {
  const seen = new Map<string, number>();
  for (const element of elements) {
    const key = `${element.role} ${element.name}`;
    const index = seen.get(key) ?? 0;
    element.sameNameIndex = index;
    seen.set(key, index + 1);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape special characters in a string for use inside a Playwright
 * locator expression (e.g. `getByRole('button', { name: '...' })`).
 */
function escapeLocatorName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Build a Playwright locator string for a given role and name.
 *
 * If the name is empty, falls back to `getByRole('role')` without a
 * name filter. When duplicate names exist for the same role, callers
 * should use `.nth()` — but we provide the base locator here.
 */
function buildLocatorString(role: string, name: string): string {
  if (!name) {
    return `getByRole('${role}')`;
  }
  return `getByRole('${role}', { name: '${escapeLocatorName(name)}' })`;
}

/**
 * Recursively walk the CDP accessibility tree and collect interactive
 * elements into the provided array, assigning refs out of the page's identity
 * number space (see SmartRefIdentity).
 */
function collectInteractiveElements(
  nodeMap: Map<string, CdpAXNode>,
  node: CdpAXNode,
  elements: IndexedElement[],
  passwordBackendIds: Set<number>,
  identity: SmartRefIdentity,
): void {
  const role = node.role?.value ?? 'none';
  const name = node.name?.value ?? '';

  // An ignored node contributes nothing itself, but we must still descend into
  // its children: Chrome hangs a chain of ignored "uninteresting" wrappers
  // (html → body → generic) directly under the RootWebArea, so returning early
  // here skipped the entire document. Same splice rule as buildTree() in
  // snapshot.ts — see the comment there for the measurement.
  if (!node.ignored && INTERACTIVE_ROLES.has(role)) {
    const ref = assignSmartRef(identity, node.backendDOMNodeId);
    const element: IndexedElement = {
      ref,
      role,
      name,
      locator: buildLocatorString(role, name),
    };

    if (node.value?.value) {
      // A password field reports its name, role and ref as usual; only the
      // contents are withheld. Chrome pre-masks `type=password` here, but not a
      // `type=text` field marked autocomplete="new-password" — see redact.ts.
      element.value =
        node.backendDOMNodeId !== undefined && passwordBackendIds.has(node.backendDOMNodeId)
          ? REDACTED_PASSWORD
          : node.value.value;
    }
    if (node.description?.value) {
      element.description = node.description.value;
    }

    elements.push(element);
  }

  // Recurse into children
  if (node.childIds) {
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (child) {
        collectInteractiveElements(nodeMap, child, elements, passwordBackendIds, identity);
      }
    }
  }
}

/**
 * Fetch the full accessibility tree via CDP and return indexed interactive
 * elements.
 */
async function getInteractiveElements(page: Page): Promise<IndexedElement[]> {
  const client = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await client.send('Accessibility.getFullAXTree' as any)) as {
      nodes: CdpAXNode[];
    };

    if (nodes.length === 0) return [];

    // Password fields are identified DOM-side and matched to a11y nodes through
    // backendNodeId — the a11y node itself carries neither `type` nor
    // `autocomplete`. Same bridge snapshot.ts uses.
    const passwordBackendIds = await getPasswordFieldBackendIds(
      client as unknown as { send: (method: string, params?: unknown) => Promise<unknown> },
    );

    // Build a map for quick lookup by nodeId
    const nodeMap = new Map<string, CdpAXNode>();
    for (const n of nodes) nodeMap.set(n.nodeId, n);

    const elements: IndexedElement[] = [];
    collectInteractiveElements(
      nodeMap,
      nodes[0],
      elements,
      passwordBackendIds,
      beginSmartRefGeneration(page),
    );
    finalizeSameNameIndices(elements);
    return elements;
  } finally {
    await client.detach().catch(() => {
      /* best-effort cleanup */
    });
  }
}

/**
 * Retrieve truncated page text content.
 */
async function getPageContent(page: Page, maxLength: number): Promise<string> {
  try {
    const text = await page.innerText('body');
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '\n... (truncated)';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a "smart snapshot" of the page: a structured representation
 * containing only interactive elements (with 1-based ref indices) plus a
 * truncated text summary of the page content.
 *
 * The indexed elements are cached internally so that `getLocatorByRef()`
 * can resolve a ref number back to a Playwright locator string without
 * re-querying the page.
 */
export async function getSmartSnapshot(
  page: Page,
  options?: SmartSnapshotOptions,
): Promise<SmartSnapshot> {
  const maxContentLength = options?.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;

  const [url, title, elements, content] = await Promise.all([
    Promise.resolve(page.url()),
    page.title(),
    getInteractiveElements(page),
    getPageContent(page, maxContentLength),
  ]);

  // Update element cache
  setElementCache(elements);

  return { url, title, elements, content };
}

/**
 * DOM-based smart snapshot for the packaged-build RPC fallback (issue #105).
 *
 * When PlaywrightEngine.getPage() returns null, the CDP accessibility tree used
 * by getSmartSnapshot() is unavailable, so this derives the same SmartSnapshot
 * shape from a single injected DOM script over the RPC `browser.evaluate`
 * channel. Lower role fidelity than the AX tree (tag/role heuristic) — the
 * accepted packaged-mode degradation; the dev path keeps full fidelity.
 *
 * Refs on this lane stay POSITIONAL (1-based walk order), unlike the CDP lane
 * above. Identity cannot be held here: the only place to keep it is the
 * `data-wmux-ref` attribute, and browser_snapshot's RPC fallback strips every
 * one of those document-wide and renumbers from 0 on each of its own scans
 * (buildDomSnapshotExpression, above). An interleaved browser_snapshot would
 * therefore either wipe the identity or, worse, leave 0-based numbers behind
 * for this scan to adopt as its own. browser_smart_snapshot skips diffing on
 * this lane for exactly that reason (tools/extraction.ts).
 *
 * Each interactive element is tagged `data-wmux-ref="<ref>"` with the
 * SAME 1-based number, so:
 *   - RPC-mode click: browser_click({smartRef}) -> [data-wmux-ref="<smartRef>"].
 *   - page-mode click after getPage() recovers: getLocatorByRef returns
 *     `[data-wmux-ref="<ref>"]`, which page.locator() resolves against the
 *     attributes this snapshot left in the (same) webview DOM.
 * elementCache is populated for exactly that second case.
 */
export async function getSmartSnapshotViaEval(
  evaluate: JsonEvaluator,
  options?: SmartSnapshotOptions,
): Promise<SmartSnapshot> {
  const maxContentLength = Math.max(
    0,
    Math.floor(options?.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH),
  );

  // Note: the selector + .slice(0, 100) cap + data-wmux-ref tagging mirror
  // browser_snapshot's RPC fallback (inspection.ts) via INTERACTIVE_SELECTOR.
  const script = `(() => {
    const sel = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    const max = ${maxContentLength};
    const isPasswordField = ${PASSWORD_FIELD_PREDICATE_JS};
    const redactedPassword = ${JSON.stringify(REDACTED_PASSWORD)};
    const els = [...document.querySelectorAll(sel)].slice(0, 100);
    const roleFor = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
        return 'textbox';
      }
      if (el.getAttribute('contenteditable') === 'true') return 'textbox';
      return 'generic';
    };
    const elements = els.map((el, i) => {
      const ref = i + 1; // 1-based — matches getSmartSnapshot / getLocatorByRef
      el.setAttribute('data-wmux-ref', String(ref));
      const name = (el.getAttribute('aria-label')
        || (el.textContent || '').trim()
        || el.getAttribute('placeholder')
        || el.getAttribute('name')
        || '').substring(0, 120);
      const out = { ref, role: roleFor(el), name };
      // el.value is the plaintext for EVERY input type, password included —
      // this path has no a11y tree doing the masking for it (redact.ts).
      const val = el.value;
      if (typeof val === 'string' && val) {
        out.value = isPasswordField(el) ? redactedPassword : val;
      }
      const desc = el.getAttribute('aria-description');
      if (desc) out.description = desc;
      return out;
    });
    let content = (document.body && document.body.innerText) || '';
    if (content.length > max) content = content.slice(0, max) + '\\n... (truncated)';
    return { url: location.href, title: document.title, content, elements };
  })()`;

  const raw = (await evaluate(script)) as {
    url?: string;
    title?: string;
    content?: string;
    elements?: Array<{ ref: number; role: string; name: string; value?: string; description?: string }>;
  } | null;

  const elements: IndexedElement[] = (raw?.elements ?? []).map((e) => ({
    ref: e.ref,
    role: e.role,
    name: e.name,
    ...(e.value !== undefined && { value: e.value }),
    ...(e.description !== undefined && { description: e.description }),
    locator: `[data-wmux-ref="${e.ref}"]`,
  }));

  // Cache so browser_click({smartRef}) resolves via getLocatorByRef even if
  // getPage() flips null->page between this snapshot and the click.
  setElementCache(elements);

  return {
    url: raw?.url ?? '',
    title: raw?.title ?? '',
    elements,
    content: raw?.content ?? '',
  };
}

/**
 * Look up the element carrying `ref` in the most recent smart snapshot.
 *
 * Keyed on the stored ref, NOT on `cache[ref - 1]`: identity refs are no
 * longer a dense 1..n range (a removed element retires its number for good),
 * so positional indexing would return the wrong element or nothing at all.
 */
export function getSmartElementByRef(ref: number): IndexedElement | null {
  return getElementCache().find((element) => element.ref === ref) ?? null;
}

/**
 * Look up a Playwright locator string by the ref number assigned during the
 * most recent smart snapshot.
 *
 * Returns `null` if no element carries that ref.
 */
export function getLocatorByRef(ref: number): string | null {
  return getSmartElementByRef(ref)?.locator ?? null;
}

/**
 * Resolve a smart ref to a live Playwright locator.
 *
 * The two lanes store two different kinds of locator and only one of them is a
 * selector: the RPC lane's `[data-wmux-ref="N"]` is CSS and goes straight to
 * `page.locator()`, while the CDP lane's `getByRole('button', { name: 'OK' })`
 * is a source snippet that `page.locator()` cannot parse at all. Rebuild the
 * latter through the real `getByRole` API, pinned with `.nth()` to the
 * instance the ref was numbered against.
 */
export function resolveSmartRefLocator(page: Page, ref: number): Locator | null {
  const element = getSmartElementByRef(ref);
  if (!element) return null;
  if (element.locator.startsWith('[data-wmux-ref=')) return page.locator(element.locator);
  const byRole = element.name
    ? page.getByRole(element.role as Parameters<Page['getByRole']>[0], { name: element.name })
    : page.getByRole(element.role as Parameters<Page['getByRole']>[0]);
  return byRole.nth(element.sameNameIndex ?? 0);
}

/**
 * Clear the cached element list. Useful when navigating to a new page
 * to avoid stale refs.
 */
export function clearElementCache(): void {
  setElementCache([]);
}
