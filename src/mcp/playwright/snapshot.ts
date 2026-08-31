import type { Page, Frame, Locator, ElementHandle } from 'playwright-core';
import { buildDomSnapshotExpression } from './dom-intelligence';
import {
  REDACTED_PASSWORD,
  getPasswordFieldBackendIds,
  redactPasswordParams,
} from './redact';
import { collectOcclusion, occlusionNote, type OcclusionInfo } from './occlusion';
import { collectPageFacts, formatPageFactsFooter } from './pageFacts';
import { peekRecentPendingRequests } from './pageCapture';

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

// ---------------------------------------------------------------------------
// Frame coordinates
// ---------------------------------------------------------------------------

/**
 * One `<iframe>` hop from a host document into a child document.
 *
 * A ref minted inside a frame is only meaningful together with the route that
 * reaches that frame, and the route has to be re-walkable later without
 * trusting anything the page can rewrite. So a hop stores a POSITION, not an
 * identity: the `<iframe>` element's index in document order among the host
 * document's frames, plus how many the host had. Matching by `src` was the
 * obvious alternative and is the wrong one — two frames can share a src, and a
 * page can change one at will, so a src match resolves a ref into whichever
 * frame answers to that string now (decision D2: tag the coordinate, then
 * fail closed when it no longer matches).
 *
 * `childUrlKey` is the child document's URL at capture time. It is what makes
 * a frame that navigated on its own detectable at resolution time: the hop
 * still lands on frame #1 of 2, but frame #1 is a different document now.
 */
export interface FrameHop {
  /** Document-order index of the `<iframe>` among the host document's frames. */
  hostIndex: number;
  /** How many frames the host document held when the ref was minted. */
  hostTotal: number;
  /** documentKey() of the `<iframe>` element's src, for the error message only. */
  hostSrcKey: string;
  /** documentKey() of the child document's own URL when the ref was minted. */
  childUrlKey: string;
}

/**
 * Where a node lives, as a route from the main frame.
 *
 * An empty path is the main frame, and every main-frame code path stays
 * byte-for-byte what it was before frames existed — that equivalence is the
 * whole reason the coordinate is a path rather than a rewrite of the ref.
 */
export interface FrameCoord {
  path: FrameHop[];
  /** Deterministic string form of `path`, used as a map key. `''` = main frame. */
  key: string;
}

/** The main frame's coordinate: the route of length zero. */
const MAIN_FRAME: FrameCoord = { path: [], key: '' };

/**
 * The map key for a route.
 *
 * Includes each hop's child URL so a frame that navigates gets a NEW key: its
 * old backendDOMNodeIds mean nothing in the new document, and a fresh key
 * retires them without touching any other frame's numbering.
 */
function frameKeyOf(path: FrameHop[]): string {
  return path.map((hop) => `${hop.hostIndex}\u0000${hop.childUrlKey}`).join('\u0001');
}

/** Extend a route by one hop. */
function descend(coord: FrameCoord, hop: FrameHop): FrameCoord {
  const path = [...coord.path, hop];
  return { path, key: frameKeyOf(path) };
}

/** Why an `<iframe>`'s contents are not in the snapshot. */
export type FrameBoundaryReason =
  | 'not-attached'
  | 'depth-cap'
  | 'count-cap'
  | 'empty';

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
  /**
   * Set on the FIRST node of a grafted child document (see graftChildFrames).
   * Every descendant inherits it during serialisation, which is what stamps a
   * frame coordinate onto the refs minted inside the frame. Absent on main
   * frame nodes, where the coordinate is the empty path.
   */
  frameCoord?: FrameCoord;
  /**
   * Set on an `<iframe>` node whose child document was actually stitched in.
   * Distinguishes "empty frame" from "contents not in this snapshot", and keeps
   * the node alive through the interactive filter even when the frame holds no
   * interactive elements of its own.
   */
  graftedFrame?: boolean;
  /** Why this iframe's contents are absent, when they are. See frameBoundaryNote. */
  frameBoundaryReason?: FrameBoundaryReason;
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

/**
 * Roles Chrome gives an `<iframe>` element.
 *
 * Measured on Chrome 141: `Accessibility.getFullAXTree` on a page target stops
 * at the iframe element — the node comes back with `childIds: []` and the
 * child document's nodes are simply absent, same-origin or not. The child
 * frame's own tree is a separate `getFullAXTree({ frameId })` call (and, for a
 * cross-origin frame, a separate CDP target entirely).
 *
 * That makes an iframe an invisible dead end in the output today: the agent
 * sees a leaf and cannot tell "this frame is empty" from "this frame's
 * contents are not in the snapshot". Naming the boundary is the fix — see
 * FRAME_BOUNDARY_NOTE for why the contents are not stitched in instead.
 */
const IFRAME_ROLES = new Set(['Iframe', 'IframePresentational']);

/**
 * The frame elements a hop counts, in the one form both sides can agree on.
 *
 * The capture side asks CDP `DOM.querySelectorAll` for this selector and the
 * resolver asks a Playwright locator for it, and a hop's index is only sound
 * while those two enumerate the SAME elements in the SAME order — both are
 * document order over the same selector, so they do. `frame` is in the set
 * because a legacy frameset page has frames and no iframes.
 */
const FRAME_ELEMENT_SELECTOR = 'iframe,frame';

/**
 * How deep the graft follows nested frames.
 *
 * Mirrors browser-use's own frame walk (dom/service.py), which caps depth and
 * frame count rather than trusting a page not to nest. An ad frame inside a
 * consent frame inside a widget is three, so five leaves headroom while still
 * bounding the number of CDP round-trips a hostile page can force.
 */
const MAX_FRAME_DEPTH = 5;

/** Total frames grafted per snapshot, across the whole tree. */
const MAX_FRAMES = 100;


/**
 * What an iframe node says instead of its contents.
 *
 * Stitching the child frame's tree in was the obvious alternative and is the
 * wrong one while refs resolve through `page.getByRole()`, which searches the
 * main frame only: every ref minted inside a frame would serialise fine and
 * then fail to resolve. A dead ref is worse than a named boundary. Making
 * frame contents reachable needs frame-aware ref resolution first.
 */
const FRAME_BOUNDARY_NOTE = '(separate document — contents not in this snapshot)';

/**
 * What an `<iframe>` says once the graft has actually looked inside it.
 *
 * "Read and empty" and "not read" are different facts and used to render
 * identically, which is the same conflation FRAME_BOUNDARY_NOTE was introduced
 * to end one level up: an agent that cannot tell them apart re-snapshots
 * forever waiting for contents that are never coming.
 */
const FRAME_EMPTY_NOTE = '(separate document — read, no content in it)';

/** Appended where a frame's own share of the output budget ran out. */
const FRAME_TRUNCATED_NOTE = '(frame content truncated)';

/** The sentence fragment naming why a frame was not read. */
const FRAME_BOUNDARY_REASONS: Record<FrameBoundaryReason, string> = {
  'not-attached': '(separate document — could not be attached, contents not in this snapshot)',
  'depth-cap': `(separate document — nested deeper than ${MAX_FRAME_DEPTH} frames, contents not in this snapshot)`,
  'count-cap': `(separate document — past the ${MAX_FRAMES}-frame budget for one snapshot, contents not in this snapshot)`,
  empty: FRAME_EMPTY_NOTE,
};

/**
 * The note an `<iframe>` node carries instead of its contents, if any.
 *
 * A frame with content in the tree says nothing extra — the content IS the
 * answer. Everything else names the specific reason rather than the generic
 * boundary, except the plain unread case, which keeps its original wording.
 */
function frameBoundaryNote(node: AXNode): string {
  if (!IFRAME_ROLES.has(node.role)) return '';
  if (node.children?.length) return '';
  if (node.frameBoundaryReason) return ` ${FRAME_BOUNDARY_REASONS[node.frameBoundaryReason]}`;
  if (node.graftedFrame) return ` ${FRAME_EMPTY_NOTE}`;
  return ` ${FRAME_BOUNDARY_NOTE}`;
}

/**
 * The two text roles Chrome stacks under every piece of visible text, and the
 * reason the 'ai' format drops one of them and sometimes both.
 *
 * Chrome renders `<h1>Dogfood page</h1>` as THREE lines — the heading, a
 * `StaticText` repeating its name, and an `InlineTextBox` repeating it again —
 * so a button costs three lines to say one word. Measured on a real dogfood
 * page that made "Dogfood page" appear three times on one screen, and across
 * live pages the two text roles are the single largest slice of the output
 * (Wikipedia: 963 InlineTextBox + 776 StaticText lines out of 3327).
 *
 * An `InlineTextBox` is the layout engine's per-line fragment of its parent
 * `StaticText`, never new text. Measured on Chrome 141 over 3054 InlineTextBox
 * nodes on three live pages (Wikipedia, Hacker News, a modal fixture): every
 * one of them had a `StaticText` parent whose name contains its text — zero
 * exceptions — apart from three under a `LineBreak`, whose text is "\n". So
 * dropping them loses wrapping positions and nothing else.
 *
 * That is a measurement, though, not a guarantee, so the drop is CONDITIONED on
 * the parent role it was measured under (TEXT_FRAGMENT_PARENTS). A different
 * Chrome major, an SVG text run, or a Blink change that hangs an InlineTextBox
 * under a nameless container would then have it as the only carrier of that
 * text — and this module would drop it silently, which is the exact failure the
 * condensation exists to avoid. Outside the measured shape the node is kept:
 * the output gets bigger, never emptier.
 *
 * A `StaticText` is dropped only in the one case where it is provably an echo:
 * it is its parent's ONLY child and serialises to exactly the parent's own
 * name with no attributes and no children of its own (see serializeNode).
 * A `link "A B"` over `StaticText "A"` + `StaticText "B"` keeps both — the
 * pieces are not the accumulated name, and which piece sits where is signal.
 *
 * 'aria' keeps everything: its contract IS the full tree, and it is the format
 * to reach for when the layout-level text really is what you are after.
 */
const INLINE_TEXT_ROLE = 'InlineTextBox';
const STATIC_TEXT_ROLE = 'StaticText';

/**
 * The parent roles an InlineTextBox was measured to be a redundant fragment OF.
 * `LineBreak` is in the set because its fragment is the "\n" it already means.
 */
const TEXT_FRAGMENT_PARENTS = new Set([STATIC_TEXT_ROLE, 'LineBreak']);

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
  /**
   * The number printed as `ref="N"`. Stable across snapshots of the same
   * document: a node keeps the number it was first given, so inserting or
   * removing a node no longer renumbers everything after it.
   */
  ref: number;
  /**
   * Position of this entry among the snapshot's entries sharing role+name
   * WITHIN THE SAME FRAME. Frame-local on purpose: the resolver counts matches
   * with a locator rooted at the entry's own frame, so a page-wide population
   * would not be the population that index is an index into (review ⑫ — get
   * this wrong and every existing click on a page with iframes regresses).
   */
  sameNameIndex: number;
  /** How many entries the snapshot listed with this role+name in that frame. */
  sameNameTotal: number;
  /** Route from the main frame to the document this ref was minted in. */
  framePath: FrameHop[];
  /** frameKeyOf(framePath). `''` = main frame. */
  frameKey: string;
}

/**
 * The ref-number space for one document.
 *
 * Refs used to be a running count over the walk, so a single inserted node
 * shifted every ref after it by one and an agent replaying a ref from the
 * previous snapshot clicked its neighbour without any error (dogfood, GitHub
 * PR page, 2026-08-30). Numbering off `backendDOMNodeId` — the id CDP keeps
 * stable for a DOM node's lifetime — makes an unchanged node keep its ref, so
 * a ref means the same element until the element itself goes away. It also
 * lets browser_snapshot's auto-diff work at all: with everything renumbered,
 * near enough every line read as changed and the diff was never adopted.
 *
 * Numbers are only ever handed out, never recycled, so a ref that named a
 * removed element can never come back pointing at a different one.
 */
interface RefIdentity {
  /**
   * frameKey → (backendDOMNodeId → the ref number that node was given).
   *
   * Two levels rather than one because backendDOMNodeId is only unique within
   * a CDP target: an out-of-process iframe numbers its own DOM from its own
   * id space, so a flat map would have a frame's node collide with a main-frame
   * node and silently hand both the same ref.
   */
  byBackendId: Map<string, Map<number, number>>;
  /** Next unused ref number. */
  next: number;
  /** URL the number space belongs to; a different document restarts it. */
  url: string | undefined;
  /** Bumped once per snapshot. Names the snapshot a ref came from. */
  generation: number;
}

/**
 * Above this many remembered nodes the identity map is dropped (an SPA that
 * churns nodes forever would otherwise grow it without bound). `next` is NOT
 * rewound with it — recycling a number is exactly the confusion this exists to
 * prevent — so the cost of hitting the cap is that live nodes are renumbered
 * once: every outstanding ref goes stale (loudly) and the next diff is a full
 * snapshot.
 */
const REF_IDENTITY_CAP = 5000;

const pageRefIdentity = new WeakMap<Page, RefIdentity>();

/** What the last snapshot on this page was taken against, per frame. */
interface SnapshotStamp {
  generation: number;
  url: string | undefined;
}

/**
 * frameKey → the document that frame held when the last snapshot ran.
 *
 * Only the main frame is stamped. A frame's own document is already recorded
 * in every ref's FrameHop, and the resolver re-reads `frame.url()` live on each
 * hop rather than trusting either copy — a second stored copy would be a value
 * nothing reads, which is worse than absent because it looks like a check.
 * The map shape is kept for the per-frame stamps this would need if the live
 * read ever became too expensive to do on every hop.
 */
const pageSnapshotStamps = new WeakMap<Page, Map<string, SnapshotStamp>>();

/**
 * Thrown instead of returning null when a ref can be shown to be stale — the
 * page navigated, the element is gone, or the page no longer holds the
 * elements the ref was numbered against. Every ref tool wraps its resolution in
 * a try/catch that turns the message into the tool result, so the agent is told
 * to re-snapshot rather than handed a silently substituted element.
 */
export class StaleRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleRefError';
  }
}

/** page.url(), tolerating a page (or a test double) that cannot answer. */
function pageUrl(page: Page): string | undefined {
  try {
    const url = (page as { url?: () => string }).url?.();
    return typeof url === 'string' && url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The part of the URL that decides whether this is still the same document.
 *
 * The fragment is dropped: a docs page rewrites `location.hash` as you scroll
 * and an in-page anchor click does the same, and counting either as a
 * navigation would retire every ref mid-flow and renumber the next snapshot
 * from scratch — undoing the diff this change exists to make possible.
 *
 * Still a URL comparison, so a same-document pushState to a new path reads as
 * a navigation (refs are retired, which is safe) and a POST that lands back on
 * the same URL does not (the refMap checks below are what catch that).
 */
function documentKey(url: string | undefined): string | undefined {
  if (url === undefined || url.length === 0) return undefined;
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

/**
 * documentKey() of a page's current URL.
 *
 * Split from documentKey so the same rule can be applied to a FRAME's url
 * (which arrives as a plain string from `frame.url()`), rather than having two
 * near-identical normalisations drift apart — the frame check is only worth
 * anything while it agrees with the page check about what "same document"
 * means.
 */
function pageDocumentKey(page: Page): string | undefined {
  return documentKey(pageUrl(page));
}

/**
 * Open a new snapshot generation, resetting the number space when the page has
 * moved to a different document (its backendDOMNodeIds mean nothing there).
 */
function beginRefGeneration(page: Page): RefIdentity {
  const url = pageDocumentKey(page);
  let identity = pageRefIdentity.get(page);
  if (!identity) {
    identity = { byBackendId: new Map(), next: 0, url, generation: 0 };
    pageRefIdentity.set(page, identity);
  } else if (identity.url !== undefined && url !== undefined && identity.url !== url) {
    // A new document invalidates every backendDOMNodeId, but the numbers stay
    // spent. Rewinding `next` here would hand an agent still holding a ref from
    // the old document whatever now sits at that number — and the navigation
    // guard cannot catch it once the URL comes back round (A → B → A).
    identity.byBackendId.clear();
  }
  if (countRememberedNodes(identity) > REF_IDENTITY_CAP) identity.byBackendId.clear();
  identity.url = url;
  identity.generation++;
  return identity;
}

/** Remembered nodes across every frame — what REF_IDENTITY_CAP is a cap on. */
function countRememberedNodes(identity: RefIdentity): number {
  let total = 0;
  for (const perFrame of identity.byBackendId.values()) total += perFrame.size;
  return total;
}

/**
 * The ref number for this node, minting one the first time we see it.
 *
 * `frameKey` selects the id space: a backendDOMNodeId means something only
 * inside the document that issued it.
 */
function assignRef(
  identity: RefIdentity,
  frameKey: string,
  backendDOMNodeId?: number,
): number {
  if (backendDOMNodeId === undefined) return identity.next++;
  let perFrame = identity.byBackendId.get(frameKey);
  if (!perFrame) {
    perFrame = new Map();
    identity.byBackendId.set(frameKey, perFrame);
  }
  const existing = perFrame.get(backendDOMNodeId);
  if (existing !== undefined) return existing;
  const ref = identity.next++;
  perFrame.set(backendDOMNodeId, ref);
  return ref;
}

/**
 * Record, per entry, the same-role+name population it was numbered against.
 *
 * resolveRef locates an element with `getByRole(...).nth(i)`, which is only
 * sound while that population is what the snapshot saw. Storing it lets the
 * resolver notice that the page has changed underneath the ref instead of
 * clamping onto whichever element happens to sit at that index now.
 */
function finalizeRefs(refs: RefEntry[]): void {
  // Keyed by frame as well as role+name (review ⑫). Two frames showing the
  // same widget each hold their own `Submit` button; counting them together
  // would give the second frame's button index 1, and the resolver — which
  // counts inside ONE frame — would then look for a second `Submit` that frame
  // does not have. Every ref on every page with a duplicated iframe would go
  // stale or resolve wrongly.
  const populationKey = (entry: RefEntry) =>
    `${entry.frameKey}\u0002${entry.role}\u0000${entry.name}`;
  const totals = new Map<string, number>();
  for (const entry of refs) {
    const key = populationKey(entry);
    const seen = totals.get(key) ?? 0;
    entry.sameNameIndex = seen;
    totals.set(key, seen + 1);
  }
  for (const entry of refs) {
    entry.sameNameTotal = totals.get(populationKey(entry)) ?? 1;
  }
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
  finalizeRefs(refs);
  pageRefMaps.set(page, refs);
  const generation = pageRefIdentity.get(page)?.generation ?? 0;
  const stamps = new Map<string, SnapshotStamp>();
  stamps.set(MAIN_FRAME.key, { generation, url: pageDocumentKey(page) });
  pageSnapshotStamps.set(page, stamps);
  if (scopeSelector === undefined) pageRefScopes.delete(page);
  else pageRefScopes.set(page, scopeSelector);
}

/**
 * The registry key for one browser surface.
 *
 * A surface, not a workspace: two surfaces in one workspace have separate
 * pages and separate ref numbering, so folding them together would recreate
 * the cross-surface false refusal this key exists to prevent.
 */
export function browserScopeKey(scope: {
  workspaceId: string;
  surfaceId?: string;
}): string {
  return `${scope.workspaceId}\u0000${scope.surfaceId ?? ''}`;
}

/**
 * Browser scope → the frame-ref numbers that scope's last snapshot minted.
 *
 * The RPC transport is reached precisely because there is no Page to look
 * anything up on, so its guard needs an answer keyed by something it still
 * has: the scope it was called for. Keying by scope rather than "any page
 * anywhere" is what keeps one surface's frame refs from refusing an unrelated
 * surface's perfectly good DOM ref.
 *
 * Holds numbers and strings only — never a Page. An earlier version kept the
 * Page as the key of a strong Map, which pinned every page that had ever
 * snapshotted a frame for the life of the process.
 *
 * Entries are replaced on every snapshot of that scope and deleted the moment
 * one mints no frame refs, so the map holds at most one entry per live browser
 * surface; the cap is a backstop for a session that churns surfaces.
 */
const FRAME_REF_SCOPE_CAP = 64;
const frameRefsByScope = new Map<string, Set<number>>();

/**
 * Record what the snapshot just taken for `scopeKey` minted, so the RPC lane
 * can refuse a frame ref for THIS surface without touching any other.
 *
 * Called by the snapshot tool for both routes: the a11y route registers what it
 * minted, and the DOM route registers nothing, which clears the scope — its
 * data-wmux-ref tags ARE the current truth and must stay resolvable.
 */
export function noteFrameRefsForScope(scopeKey: string, page: Page | null): void {
  const numbers = new Set<number>();
  for (const entry of (page && pageRefMaps.get(page)) || []) {
    if (entry.frameKey !== MAIN_FRAME.key) numbers.add(entry.ref);
  }
  frameRefsByScope.delete(scopeKey);
  if (numbers.size === 0) return;
  frameRefsByScope.set(scopeKey, numbers);
  while (frameRefsByScope.size > FRAME_REF_SCOPE_CAP) {
    const oldest = frameRefsByScope.keys().next().value;
    if (oldest === undefined) break;
    frameRefsByScope.delete(oldest);
  }
}

/**
 * Was this ref minted inside an iframe?
 *
 * Exported for the fail-closed guard in the tool layer: a frame ref must never
 * reach a `[data-wmux-ref]` lookup. Those attributes are written into the MAIN
 * document only, so the selector cannot find the element the ref names — but it
 * CAN find an unrelated main-document element that a previous DOM snapshot
 * tagged with the same number, and then click it. That is the loudest failure
 * this feature can produce, so it is refused rather than attempted.
 */
export function isFrameRef(page: Page, ref: string): boolean {
  const wanted = refNumber(ref);
  if (wanted === null) return false;
  const refs = pageRefMaps.get(page);
  if (!refs) return false;
  return refs.some((entry) => entry.ref === wanted && entry.frameKey !== MAIN_FRAME.key);
}

/**
 * A ref string as the number it names, or null when it does not name one.
 *
 * Strict, not parseInt: `parseInt('12abc')` is 12 and `parseInt('0x10')` is 16,
 * so a guard built on it answers questions about a ref the caller never asked
 * about. A ref is a run of digits and nothing else — the same shape
 * REF_ATTR_PATTERN already enforces on the data-attr side.
 */
function refNumber(ref: string): number | null {
  return /^\d+$/.test(ref) ? Number(ref) : null;
}

/**
 * Same question with no Page to ask it of — the RPC transport's only option.
 *
 * Scoped to the surface the call is for. An unrelated surface's frame refs say
 * nothing about this one's numbering, and refusing on them would block a
 * perfectly good DOM ref on an RPC-only surface for as long as some other page
 * happened to hold that number.
 *
 * A surface with no entry is not refused: either it never took an a11y
 * snapshot, or its last one had no frames, and in both cases its
 * data-wmux-ref tags are the current truth.
 */
export function isOutstandingFrameRef(scopeKey: string, ref: string): boolean {
  const wanted = refNumber(ref);
  if (wanted === null) return false;
  return frameRefsByScope.get(scopeKey)?.has(wanted) === true;
}

/** The message both guards raise, so the agent reads one explanation. */
export function frameRefFallbackMessage(ref: string): string {
  return (
    `ref=${ref} was minted inside an iframe and cannot be resolved through the ` +
    `data-wmux-ref fallback, which only tags the main document. ` +
    `Run browser_snapshot to get current refs.`
  );
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

/**
 * Everything serialisation needs beyond the node itself.
 *
 * `refs` is written through (the ref numbering is a running count over the
 * whole walk) and `occlusion` is read — bundling them keeps the recursive
 * signature from growing an argument per annotation.
 */
interface SerializeCtx {
  format: 'ai' | 'aria';
  maxDepth: number;
  refs: RefEntry[];
  /** The document's ref-number space, so an unchanged node keeps its number. */
  identity: RefIdentity;
  /** Null when nothing is covering the page, which is the normal case. */
  occlusion: OcclusionInfo | null;
  /**
   * Characters left for frame content — ONE pool for the whole snapshot,
   * drawn down by every grafted frame in it.
   *
   * A page's own controls are what the caller asked about; a frame's are a
   * bonus. Without a cap a chatty ad frame fills the output and pushes the
   * page's own buttons past the truncation point, which leaves the snapshot
   * worse than it was when frames were unreachable.
   *
   * Shared rather than per frame, because a per-frame allowance is not a cap
   * at all: ten sibling ad frames at 40% each is 400% of the budget, and the
   * host document is squeezed out by exactly the case the cap exists for.
   * One pool also gives nesting the right shape for free — a child frame can
   * only spend what its parent has not, since both draw on the same counter.
   *
   * The consequence is deliberate: frames are served in document order and an
   * early greedy frame can leave a later one with nothing. A later frame that
   * gets nothing says so (FRAME_TRUNCATED_NOTE), which is the same contract a
   * truncated one already has.
   */
  frameBudgetRemaining: number;
}

/** The share of one snapshot's budget ALL grafted frames together may spend. */
const FRAME_BUDGET_SHARE = 0.4;

/**
 * The frame a node is being serialised in.
 *
 * Threaded through the recursion rather than stored on every node: only the
 * root of a grafted document carries `frameCoord`, and everything under it
 * inherits — which is what keeps the main-frame walk allocation-for-allocation
 * identical to what it was before frames existed.
 */
function frameOf(node: AXNode, inherited: FrameCoord): FrameCoord {
  return node.frameCoord ?? inherited;
}

function serializeNode(
  node: AXNode,
  ctx: SerializeCtx,
  currentDepth: number,
  indent: number,
  inheritedFrame: FrameCoord = MAIN_FRAME,
): string {
  if (currentDepth > ctx.maxDepth) return '';

  const frame = frameOf(node, inheritedFrame);
  const pad = '  '.repeat(indent);
  const role = node.role;
  const name = node.name || '';

  // Build attribute string
  const attrs: string[] = [];

  if (ctx.format === 'ai' && isInteractive(role)) {
    const ref = assignRef(ctx.identity, frame.key, node.backendDOMNodeId);
    ctx.refs.push({
      role,
      name,
      backendDOMNodeId: node.backendDOMNodeId,
      ref,
      // Filled in by finalizeRefs once the whole walk is known.
      sameNameIndex: 0,
      sameNameTotal: 0,
      framePath: frame.path,
      frameKey: frame.key,
    });
    attrs.push(`ref="${ref}"`);
  }

  if (node.checked !== undefined) attrs.push(`checked="${node.checked}"`);
  if (node.disabled) attrs.push('disabled');
  if (node.expanded !== undefined) attrs.push(`expanded="${node.expanded}"`);
  if (node.selected) attrs.push('selected');
  if (node.level !== undefined) attrs.push(`level="${node.level}"`);
  if (node.valuetext) attrs.push(`valuetext="${node.valuetext}"`);
  if (node.value) attrs.push(`value="${node.value}"`);
  // Exactly one node per document carries `focused` (measured: Chrome attaches
  // the property to the focused element only, and to nothing at all when focus
  // is on the body), so this is a single word on a single line.
  if (node.focused) attrs.push('focused');
  // The layer the note names, marked so `div#backdrop` in the note and a node
  // in the tree are visibly the same thing — the note used to know a selector
  // the tree never mentioned. Absent without comment when the layer has no
  // a11y node of its own (Chrome ignores a bare backdrop `<div>`, or it falls
  // outside the serialised depth) — same fail-open as the probe itself.
  if (
    ctx.occlusion?.layerBackendId !== undefined &&
    node.backendDOMNodeId === ctx.occlusion.layerBackendId
  ) {
    attrs.push('overlay');
  }
  // Only meaningful while an overlay is up. Deliberately NOT gated on
  // isInteractive(): the reachable set only ever holds elements the probe's own
  // selector matched (links, buttons, form fields, `[role]`, `[onclick]`,
  // `[tabindex]`, `summary`), and that selector is WIDER than INTERACTIVE_ROLES
  // — gating here would leave a genuinely clickable node unmarked while the
  // note above asserts that unmarked means unreachable.
  if (
    ctx.occlusion &&
    node.backendDOMNodeId !== undefined &&
    ctx.occlusion.reachable.has(node.backendDOMNodeId)
  ) {
    attrs.push('clickable');
  }

  const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  const nameStr = name ? ` "${name}"` : '';
  // Only when the node really is a dead end. Chrome 141 always stops at the
  // iframe element, but a version or engine that inlines the child document
  // would turn this note into a lie.
  const frameStr = frameBoundaryNote(node);

  let line = `${pad}- ${role}${nameStr}${attrStr}${frameStr}`;

  // Recurse into children. In 'ai' format an InlineTextBox under one of the
  // parents it was measured to be a fragment of never gets that far — see
  // INLINE_TEXT_ROLE — so neither it nor its subtree is walked.
  const isFragmentParent = TEXT_FRAGMENT_PARENTS.has(role);
  const childLines: string[] = [];
  // Only a grafted frame's contents are metered; everything else is not, which
  // keeps the main-document walk exactly as it was.
  const metered = node.graftedFrame === true;
  let frameTruncated = false;
  if (node.children) {
    for (const child of node.children) {
      if (ctx.format === 'ai' && isFragmentParent && child.role === INLINE_TEXT_ROLE) continue;
      // Where the refs for this child start, so a child that does not make it
      // into the output does not leave a ref behind either. A ref for a line
      // the agent cannot see is a ref it cannot have meant to use.
      const refMark = ctx.refs.length;
      const remainingBefore = ctx.frameBudgetRemaining;
      const childStr = serializeNode(child, ctx, currentDepth + 1, indent + 1, frame);
      if (!childStr) continue;
      if (metered) {
        // A nested grafted frame inside this child has already charged its own
        // bytes to the same pool, so charging the child's full length again
        // would bill that content twice and cut this frame short by the size of
        // its own children's frames.
        const chargedByNested = remainingBefore - ctx.frameBudgetRemaining;
        const own = childStr.length - chargedByNested;
        if (own > ctx.frameBudgetRemaining) {
          ctx.refs.length = refMark;
          ctx.frameBudgetRemaining = remainingBefore;
          frameTruncated = true;
          break;
        }
        ctx.frameBudgetRemaining -= own;
      }
      childLines.push(childStr);
    }
  }
  if (frameTruncated) childLines.push(`${pad}  - ${FRAME_TRUNCATED_NOTE}`);

  // The echo: an only child that serialised to nothing but the parent's own
  // name. Tested against the produced LINE rather than against the node, so a
  // StaticText that carries an attribute (focused, clickable) or any child of
  // its own can never be silently dropped — either would make the string
  // differ. No ref is lost with it: a line this shape minted none.
  //
  // The literal below therefore has to reassemble a child line exactly as the
  // recursion above builds one — `indent + 1`, i.e. this node's pad plus two
  // spaces. Changing how a line is assembled without changing this literal does
  // not corrupt anything, it just stops matching and quietly returns the output
  // to its pre-condensation size; the whole-output assertion in
  // snapshot.density.test.ts is what catches that.
  if (
    ctx.format === 'ai' &&
    childLines.length === 1 &&
    childLines[0] === `${pad}  - ${STATIC_TEXT_ROLE}${nameStr}`
  ) {
    childLines.length = 0;
  }

  if (childLines.length > 0) {
    line += '\n' + childLines.join('\n');
  }

  return line;
}

/** Serialise a list of sibling nodes at the top level of the output. */
function serializeForest(nodes: AXNode[], ctx: SerializeCtx): string {
  const lines: string[] = [];

  for (const node of nodes) {
    const s = serializeNode(node, ctx, 0, 0, MAIN_FRAME);
    if (s) lines.push(s);
  }

  return lines.join('\n');
}

function serializeTree(root: AXNode, ctx: SerializeCtx): string {
  // The RootWebArea is a container, not content — emit its children.
  return serializeForest(root.children ?? [root], ctx);
}

function stripNonInteractive(node: AXNode): AXNode | null {
  if (isInteractive(node.role)) return node;
  // An iframe ALWAYS survives the interactive filter. It is not interactive, so
  // it would otherwise vanish — and its disappearance is exactly the wrong
  // signal in both directions. For a frame that was never read, the controls
  // inside it are not in the snapshot either, so a filtered tree with no iframe
  // line reads as "this page has no such button" when the truth is "look inside
  // the frame". For a frame that WAS read and holds nothing interactive, the
  // line is the evidence of that: dropping it turns a checked-and-empty frame
  // back into an unexplained absence, and the graft would look like it never
  // ran.
  if (IFRAME_ROLES.has(node.role)) {
    const inside = (node.children ?? [])
      .map(stripNonInteractive)
      .filter((c): c is AXNode => c !== null);
    if (inside.length > 0) return { ...node, children: inside };
    // Childless here means "nothing interactive in it", which frameBoundaryNote
    // renders as read-and-empty when the frame was actually grafted.
    return { ...node, children: undefined };
  }

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
async function fetchAccessibilityTree(
  client: CdpClient,
  /**
   * Present only on the whole-page path. A scoped snapshot deliberately does
   * NOT graft: its refs are numbered inside one selector-matched element, and
   * a selector scope cannot be combined with a frame route (see resolveRef).
   */
  graftInto?: { page: Page; extraSessions: CdpClient[] },
): Promise<BuiltTree | null> {
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

  if (built && graftInto) {
    // Fail-open around the whole walk: a frame that cannot be read costs its
    // own boundary note, and a walk that throws costs the frames it had not
    // reached yet — never the page's own tree.
    try {
      const doc = (await client.send('DOM.getDocument', { depth: 0 })) as {
        root?: { nodeId?: number };
      };
      const documentNodeId = doc?.root?.nodeId;
      if (documentNodeId) {
        await graftChildFrames(
          {
            client,
            root: graftInto.page,
            documentNodeId,
            built,
            coord: MAIN_FRAME,
            depth: 0,
            passwordBackendIds,
          },
          {
            remaining: MAX_FRAMES,
            visited: new Set<string>(),
            extraSessions: graftInto.extraSessions,
            page: graftInto.page,
          },
        );
      }
    } catch {
      /* the page's own tree is worth more than the frames under it */
    }
  }

  return built;
}

// ---------------------------------------------------------------------------
// Child-frame grafting
// ---------------------------------------------------------------------------

/** CDP `DOM.describeNode` fields the graft reads. */
interface CdpDomNode {
  backendNodeId?: number;
  frameId?: string;
  contentDocument?: { nodeId?: number };
  attributes?: string[];
}

/** Read one attribute out of CDP's flat [name, value, name, value] array. */
function attributeOf(node: CdpDomNode | undefined, wanted: string): string | undefined {
  const attrs = node?.attributes;
  if (!attrs) return undefined;
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i] === wanted) return attrs[i + 1];
  }
  return undefined;
}

/** Everything one host document contributes to the walk. */
interface GraftHost {
  /** CDP session the host document lives on. */
  client: CdpClient;
  /** Playwright handle on the same document — the index cross-check. */
  root: Page | Frame;
  /** CDP nodeId of the host document, for DOM.querySelectorAll. */
  documentNodeId: number;
  /** The host's built tree, so an `<iframe>` element can find its AX node. */
  built: BuiltTree;
  /** Route from the main frame to this host. */
  coord: FrameCoord;
  depth: number;
  /**
   * Password fields to mask, in this session's backendNodeId space.
   *
   * Shared with the host document on purpose: `DOM.performSearch` was measured
   * to reach same-process iframes already (redact.ts), and backendNodeIds are
   * unique per target — so the host's one search covers every same-process
   * frame under it. An out-of-process frame gets its own search on its own
   * session, because its ids live in a different space.
   */
  passwordBackendIds: Set<number>;
}

/** Mutable budget shared by every host in one snapshot's walk. */
interface GraftBudget {
  remaining: number;
  /** frameIds already grafted — a page that re-parents a frame cannot loop us. */
  visited: Set<string>;
  /** Extra CDP sessions opened for out-of-process frames, closed by the caller. */
  extraSessions: CdpClient[];
  /** The page the walk started on — the only handle that can mint a session. */
  page: Page;
}

/**
 * A cross-origin frame's tree, over a session bound to its own target.
 *
 * Fail-open like everything else in the walk: an unattachable target (a frame
 * still navigating, a target the connection cannot see) leaves the caller's
 * boundary note in place, which is exactly what the snapshot said before.
 */
async function openOutOfProcessDocument(
  childFrame: Frame,
  budget: GraftBudget,
): Promise<ChildDocument | null> {
  let session: CdpClient | null = null;
  try {
    session = (await budget.page
      .context()
      .newCDPSession(childFrame)) as unknown as CdpClient;
    budget.extraSessions.push(session);

    await session.send('Accessibility.enable').catch(() => { /* best-effort */ });
    const passwordBackendIds = await getPasswordFieldBackendIds(session);
    const doc = (await session.send('DOM.getDocument', { depth: 0 })) as {
      root?: { nodeId?: number };
    };
    const documentNodeId = doc?.root?.nodeId;
    if (!documentNodeId) return null;

    const nodes = (await session.send('Accessibility.getFullAXTree')) as {
      nodes?: CdpAXNode[];
    };
    const built = buildTree(nodes?.nodes ?? [], passwordBackendIds);
    if (!built) return null;
    return { built, client: session, documentNodeId, passwordBackendIds };
  } catch {
    return null;
  }
}

/**
 * Stitch child documents into the host tree, in place.
 *
 * In place matters: the overflow path in generateSnapshot re-serialises the
 * ORIGINAL tree after stripping non-interactive nodes, so a graft that built a
 * new tree would be silently discarded on exactly the large pages that most
 * need it.
 *
 * Every failure is fail-open — the `<iframe>` node keeps a boundary note
 * saying why its contents are absent, which is strictly what the snapshot said
 * before frames were reachable at all. A frame is never half-grafted: either
 * its nodes are in, and refs minted in it carry a route that resolves, or they
 * are not.
 */
async function graftChildFrames(host: GraftHost, budget: GraftBudget): Promise<void> {
  let describedFrames: { nodeId: number; described: CdpDomNode | undefined }[];
  let hostTotal: number;
  try {
    const found = (await host.client.send('DOM.querySelectorAll', {
      nodeId: host.documentNodeId,
      selector: FRAME_ELEMENT_SELECTOR,
    })) as { nodeIds?: number[] };
    const nodeIds = found?.nodeIds ?? [];
    if (nodeIds.length === 0) return;
    hostTotal = nodeIds.length;

    describedFrames = [];
    for (const nodeId of nodeIds) {
      const described = (await host.client.send('DOM.describeNode', {
        nodeId,
        // depth 1 + pierce is what exposes contentDocument, and contentDocument
        // is also the same-process/out-of-process discriminator: an OOPIF's
        // document belongs to another target and is simply not here.
        depth: 1,
        pierce: true,
      })) as { node?: CdpDomNode };
      describedFrames.push({ nodeId, described: described?.node });
    }
  } catch {
    return;
  }

  // The resolver counts frames with a Playwright locator over the same
  // selector, so a ref's positional index is only sound while the two
  // enumerations agree. They are both document order over one selector, so
  // they do — but if they ever disagree, minting refs against an index the
  // resolver will read differently is exactly the silent wrong-element bug
  // this design exists to avoid. Graft nothing instead.
  let liveCount: number;
  try {
    liveCount = await host.root.locator(FRAME_ELEMENT_SELECTOR).count();
  } catch {
    return;
  }
  if (liveCount !== hostTotal) return;

  for (let hostIndex = 0; hostIndex < describedFrames.length; hostIndex++) {
    const { described } = describedFrames[hostIndex];
    const backendNodeId = described?.backendNodeId;
    if (backendNodeId === undefined) continue;

    const hostAx = host.built.byBackendId.get(backendNodeId)?.[0];
    // No a11y node for this `<iframe>` means Chrome did not render it —
    // display:none, zero-box, or an ad blocker's leftover. browser-use walks
    // only visible frames for the same reason; here the visibility test is
    // free, because absence from the a11y tree IS the answer, and grafting
    // into nothing would mint refs no serialisation ever emits.
    if (!hostAx) continue;

    const frameId = described?.frameId;
    if (!frameId || budget.visited.has(frameId)) {
      hostAx.frameBoundaryReason = 'not-attached';
      continue;
    }
    if (host.depth + 1 > MAX_FRAME_DEPTH) {
      hostAx.frameBoundaryReason = 'depth-cap';
      continue;
    }
    if (budget.remaining <= 0) {
      hostAx.frameBoundaryReason = 'count-cap';
      continue;
    }

    // The Playwright side of the same hop. Taken through an element handle
    // rather than Locator.contentFrame() because the child's url() is what the
    // hop records, and a FrameLocator cannot say what it points at.
    let childFrame: Frame | null = null;
    try {
      const handle = await host.root
        .locator(FRAME_ELEMENT_SELECTOR)
        .nth(hostIndex)
        .elementHandle();
      childFrame = handle ? await handle.contentFrame() : null;
    } catch {
      childFrame = null;
    }
    if (!childFrame) {
      hostAx.frameBoundaryReason = 'not-attached';
      continue;
    }

    const hop: FrameHop = {
      hostIndex,
      hostTotal,
      hostSrcKey: documentKey(attributeOf(described, 'src')) ?? '',
      childUrlKey: documentKey(childFrame.url()) ?? '',
    };
    const childCoord = descend(host.coord, hop);

    const child = await openChildDocument(host, frameId, described, childFrame, budget);
    if (!child) {
      hostAx.frameBoundaryReason = 'not-attached';
      continue;
    }

    budget.visited.add(frameId);
    budget.remaining--;

    // Grafted either way: the agent now knows the frame WAS read, so an empty
    // one reads as "nothing in here" instead of "contents withheld".
    hostAx.graftedFrame = true;
    const injected = child.built.root.children ?? [];
    if (injected.length === 0) {
      hostAx.frameBoundaryReason = 'empty';
      continue;
    }
    hostAx.frameBoundaryReason = undefined;

    // Only the top level is stamped; serializeNode inherits the coordinate
    // down the subtree, which keeps the main-frame walk untouched.
    for (const node of injected) node.frameCoord = childCoord;
    // Appended after the iframe node's own children (Chrome gives it none, but
    // a future engine might) so the order is deterministic — the overflow
    // re-serialisation has to reproduce it exactly.
    hostAx.children = [...(hostAx.children ?? []), ...injected];

    await graftChildFrames(
      {
        client: child.client,
        root: childFrame,
        documentNodeId: child.documentNodeId,
        built: child.built,
        coord: childCoord,
        depth: host.depth + 1,
        passwordBackendIds: child.passwordBackendIds,
      },
      budget,
    );
  }
}

/** A child document opened for grafting: its tree, its session, its DOM root. */
interface ChildDocument {
  built: BuiltTree;
  client: CdpClient;
  documentNodeId: number;
  /** In `client`'s backendNodeId space — the host's set, or the frame's own. */
  passwordBackendIds: Set<number>;
}

/**
 * Read one child frame's accessibility tree.
 *
 * Same-process frames answer on the host's own session: `getFullAXTree` takes a
 * frameId, and `DOM.describeNode(pierce)` already handed us the child document
 * node.
 *
 * A cross-origin frame is a separate CDP target and has no contentDocument
 * here, so it gets a session of its own — the frame-owning-session idea mirrors
 * stagehand understudy/cdp.ts (MIT, Browserbase Inc.), which attaches per frame
 * target rather than trying to reach one through the page's session. The
 * attach itself goes through Playwright's own `newCDPSession(frame)` instead of
 * `Target.setAutoAttach`/`attachToTarget`, because Playwright already owns the
 * target bookkeeping on this connection and a second auto-attach probe would
 * register a session it never closes.
 *
 * Its backendNodeIds live in a different id space, so it also gets its own
 * password search — reusing the host's set would mask by coincidence.
 */
async function openChildDocument(
  host: GraftHost,
  frameId: string,
  described: CdpDomNode | undefined,
  childFrame: Frame,
  budget: GraftBudget,
): Promise<ChildDocument | null> {
  const documentNodeId = described?.contentDocument?.nodeId;
  if (documentNodeId === undefined) {
    return await openOutOfProcessDocument(childFrame, budget);
  }
  try {
    const nodes = (await host.client.send('Accessibility.getFullAXTree', { frameId })) as {
      nodes?: CdpAXNode[];
    };
    const built = buildTree(nodes?.nodes ?? [], host.passwordBackendIds);
    if (!built) return null;
    return {
      built,
      client: host.client,
      documentNodeId,
      passwordBackendIds: host.passwordBackendIds,
    };
  } catch {
    return null;
  }
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

/** The a11y tree plus the annotations that only a live CDP session can supply. */
interface SnapshotSource {
  tree: AXNode | null;
  occlusion: OcclusionInfo | null;
}

async function getAccessibilityTree(page: Page): Promise<SnapshotSource> {
  // Sessions opened for out-of-process frames during the graft. Detached here
  // rather than inside the walk so one frame's cleanup cannot abort the rest.
  const extraSessions: CdpClient[] = [];
  try {
    return await withCdpSession<SnapshotSource>(
      page,
      async (client) => ({
        tree: (await fetchAccessibilityTree(client, { page, extraSessions }))?.root ?? null,
      // After the tree, never instead of it: a thrown occlusion probe must not
      // cost the caller its snapshot (collectOcclusion swallows its own
      // failures, and this ordering keeps the tree even if that ever changes).
        occlusion: await collectOcclusion(client).catch(() => null),
      }),
      { tree: null, occlusion: null },
    );
  } finally {
    for (const extra of extraSessions) {
      await extra.detach().catch(() => { /* best-effort */ });
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an accessibility-tree snapshot of the page.
 *
 * In 'ai' format every interactive element receives a `ref="N"` attribute that
 * can later be resolved back to an ElementHandle via `resolveRef()`. The number
 * belongs to the DOM node, not to its position in the walk: a node that is
 * still there keeps the ref it had, and a new node takes the next unused
 * number. See RefIdentity.
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
  // Opened before anything can fail so every exit — including the DOM
  // fallthroughs below — stamps the same generation onto the page.
  const identity = beginRefGeneration(page);

  const { tree, occlusion } = await getAccessibilityTree(page);

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

  const refs: RefEntry[] = [];
  const ctx: SerializeCtx = {
    format,
    maxDepth: depth,
    refs,
    identity,
    occlusion,
    frameBudgetRemaining: Math.floor(maxLength * FRAME_BUDGET_SHARE),
  };
  let output = serializeTree(effectiveTree, ctx);

  // The overlay note is prepended AFTER truncation — it is the one line that
  // explains why the refs below may not respond, so losing it to a length cap
  // would be exactly backwards — but it is charged against maxLength all the
  // same, or the note's page-controlled layer label would let the page decide
  // how far past the caller's budget the result runs.
  const note = occlusion ? `${occlusionNote(occlusion)}\n` : '';

  // Page facts (readiness hint + scrollable containers) are collected AFTER
  // serialization and charged against the SAME budget, so adding the footer
  // cannot push a snapshot past the caller's maxLength. Deliberately not
  // applied in generateScopedSnapshot: a scoped snapshot is a small subtree by
  // definition, so "nearly empty" would fire on every correct result.
  const facts = await collectPageFacts(page);
  const footer = facts
    ? formatPageFactsFooter(facts, peekRecentPendingRequests(page))
    : '';
  const budget = Math.max(0, maxLength - note.length - footer.length);

  // If the output exceeds the budget AND we are in 'ai' mode, strip
  // non-interactive nodes and regenerate.
  if (output.length > budget && format === 'ai') {
    const trimmed = stripNonInteractive(tree);
    if (trimmed) {
      refs.length = 0;
      // The pool is per rendering, not per call: the first pass spent it, and
      // a retry that starts empty would truncate every frame at once.
      ctx.frameBudgetRemaining = Math.floor(maxLength * FRAME_BUDGET_SHARE);
      output = serializeTree(trimmed, ctx);
    }
  }

  // Hard-truncate as a last resort
  if (output.length > budget) {
    output = output.slice(0, budget) + '\n... (truncated)';
  }

  output = note + output + footer;

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
  // The number space is per document, not per scope: a node keeps the ref it
  // was given whether it was reached through a selector or the whole page.
  const identity = beginRefGeneration(page);

  const found = await withCdpSession<{ forest: AXNode[] | null; occlusion: OcclusionInfo | null }>(
    page,
    async (client) => {
      // Resolve the selector FIRST: a miss costs nothing and must reach the DOM
      // listing, which owns the user-facing "No element matches selector:" error.
      const backendId = await resolveSelectorBackendId(client, selector);
      if (backendId === null) return { forest: null, occlusion: null };

      const built = await fetchAccessibilityTree(client);
      if (!built || isRootOnly(built.root)) return { forest: null, occlusion: null };

      return {
        forest: built.byBackendId.get(backendId) ?? null,
        // Occlusion is a whole-page fact, so it is worth just as much inside a
        // scope — a selector aimed at the page behind an overlay is exactly the
        // case where the agent is about to click something inert.
        occlusion: await collectOcclusion(client).catch(() => null),
      };
    },
    { forest: null, occlusion: null },
  );

  const { forest, occlusion } = found;
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

  const refs: RefEntry[] = [];
  const ctx: SerializeCtx = {
    format,
    maxDepth: depth,
    refs,
    identity,
    occlusion,
    frameBudgetRemaining: Math.floor(maxLength * FRAME_BUDGET_SHARE),
  };
  // Unlike the page-level tree, the matched element is content, not a container
  // — `dialog "Settings"` is exactly the context the selector asked about — so
  // serialize the forest as-is instead of dropping its top level.
  let output = serializeForest(scoped, ctx);

  // Same length accounting as the page-level path: the note goes on top after
  // truncation, and is charged against the caller's budget.
  const note = occlusion ? `${occlusionNote(occlusion)}\n` : '';
  const budget = Math.max(0, maxLength - note.length);

  if (output.length > budget && format === 'ai') {
    const trimmed = forest
      .map(stripNonInteractive)
      .filter((n): n is AXNode => n !== null);
    if (trimmed.length > 0) {
      refs.length = 0;
      ctx.frameBudgetRemaining = Math.floor(maxLength * FRAME_BUDGET_SHARE);
      output = serializeForest(trimmed, ctx);
    }
  }

  if (output.length > budget) {
    output = output.slice(0, budget) + '\n... (truncated)';
  }

  output = note + output;

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
 *
 * Throws StaleRefError — rather than returning a substitute element — when the
 * page navigated since that snapshot, when the ref named an element the latest
 * snapshot no longer lists, or when the role+name population it was numbered
 * against has changed. Returning null still means "no such ref here", which is
 * what sends the DOM-snapshot case to the data-wmux-ref locator below.
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
  // Belt and braces for the frame case: a populated refMap already blocks the
  // fallback above, but a frame ref reaching the data-attr locator is the one
  // outcome that resolves to a confidently wrong element, so it is named and
  // refused rather than left to depend on that branch staying as it is.
  if (isFrameRef(page, ref)) throw new StaleRefError(frameRefFallbackMessage(ref));
  return resolveRefViaDataAttr(page, ref);
}

/**
 * Walk a ref's frame route and hand back the document it was minted in.
 *
 * Three checks per hop, all of them fail-closed — a frame ref that cannot be
 * proven to still name the same document is an error, never a best guess:
 *
 *  1. the host document still holds exactly as many frames as it did, so the
 *     positional index still counts the same population;
 *  2. the frame at that position still has a document we can reach (a frame
 *     that was removed, or is not yet attached, resolves to null);
 *  3. that document is still the one the ref was minted against — the live
 *     `frame.url()` re-read that catches a frame which navigated on its own
 *     (review ⑬), which no page-level URL check can see.
 *
 * Returns `page` unchanged for the empty route, so every main-frame ref takes
 * exactly the path it took before frames existed.
 */
async function resolveFrameRoot(
  page: Page,
  path: FrameHop[],
  ref: string,
): Promise<Page | Frame> {
  if (path.length === 0) return page;

  let root: Page | Frame = page;
  for (let depth = 0; depth < path.length; depth++) {
    const hop = path[depth];
    const where = `frame ${depth + 1} of ${path.length} on the route (${hop.hostSrcKey || 'about:blank'})`;

    const frames: Locator = root.locator(FRAME_ELEMENT_SELECTOR);
    const count = await frames.count();
    if (count !== hop.hostTotal) {
      throw new StaleRefError(
        `ref=${ref} is stale — the document holding ${where} now has ${count} iframe(s), ` +
          `not the ${hop.hostTotal} the last snapshot listed, so the ref no longer identifies ` +
          `one frame. Run browser_snapshot to get current refs.`,
      );
    }

    // elementHandle().contentFrame() rather than Locator.contentFrame(): a
    // FrameLocator can search but cannot say what it is looking at, and the
    // URL re-read below is the whole point of the hop.
    const handle: ElementHandle | null = await frames
      .nth(hop.hostIndex)
      .elementHandle()
      .catch(() => null);
    const child: Frame | null = handle
      ? await handle.contentFrame().catch(() => null)
      : null;
    if (!child) {
      throw new StaleRefError(
        `ref=${ref} is stale — ${where} no longer has a reachable document. ` +
          `Run browser_snapshot to get current refs.`,
      );
    }

    const liveKey = documentKey(child.url());
    if (liveKey !== undefined && hop.childUrlKey !== '' && liveKey !== hop.childUrlKey) {
      throw new StaleRefError(
        `ref=${ref} is stale — ${where} navigated on its own ` +
          `(${hop.childUrlKey} → ${liveKey}). Run browser_snapshot to get current refs.`,
      );
    }

    root = child;
  }
  return root;
}

/**
 * Resolve a ref through the a11y refMap stored by generateSnapshot().
 *
 * Throws StaleRefError rather than returning a guess whenever the ref can be
 * shown not to name what the caller thinks it names.
 */
async function resolveRefViaAxMap(
  page: Page,
  ref: string,
): Promise<ElementHandle | null> {
  const wanted = refNumber(ref);
  if (wanted === null) return null;

  const refs = pageRefMaps.get(page);
  // An empty map is the DOM-fallthrough case, which resolveRef serves through
  // the data-wmux-ref locator instead — not a staleness signal.
  if (!refs || refs.length === 0) return null;

  const stamp = pageSnapshotStamps.get(page)?.get(MAIN_FRAME.key);
  const liveUrl = pageDocumentKey(page);
  if (stamp?.url !== undefined && liveUrl !== undefined && stamp.url !== liveUrl) {
    throw new StaleRefError(
      `ref=${ref} is stale — the page navigated since snapshot #${stamp.generation} ` +
        `(${stamp.url} → ${liveUrl}). Run browser_snapshot to get current refs.`,
    );
  }

  const target = refs.find((entry) => entry.ref === wanted);
  if (!target) {
    const identity = pageRefIdentity.get(page);
    // The number was handed out on this document but the latest snapshot does
    // not list it: the element it named is gone. Say so — the number will never
    // be reissued, so retrying cannot help, only re-snapshotting can.
    if (identity && wanted < identity.next) {
      throw new StaleRefError(
        `ref=${ref} is stale — the element it named is no longer in the page snapshot ` +
          `(current snapshot #${identity.generation}). Run browser_snapshot to get current refs.`,
      );
    }
    return null;
  }

  // Use Playwright's getByRole to locate the element. A scoped snapshot numbered
  // its refs inside one element, so search inside that same element — otherwise
  // the nth-match count below is taken over the whole page and can land on an
  // identical role+name that the caller deliberately scoped out.
  const scopeSelector = pageRefScopes.get(page);

  // A selector scope and a frame route are two different answers to "where do
  // I count from", and there is no sound way to combine them: the selector was
  // resolved in the main document, so it cannot name an element inside a
  // frame, and applying it after the hops would silently re-scope the search to
  // whatever that selector happens to match in the child document. Refused
  // rather than guessed — a scoped snapshot never mints frame refs anyway
  // (generateScopedSnapshot does not graft), so this can only be reached by
  // replaying a ref across a change of snapshot mode.
  if (target.framePath.length > 0 && scopeSelector !== undefined) {
    throw new StaleRefError(
      `ref=${ref} was minted inside an iframe, but the latest snapshot was scoped to ` +
        `"${scopeSelector}" — a selector scope cannot reach into a frame. ` +
        `Run browser_snapshot without a selector to get current refs.`,
    );
  }

  const frameRoot = await resolveFrameRoot(page, target.framePath, ref);

  let count: number;
  let locator: ReturnType<Page['getByRole']>;
  try {
    const root = scopeSelector ? page.locator(scopeSelector).first() : frameRoot;
    locator = root.getByRole(target.role as any, {
      name: target.name || undefined,
      exact: true,
    });
    count = await locator.count();
  } catch {
    return null;
  }

  if (count === 0) return null;

  // The nth-match below is only sound while the page still holds the elements
  // the snapshot numbered against. It used to clamp with Math.min(), which
  // turned "the page changed" into "click the last one that matches" — the
  // silent wrong-element case.
  //
  // Deliberately narrow, because the two counts are not measured the same way:
  // the snapshot enumerates an accessibility tree that a depth cap or an
  // `interactive` filter may have trimmed, while the locator sweeps the whole
  // page. Comparing them for every ref would block valid clicks whenever a
  // same-named element sits below the depth cap, or a toast adds one.
  //
  //  - Unnamed entries are exempt: the locator runs with no name filter, so it
  //    counts named siblings too and the totals are not comparable at all.
  //  - Entries the snapshot saw only one of are exempt: the index is 0 either
  //    way, so the count buys no safety and only costs false rejections.
  //
  // What is left is exactly the case the index is load-bearing for: the
  // snapshot listed several elements with this role+name, and which one a ref
  // means depends on that population still being what it was.
  if (target.name && target.sameNameTotal > 1 && count !== target.sameNameTotal) {
    throw new StaleRefError(
      `ref=${ref} is stale — the page now has ${count} ${target.role} element(s) named ` +
        `"${target.name}", not the ${target.sameNameTotal} the last snapshot listed, so the ref ` +
        `no longer identifies one element. Run browser_snapshot to get current refs.`,
    );
  }

  try {
    const nth = Math.min(target.sameNameIndex, count - 1);
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
