import { getConnectionScope } from '../connectionScope';

// ---------------------------------------------------------------------------
// Element descriptors — what a ref number MEANS, kept across snapshots.
//
// A ref number alone is only as good as the snapshot that minted it. Two lanes
// mint refs positionally (the DOM interactive listing that browser_snapshot
// falls back to, and getSmartSnapshotViaEval), so opening a dropdown renumbered
// a link from 2 to 14 and the ref the agent was holding was rejected as stale
// even though the element had not moved (#1355).
//
// A descriptor — role + accessible name + nth-of-kind — is what survives that.
// It is used for exactly two things, and they are the same match:
//
//  1. STABLE NUMBERING. A re-snapshot of the same surface gives an element
//     whose descriptor matches a previous ref that same number again; genuinely
//     new elements take numbers after the previous maximum, so a number is
//     never reused for a different element.
//  2. RECOVERY. A ref from an earlier generation that the current listing does
//     not carry is looked up through its stored descriptor. Exactly one match
//     in the current listing → act on it and say so. Zero or several → the
//     caller keeps its stale error, because a guess is the one outcome worse
//     than a refusal.
// ---------------------------------------------------------------------------

/** The stored identity of one ref, as the snapshot that minted it saw it. */
export interface RefDescriptor {
  ref: number;
  role: string;
  name: string;
  /** Position among that snapshot's elements sharing this role+name. */
  kindIndex: number;
}

/** Anything a descriptor can be computed from. */
export interface DescribableElement {
  role: string;
  name: string;
}

/**
 * Stable ref assignment, and the nth-of-kind numbering it is built on.
 *
 * Written as plain, closure-free ES5 so the SAME function can be shipped into
 * the page as source text (STABLE_REF_ASSIGNMENT_JS) for the lanes that must
 * number and stamp `data-wmux-ref` in one round trip. One implementation, two
 * runtimes — a second copy of the rule in page JS would drift from this one,
 * and a numbering that disagrees with the recorded descriptors is the defect
 * this exists to fix.
 *
 * `prior` is the descriptor set of the last few generations, newest first;
 * `nextRef` the first number never yet handed out on this surface (0 on the
 * DOM listing lane, 1 on the smart lanes).
 */
export function assignStableRefs(
  prior: readonly RefDescriptor[],
  nextRef: number,
  current: readonly DescribableElement[],
): { refs: number[]; kindIndexes: number[]; nextRef: number } {
  const groupKey = function (role: string, name: string) { return role + '\u0000' + name; };
  const exactKey = function (role: string, name: string, k: number) {
    return role + '\u0000' + name + '\u0000' + k;
  };

  // nth-of-kind over the listing being numbered.
  const counts: Record<string, number> = {};
  const kinds: number[] = [];
  for (let i = 0; i < current.length; i++) {
    const g = groupKey(current[i].role, current[i].name);
    const n = counts[g] === undefined ? 0 : counts[g];
    kinds.push(n);
    counts[g] = n + 1;
  }

  // Newest generation wins for a given descriptor: `prior` arrives newest
  // first, so only the first occurrence of a key is kept.
  const byExact: Record<string, number> = {};
  const byGroup: Record<string, number[]> = {};
  for (let p = 0; p < prior.length; p++) {
    const e = prior[p];
    const ek = exactKey(e.role, e.name, e.kindIndex);
    if (byExact[ek] === undefined) byExact[ek] = e.ref;
    const gk = groupKey(e.role, e.name);
    if (byGroup[gk] === undefined) byGroup[gk] = [];
    byGroup[gk].push(e.ref);
  }

  const refs: number[] = new Array(current.length);
  const used: Record<string, boolean> = {};

  // Pass 1 — same role, same name, same nth. The element is exactly where the
  // earlier snapshot saw it, so it keeps its number.
  for (let a = 0; a < current.length; a++) {
    const k1 = exactKey(current[a].role, current[a].name, kinds[a]);
    const r1 = byExact[k1];
    if (r1 !== undefined && used[String(r1)] !== true) {
      refs[a] = r1;
      used[String(r1)] = true;
    }
  }

  // Pass 2 — the nth drifted because a same-named sibling appeared or left,
  // but the role+name group has exactly one element still unnumbered and
  // exactly one unclaimed number, so the pairing is not a guess.
  const pending: Record<string, number[]> = {};
  for (let b = 0; b < current.length; b++) {
    if (refs[b] !== undefined) continue;
    const g2 = groupKey(current[b].role, current[b].name);
    if (pending[g2] === undefined) pending[g2] = [];
    pending[g2].push(b);
  }
  const groups = Object.keys(pending);
  for (let c = 0; c < groups.length; c++) {
    const slots = pending[groups[c]];
    const candidates = byGroup[groups[c]] === undefined ? [] : byGroup[groups[c]];
    const free: number[] = [];
    for (let d = 0; d < candidates.length; d++) {
      if (used[String(candidates[d])] !== true) free.push(candidates[d]);
    }
    if (slots.length === 1 && free.length === 1) {
      refs[slots[0]] = free[0];
      used[String(free[0])] = true;
    }
  }

  // Pass 3 — genuinely new elements, after the previous maximum. Numbers are
  // only ever handed out, never recycled: past every number `prior` holds too,
  // even when the caller's count is behind it.
  let next = nextRef;
  // A number at the edge of the safe range is not followed: counting on from
  // it could no longer tell two numbers apart.
  for (let q = 0; q < prior.length; q++) {
    if (prior[q].ref + 1 > next && prior[q].ref < 9007199254740991) next = prior[q].ref + 1;
  }
  for (let f = 0; f < current.length; f++) {
    if (refs[f] === undefined) {
      refs[f] = next;
      next = next + 1;
    }
  }

  return { refs: refs, kindIndexes: kinds, nextRef: next };
}

/**
 * `assignStableRefs` as source text, for the injected-script lanes that number
 * and stamp in the page. Use as `(${STABLE_REF_ASSIGNMENT_JS})(prior, next, els)`.
 */
export const STABLE_REF_ASSIGNMENT_JS = String(assignStableRefs);

/**
 * The one element in `candidates` a descriptor can be said to name.
 *
 * Role and name must match; the nth is NOT required to, because the whole point
 * is to survive a listing that grew or shrank around the element. That makes
 * the rule deliberately strict in the other direction: several same-role,
 * same-name candidates are ambiguous and resolve to nothing, so two identical
 * siblings can never be told apart by a coin flip.
 */
export function uniqueDescriptorMatch<T extends DescribableElement>(
  descriptor: { role: string; name: string },
  candidates: readonly T[],
): T | null {
  const matches = candidates.filter(
    (candidate) => candidate.role === descriptor.role && candidate.name === descriptor.name,
  );
  return matches.length === 1 ? matches[0] : null;
}

// ---------------------------------------------------------------------------
// Per-surface descriptor history
// ---------------------------------------------------------------------------

/**
 * How many snapshot generations of descriptors a surface keeps.
 *
 * Three, deliberately: an agent holding a ref is normally one snapshot behind,
 * occasionally two (it snapshotted, scrolled, snapshotted, then clicked), and
 * past that a ref is old enough that re-snapshotting is the honest answer.
 * Keeping every generation would let an SPA that churns nodes grow this
 * without bound, which is the cost the cap exists to avoid.
 */
export const DESCRIPTOR_GENERATIONS = 3;

/**
 * How many surfaces the store holds before the least recently written is
 * dropped. Same ceiling as the snapshot baselines: a handful of surfaces per
 * agent is the realistic maximum, and an entry costs three listings.
 */
export const MAX_SURFACES = 16;

interface SurfaceHistory {
  /** Newest last. At most DESCRIPTOR_GENERATIONS entries. */
  generations: RefDescriptor[][];
  /** First number never handed out on this surface. */
  nextRef: number;
}

let moduleStore: Map<string, SurfaceHistory> | undefined;

function getStore(): Map<string, SurfaceHistory> {
  const scope = getConnectionScope();
  if (scope) {
    const existing = scope.refDescriptors as Map<string, SurfaceHistory> | undefined;
    if (existing) return existing;
    const fresh = new Map<string, SurfaceHistory>();
    scope.refDescriptors = fresh;
    return fresh;
  }
  if (!moduleStore) moduleStore = new Map();
  return moduleStore;
}

function historyFor(surfaceKey: string, base: number): SurfaceHistory {
  const store = getStore();
  const existing = store.get(surfaceKey);
  if (existing) return existing;
  const fresh: SurfaceHistory = { generations: [], nextRef: base };
  store.set(surfaceKey, fresh);
  while (store.size > MAX_SURFACES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return fresh;
}

/**
 * Descriptors of the generations this surface still remembers, newest first.
 *
 * Handed to `assignStableRefs` as its `prior`, and searched by
 * `describeRetiredRef`. `base` seeds an unseen surface's number space (the two
 * lanes disagree on whether refs start at 0 or 1).
 */
export function priorRefDescriptors(surfaceKey: string, base: number): RefDescriptor[] {
  const history = historyFor(surfaceKey, base);
  const out: RefDescriptor[] = [];
  for (let i = history.generations.length - 1; i >= 0; i--) out.push(...history.generations[i]);
  return out;
}

/** First number never handed out on this surface. */
export function nextRefFor(surfaceKey: string, base: number): number {
  return historyFor(surfaceKey, base).nextRef;
}

/**
 * Remember what this generation's refs meant, and how far the number space has
 * been spent. Trims to the last DESCRIPTOR_GENERATIONS listings.
 *
 * `kindIndex` is recomputed here rather than trusted from the caller so the
 * stored descriptors are always the ones `assignStableRefs` will compare
 * against — the two must be derived by the same rule or a re-snapshot of an
 * unchanged page would renumber everything and show every line as changed.
 */
export function recordRefGeneration(
  surfaceKey: string,
  base: number,
  elements: readonly (DescribableElement & { ref: number })[],
): void {
  const history = historyFor(surfaceKey, base);
  const counts = new Map<string, number>();
  const generation: RefDescriptor[] = elements.map((element) => {
    const key = `${element.role}\u0000${element.name}`;
    const kindIndex = counts.get(key) ?? 0;
    counts.set(key, kindIndex + 1);
    return { ref: element.ref, role: element.role, name: element.name, kindIndex };
  });
  history.generations.push(generation);
  while (history.generations.length > DESCRIPTOR_GENERATIONS) history.generations.shift();
  for (const element of elements) {
    if (element.ref + 1 > history.nextRef) history.nextRef = element.ref + 1;
  }
  // Refresh insertion order so the surface eviction above is LRU-ish.
  const store = getStore();
  store.delete(surfaceKey);
  store.set(surfaceKey, history);
}

/**
 * Mark every number below `upTo` as spent on this surface without recording
 * what it meant. The RPC lane's frame refs use it: a later listing never
 * hands those numbers out again, and no descriptor can match them back.
 */
export function reserveRefs(surfaceKey: string, base: number, upTo: number): void {
  const history = historyFor(surfaceKey, base);
  if (upTo > history.nextRef) history.nextRef = upTo;
}

/**
 * What a ref meant, in the most recent generation that carried it.
 *
 * Returns null for a number this surface never minted — which is a different
 * failure (a typo, or a ref from another surface) and must not be answered with
 * a recovered element.
 */
export function describeRetiredRef(surfaceKey: string, ref: number): RefDescriptor | null {
  const history = getStore().get(surfaceKey);
  if (!history) return null;
  for (let i = history.generations.length - 1; i >= 0; i--) {
    const found = history.generations[i].find((entry) => entry.ref === ref);
    if (found) return found;
  }
  return null;
}

/**
 * The note a recovered ref is reported with. One wording, so both lanes say
 * the same thing and a test can pin it.
 */
export function recoveredRefNote(ref: number, label = 'ref'): string {
  return `note=${label} ${ref} was from an earlier snapshot; resolved to the same element`;
}

/** Forget every surface. Tests only — production entries age out by generation. */
export function clearRefDescriptors(): void {
  const scope = getConnectionScope();
  if (scope) scope.refDescriptors = undefined;
  moduleStore = undefined;
}
