import type { Page } from 'playwright-core';
import type { JsonEvaluator } from './page-eval';
import { getConnectionScope } from '../connectionScope';

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
 * Stale-tag hygiene: prior `data-wmux-ref` attributes are removed before
 * re-numbering from 0. Without this, a shrunk interactive set between two
 * snapshots would leave two elements sharing one ref, and resolveRef's
 * `.first()` data-attr fallback (snapshot.ts) could pick the wrong one.
 */
export function buildDomSnapshotExpression(): string {
  return `(() => {
    const sel = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    document.querySelectorAll('[data-wmux-ref]').forEach(el => el.removeAttribute('data-wmux-ref'));
    const interactives = [...document.querySelectorAll(sel)].slice(0, 100);
    interactives.forEach((el, i) => el.setAttribute('data-wmux-ref', String(i)));
    const title = document.title;
    const url = location.href;
    const lines = ['Page: ' + title, 'URL: ' + url, ''];
    document.querySelectorAll('h1,h2,h3').forEach(h => {
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
  /** 1-based index */
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
 * elements into the provided array, assigning 1-based ref numbers.
 */
function collectInteractiveElements(
  nodeMap: Map<string, CdpAXNode>,
  node: CdpAXNode,
  elements: IndexedElement[],
): void {
  if (node.ignored) return;

  const role = node.role?.value ?? 'none';
  const name = node.name?.value ?? '';

  if (INTERACTIVE_ROLES.has(role)) {
    const ref = elements.length + 1; // 1-based
    const element: IndexedElement = {
      ref,
      role,
      name,
      locator: buildLocatorString(role, name),
    };

    if (node.value?.value) {
      element.value = node.value.value;
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
        collectInteractiveElements(nodeMap, child, elements);
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

    // Build a map for quick lookup by nodeId
    const nodeMap = new Map<string, CdpAXNode>();
    for (const n of nodes) nodeMap.set(n.nodeId, n);

    const elements: IndexedElement[] = [];
    collectInteractiveElements(nodeMap, nodes[0], elements);
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
 * Refs are 1-based to match getSmartSnapshot() and getLocatorByRef()'s `ref-1`
 * lookup. Each interactive element is tagged `data-wmux-ref="<ref>"` with the
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
      const val = el.value;
      if (typeof val === 'string' && val) out.value = val;
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
 * Look up a Playwright locator string by the 1-based ref number assigned
 * during the most recent `getSmartSnapshot()` call.
 *
 * Returns `null` if the ref is out of range or no snapshot has been taken.
 */
export function getLocatorByRef(ref: number): string | null {
  const cache = getElementCache();
  if (ref < 1 || ref > cache.length) return null;
  return cache[ref - 1].locator;
}

/**
 * Clear the cached element list. Useful when navigating to a new page
 * to avoid stale refs.
 */
export function clearElementCache(): void {
  setElementCache([]);
}
