import type { Page, ElementHandle } from 'playwright-core';
import { buildDomSnapshotExpression } from './dom-intelligence';
import {
  REDACTED_PASSWORD,
  getPasswordFieldBackendIds,
  redactPasswordParams,
} from './redact';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SnapshotOptions {
  /** 'ai' = interactive elements with ref, 'aria' = full tree */
  format?: 'ai' | 'aria';
  /** Maximum tree depth (default 10) */
  depth?: number;
  /** Maximum output length in characters (default 50000) */
  maxLength?: number;
  /** 'interactive' = strip non-interactive nodes up front ('ai' format only),
   *  not just on overflow — the measured-dominant agent usage. */
  filter?: 'interactive';
}

/**
 * Emitted when `filter` arrives with `format:"aria"`. The strip exists on the
 * 'ai' path only — aria's contract IS the whole tree, so filtering it would
 * break the thing the format was asked for. Reporting the param as ignored
 * beats dropping it in silence, the same honesty rule the aria-unavailable
 * notes below already follow (#1082).
 */
const ARIA_FILTER_NOTE = '(note: filter ignored for aria format — returning the full tree)';

/** CDP Accessibility.AXNode shape (subset of fields we use) */
interface CdpAXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  value?: { type: string; value: string };
  description?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: any } }>;
  childIds?: string[];
  parentId?: string;
  ignored?: boolean;
}

/** Normalised tree node built from CDP data */
export interface AXNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  children?: AXNode[];
  backendDOMNodeId?: number;
  // properties
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  level?: number;
  selected?: boolean;
  pressed?: boolean | 'mixed';
  valuetext?: string;
}

// Roles considered interactive — these get a ref number in 'ai' format
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
// CDP → AXNode tree builder
// ---------------------------------------------------------------------------

/** A built tree plus the DOM→a11y index that selector scoping resolves through. */
interface BuiltTree {
  root: AXNode;
  /**
   * backendDOMNodeId → the node(s) that DOM element contributes to the tree.
   * Normally a single node; for an `ignored` element it is the forest its
   * children were spliced into, so scoping a selector to an "uninteresting"
   * wrapper still yields that wrapper's real content instead of nothing.
   */
  byBackendId: Map<number, AXNode[]>;
}

/**
 * @param passwordBackendIds backendNodeIds of the document's password fields
 *   (resolved DOM-side by getPasswordFieldBackendIds). Their values never reach
 *   the tree — see the redaction branch in convert().
 */
function buildTree(
  nodes: CdpAXNode[],
  passwordBackendIds: Set<number> = new Set(),
): BuiltTree | null {
  if (nodes.length === 0) return null;

  const map = new Map<string, CdpAXNode>();
  for (const n of nodes) map.set(n.nodeId, n);

  const byBackendId = new Map<number, AXNode[]>();

  /** Record what a DOM element contributed, then hand it back to the caller. */
  function index(cdp: CdpAXNode, contributed: AXNode[]): AXNode[] {
    if (cdp.backendDOMNodeId !== undefined && contributed.length > 0) {
      byBackendId.set(cdp.backendDOMNodeId, contributed);
    }
    return contributed;
  }

  /**
   * Convert one CDP node into the list of nodes it contributes to its parent.
   *
   * An `ignored` node is SPLICED, not dropped: the node itself disappears but
   * its children take its place under the parent (what Playwright/Puppeteer
   * do). Dropping the subtree looks harmless — the nodes are "uninteresting"
   * after all — but Chrome hangs a chain of ignored wrappers (html → body →
   * generic, every one of them `ignoredReasons: ["uninteresting"]`) directly
   * under the RootWebArea, so dropping them decapitates the entire document.
   * Measured on a real page: 8 ignored nodes out of 1126 left the root with
   * ZERO children, which made isRootOnly() true and silently demoted every
   * snapshot to the DOM fallback — taking `format:"aria"` and
   * `filter:"interactive"` (a11y-path-only features) down with it. Splicing
   * the same tree keeps 1118 nodes, links included.
   */
  function convert(cdp: CdpAXNode): AXNode[] {
    // A password field is materialised WITHOUT its subtree, and with its value
    // replaced. The subtree has to go because Chrome repeats the field's
    // contents a second time as StaticText descendants of the input (its shadow
    // editor's text), so masking the node's own `value` alone still leaks —
    // measured on Chrome 141, see redact.ts. Dropping it costs nothing: the
    // only thing under an <input> is that editor text. The field itself stays
    // whole — role, label, ref — which is what makes the form fillable.
    if (
      cdp.backendDOMNodeId !== undefined &&
      passwordBackendIds.has(cdp.backendDOMNodeId)
    ) {
      return index(cdp, [redactValue(materialize(cdp, []))]);
    }
    const children = convertChildren(cdp);
    // Contribute our (already spliced) children in our own place. Recursion
    // flattens an ignored → ignored → ignored → real chain in a single pass.
    if (cdp.ignored) return index(cdp, children);
    return index(cdp, [materialize(cdp, children)]);
  }

  /**
   * Mask a node's value in place. An EMPTY field is left alone: `value` stays
   * undefined and the node renders without a value attribute, exactly as it
   * does today — "this field is filled" is legitimate signal, the contents are
   * not.
   */
  function redactValue(node: AXNode): AXNode {
    if (node.value) node.value = REDACTED_PASSWORD;
    if (node.valuetext) node.valuetext = REDACTED_PASSWORD;
    return node;
  }

  function convertChildren(cdp: CdpAXNode): AXNode[] {
    if (!cdp.childIds || cdp.childIds.length === 0) return [];
    const out: AXNode[] = [];
    for (const cid of cdp.childIds) {
      const child = map.get(cid);
      if (child) out.push(...convert(child));
    }
    return out;
  }

  function materialize(cdp: CdpAXNode, children: AXNode[]): AXNode {
    const role = cdp.role?.value ?? 'none';
    const name = cdp.name?.value ?? '';

    const node: AXNode = { role, name };
    if (cdp.value?.value) node.value = cdp.value.value;
    if (cdp.description?.value) node.description = cdp.description.value;
    if (cdp.backendDOMNodeId !== undefined) node.backendDOMNodeId = cdp.backendDOMNodeId;

    // Extract boolean/enum properties
    if (cdp.properties) {
      for (const prop of cdp.properties) {
        switch (prop.name) {
          case 'checked':
            node.checked = prop.value.value === 'mixed' ? 'mixed' : !!prop.value.value;
            break;
          case 'disabled':
            node.disabled = !!prop.value.value;
            break;
          case 'expanded':
            node.expanded = !!prop.value.value;
            break;
          case 'focused':
            node.focused = !!prop.value.value;
            break;
          case 'level':
            node.level = Number(prop.value.value);
            break;
          case 'selected':
            node.selected = !!prop.value.value;
            break;
          case 'pressed':
            node.pressed = prop.value.value === 'mixed' ? 'mixed' : !!prop.value.value;
            break;
          case 'valuetext':
            node.valuetext = String(prop.value.value);
            break;
        }
      }
    }

    if (children.length > 0) node.children = children;

    return node;
  }

  // The root is materialised even when it is itself ignored. It is a pure
  // container at this layer — serializeTree emits `root.children` and never the
  // root's own line, and isRootOnly only reads its children — so keeping it
  // preserves every promoted child instead of arbitrarily electing one of them
  // as the new root (or returning null and losing the document outright).
  const root = materialize(nodes[0], convertChildren(nodes[0]));
  index(nodes[0], [root]);
  return { root, byBackendId };
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

export interface RefEntry {
  role: string;
  name: string;
  backendDOMNodeId?: number;
}

/** Per-page storage of the last generated refMap to avoid concurrency issues */
const pageRefMaps = new WeakMap<Page, RefEntry[]>();

/**
 * CSS selector the last a11y refMap was scoped to, when it was scoped.
 * resolveRef must search inside that element, not the whole page: a scoped
 * refMap numbers refs within the subtree, so counting same-role+name matches
 * page-wide would resolve to an element outside the requested scope.
 * Always written together with pageRefMaps via setPageRefs().
 */
const pageRefScopes = new WeakMap<Page, string>();

function setPageRefs(page: Page, refs: RefEntry[], scopeSelector?: string): void {
  pageRefMaps.set(page, refs);
  if (scopeSelector === undefined) pageRefScopes.delete(page);
  else pageRefScopes.set(page, scopeSelector);
}

/**
 * Mark a page's refs as DOM-attribute-based: an empty a11y refMap makes
 * resolveRef fall through to the `[data-wmux-ref]` locator. Used by the
 * selector-scoped snapshot path in inspection.ts, which tags refs via the DOM
 * expression while a live Page (and possibly a stale a11y refMap from an
 * earlier unscoped snapshot) exists.
 */
export function markDomRefsActive(page: Page): void {
  setPageRefs(page, []);
}


function isInteractive(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

function serializeNode(
  node: AXNode,
  format: 'ai' | 'aria',
  currentDepth: number,
  maxDepth: number,
  indent: number,
  refs: RefEntry[],
): string {
  if (currentDepth > maxDepth) return '';

  const pad = '  '.repeat(indent);
  const role = node.role;
  const name = node.name || '';

  // Build attribute string
  const attrs: string[] = [];

  if (format === 'ai' && isInteractive(role)) {
    const ref = refs.length;
    refs.push({ role, name, backendDOMNodeId: node.backendDOMNodeId });
    attrs.push(`ref="${ref}"`);
  }

  if (node.checked !== undefined) attrs.push(`checked="${node.checked}"`);
  if (node.disabled) attrs.push('disabled');
  if (node.expanded !== undefined) attrs.push(`expanded="${node.expanded}"`);
  if (node.selected) attrs.push('selected');
  if (node.level !== undefined) attrs.push(`level="${node.level}"`);
  if (node.valuetext) attrs.push(`valuetext="${node.valuetext}"`);
  if (node.value) attrs.push(`value="${node.value}"`);

  const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  const nameStr = name ? ` "${name}"` : '';

  let line = `${pad}- ${role}${nameStr}${attrStr}`;

  // Recurse into children
  const childLines: string[] = [];
  if (node.children) {
    for (const child of node.children) {
      const childStr = serializeNode(child, format, currentDepth + 1, maxDepth, indent + 1, refs);
      if (childStr) childLines.push(childStr);
    }
  }

  if (childLines.length > 0) {
    line += '\n' + childLines.join('\n');
  }

  return line;
}

/** Serialise a list of sibling nodes at the top level of the output. */
function serializeForest(
  nodes: AXNode[],
  format: 'ai' | 'aria',
  maxDepth: number,
  refs: RefEntry[],
): string {
  const lines: string[] = [];

  for (const node of nodes) {
    const s = serializeNode(node, format, 0, maxDepth, 0, refs);
    if (s) lines.push(s);
  }

  return lines.join('\n');
}

function serializeTree(
  root: AXNode,
  format: 'ai' | 'aria',
  maxDepth: number,
  refs: RefEntry[],
): string {
  // The RootWebArea is a container, not content — emit its children.
  return serializeForest(root.children ?? [root], format, maxDepth, refs);
}

function stripNonInteractive(node: AXNode): AXNode | null {
  if (isInteractive(node.role)) return node;

  if (!node.children) return null;

  const filtered = node.children
    .map(stripNonInteractive)
    .filter((c): c is AXNode => c !== null);

  if (filtered.length === 0) return null;

  return { ...node, children: filtered };
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

/**
 * A "root-only" tree is a single node with no rendered children — what CDP
 * `Accessibility.getFullAXTree` returns for a layout-less document. A background
 * browser surface is rendered `display:none` (BrowserPanel.tsx), so its guest
 * has no layout and the whole a11y tree collapses to the `RootWebArea`.
 * generateSnapshot() uses this to decide when to fall through to the DOM-selector
 * snapshot (which needs no layout). Exported for unit testing (issue #353).
 */
export function isRootOnly(tree: AXNode): boolean {
  return !tree.children || tree.children.length === 0;
}

type CdpClient = {
  send: (method: string, params?: unknown) => Promise<unknown>;
  detach: () => Promise<void>;
};

/** Fetch and build the full a11y tree over an already-open CDP session. */
async function fetchAccessibilityTree(client: CdpClient): Promise<BuiltTree | null> {
  // Enable the Accessibility domain before querying. Without it, getFullAXTree
  // is racy on heavy pages — the domain computes the tree lazily on enable.
  await client.send('Accessibility.enable').catch(() => { /* best-effort */ });

  // Which nodes may show their value. Resolved DOM-side (an a11y node carries
  // neither `type` nor `autocomplete`) and matched through backendNodeId, the
  // id space both domains share. Reused across the retry below — the document
  // does not change identity in 250 ms.
  const passwordBackendIds = await getPasswordFieldBackendIds(client);

  let built = buildTree(
    (await client.send('Accessibility.getFullAXTree') as { nodes: CdpAXNode[] }).nodes,
    passwordBackendIds,
  );

  // A foreground heavy / custom-element SPA can momentarily yield a root-only
  // tree while the a11y tree is still computing. One short retry salvages those
  // into a proper tree instead of degrading to the DOM fallback. Background
  // surfaces stay root-only regardless (no layout) — generateSnapshot handles
  // those via the DOM-selector fallthrough, so the extra 250 ms is the price of
  // recovering foreground fidelity.
  if (built && isRootOnly(built.root)) {
    await new Promise((r) => setTimeout(r, 250));
    built = buildTree(
      (await client.send('Accessibility.getFullAXTree') as { nodes: CdpAXNode[] }).nodes,
      passwordBackendIds,
    );
  }

  return built;
}

/**
 * Resolve a CSS selector to the backendNodeId the a11y tree indexes elements
 * by. `backendNodeId` is the one id space shared by the DOM and Accessibility
 * domains, which is what lets a DOM selector address an a11y subtree at all.
 * Returns null when the selector matches nothing (or DOM queries are refused),
 * so the caller can fall back rather than report a wrong scope.
 */
async function resolveSelectorBackendId(
  client: CdpClient,
  selector: string,
): Promise<number | null> {
  try {
    const doc = (await client.send('DOM.getDocument', { depth: 0 })) as {
      root?: { nodeId?: number };
    };
    const rootNodeId = doc?.root?.nodeId;
    if (!rootNodeId) return null;

    const found = (await client.send('DOM.querySelector', {
      nodeId: rootNodeId,
      selector,
    })) as { nodeId?: number };
    // CDP reports "no match" as nodeId 0, not as an error.
    if (!found?.nodeId) return null;

    const described = (await client.send('DOM.describeNode', {
      nodeId: found.nodeId,
    })) as { node?: { backendNodeId?: number } };
    return described?.node?.backendNodeId ?? null;
  } catch {
    // An invalid selector makes DOM.querySelector throw — same as no match for
    // our purposes: let the DOM listing produce the user-facing error.
    return null;
  }
}

async function withCdpSession<T>(
  page: Page,
  fn: (client: CdpClient) => Promise<T>,
  onFailure: T,
): Promise<T> {
  // A dropped/crashed page can't yield a CDP session — return the failure value
  // so the caller falls through to the DOM snapshot instead of throwing.
  const client = (await page.context().newCDPSession(page).catch(() => null)) as CdpClient | null;
  if (!client) return onFailure;
  try {
    return await fn(client);
  } catch {
    // getFullAXTree can throw on a crashed/detached target. Degrade so the
    // caller falls through to the DOM snapshot rather than failing the whole
    // snapshot (panel review — a11y-error path must be rescued too).
    return onFailure;
  } finally {
    await client.send('Accessibility.disable').catch(() => { /* best-effort */ });
    await client.detach().catch(() => { /* best-effort */ });
  }
}

async function getAccessibilityTree(page: Page): Promise<AXNode | null> {
  return withCdpSession(
    page,
    async (client) => (await fetchAccessibilityTree(client))?.root ?? null,
    null,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an accessibility-tree snapshot of the page.
 *
 * In 'ai' format every interactive element receives a sequential `ref="N"`
 * attribute that can later be resolved back to an ElementHandle via
 * `resolveRef()`.
 *
 * Uses CDP `Accessibility.getFullAXTree` under the hood to obtain a
 * structured tree that can be filtered and annotated.
 */
export async function generateSnapshot(
  page: Page,
  options?: SnapshotOptions,
): Promise<string> {
  const format = options?.format ?? 'ai';
  const depth = options?.depth ?? 10;
  const maxLength = options?.maxLength ?? 50_000;

  const tree = await getAccessibilityTree(page);

  // A null tree (no CDP session / getFullAXTree threw / zero nodes) OR a root-only
  // tree (the a11y path collapsed — a background surface with no layout, or a page
  // whose custom elements never expose an a11y tree) both fall through to the
  // DOM-selector snapshot, which needs no layout and tags data-wmux-ref for
  // resolveRef. Applies to BOTH 'ai' and 'aria': a root-only aria tree is equally
  // useless, and the interactive listing beats an empty result (issue #353).
  if (!tree || isRootOnly(tree)) {
    try {
      // Honor filter on the DOM path too — the listing drops its heading block
      // (#1066: the param used to be dropped silently on this early return).
      // The listing carries the page URL and every link href verbatim, so it
      // gets the same URL redaction the network listing does (inspection.ts
      // applies it to its own two DOM-listing branches).
      let domSnapshot = redactPasswordParams(
        (await page.evaluate(
          buildDomSnapshotExpression(undefined, { filter: options?.filter }),
        )) as string,
      );
      // aria has no DOM-listing equivalent — say so instead of silently
      // returning the ai-style listing (same honesty rule as the selector
      // path in inspection.ts). 'ai' needs no note: the listing IS ai-style.
      if (format === 'aria') {
        domSnapshot = `(note: aria format unavailable — the a11y tree collapsed, returning the DOM interactive listing)\n${domSnapshot}`;
      }
      // Leave the refMap empty so resolveRef falls through to the data-wmux-ref
      // locator the DOM expression just tagged.
      setPageRefs(page, []);
      return domSnapshot;
    } catch (err) {
      // Don't mask a real failure (navigation / detach / script error) as a
      // silent empty snapshot — surface it, then degrade gracefully.
      console.warn('[snapshot] DOM fallback failed:', err);
      setPageRefs(page, []);
      if (!tree) return '(empty page)';
      // else: serialize the (root-only) tree below — better than nothing.
    }
  }

  // Opt-in interactive-only filter: same strip as the overflow retry below,
  // but unconditional — the agent asked for only actionable nodes. Zero
  // interactive nodes must NOT fall back to the full tree (review consensus:
  // the filter would silently invert into maximum output) — say so instead.
  let effectiveTree = tree;
  let filterNote = '';
  if (options?.filter === 'interactive') {
    if (format === 'ai') {
      const stripped = stripNonInteractive(tree);
      if (!stripped) {
        setPageRefs(page, []);
        return '(no interactive elements on this page)';
      }
      effectiveTree = stripped;
    } else {
      filterNote = ARIA_FILTER_NOTE;
    }
  }

  let refs: RefEntry[] = [];
  let output = serializeTree(effectiveTree, format, depth, refs);

  // If the output exceeds maxLength AND we are in 'ai' mode, strip
  // non-interactive nodes and regenerate.
  if (output.length > maxLength && format === 'ai') {
    const trimmed = stripNonInteractive(tree);
    if (trimmed) {
      refs = [];
      output = serializeTree(trimmed, format, depth, refs);
    }
  }

  // Hard-truncate as a last resort
  if (output.length > maxLength) {
    output = output.slice(0, maxLength) + '\n... (truncated)';
  }

  // Store the refMap for this page so resolveRef can use it without re-querying
  setPageRefs(page, refs);

  return filterNote ? `${filterNote}\n${output}` : output;
}

/**
 * Snapshot only the subtree of the first element matching `selector`, via the
 * accessibility tree.
 *
 * Selector scoping used to run DOM-side unconditionally, which made it blind to
 * layout: the DOM listing hands out refs for `visibility:hidden` /
 * zero-box elements, and every click on one of those refs timed out (dogfood
 * P0). It also meant `format:"aria"` was silently unavailable whenever a
 * selector was given. The a11y tree already encodes what is actually rendered,
 * so scope through it instead and keep the DOM listing as the fallback.
 *
 * Scoping resolves DOM → a11y through `backendNodeId`, the id space both CDP
 * domains share: `DOM.querySelector` for the element, then the tree's
 * backendDOMNodeId index. Chosen over `Accessibility.getPartialAXTree`, which
 * returns a node with its ancestors and immediate children only — a deep
 * subtree would cost one round-trip per node, whereas the full tree is a single
 * call we already make for every unscoped snapshot and can index for free.
 *
 * Returns null (never a partial or wrong-scope result) when the a11y route
 * cannot serve the request — no CDP session, collapsed tree, selector miss, or
 * an element with no a11y presence — so the caller falls back to the DOM
 * listing, which stays the last resort and the source of the "no match" error.
 */
export async function generateScopedSnapshot(
  page: Page,
  selector: string,
  options?: SnapshotOptions,
): Promise<string | null> {
  const format = options?.format ?? 'ai';
  const depth = options?.depth ?? 10;
  const maxLength = options?.maxLength ?? 50_000;

  const forest = await withCdpSession<AXNode[] | null>(
    page,
    async (client) => {
      // Resolve the selector FIRST: a miss costs nothing and must reach the DOM
      // listing, which owns the user-facing "No element matches selector:" error.
      const backendId = await resolveSelectorBackendId(client, selector);
      if (backendId === null) return null;

      const built = await fetchAccessibilityTree(client);
      if (!built || isRootOnly(built.root)) return null;

      return built.byBackendId.get(backendId) ?? null;
    },
    null,
  );

  if (!forest || forest.length === 0) return null;

  let scoped = forest;
  let filterNote = '';
  if (options?.filter === 'interactive') {
    if (format === 'ai') {
      scoped = forest
        .map(stripNonInteractive)
        .filter((n): n is AXNode => n !== null);
      if (scoped.length === 0) {
        setPageRefs(page, [], selector);
        return '(no interactive elements in this subtree)';
      }
    } else {
      filterNote = ARIA_FILTER_NOTE;
    }
  }

  let refs: RefEntry[] = [];
  // Unlike the page-level tree, the matched element is content, not a container
  // — `dialog "Settings"` is exactly the context the selector asked about — so
  // serialize the forest as-is instead of dropping its top level.
  let output = serializeForest(scoped, format, depth, refs);

  if (output.length > maxLength && format === 'ai') {
    const trimmed = forest
      .map(stripNonInteractive)
      .filter((n): n is AXNode => n !== null);
    if (trimmed.length > 0) {
      refs = [];
      output = serializeForest(trimmed, format, depth, refs);
    }
  }

  if (output.length > maxLength) {
    output = output.slice(0, maxLength) + '\n... (truncated)';
  }

  // Record the scope alongside the refs: these ref numbers are subtree-relative,
  // so resolveRef must count matches inside the same element.
  setPageRefs(page, refs, selector);

  return filterNote ? `${filterNote}\n${output}` : output;
}

/**
 * Resolve a ref number (produced by `generateSnapshot` with format='ai')
 * back to a live ElementHandle.
 *
 * Uses the refMap stored during the last `generateSnapshot()` call for
 * the same page, avoiding a full accessibility tree re-query.
 *
 * Falls back to role-based locator matching using the stored role+name.
 */
export async function resolveRef(
  page: Page,
  ref: string,
): Promise<ElementHandle | null> {
  // Primary: the a11y refMap from the last generateSnapshot() on this page.
  const primary = await resolveRefViaAxMap(page, ref);
  if (primary) return primary;

  // Fallback: DOM snapshots (the RPC fallback + the root-only fallthrough) tag
  // elements with data-wmux-ref. Only consult it when the CURRENT snapshot did
  // NOT come from the a11y path — a populated refMap means the last snapshot was
  // a11y-mode, so any lingering data-wmux-ref tags are STALE from a prior DOM
  // snapshot and could silently resolve the wrong element (panel review, #353).
  // An empty/absent refMap is the DOM-fallthrough / dropped-page case, where the
  // data-attr tags ARE the current source of truth (this preserves the
  // backend-flap fix — DOM-minted refs stay usable through the Playwright path).
  const refs = pageRefMaps.get(page);
  if (refs && refs.length > 0) return null;
  return resolveRefViaDataAttr(page, ref);
}

/** Resolve a ref through the a11y refMap stored by generateSnapshot(). */
async function resolveRefViaAxMap(
  page: Page,
  ref: string,
): Promise<ElementHandle | null> {
  const targetIndex = parseInt(ref, 10);
  if (Number.isNaN(targetIndex) || targetIndex < 0) return null;

  const refs = pageRefMaps.get(page);
  if (!refs || targetIndex >= refs.length) return null;

  const target = refs[targetIndex];

  // Use Playwright's getByRole to locate the element. A scoped snapshot numbered
  // its refs inside one element, so search inside that same element — otherwise
  // the nth-match count below is taken over the whole page and can land on an
  // identical role+name that the caller deliberately scoped out.
  const scopeSelector = pageRefScopes.get(page);
  try {
    const root = scopeSelector ? page.locator(scopeSelector).first() : page;
    const locator = root.getByRole(target.role as any, {
      name: target.name || undefined,
      exact: true,
    });

    const count = await locator.count();
    if (count === 0) return null;

    // Find which instance corresponds to our ref by counting all
    // refs with the same role+name before our target index
    let sameRoleNameBefore = 0;
    for (let i = 0; i < targetIndex; i++) {
      if (
        refs[i].role === target.role &&
        refs[i].name === target.name
      ) {
        sameRoleNameBefore++;
      }
    }

    const nth = Math.min(sameRoleNameBefore, count - 1);
    return await locator.nth(nth).elementHandle();
  } catch {
    return null;
  }
}

// data-wmux-ref values are always non-negative integer strings, so anything
// else is not a real ref — reject it (matches exactly the tags we mint and
// blocks selector/JS injection).
const REF_ATTR_PATTERN = /^\d+$/;

/** Resolve a ref through the data-wmux-ref attribute left by a DOM snapshot. */
async function resolveRefViaDataAttr(
  page: Page,
  ref: string,
): Promise<ElementHandle | null> {
  if (!REF_ATTR_PATTERN.test(ref)) return null;
  try {
    const locator = page.locator(`[data-wmux-ref="${ref}"]`);
    if ((await locator.count()) === 0) return null;
    return await locator.first().elementHandle();
  } catch {
    return null;
  }
}
