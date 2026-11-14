/**
 * A git bundle of an agent's work handed back to the PC that asked for it
 * (bring-back): its id, the limits on its bytes, and how long it is kept for
 * the asking PC to fetch. The transfer is daemon/a2aRemote/bundleOutbox.ts
 * (the PC that made it serves it) and bundleIntake.ts (the asking PC takes it).
 */

/** A bundle's id: `bd-` and a UUID, minted by the PC that made it. */
const BUNDLE_ID_RE = /^bd-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isBundleId(v: unknown): v is string {
  return typeof v === 'string' && BUNDLE_ID_RE.test(v);
}

/** The largest bundle taken when no setting says otherwise. */
export const BUNDLE_BYTES_DEFAULT = 64 * 1024 * 1024;
/** How long a made bundle waits for its fetch when no setting says otherwise. */
export const BUNDLE_TTL_DEFAULT_MS = 60 * 60 * 1000;

/**
 * The largest bundle any setting may allow: the most bytes whose transfer
 * budget (30 s plus 1 Mbit/s, server.ts continueTransferBudgetMs) still fits
 * under its 10-minute ceiling, so a bundle is never cut by its own budget.
 */
export const BUNDLE_BYTES_CEILING = Math.floor(((10 * 60_000 - 30_000) * 1_000) / 8);

/** A size setting as taken: a whole number of bytes from 1 to the ceiling, else the default. */
export function bundleBytesMax(setting: unknown): number {
  return typeof setting === 'number' && Number.isInteger(setting) && setting >= 1 ? Math.min(setting, BUNDLE_BYTES_CEILING) : BUNDLE_BYTES_DEFAULT;
}

/** What the asking PC is told it may fetch: one file, its size and hash. */
export interface A2aBundleManifestV1 {
  bundleId: string;
  sha256: string;
  bytes: number;
}

// ─── Asking for a bundle (link envelopes) ───────────────────────────────────
//
// Each rides on a 'link' envelope whose `linkId` is the ask's id, at version
// 0; none touches a link record. They go only to a PC that advertises
// `bundle.1` (A2A_FEATURE_BUNDLE).
//
//   asking PC -> box  link.state 'bundle-ask'  + `bundleAsk`  (A2aBundleAskV1)
//   box -> asking PC  link.state 'bundle-made' + `bundleMade` (A2aBundleMadeV1)
//
// An ask is one of three:
//   make  the box makes a bundle of the spawn's branch past its base commit
//         and answers with its manifest (or why not);
//   send  the asking PC waits for that bundle now: the box puts it there
//         (only when the box joined the asking PC; else the asking PC fetches);
//   done  the asking PC took it: the offer ends and the file goes.

export const A2A_BUNDLE_LINK_STATES = ['bundle-ask', 'bundle-made'] as const;
export type A2aBundleLinkState = (typeof A2A_BUNDLE_LINK_STATES)[number];

/** An ask's id: `ba-` and a UUID, minted by the asking PC. */
const ASK_ID_RE = /^ba-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPAWN_ID_RE = /^sp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An origin as originUrlRepoKey writes it (shared/a2aContinue.ts). */
const REPO_KEY_RE = /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+){1,21}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function isBundleAskId(v: unknown): v is string {
  return typeof v === 'string' && ASK_ID_RE.test(v);
}

export type A2aBundleAskV1 =
  | { v: 1; askId: string; op: 'make'; spawnId: string; origin: string }
  | { v: 1; askId: string; op: 'send' | 'done'; bundleId: string };

/**
 * Why the box makes or sends no bundle. Only these reach the asking PC:
 * never a path, a ref or git's own words.
 */
export const A2A_BUNDLE_REFUSALS = [
  /** The spawn was not started headless on the box: nothing to make it from. */
  'not-supported',
  /** No start the asking PC made has that id on the box. */
  'unknown-spawn',
  /** The box's worktree is not of the repository the asking PC names. */
  'origin-mismatch',
  /** The commit the work started from is not under the branch (or not there). */
  'base-missing',
  /** Nothing was committed past the base, and nothing changed. */
  'empty',
  /** Nothing was committed past the base, but the worktree has changes: work that is not committed is not brought back. */
  'uncommitted-only',
  /** A shallow repository: a bundle of it cannot be read back. */
  'shallow',
  /** The repository's own config names a program git would run. */
  'repo-config',
  /** Past the size the box makes, or the room it keeps for that PC. */
  'too-large',
  /** The branch moved while the bundle was made. */
  'changed',
  /** Too many asks from that PC in the last minute. */
  'rate-limited',
  /** A make for that PC (or too many in all) runs, or that PC has too many bundles standing. */
  'busy',
  /** No offer of that bundle stands (taken, past its time, or never made). */
  'gone',
  /** The transfer broke: ask to send it again. */
  'again',
  /** The box could not do it now (git failed or ran past its time). */
  'unavailable',
] as const;
export type A2aBundleRefusal = (typeof A2A_BUNDLE_REFUSALS)[number];

export type A2aBundleMadeV1 =
  | { v: 1; askId: string; op: 'made'; manifest: A2aBundleManifestV1 }
  | { v: 1; askId: string; op: 'refused'; reason: A2aBundleRefusal };

/**
 * The one ref a bundle holds: `refs/wmux/bundle/<tree id>`, where the tree id
 * is the one the box named the spawn's worktree and branch with
 * (headlessStarter.ts headlessTreeId: from the asking PC's id and the spawn
 * id). The asking PC computes it the same way and takes only that ref, never
 * a name the box sent. It lives outside refs/heads and refs/tags.
 */
export function bundleRefName(treeId: string): string {
  return `refs/wmux/bundle/${treeId}`;
}

/** The namespace of those refs, swept on the box at start. */
export const BUNDLE_REF_PREFIX = 'refs/wmux/bundle/';

const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An ask as it came off the wire, or null when it is not one. Pure. */
export function parseBundleAsk(v: unknown): A2aBundleAskV1 | null {
  if (!isPlain(v) || v.v !== 1 || !isBundleAskId(v.askId)) return null;
  if (v.op === 'make') {
    if (!onlyKeys(v, ['v', 'askId', 'op', 'spawnId', 'origin'])) return null;
    if (typeof v.spawnId !== 'string' || !SPAWN_ID_RE.test(v.spawnId) || typeof v.origin !== 'string' || !REPO_KEY_RE.test(v.origin)) return null;
    return { v: 1, askId: v.askId, op: 'make', spawnId: v.spawnId, origin: v.origin };
  }
  if (v.op === 'send' || v.op === 'done') {
    if (!onlyKeys(v, ['v', 'askId', 'op', 'bundleId']) || !isBundleId(v.bundleId)) return null;
    return { v: 1, askId: v.askId, op: v.op, bundleId: v.bundleId };
  }
  return null;
}

/** An answer as it came off the wire, or null when it is not one. Pure. */
export function parseBundleMade(v: unknown): A2aBundleMadeV1 | null {
  if (!isPlain(v) || v.v !== 1 || !isBundleAskId(v.askId)) return null;
  if (v.op === 'made') {
    const m = v.manifest;
    if (!onlyKeys(v, ['v', 'askId', 'op', 'manifest']) || !isPlain(m) || !onlyKeys(m, ['bundleId', 'sha256', 'bytes'])) return null;
    if (!isBundleId(m.bundleId) || typeof m.sha256 !== 'string' || !SHA256_RE.test(m.sha256)) return null;
    if (typeof m.bytes !== 'number' || !Number.isInteger(m.bytes) || m.bytes < 1 || m.bytes > BUNDLE_BYTES_CEILING) return null;
    return { v: 1, askId: v.askId, op: 'made', manifest: { bundleId: m.bundleId, sha256: m.sha256, bytes: m.bytes } };
  }
  if (v.op === 'refused') {
    if (!onlyKeys(v, ['v', 'askId', 'op', 'reason']) || !(A2A_BUNDLE_REFUSALS as readonly unknown[]).includes(v.reason)) return null;
    return { v: 1, askId: v.askId, op: 'refused', reason: v.reason as A2aBundleRefusal };
  }
  return null;
}
