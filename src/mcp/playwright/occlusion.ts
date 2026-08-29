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
 * So the test is GATED: it runs only once a viewport-scale overlay layer has
 * been positively identified, and it stays silent otherwise. The same six
 * production pages produce zero detections through the gate; the CSS-modal
 * fixture is caught with its backdrop named.
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
 * annotations. The note alone is served instead.
 */
const MAX_REACHABLE_MARKS = 50;

/** Give up rather than hang a snapshot behind a paused/wedged renderer. */
const EVAL_TIMEOUT_MS = 2_000;

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
 * Stage 2 probes each visible, in-viewport control at its centre and four
 * inset points; reaching itself (or an ancestor/descendant, which is the same
 * click) at ANY point counts as reachable. Five points rather than one is what
 * stops an inline sliver or an off-centre child from reading as covered.
 *
 * Returning zero blocked controls means the layer does not actually intercept
 * pointer events (`pointer-events: none` decorative gradients are common), so
 * it reports nothing at all.
 */
const OVERLAY_PROBE_JS = `(() => {
  const vw = innerWidth, vh = innerHeight;
  if (!vw || !vh) return { label: null };
  try { if (document.querySelector(':modal')) return { label: null }; } catch (e) { /* older engine */ }
  if (document.querySelector('[inert]')) return { label: null };

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

  const SEL = 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]';
  const PTS = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  const reachable = [];
  let blockedCount = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    let ok = false;
    for (const p of PTS) {
      const x = Math.min(Math.max(r.left + r.width * p[0], 0), vw - 1);
      const y = Math.min(Math.max(r.top + r.height * p[1], 0), vh - 1);
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) { ok = true; break; }
    }
    if (ok) reachable.push(el); else blockedCount++;
  }
  if (blockedCount === 0) return { label: null };

  const role = layer.getAttribute('role');
  const label = layer.tagName.toLowerCase()
    + (role ? '[role=' + role + ']' : '')
    + (layer.id ? '#' + layer.id : '');
  return { label: label, blockedCount: blockedCount, reachable: reachable, reachableCount: reachable.length };
})()`;

/** Resolve, or give up after EVAL_TIMEOUT_MS — a paused renderer never answers. */
function withTimeout<T>(p: Promise<T>): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), EVAL_TIMEOUT_MS)),
  ]);
}

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
  try {
    // returnByValue is NOT usable here: the payload carries live Elements, and
    // the point of keeping them as remote handles is that DOM.describeNode can
    // turn each one into the backendNodeId the a11y tree is indexed by.
    const evaluated = (await withTimeout(
      client.send('Runtime.evaluate', {
        expression: OVERLAY_PROBE_JS,
        returnByValue: false,
        objectGroup,
        timeout: EVAL_TIMEOUT_MS,
      }),
    )) as { result?: { objectId?: string } } | null;

    const rootId = evaluated?.result?.objectId;
    if (!rootId) return null;

    const rootProps = (await withTimeout(
      client.send('Runtime.getProperties', { objectId: rootId, ownProperties: true }),
    )) as { result?: RemoteProp[] } | null;
    const props = rootProps?.result;
    if (!props) return null;

    const label = propOf(props, 'label')?.value;
    if (typeof label !== 'string' || label === '') return null;

    const blockedCount = Number(propOf(props, 'blockedCount')?.value ?? 0);
    const reachableCount = Number(propOf(props, 'reachableCount')?.value ?? 0);
    const reachable = new Set<number>();

    if (reachableCount > MAX_REACHABLE_MARKS) {
      return { layer: label, blockedCount, reachable, truncated: true };
    }

    const arrayId = propOf(props, 'reachable')?.objectId;
    if (arrayId) {
      const items = (await withTimeout(
        client.send('Runtime.getProperties', { objectId: arrayId, ownProperties: true }),
      )) as { result?: RemoteProp[] } | null;
      for (const item of items?.result ?? []) {
        // Own properties of an array include `length`; only the index slots
        // hold elements.
        if (!/^\d+$/.test(item.name)) continue;
        const objectId = item.value?.objectId;
        if (!objectId) continue;
        const described = (await withTimeout(
          client.send('DOM.describeNode', { objectId }),
        )) as { node?: { backendNodeId?: number } } | null;
        const backendNodeId = described?.node?.backendNodeId;
        if (backendNodeId !== undefined) reachable.add(backendNodeId);
      }
    }

    return { layer: label, blockedCount, reachable, truncated: false };
  } catch {
    // No Runtime domain / detached target / hostile page — see fail-open above.
    return null;
  } finally {
    await client
      .send('Runtime.releaseObjectGroup', { objectGroup })
      .catch(() => { /* best-effort cleanup */ });
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
