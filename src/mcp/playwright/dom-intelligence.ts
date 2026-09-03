import type { Locator, Page } from 'playwright-core';
import type { JsonEvaluator } from './page-eval';
import { getConnectionScope } from '../connectionScope';
import {
  PASSWORD_FIELD_PREDICATE_JS,
  REDACTED_PASSWORD,
  getPasswordFieldBackendIds,
} from './redact';
import { ancestorContext } from '../../shared/browserReplay/actionTrace';
import { getOwnAttributeLabels } from './ownAttributes';

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
   * Position among the same role+name population the snapshot saw, so
   * `getByRole(role, { name, exact: true }).nth(i)` picks the instance the ref
   * was numbered against. Zeroed on the RPC lane, whose locator is a CSS
   * selector that already names one element.
   */
  sameNameIndex: number;
  /** How many elements the snapshot listed with this role+name. */
  sameNameTotal: number;
  /**
   * The same pair over the whole ROLE population, ignoring names.
   *
   * An unnamed element cannot be located with a name filter, and
   * `getByRole(role)` with no filter counts the named siblings too — so the
   * name-keyed index is not an index into the population that locator returns.
   * Resolution uses this pair instead for an unnamed element (review ①).
   */
  roleIndex: number;
  roleTotal: number;
  /**
   * `role "name"` of the nearest named structural ancestor at snapshot time —
   * the same string the accessibility-lane snapshot mints (see
   * ancestorContext). `''` when nothing above it is named. The replay runner
   * uses it to stop a same-count swap of same-name elements (#1182); it is
   * never used to LOCATE the element. Absent on the RPC lane, which records no
   * ref axis to carry it.
   */
  context: string;
  /**
   * The element's own `attr=value` identifier — the same string, from the same
   * `DOM.getDocument` pass and the same ownAttributeLabel rule, that the
   * accessibility-lane snapshot stamps on its RefEntry. `''` when the element
   * carries none of the four attributes, and on the RPC lane.
   *
   * It is what tells two genuinely identical siblings apart, which `context`
   * cannot — they share a container. Verify-only: never used to LOCATE.
   */
  own: string;
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
  /**
   * Surface the snapshot was requested for. Stored with the cache so a later
   * click on ANOTHER surface is refused rather than resolved against the wrong
   * page — one connection can drive several (review 7).
   */
  surfaceId?: string;
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
// Element cache — the last smart snapshot, and what it was taken against
// ---------------------------------------------------------------------------

/**
 * The last smart snapshot this connection took, with everything a later
 * `browser_click({ smartRef })` needs to prove the ref still means what the
 * agent thinks it means.
 *
 * The page and surface are recorded because neither the ref number nor the
 * cache is scoped to one (review 7): ref numbers restart at 1 per Page, the
 * cache is per CONNECTION, and one connection can drive several surfaces and
 * tabs. Without them, snapshotting tab A and then clicking on tab B resolves
 * A's ref against B's DOM and reports success.
 *
 * A plain reference, not a WeakRef: the record is replaced wholesale by the
 * next smart snapshot and lives on the connection scope, so at most one closed
 * Page is held, and only until that connection snapshots again or goes away.
 * (WeakRef is also absent from the MCP build's ES2020 lib.)
 */
interface SmartSnapshotRecord {
  elements: IndexedElement[];
  /** The page the snapshot was taken on. Absent on the RPC lane. */
  page: Page | null;
  /** Surface the snapshot was taken on, when the caller named one. */
  surfaceId: string | undefined;
  /** identity.generation at capture time — which snapshot minted these refs. */
  generation: number;
  /** identity.documentEpoch at capture time. */
  documentEpoch: number;
}

const EMPTY_RECORD: SmartSnapshotRecord = {
  elements: [],
  page: null,
  surfaceId: undefined,
  generation: 0,
  documentEpoch: 0,
};

// Fallback store for single-child mode (no connection scope active). Under the
// broker each connection keeps its OWN cache on its AsyncLocalStorage scope so
// concurrent agents' smart refs never collide — see getElementCache/setElementCache.
let moduleElementCache: SmartSnapshotRecord = EMPTY_RECORD;

function getSnapshotRecord(): SmartSnapshotRecord {
  const scope = getConnectionScope();
  if (scope) return (scope.elementCache as SmartSnapshotRecord | undefined) ?? EMPTY_RECORD;
  return moduleElementCache;
}

function getElementCache(): IndexedElement[] {
  return getSnapshotRecord().elements;
}

function setSnapshotRecord(record: SmartSnapshotRecord): void {
  const scope = getConnectionScope();
  if (scope) scope.elementCache = record;
  else moduleElementCache = record;
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
 *
 * One level, not the frameKey-keyed two-level map RefIdentity uses, because
 * this walk never leaves the main frame. `Accessibility.getFullAXTree` on a
 * page target stops AT the `<iframe>` element — `childIds: []`, the child
 * document's nodes simply absent, same-origin or not (measured on Chrome 141;
 * see IFRAME_ROLES in snapshot.ts). browser_snapshot reaches frame contents
 * only by grafting them with an explicit per-frame `getFullAXTree({ frameId })`,
 * which is why it needs the second level; this walk makes no such call, so
 * every backendDOMNodeId it ever sees was issued by one document. That is also
 * what keeps the sameNameIndex population and the `page.getByRole` population
 * the same set — both are main-frame-only.
 */
interface SmartRefIdentity {
  /** backendDOMNodeId → the smart ref that node was given. */
  byBackendId: Map<number, number>;
  /** Next unused ref number (1-based). */
  next: number;
  /** URL the number space belongs to; a different document restarts it. */
  url: string | undefined;
  /** Bumped once per snapshot. Names the snapshot a ref came from. */
  generation: number;
  /**
   * Bumped on every main-frame navigation, reload included.
   *
   * The URL alone cannot see a reload, a back/forward to the same URL, or a
   * re-submitted form: `smartDocumentKey` reads the same string on both sides
   * while the document underneath is new and its low backendDOMNodeIds would
   * be handed the refs of the old one (review ④). The epoch is what makes that
   * boundary visible — it also lands in the diff baseline's attrs key, so the
   * baseline for the old document can never be diffed against the new one.
   */
  documentEpoch: number;
}

/**
 * How many remembered nodes the identity map may hold before it is trimmed (an
 * SPA that churns nodes forever would otherwise grow it without bound). `next`
 * is NOT rewound by any trim — recycling a number is exactly the confusion this
 * exists to prevent. See capSmartRefIdentity for the order a trim takes.
 */
const SMART_REF_IDENTITY_CAP = 5000;

const pageSmartRefIdentity = new WeakMap<Page, SmartRefIdentity>();

/** What the last smart snapshot on this page was taken against. */
interface SmartSnapshotStamp {
  generation: number;
  documentEpoch: number;
  url: string | undefined;
}

const pageSmartStamps = new WeakMap<Page, SmartSnapshotStamp>();

/** Pages already carrying the `framenavigated` listener below. */
const navigationHooked = new WeakSet<Page>();

/** Stable per-Page number, so a baseline key can name the page it describes. */
const pageIds = new WeakMap<Page, number>();
let nextPageId = 1;

function pageId(page: Page): number {
  const existing = pageIds.get(page);
  if (existing !== undefined) return existing;
  const id = nextPageId++;
  pageIds.set(page, id);
  return id;
}

/**
 * Identity of the exact document this page is showing, for the diff baseline's
 * attrs key.
 *
 * Two things the surface key alone cannot separate (review ④ and ⑦): a second
 * tab or surface on the same URL, whose listing is a different page entirely,
 * and a reload of the same URL, whose refs are a different number space. Both
 * come back as a different token, and an attrs mismatch drops the baseline —
 * so neither can be answered with "(no changes since previous snapshot)".
 */
export function smartPageToken(page: Page): string {
  const identity = pageSmartRefIdentity.get(page);
  return `p${pageId(page)}e${identity?.documentEpoch ?? 0}`;
}

/**
 * Retire the number space when the page navigates, reload included.
 *
 * Playwright reports every main-frame commit here, which is the signal
 * `smartDocumentKey` cannot supply on its own. Attached once per page and
 * never removed: the listener outlives no more than the Page itself, and
 * `page.on` is absent on the RPC lane and on test doubles, so its absence is
 * tolerated rather than required.
 */
function hookNavigation(page: Page, identity: SmartRefIdentity): void {
  if (navigationHooked.has(page)) return;
  const on = (page as { on?: (event: string, fn: (frame: unknown) => void) => void }).on;
  if (typeof on !== 'function') return;
  navigationHooked.add(page);
  try {
    on.call(page, 'framenavigated', (frame: unknown) => {
      const main = (page as { mainFrame?: () => unknown }).mainFrame?.();
      if (main !== undefined && frame !== main) return;
      identity.byBackendId.clear();
      identity.documentEpoch++;
    });
  } catch {
    /* a page that cannot take a listener keeps the URL check alone */
  }
}

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
    identity = { byBackendId: new Map(), next: 1, url, generation: 0, documentEpoch: 0 };
    pageSmartRefIdentity.set(page, identity);
  } else if (identity.url !== undefined && url !== undefined && identity.url !== url) {
    identity.byBackendId.clear();
  }
  identity.url = url;
  identity.generation++;
  hookNavigation(page, identity);
  return identity;
}

/**
 * Keep the identity map under SMART_REF_IDENTITY_CAP, in the order that costs
 * the least (review 9).
 *
 * Nothing is forgotten while the map fits, and remembering a node the current
 * walk did not see is the whole point of the map on this side of the cap: a
 * menu that closes and reopens, a tab panel that swaps out and back, a row
 * scrolled out of a virtualised list — each comes back to the ref it had, which
 * keeps it out of the diff and keeps a ref the agent is holding valid. An
 * earlier draft pruned to the walk on every snapshot and turned every one of
 * those round trips into a renumber.
 *
 * Over the cap, the entries this walk did not see have the least claim to the
 * space, so they go first; only if the live page ALONE still exceeds the cap is
 * the map dropped whole. That last case renumbers every live element at once —
 * loud, and correct: every outstanding ref goes stale rather than quietly
 * meaning something new, and `next` is never rewound, so no number is reused.
 *
 * A document boundary is a different question and keeps its own answer: every
 * backendDOMNodeId means nothing in a new document, so a changed URL and the
 * `framenavigated` hook clear the map outright.
 */
function capSmartRefIdentity(identity: SmartRefIdentity, seen: Set<number>): void {
  if (identity.byBackendId.size <= SMART_REF_IDENTITY_CAP) return;
  for (const backendId of [...identity.byBackendId.keys()]) {
    if (!seen.has(backendId)) identity.byBackendId.delete(backendId);
  }
  if (identity.byBackendId.size > SMART_REF_IDENTITY_CAP) identity.byBackendId.clear();
}

/** The smart ref for this node, minting one the first time we see it. */
function assignSmartRef(identity: SmartRefIdentity, backendDOMNodeId: number): number {
  const existing = identity.byBackendId.get(backendDOMNodeId);
  if (existing !== undefined) return existing;
  const ref = identity.next++;
  identity.byBackendId.set(backendDOMNodeId, ref);
  return ref;
}

/**
 * Record, per element, the populations resolution counts it against.
 *
 * resolveSmartRefLocator locates through `getByRole(...).nth(i)`, which is only
 * sound against the population the snapshot saw — a stable ref number says
 * nothing about where the element now sits in that population. Both pairs are
 * stored because the locator differs by whether the element has a name: see
 * IndexedElement.roleIndex.
 */
function finalizeSmartPopulations(elements: IndexedElement[]): void {
  // NUL-separated (review 8): neither a role nor a name can contain one, so no
  // role+name pair can be spelled two ways. A plain space let `button` + `a b`
  // and `button a` + `b` collide into a single population.
  const nameKey = (element: IndexedElement) => `${element.role}\u0000${element.name}`;
  const nameCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();
  for (const element of elements) {
    const byName = nameCounts.get(nameKey(element)) ?? 0;
    element.sameNameIndex = byName;
    nameCounts.set(nameKey(element), byName + 1);
    const byRole = roleCounts.get(element.role) ?? 0;
    element.roleIndex = byRole;
    roleCounts.set(element.role, byRole + 1);
  }
  for (const element of elements) {
    element.sameNameTotal = nameCounts.get(nameKey(element)) ?? 1;
    element.roleTotal = roleCounts.get(element.role) ?? 1;
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
 *
 * `seen` collects every backendDOMNodeId this walk numbered, so an over-cap
 * identity map can be trimmed back to the live page afterwards.
 */
function collectInteractiveElements(
  nodeMap: Map<string, CdpAXNode>,
  node: CdpAXNode,
  elements: IndexedElement[],
  passwordBackendIds: Set<number>,
  identity: SmartRefIdentity,
  seen: Set<number>,
  ownLabels: Map<number, string>,
  inheritedContext = '',
): void {
  const role = node.role?.value ?? 'none';
  const name = node.name?.value ?? '';

  // An ignored node contributes nothing itself, but we must still descend into
  // its children: Chrome hangs a chain of ignored "uninteresting" wrappers
  // (html → body → generic) directly under the RootWebArea, so returning early
  // here skipped the entire document. Same splice rule as buildTree() in
  // snapshot.ts — see the comment there for the measurement.
  //
  // A node with no backendDOMNodeId is passed over entirely (review 11). There
  // is nothing to key its ref on, so it drew a fresh number out of the space on
  // every single snapshot: the ref an agent read was never the ref the next
  // snapshot would print, and its line changed in every diff, which is exactly
  // the churn identity refs exist to stop. Listing an element the agent cannot
  // hold on to is worse than not listing it.
  if (!node.ignored && INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId !== undefined) {
    const backendId = node.backendDOMNodeId;
    seen.add(backendId);
    const element: IndexedElement = {
      ref: assignSmartRef(identity, backendId),
      role,
      name,
      locator: buildLocatorString(role, name),
      // Where the element sits, not what it is: the same value the a11y lane
      // stamps, so a flow recorded here replays against a snapshot taken there.
      context: inheritedContext,
      // What it IS, for the case where where-it-sits cannot decide. Same
      // source and same rule as the a11y lane, for the same cross-lane reason.
      own: ownLabels.get(backendId) ?? '',
      // Filled in by finalizeSmartPopulations once the whole walk is known.
      sameNameIndex: 0,
      sameNameTotal: 0,
      roleIndex: 0,
      roleTotal: 0,
    };

    if (node.value?.value) {
      // A password field reports its name, role and ref as usual; only the
      // contents are withheld. Chrome pre-masks `type=password` here, but not a
      // `type=text` field marked autocomplete="new-password" — see redact.ts.
      element.value = passwordBackendIds.has(backendId) ? REDACTED_PASSWORD : node.value.value;
    }
    if (node.description?.value) {
      element.description = node.description.value;
    }

    elements.push(element);
  }

  // Recurse into children. An ignored wrapper contributes no context of its
  // own — ancestorContext returns the inherited value for it — so a named
  // container survives an ignored generic between it and the control.
  const childContext = ancestorContext(role, name, inheritedContext);
  if (node.childIds) {
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (child) {
        collectInteractiveElements(
          nodeMap, child, elements, passwordBackendIds, identity, seen, ownLabels, childContext,
        );
      }
    }
  }
}

/**
 * Fetch the full accessibility tree via CDP and return indexed interactive
 * elements.
 */
async function getInteractiveElements(page: Page): Promise<IndexedElement[]> {
  const identity = beginSmartRefGeneration(page);
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

    // The element's own identifying attribute, over the same bridge and from
    // the same shared helper snapshot.ts uses — a value read differently here
    // would stop every replay that crosses lanes (see IndexedElement.own).
    const ownLabels = await getOwnAttributeLabels(
      client as unknown as { send: (method: string, params?: unknown) => Promise<unknown> },
    );

    // Build a map for quick lookup by nodeId
    const nodeMap = new Map<string, CdpAXNode>();
    for (const n of nodes) nodeMap.set(n.nodeId, n);

    const elements: IndexedElement[] = [];
    const seen = new Set<number>();
    collectInteractiveElements(
      nodeMap, nodes[0], elements, passwordBackendIds, identity, seen, ownLabels,
    );
    capSmartRefIdentity(identity, seen);
    finalizeSmartPopulations(elements);
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

  // Stamp what these refs were minted against, so a later click can tell a
  // live ref from one the page has moved out from under.
  const identity = pageSmartRefIdentity.get(page);
  pageSmartStamps.set(page, {
    generation: identity?.generation ?? 0,
    documentEpoch: identity?.documentEpoch ?? 0,
    url: smartDocumentKey(page),
  });
  setSnapshotRecord({
    elements,
    page,
    surfaceId: options?.surfaceId,
    generation: identity?.generation ?? 0,
    documentEpoch: identity?.documentEpoch ?? 0,
  });

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
    // No named-ancestor pass on the RPC lane, and none is needed: this lane
    // records no ref axis (smartRefAxisEntry returns null for its locator).
    context: '',
    // Same reason: nothing on this lane carries a ref axis to verify.
    own: '',
    // The populations are unused on this lane: its locator is a CSS selector
    // naming one tagged element, so nothing counts a role or a name.
    sameNameIndex: 0,
    sameNameTotal: 1,
    roleIndex: 0,
    roleTotal: 1,
  }));

  // Cache so browser_click({smartRef}) resolves via the data attribute even if
  // getPage() flips null->page between this snapshot and the click. No page is
  // recorded: this lane has none, and the attribute selector is page-agnostic.
  setSnapshotRecord({
    elements,
    page: null,
    surfaceId: options?.surfaceId,
    generation: 0,
    documentEpoch: 0,
  });

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
 * Thrown instead of resolving a smart ref that can be shown not to name what
 * the caller thinks it names — the page navigated, the element is gone, the
 * click is aimed at another page, or the population the ref indexes into has
 * changed size.
 *
 * The sibling of snapshot.ts's StaleRefError, declared here rather than
 * imported because snapshot.ts already imports this module. browser_click
 * turns the message into its tool result, so the agent is told to re-snapshot
 * instead of being handed a silently substituted element.
 */
export class StaleSmartRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleSmartRefError';
  }
}

const RESNAPSHOT = 'Run browser_smart_snapshot to get current refs.';

/**
 * Resolve a smart ref to a live Playwright locator.
 *
 * The two lanes store two different kinds of locator and only one of them is a
 * selector: the RPC lane's `[data-wmux-ref="N"]` is CSS and goes straight to
 * `page.locator()`, while the CDP lane's `getByRole('button', { name: 'OK' })`
 * is a source snippet that `page.locator()` cannot parse at all. Rebuild the
 * latter through the real `getByRole` API, pinned with `.nth()` to the instance
 * the ref was numbered against.
 *
 * Every check here mirrors resolveRefViaAxMap in snapshot.ts, and for the same
 * reason: a stable ref number says the element has not been renumbered, not
 * that it is still there. Before this, a ref replayed after the page moved
 * resolved to whatever now sat at that index and reported a successful click
 * (review 2) — the older positional locator at least failed to parse.
 */
export async function resolveSmartRefLocator(page: Page, ref: number): Promise<Locator> {
  const record = getSnapshotRecord();
  const element = record.elements.find((e) => e.ref === ref);

  // Wrong page, whatever the ref says. Checked before anything else: on the
  // CDP lane the refs belong to ONE page, and every check below would
  // otherwise be run against a DOM the snapshot never saw (review 7).
  if (record.page !== null && record.page !== page) {
    throw new StaleSmartRefError(
      `smartRef=${ref} was taken on a different page than the one this click targets` +
        `${record.surfaceId ? ` (snapshot surface "${record.surfaceId}")` : ''}. ${RESNAPSHOT}`,
    );
  }

  const identity = pageSmartRefIdentity.get(page);
  const stamp = pageSmartStamps.get(page);
  if (stamp) {
    const liveUrl = smartDocumentKey(page);
    if (stamp.url !== undefined && liveUrl !== undefined && stamp.url !== liveUrl) {
      throw new StaleSmartRefError(
        `smartRef=${ref} is stale — the page navigated since snapshot #${stamp.generation} ` +
          `(${stamp.url} → ${liveUrl}). ${RESNAPSHOT}`,
      );
    }
    // Same URL, different document: a reload, a back/forward, or a re-submitted
    // form. The URL comparison above cannot see any of them (review 4).
    if (identity && identity.documentEpoch !== stamp.documentEpoch) {
      throw new StaleSmartRefError(
        `smartRef=${ref} is stale — the page reloaded since snapshot #${stamp.generation}, ` +
          `so its refs name elements that no longer exist. ${RESNAPSHOT}`,
      );
    }
  }

  if (!element) {
    // The number was handed out on this document but the latest snapshot does
    // not list it: the element it named is gone. The number is never reissued,
    // so retrying cannot help — only re-snapshotting can.
    if (identity && ref >= 1 && ref < identity.next) {
      throw new StaleSmartRefError(
        `smartRef=${ref} is stale — the element it named is no longer in the page snapshot ` +
          `(current snapshot #${identity.generation}). ${RESNAPSHOT}`,
      );
    }
    throw new StaleSmartRefError(`Element with smartRef=${ref} not found. ${RESNAPSHOT}`);
  }

  if (element.locator.startsWith('[data-wmux-ref=')) return page.locator(element.locator);

  const role = element.role as Parameters<Page['getByRole']>[0];
  // `exact: true` (review 1): getByRole's name filter is substring- and
  // case-insensitive by default, so a ref for "Save" matched "Save draft" and
  // the index it was paired with then indexed into a population the snapshot
  // never counted.
  //
  // An unnamed element cannot use the name filter at all, and `getByRole(role)`
  // sweeps the named siblings too — so it is counted against the whole-role
  // population instead, which is the population that locator actually returns.
  const named = element.name.length > 0;
  const locator = named
    ? page.getByRole(role, { name: element.name, exact: true })
    : page.getByRole(role);
  const index = named ? element.sameNameIndex : element.roleIndex;
  const total = named ? element.sameNameTotal : element.roleTotal;

  let count: number;
  try {
    count = await locator.count();
  } catch {
    throw new StaleSmartRefError(
      `smartRef=${ref} (${element.role} "${element.name}") could not be located. ${RESNAPSHOT}`,
    );
  }
  if (count === 0) {
    throw new StaleSmartRefError(
      `smartRef=${ref} is stale — no ${element.role} element` +
        `${named ? ` named "${element.name}"` : ''} is on the page any more. ${RESNAPSHOT}`,
    );
  }

  // The nth-match below is only sound while the page still holds the elements
  // the snapshot numbered. Narrow on purpose, exactly as resolveRefViaAxMap is:
  // a population of one indexes to 0 either way, so comparing counts there buys
  // no safety and only costs false rejections.
  if (total > 1 && count !== total) {
    throw new StaleSmartRefError(
      `smartRef=${ref} is stale — the page now has ${count} ${element.role} element(s)` +
        `${named ? ` named "${element.name}"` : ''}, not the ${total} the last snapshot ` +
        `listed, so the ref no longer identifies one element. ${RESNAPSHOT}`,
    );
  }

  return locator.nth(Math.min(index, count - 1));
}

/**
 * The identity of a smart ref, in the shape the replay recorder stores.
 *
 * browser_click recorded its smartRef steps as a CSS axis built from
 * IndexedElement.locator, which on the CDP lane is the SOURCE TEXT of a
 * getByRole call — `page.locator()` cannot parse it, so every such step failed
 * on replay while the live click succeeded, quietly filling traces with steps
 * that could never run (review 6). The ref axis carries the same 4-tuple
 * browser_snapshot records, which the replay runner already knows how to
 * re-resolve.
 *
 * Returns null for the RPC lane, whose CSS selector is a real selector and is
 * recorded as one.
 */
export function smartRefAxisEntry(ref: number): {
  role: string;
  name: string;
  sameNameIndex: number;
  sameNameTotal: number;
  frameKey: string;
  context?: string;
  own?: string;
} | null {
  const element = getSmartElementByRef(ref);
  if (!element || element.locator.startsWith('[data-wmux-ref=')) return null;
  const named = element.name.length > 0;
  return {
    role: element.role,
    name: element.name,
    sameNameIndex: named ? element.sameNameIndex : element.roleIndex,
    sameNameTotal: named ? element.sameNameTotal : element.roleTotal,
    // Always the main frame: this walk never leaves it (see SmartRefIdentity).
    frameKey: '',
    // The nearest named ancestor, so a smartRef-recorded step gets the same
    // #1182 verifier a snapshot-recorded one does. Omitted when empty, exactly
    // as refEntryToAxis would drop it.
    ...(element.context.length > 0 && { context: element.context }),
    // The second verifier, for the identical siblings the context cannot
    // separate. Same string the a11y lane would have stamped on this element.
    ...(element.own.length > 0 && { own: element.own }),
  };
}

/**
 * Clear the cached element list. Useful when navigating to a new page
 * to avoid stale refs.
 */
export function clearElementCache(): void {
  setSnapshotRecord(EMPTY_RECORD);
}
