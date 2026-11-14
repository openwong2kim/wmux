/**
 * Bringing back an agent's work, the asking PC's side (fanout_bring_back):
 * the daemon RPC main calls, what it answers, the reasons only this PC gives,
 * the limits it keeps, and the fixed words each outcome is told with.
 *
 * Nothing the box or the bundle sends is ever shown as written: a caller sees
 * these words, a commit sha and a branch name, nothing else.
 */
import { A2A_BUNDLE_REFUSALS, type A2aBundleManifestV1, type A2aBundleRefusal } from './a2aBundle';

export const A2A_BUNDLE_ASK_RPC = {
  /** Ask (or follow) the bring-back of one spawn: `{ hostId, spawnId, origin, waitMs? }` → BundleBringBackState. */
  bringBack: 'a2a.remote.bundle.bringBack',
  /** The staged bundle was imported (or refused there): `{ hostId, spawnId }`; its file goes and the record ends. */
  release: 'a2a.remote.bundle.release',
} as const;

/** Reasons only the asking PC gives: never on the wire (A2A_BUNDLE_REFUSALS is the wire list). */
export const BUNDLE_ASKER_REFUSALS = [
  /** The commit the work started from is not in the home repository. */
  'base-not-local',
  /** The returned branch already holds work the bundle does not contain. */
  'not-fast-forward',
  /** No home repository was recorded for the task, or it is no longer a git top level. */
  'no-home-repo',
  /** The bundle is not the one bundle this PC takes (its header, its one ref). */
  'bundle-unexpected',
  /** Bringing work back is off on this PC. */
  'feature-off',
  /** Too many bundles are staged or asked for on this PC already. */
  'staging-full',
  /** The home repository's own git config names a program git would run. */
  'home-repo-config',
  /** The home repository belongs to another user, so git does not work in it with this user's settings. */
  'home-repo-owner',
  /** Git refused the import (a corrupt object, the branch checked out): nothing was written. */
  'import-failed',
  /** Git on this PC is older than the version seen to check a bundle's objects on fetch, or its version is unreadable. */
  'git-too-old',
] as const;
export type BundleAskerRefusal = (typeof BUNDLE_ASKER_REFUSALS)[number];
export type BundleBringBackRefusal = A2aBundleRefusal | BundleAskerRefusal;

export function isBundleBringBackRefusal(v: unknown): v is BundleBringBackRefusal {
  return (A2A_BUNDLE_REFUSALS as readonly unknown[]).includes(v) || (BUNDLE_ASKER_REFUSALS as readonly unknown[]).includes(v);
}

/**
 * The asking PC's limits, in one place so each can become a setting. The
 * largest bundle is the existing setting (a2aBundle.ts bundleBytesMax).
 */
export const BUNDLE_ASK_LIMITS = Object.freeze({
  /** How long an ask, and a bundle staged for it, is kept before it is swept. */
  stagedTtlMs: 2 * 60 * 60 * 1000,
  /** Asks (open or staged) for one PC. */
  perHostFiles: 4,
  /** Bytes staged from one PC. */
  perHostBytes: 256 * 1024 * 1024,
  /** Asks (open or staged) for all PCs together. */
  totalFiles: 8,
  /** How often staging is swept (also once at daemon start). */
  sweepMs: 10 * 60 * 1000,
  /** Retries of one step the box answered again, busy or rate-limited (the box takes 12 asks a minute). */
  retries: 3,
  /** The wait before each retry, plus up to `jitterMs`. */
  backoffMs: [10_000, 20_000, 40_000] as readonly number[],
  jitterMs: 3_000,
  /** The longest a bringBack call waits for its ask to move on. */
  waitMaxMs: 20_000,
});

/** What a bringBack call answers. */
export type BundleBringBackState =
  /** The ask runs (the box makes it, or it is on its way): call again later. */
  | { state: 'asking' }
  /** The bundle is staged here: `ref` is the one ref it may hold, computed on this PC. */
  | { state: 'staged'; file: string; manifest: A2aBundleManifestV1; ref: string }
  | { state: 'refused'; reason: BundleBringBackRefusal };

/** The kinds of home-repository config key that refuse an import (home-repo-config), each with its fixed words: the kind, never the value. */
export const HOME_REPO_CONFIG_KIND_TEXT = {
  core: 'a core setting that runs a program',
  credential: 'a credential setting',
  include: 'an include of another config file',
  protocol: 'a protocol setting',
  url: 'a URL rewrite',
  remote: 'a remote program setting',
  push: 'a push setting',
  transport: 'an http or ssh transport setting',
  signing: 'a signing program setting',
  filter: 'a content filter',
  fsck: 'a setting that weakens git\'s object checks',
} as const;
export type HomeRepoConfigKind = keyof typeof HOME_REPO_CONFIG_KIND_TEXT;

/** The fixed words for each refusal: what happened and what the caller can do. */
export function bringBackRefusalText(reason: BundleBringBackRefusal, configKind?: HomeRepoConfigKind): string {
  switch (reason) {
    case 'not-supported': return 'the other PC cannot hand back this task\'s work (it was not started headless there, or its wmux is too old)';
    case 'unknown-spawn': return 'the other PC has no task with that id from this PC';
    case 'origin-mismatch': return 'the task\'s folder on the other PC is not of the same repository as the home repository';
    case 'base-missing': return 'the commit the task started from is not on its branch on the other PC';
    case 'empty': return 'the agent committed nothing past the commit it started from';
    case 'uncommitted-only': return 'the agent\'s changes are not committed: ask the agent to commit, then bring back again';
    case 'shallow': return 'the repository on the other PC is shallow, so its work cannot be bundled';
    case 'repo-config': return 'the repository on the other PC has git config that runs a program, so it was not bundled';
    case 'too-large': return 'the work is larger than the bundle size limit';
    case 'changed': return 'the agent\'s branch moved while it was bundled: bring back again';
    case 'rate-limited': return 'the other PC took too many asks in the last minute: bring back again in a minute';
    case 'busy': return 'the other PC is busy with other bundles: bring back again later';
    case 'gone': return 'the other PC no longer holds that bundle: bring back again';
    case 'again': return 'the transfer broke: bring back again';
    case 'unavailable': return 'the other PC could not make or send the bundle now: bring back again later';
    case 'base-not-local': return 'the commit the task started from is not in the home repository: fetch it there, then bring back again';
    case 'not-fast-forward': return 'the returned branch already holds different work: rename or delete it, then bring back again';
    case 'no-home-repo': return 'no home repository is known for this task (its pane was not in a git repository with an origin at fanout_start, or that repository is gone)';
    case 'bundle-unexpected': return 'what came back is not the one bundle this PC takes, so nothing was imported';
    case 'feature-off': return 'bringing work back is off on this PC or the other one';
    case 'staging-full': return 'too many bundles are waiting on this PC: import or let them expire, then bring back again';
    case 'home-repo-config': return `the home repository's own git config (.git/config) has ${configKind ? HOME_REPO_CONFIG_KIND_TEXT[configKind] : 'a setting that runs a program'}, which wmux does not run git with: remove it there, then bring back again`;
    case 'home-repo-owner': return 'the home repository belongs to another user, and wmux runs git without the global config that could mark it safe: bring back into a repository this user owns';
    case 'git-too-old': return 'git on this PC is too old to check a returned bundle; update git, then bring back again';
    case 'import-failed': return 'git refused to import the bundle (a damaged object, or the returned branch is checked out): nothing was changed';
  }
}

/** The branch a spawn's work is brought back to in the home repository. `spawnId` is checked by the caller. */
export function returnedBranchName(spawnId: string): string {
  return `wmux/returned/${spawnId}`;
}
