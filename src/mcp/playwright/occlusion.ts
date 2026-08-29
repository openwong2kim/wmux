/**
 * "Is this control actually clickable?" for browser_snapshot.
 *
 * A snapshot can show a `button` that is on screen, enabled, and correctly
 * named, and clicking it still fails — because something is painted on top of
 * it. The agent has no way to see that from the tree, so it clicks and waits
 * out a 30 s timeout to learn it (a real dogfood loss).
 *
 * What Chrome already handles, measured on Chrome 141 against three fixtures
 * (`Accessibility.getFullAXTree` before and after each state change):
 *
 *   <dialog>.showModal()     15 nodes → 9   content behind the modal REMOVED
 *   subtree.inert = true     13 nodes → 6   the inert subtree REMOVED
 *   CSS backdrop + panel     35 nodes → 46  every covered control still present
 *
 * So the a11y tree already models the two spec-defined cases exactly, and the
 * one it cannot model is the one the web actually uses: a plain `<div>` with a
 * high z-index over the page — every React/Tailwind/Bootstrap modal, cookie
 * wall and paywall. That single gap is all this module fills.
 *
 * Precision is the whole design constraint. A snapshot that says "not
 * clickable" about a control that IS clickable is worse than saying nothing:
 * the agent stops trying, silently and permanently, whereas the status quo
 * costs one timeout and the agent recovers. A naive per-element centre-point
 * hit test does not clear that bar — measured over five production pages
 * (Wikipedia, GitHub, Hacker News, MDN, Stack Overflow) it called 27/95,
 * 83/177 and 9/56 in-viewport controls "blocked" while every one of them was
 * clickable; the culprits are duplicated-but-hidden nav trees, 4-px-wide
 * inline link slivers and elements whose centre lands on a sibling.
 *
 * So the test is GATED, and the gate has three independent conditions (see
 * OVERLAY_PROBE_JS). It stays silent otherwise. Six production pages produce
 * zero detections through the gate; the CSS-modal fixture is caught with its
 * backdrop named.
 */

/** The subset of a CDP session this module needs. */
interface CdpSender {
  send: (method: string, params?: unknown) => Promise<unknown>;
}

export interface OcclusionInfo {
  /** Short DOM label for the overlay layer, e.g. `div#backdrop`. */
  layer: string;
  /** How many on-screen controls the layer keeps from receiving clicks. */
  blockedCount: number;
  /**
   * backendNodeIds of the controls that DO still receive clicks. The reachable
   * side is marked rather than the blocked side because an overlay is, by the
   * gate's definition, covering most of the page: the reachable set is the
   * small one, which keeps both the output and the auto-diff small.
   */
  reachable: Set<number>;
  /** The reachable set was too large to resolve — the note stands alone. */
  truncated: boolean;
}

/**
 * Above this many reachable controls the layer is not behaving like a modal,
 * and resolving them all would cost one CDP round-trip each for a wall of
 * annotations. The note alone is served instead. Enforced twice: once against
 * the count the page reports, and again as a hard stop while walking the array
 * — a page can patch `Array.prototype.push`/`length` to under-report its own
 * size, and the probe runs in that page's main world.
 */
const MAX_REACHABLE_MARKS = 50;

/**
 * The layer's label is page-controlled text (a tag name, a `role`, an `id`).
 * Truncated here rather than in the probe: a hostile page can patch
 * `String.prototype.slice`, so the cap has to be applied on this side of the
 * wire, or the page decides how much of the agent's context it consumes.
 */
const MAX_LABEL_CHARS = 120;

/**
 * Wall-clock budget for the WHOLE collection, not per call. Per-call timeouts
 * multiply: one evaluate + two getProperties + fifty describeNode at 2 s each
 * is a 106-second worst case on a slow-but-alive renderer, which would stall
 * the snapshot far longer than the snapshot is worth.
 */
const TOTAL_BUDGET_MS = 2_000;

/**
 * Cleanup gets its own small budget, separate from the shared deadline, so a
 * collection that used its whole budget still gets a bounded chance to release
 * the object group — and a wedged renderer still cannot hang the snapshot.
 */
const CLEANUP_BUDGET_MS = 500;

/**
 * Runs in the page. Two stages, and the first one is a gate: everything after
 * it only happens on a page that demonstrably has an overlay layer.
 *
 * Stage 1 finds the layer — the outermost positioned ancestor of a hit that
 * still covers ≥75% of the viewport in both axes — and requires it to be the
 * top-most thing at ≥40% of a 5×5 sample grid. Native `:modal` and `inert`
 * short-circuit to "nothing to report": Chrome has already dropped that
 * content from the a11y tree, so there is nothing left to annotate.
 *
 * The grid test alone is NOT enough, and this is the failure that matters: an
 * app shell — the `position: fixed; inset: 0` wrapper a dashboard, a map or a
 * canvas app puts around its whole UI — is the outermost viewport-scale
 * positioned ancestor at every grid point, exactly like a backdrop is. So the
 * gate adds a structural test: a real backdrop does not CONTAIN the page's
 * controls, while a layout root contains nearly all of them. A layer holding
 * more than half of the document's controls is a layout root, and the probe
 * bails.
 *
 * Stage 2 probes each visible, in-viewport control at its centre and four
 * inset points; reaching itself (or an ancestor/descendant, which is the same
 * click) at ANY point counts as reachable. Five points rather than one is what
 * stops an inline sliver or an off-centre child from reading as covered.
 * `pointer-events: none` is checked explicitly because `elementFromPoint`
 * skips such an element and hands back its ancestor, which would otherwise
 * read as "reached".
 *
 * Stage 2 then has to agree with stage 1: a layer that covers the viewport but
 * blocks only a minority of the controls behind it is not a modal, and the one
 * or two hit-test misfires that survive the five-point probe must never be
 * enough on their own to declare a whole page unclickable.
 *
 * Exported so the gate's decisions can be pinned by unit tests: the source runs
 * against a stub DOM in occlusion.probe.test.ts, since layout-dependent
 * behaviour is otherwise only observable against a live browser.
 */
export const OVERLAY_PROBE_JS = `(() => {
  const vw = innerWidth, vh = innerHeight;
  if (!vw || !vh) return { label: null };
  try { if (document.querySelector(':modal')) return { label: null }; } catch (e) { /* older engine */ }
  if (document.querySelector('[inert]')) return { label: null };

  const SEL = 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]';
  const controls = document.querySelectorAll(SEL);

  const layerOf = (el) => {
    let best = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
      const r = n.getBoundingClientRect();
      if (r.width >= vw * 0.75 && r.height >= vh * 0.75) best = n;
    }
    return best;
  };

  const counts = new Map();
  let samples = 0;
  for (let gx = 1; gx <= 5; gx++) for (let gy = 1; gy <= 5; gy++) {
    const hit = document.elementFromPoint(Math.round(vw * gx / 6), Math.round(vh * gy / 6));
    if (!hit) continue;
    samples++;
    const layer = layerOf(hit);
    if (layer) counts.set(layer, (counts.get(layer) || 0) + 1);
  }
  let layer = null, best = 0;
  for (const entry of counts) if (entry[1] > best) { layer = entry[0]; best = entry[1]; }
  if (!layer || !samples || best / samples < 0.4) return { label: null };

  // An app shell contains the page's controls; a backdrop does not.
  let inside = 0;
  for (const el of controls) if (layer.contains(el)) inside++;
  if (controls.length > 0 && inside * 2 > controls.length) return { label: null };

  const PTS = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  const reachable = [];
  let tested = 0, blockedCount = 0;
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    tested++;
    if (getComputedStyle(el).pointerEvents === 'none') { blockedCount++; continue; }
    let ok = false;
    for (const p of PTS) {
      const x = Math.min(Math.max(r.left + r.width * p[0], 0), vw - 1);
      const y = Math.min(Math.max(r.top + r.height * p[1], 0), vh - 1);
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) { ok = true; break; }
    }
    if (ok) reachable.push(el); else blockedCount++;
  }
  // A real full-viewport backdrop blocks essentially everything behind it. A
  // minority means stray hit-test noise, not an overlay.
  if (blockedCount === 0 || blockedCount * 2 <= tested) return { label: null };

  const role = layer.getAttribute('role');
  const label = layer.tagName.toLowerCase()
    + (role ? '[role=' + role + ']' : '')
    + (layer.id ? '#' + layer.id : '');
  return { label: label, blockedCount: blockedCount, reachable: reachable, reachableCount: reachable.length };
})()`;

type RemoteProp = { name: string; value?: { value?: unknown; objectId?: string } };

function propOf(props: RemoteProp[], name: string): RemoteProp['value'] {
  return props.find((p) => p.name === name)?.value;
}

/**
 * Detect a CSS-only overlay covering the page and, if there is one, work out
 * which controls still receive clicks.
 *
 * Returns null on every "nothing to say" outcome — no overlay, an overlay that
 * intercepts nothing, a native modal Chrome already handled, or any CDP
 * failure. Fail-open is deliberate: this is an annotation on top of a
 * snapshot, and a snapshot without it is exactly today's snapshot.
 */
export async function collectOcclusion(client: CdpSender): Promise<OcclusionInfo | null> {
  const objectGroup = 'wmux-occlusion';
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  /** Resolve, or give up when the shared budget runs out. */
  const bounded = <T>(p: Promise<T>): Promise<T | null> =>
    Promise.race([
      p.catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))),
    ]);

  // Only the branch that actually obtained a handle has anything to release,
  // and skipping the call otherwise is what keeps a wedged renderer — whose
  // evaluate just timed out and which will not answer this either — from
  // reinstating the hang the budget above exists to prevent.
  let acquired = false;
  try {
    // returnByValue is NOT usable here: the payload carries live Elements, and
    // the point of keeping them as remote handles is that DOM.describeNode can
    // turn each one into the backendNodeId the a11y tree is indexed by.
    const evaluated = (await bounded(
      client.send('Runtime.evaluate', {
        expression: OVERLAY_PROBE_JS,
        returnByValue: false,
        objectGroup,
        timeout: TOTAL_BUDGET_MS,
      }),
    )) as { result?: { objectId?: string } } | null;

    const rootId = evaluated?.result?.objectId;
    if (!rootId) return null;
    acquired = true;

    const rootProps = (await bounded(
      client.send('Runtime.getProperties', { objectId: rootId, ownProperties: true }),
    )) as { result?: RemoteProp[] } | null;
    const props = rootProps?.result;
    if (!props) return null;

    const rawLabel = propOf(props, 'label')?.value;
    if (typeof rawLabel !== 'string' || rawLabel === '') return null;
    const label = rawLabel.slice(0, MAX_LABEL_CHARS);

    const blockedCount = Number(propOf(props, 'blockedCount')?.value ?? 0);
    const reachableCount = Number(propOf(props, 'reachableCount')?.value ?? 0);
    const reachable = new Set<number>();

    if (reachableCount > MAX_REACHABLE_MARKS) {
      return { layer: label, blockedCount, reachable, truncated: true };
    }

    const arrayId = propOf(props, 'reachable')?.objectId;
    if (arrayId) {
      const items = (await bounded(
        client.send('Runtime.getProperties', { objectId: arrayId, ownProperties: true }),
      )) as { result?: RemoteProp[] } | null;
      const objectIds: string[] = [];
      for (const item of items?.result ?? []) {
        // Own properties of an array include `length`; only the index slots
        // hold elements. The cap is re-applied here rather than trusted from
        // reachableCount — see MAX_REACHABLE_MARKS.
        if (objectIds.length >= MAX_REACHABLE_MARKS) break;
        if (!/^\d+$/.test(item.name)) continue;
        const objectId = item.value?.objectId;
        if (objectId) objectIds.push(objectId);
      }
      // One round-trip each, but issued together: sequentially these are the
      // dominant cost of the whole collection.
      const described = await Promise.all(
        objectIds.map((objectId) =>
          bounded(client.send('DOM.describeNode', { objectId })) as Promise<{
            node?: { backendNodeId?: number };
          } | null>,
        ),
      );
      for (const node of described) {
        const backendNodeId = node?.node?.backendNodeId;
        if (backendNodeId !== undefined) reachable.add(backendNodeId);
      }
    }

    return { layer: label, blockedCount, reachable, truncated: false };
  } catch {
    // No Runtime domain / detached target / hostile page — see fail-open above.
    return null;
  } finally {
    if (acquired) {
      await Promise.race([
        client.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, CLEANUP_BUDGET_MS)),
      ]);
    }
  }
}

/**
 * The one line an occluded page earns at the top of its snapshot.
 *
 * One line rather than an `obscured` marker per covered control, because an
 * overlay covers most of the page by the gate's own definition: per-control
 * marking would both dominate the output and make every modal open/close a
 * whole-snapshot auto-diff. This way the state change is a few lines.
 */
export function occlusionNote(info: OcclusionInfo): string {
  if (info.truncated) {
    return `(note: an overlay (${info.layer}) is covering the page — ${info.blockedCount} on-screen controls behind it will not receive clicks)`;
  }
  return `(note: an overlay (${info.layer}) is covering the page — ${info.blockedCount} on-screen controls behind it will not receive clicks; only controls marked "clickable" are reachable right now)`;
}
