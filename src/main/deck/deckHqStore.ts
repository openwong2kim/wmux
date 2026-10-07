// ─── Command Deck — the HQ workspace (main bot, A2 core) ─────────────────────
//
// With an HQ designated, exactly ONE workspace may run a deck brain: the HQ.
// Every other workspace keeps its panes, channels and fan-out routing, but never
// starts a brain turn. With no HQ designated (the default) nothing changes —
// every workspace keeps today's per-workspace brain eligibility.
//
// The HQ is app-owned: its id lives here, in main, and this file is the source
// of truth. The renderer only reads it (DECK_HQ_GET); the setter is an internal
// main API (the HQ-pick UI is a later change).
//
// One JSON file (`deck-hq.json`) in the wmux data dir, atomic-written and
// WMUX_DATA_SUFFIX-isolated — the same storage shape as deck-autonomy.json.
// Reads are cached in memory and revalidated by the file's mtime/size, so the
// per-event hot paths do not re-parse it.
//
// MASTER SWITCH (`moaEnabled`): the main bot as a whole. Off makes the deck
// brain fully inert (see deck.handler). Nothing is deleted, so turning it back
// on restores the previous state. The value is decided once per install by
// ensureMoaDefault: off for a new install, on for an install that already uses
// a deck brain (so it keeps today's behaviour). Until that runs, absent = on.
//
// HQ TURN CAP (`hqMaxTurnsPerHour`): with an HQ designated, its automatic turns
// are capped per trailing hour (default 12). No HQ designated → no cap.
//
// UNREADABLE FILE (fail closed): a file that exists but whose primary and every
// backup copy are unreadable or invalid is NOT read as unset. It reads as
// 'corrupt': the master switch is off (no brain runs anywhere), and every
// write to this store is refused so the next write cannot erase the HQ id, the
// migration marker or the archive. Recovery is manual (fix or remove the file).

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import {
  atomicReadJSONSync,
  atomicWriteJSON,
  atomicWriteJSONSync,
  BACKUP_SUFFIXES,
} from '../../daemon/util/atomicWrite';
import { quarantineFileSync } from '../../daemon/util/atomicWrite/quarantine';
import { createSerialChain } from './serialChain';
import { mutateDeckSchedules } from './deckScheduleStore';
import { loadDeckLoopState, setLoopStatus } from './deckLoopStateStore';
import {
  loadDeckDecisions,
  clearPendingDecisionIfUnchanged,
  type WorkspaceDecision,
} from './deckDecisionStore';
import { loadLiveDeckWorks, archiveDeckWork, clearActiveDeckWork } from './deckWorkStore';
import { loadDeckAutonomy, loadWorkspaceMode, modeToCaps, setWorkspaceAutonomy } from './deckAutonomyStore';
import { getCommanderSessionPath } from './commanderSessionStore';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** Non-HQ pending decisions archived by the migration, kept for reference. */
const MAX_ARCHIVED_DECISIONS = 200;

/** Default hourly cap on the HQ's automatic turns. */
export const DEFAULT_HQ_MAX_TURNS_PER_HOUR = 12;

import {
  MOA_MAX_TURNS_PER_HOUR_RANGE,
  MOA_MEMORY_DECISION_KEY,
  MOA_ISSUE_POLL_MINUTES_DEFAULT,
  MOA_ISSUE_POLL_MINUTES_RANGE,
  MOA_ISSUE_LIST_MAX,
  MOA_AUTO_DAILY_CAP_DEFAULT,
  MOA_AUTO_DAILY_CAP_RANGE,
  parseIgnoredRepos,
  parseTrustedAuthors,
  type MoaLevel,
  type MoaConfig,
  type MoaConfigPatch,
} from '../../shared/moa';
import { MOA_ASK_MODES, type MoaAskMode } from '../../shared/moaAsk';
import { sanitizeAutoRules } from '../../shared/moaDecision';
export type { MoaLevel, MoaConfig, MoaConfigPatch };

export interface ArchivedHqDecision {
  workspaceId: string;
  decision: WorkspaceDecision;
  archivedAt: number;
}

interface HqFile {
  hqWorkspaceId: string | null;
  /** Master switch; absent = on. */
  moaEnabled?: boolean;
  /** Hourly cap on the HQ's automatic turns; absent = the default. */
  hqMaxTurnsPerHour?: number;
  /** Why the switch got its first value (ensureMoaDefault). */
  moaDefault?: 'new-install' | 'existing-brain';
  /** The operator has been through the Moa first-run card. */
  moaOnboarded?: boolean;
  /** Ramp level: 1 observe and report, 2 delegate on request, 3 autonomous. */
  moaLevel?: MoaLevel;
  /** Moa's speech-bubble notifications (renderer). Absent = on. */
  moaBubbles?: boolean;
  /** Still Moa's animations regardless of the OS setting. Absent = off. */
  moaReduceMotion?: boolean;
  /** HQ approval lane opt-in (hqApprovalLane.ts). Absent = off. */
  hqApprovalPress?: boolean;
  /** "Remember this?" proposals (moaMemory.ts). Absent = on. */
  moaMemoryProposals?: boolean;
  /** Issue / outside-PR proposals opt-in (moaIssueProposals.ts). Absent = off. */
  moaIssueProposals?: boolean;
  /** Moa may hand off to a danger-mode workspace without a card (moaHandoff.ts),
   *  while the HQ is in danger mode too. Absent = on. */
  moaAutoHandoff?: boolean;
  /** Moa reads its delegated repos without a prompt (moaReadGate.ts). Absent = on. */
  moaReadWithoutAsking?: boolean;
  /** Shadow judge opt-in (moaShadowFeed.ts): records only. Absent = off. */
  moaShadowJudge?: boolean;
  /** Logins whose `wmux:auto` items may be handed off without a card. */
  moaTrustedAuthors?: string[];
  /** Minutes between proposal scans; absent = the default. */
  moaIssuePollMinutes?: number;
  /** Repo keys the proposals skip ("Ignore this repo"). */
  moaIgnoredRepos?: string[];
  /** moa_ask mode (moaAskService.ts). Absent or unknown = off. */
  moaAskMode?: MoaAskMode;
  /** Rule ids the owner allowed to settle by themselves. Absent = none. */
  moaAutoRules?: string[];
  /** Auto answers per local day. Absent = MOA_AUTO_DAILY_CAP_DEFAULT. */
  moaAutoDailyCap?: number;
  /** The auto kill switch. Absent = off. */
  moaAutoPaused?: boolean;
  /** Archived decisions up to this archivedAt have been acknowledged. */
  archiveAckedAt?: number;
  /** Set once the non-HQ migration has completed for `hqWorkspaceId`. */
  migration?: { doneAt: number; hqWorkspaceId: string };
  archivedDecisions?: ArchivedHqDecision[];
}

interface Loaded {
  file: HqFile;
  corrupt: boolean;
}

export function getDeckHqPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-hq.json');
}

const serialize = createSerialChain();
let corruptWarned = false;

/** Strict shape check: anything else is "invalid", which fails closed. */
function isValidHqFile(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const o = data as Record<string, unknown>;
  if (o.hqWorkspaceId !== undefined && o.hqWorkspaceId !== null
    && !(typeof o.hqWorkspaceId === 'string' && WORKSPACE_ID_RE.test(o.hqWorkspaceId))) return false;
  if (o.moaEnabled !== undefined && typeof o.moaEnabled !== 'boolean') return false;
  if (o.hqMaxTurnsPerHour !== undefined
    && !(typeof o.hqMaxTurnsPerHour === 'number' && Number.isInteger(o.hqMaxTurnsPerHour) && o.hqMaxTurnsPerHour >= 1)) return false;
  if (o.archivedDecisions !== undefined && !Array.isArray(o.archivedDecisions)) return false;
  for (const k of ['moaOnboarded', 'moaBubbles', 'moaReduceMotion', 'hqApprovalPress', 'moaMemoryProposals', 'moaIssueProposals', 'moaAutoHandoff', 'moaReadWithoutAsking', 'moaShadowJudge'] as const) {
    if (o[k] !== undefined && typeof o[k] !== 'boolean') return false;
  }
  if (o.moaLevel !== undefined && o.moaLevel !== 1 && o.moaLevel !== 2 && o.moaLevel !== 3) return false;
  if (o.archiveAckedAt !== undefined && typeof o.archiveAckedAt !== 'number') return false;
  if (o.moaIssuePollMinutes !== undefined && typeof o.moaIssuePollMinutes !== 'number') return false;
  for (const k of ['moaTrustedAuthors', 'moaIgnoredRepos'] as const) {
    if (o[k] !== undefined && !Array.isArray(o[k])) return false;
  }
  return true;
}

function sanitize(o: Record<string, unknown>): HqFile {
  const out: HqFile = { hqWorkspaceId: typeof o.hqWorkspaceId === 'string' ? o.hqWorkspaceId : null };
  if (typeof o.moaEnabled === 'boolean') out.moaEnabled = o.moaEnabled;
  if (typeof o.hqMaxTurnsPerHour === 'number') out.hqMaxTurnsPerHour = o.hqMaxTurnsPerHour;
  const m = o.migration as Record<string, unknown> | undefined;
  if (m && typeof m.doneAt === 'number' && typeof m.hqWorkspaceId === 'string') {
    out.migration = { doneAt: m.doneAt, hqWorkspaceId: m.hqWorkspaceId };
  }
  if (Array.isArray(o.archivedDecisions)) out.archivedDecisions = o.archivedDecisions as ArchivedHqDecision[];
  if (o.moaDefault === 'new-install' || o.moaDefault === 'existing-brain') out.moaDefault = o.moaDefault;
  if (typeof o.moaOnboarded === 'boolean') out.moaOnboarded = o.moaOnboarded;
  if (o.moaLevel === 1 || o.moaLevel === 2 || o.moaLevel === 3) out.moaLevel = o.moaLevel;
  if (typeof o.moaBubbles === 'boolean') out.moaBubbles = o.moaBubbles;
  if (typeof o.moaReduceMotion === 'boolean') out.moaReduceMotion = o.moaReduceMotion;
  if (typeof o.hqApprovalPress === 'boolean') out.hqApprovalPress = o.hqApprovalPress;
  if (typeof o.moaMemoryProposals === 'boolean') out.moaMemoryProposals = o.moaMemoryProposals;
  if (typeof o.archiveAckedAt === 'number') out.archiveAckedAt = o.archiveAckedAt;
  if (typeof o.moaIssueProposals === 'boolean') out.moaIssueProposals = o.moaIssueProposals;
  if (typeof o.moaAutoHandoff === 'boolean') out.moaAutoHandoff = o.moaAutoHandoff;
  if (typeof o.moaReadWithoutAsking === 'boolean') out.moaReadWithoutAsking = o.moaReadWithoutAsking;
  if (typeof o.moaShadowJudge === 'boolean') out.moaShadowJudge = o.moaShadowJudge;
  if (Array.isArray(o.moaTrustedAuthors)) out.moaTrustedAuthors = parseTrustedAuthors(o.moaTrustedAuthors);
  if (typeof o.moaIssuePollMinutes === 'number') {
    const n = issuePollMinutes(o.moaIssuePollMinutes);
    if (n !== null) out.moaIssuePollMinutes = n;
  }
  if (Array.isArray(o.moaIgnoredRepos)) out.moaIgnoredRepos = parseIgnoredRepos(o.moaIgnoredRepos);
  // The delegate's fields fail closed one by one (an unknown value reads as
  // off / none), so they never mark the whole file corrupt.
  if (typeof o.moaAskMode === 'string' && (MOA_ASK_MODES as readonly string[]).includes(o.moaAskMode)) out.moaAskMode = o.moaAskMode as MoaAskMode;
  if (Array.isArray(o.moaAutoRules)) out.moaAutoRules = sanitizeAutoRules(o.moaAutoRules);
  const cap = autoDailyCap(o.moaAutoDailyCap);
  if (cap !== null) out.moaAutoDailyCap = cap;
  if (typeof o.moaAutoPaused === 'boolean') out.moaAutoPaused = o.moaAutoPaused;
  return out;
}

function readFresh(p: string): Loaded {
  let raw: Record<string, unknown> | null = null;
  try {
    // No quarantine: moving a bad primary aside would make the next read see
    // "no file" and fail OPEN.
    raw = atomicReadJSONSync<Record<string, unknown>>(p, {
      validate: isValidHqFile,
      quarantineOnCorruption: false,
    });
  } catch {
    raw = null;
  }
  if (raw !== null) return { file: sanitize(raw), corrupt: false };
  const exists = [p, ...BACKUP_SUFFIXES.map((s) => `${p}${s}`)].some((f) => fs.existsSync(f));
  if (!exists) return { file: { hqWorkspaceId: null }, corrupt: false };
  if (!corruptWarned) {
    corruptWarned = true;
    console.warn(`[deck:hq] ${p} is unreadable or invalid; the main bot stays off until it is fixed`);
  }
  return { file: { hqWorkspaceId: null }, corrupt: true };
}

/** mtime+size of the primary and the first backup: a write renames over the
 *  primary, so any change (ours or external) changes the key. */
function statKey(p: string): string {
  const one = (f: string): string => {
    try {
      const s = fs.statSync(f);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '-';
    }
  };
  return `${one(p)}|${one(`${p}${BACKUP_SUFFIXES[0]}`)}`;
}

const cache = new Map<string, { key: string; loaded: Loaded }>();

/** The first value of the switch, decided in memory before it is on disk
 *  (ensureMoaDefault). It answers every read until the file carries the
 *  field, so a write that fails can never leave a new install switched on. */
const pendingDefault = new Map<string, { enabled: boolean; reason: 'new-install' | 'existing-brain' }>();

/** The file as stored (no pending default). */
function loadStored(dir?: string): Loaded {
  const p = getDeckHqPath(dir);
  const key = statKey(p);
  const hit = cache.get(p);
  if (hit && hit.key === key) return hit.loaded;
  const loaded = readFresh(p);
  cache.set(p, { key, loaded });
  return loaded;
}

function load(dir?: string): Loaded {
  const loaded = loadStored(dir);
  const pending = pendingDefault.get(getDeckHqPath(dir));
  if (!pending || loaded.corrupt || loaded.file.moaEnabled !== undefined) return loaded;
  return { corrupt: false, file: { ...loaded.file, moaEnabled: pending.enabled, moaDefault: pending.reason } };
}

// Writers, swappable in tests to inject a failing disk.
let writeAsync: typeof atomicWriteJSON = atomicWriteJSON;
let writeSync: typeof atomicWriteJSONSync = atomicWriteJSONSync;

/** Tests only: replace the writers (null restores the real ones). */
export function __setHqWritersForTest(w: { async?: typeof atomicWriteJSON; sync?: typeof atomicWriteJSONSync } | null): void {
  writeAsync = w?.async ?? atomicWriteJSON;
  writeSync = w?.sync ?? atomicWriteJSONSync;
}

/** Write the file (refused while corrupt) and drop the cached copy. */
async function write(dir: string | undefined, next: HqFile): Promise<void> {
  const p = getDeckHqPath(dir);
  try {
    await writeAsync(p, next);
  } finally {
    cache.delete(p);
  }
  emitHqStoreWritten();
}

// ── Change notification (the HQ approval lane's policy) ─────────────────────
// Moa's switch, the HQ id and the lane opt-in are part of the policy main
// publishes to the daemon (workspaceFactsFeed). A bare "something changed"
// signal, like deckAutonomyStore's: the subscriber recomputes the whole policy.

const hqWriteListeners = new Set<() => void>();

/** Subscribe to "deck-hq.json was rewritten". Returns the unsubscribe. */
export function onHqStoreWritten(listener: () => void): () => void {
  hqWriteListeners.add(listener);
  return () => {
    hqWriteListeners.delete(listener);
  };
}

function emitHqStoreWritten(): void {
  for (const listener of hqWriteListeners) {
    try {
      listener();
    } catch (err) {
      console.warn(`[deck:hq] store write listener threw: ${String(err)}`);
    }
  }
}

class HqStoreCorruptError extends Error {
  constructor() {
    super('deck-hq.json is unreadable; refusing to overwrite it');
  }
}

/** Run a read-modify-write of the file, refused while the store is corrupt. */
function mutate<T>(dir: string | undefined, fn: (file: HqFile) => Promise<T>): Promise<T> {
  return serialize(async () => {
    const { file, corrupt } = load(dir);
    if (corrupt) throw new HqStoreCorruptError();
    return fn(file);
  });
}

/** True while deck-hq.json exists but cannot be read (fail closed). */
export function isHqStoreCorrupt(dir?: string): boolean {
  return load(dir).corrupt;
}

/** The designated HQ workspace id, or null when none is designated. Never throws. */
export function getHqWorkspaceId(dir?: string): string | null {
  return load(dir).file.hqWorkspaceId;
}

/** The HQ approval lane opt-in. Absent = off; a corrupt store = off. */
export function isHqApprovalPressEnabled(dir?: string): boolean {
  const { file, corrupt } = load(dir);
  return !corrupt && file.hqApprovalPress === true;
}

/** Whether Moa may propose precedents and skills. Absent = on; a corrupt
 *  store = off. Moa off overrides it. */
export function isMoaMemoryProposalsEnabled(dir?: string): boolean {
  const { file, corrupt } = load(dir);
  return !corrupt && file.moaEnabled !== false && file.moaMemoryProposals !== false;
}

/** The master switch. Absent = on (today's behaviour); a corrupt store = off. */
export function isMoaEnabled(dir?: string): boolean {
  const { file, corrupt } = load(dir);
  return !corrupt && file.moaEnabled !== false;
}

/** Persist the master switch. Stores only; the handler stops/starts the
 *  runtime. Returns false (nothing written) while the store is corrupt. */
export async function setMoaEnabled(enabled: boolean, dir?: string): Promise<boolean> {
  try {
    await mutate(dir, (file) => write(dir, { ...file, moaEnabled: enabled }));
    return true;
  } catch (err) {
    if (err instanceof HqStoreCorruptError) return false;
    throw err;
  }
}

// ── Defaults and Moa settings ───────────────────────────────────────────────

/** True when this install already uses a deck brain: a workspace in a mode
 *  other than off, a persisted brain conversation, or HQ state from an
 *  earlier version (a designated HQ, a migration marker, archived decisions). */
function hasExistingBrain(file: HqFile, dir?: string): boolean {
  if (file.hqWorkspaceId !== null || file.migration !== undefined || (file.archivedDecisions?.length ?? 0) > 0) {
    return true;
  }
  try {
    if (Object.values(loadDeckAutonomy(dir)).some((e) => e.mode !== 'off')) return true;
  } catch {
    // unreadable autonomy: fall through to the session check
  }
  try {
    const raw = atomicReadJSONSync<Record<string, unknown>>(getCommanderSessionPath(dir));
    const sessions = raw?.sessions;
    if (sessions && typeof sessions === 'object' && Object.keys(sessions).length > 0) return true;
  } catch {
    // none
  }
  return false;
}

/**
 * Decide the master switch's first value, once per install. A new install
 * starts with Moa off. An install that already uses a deck brain keeps
 * today's behaviour: the switch stays on and no HQ is designated, so every
 * workspace keeps its own brain until the operator sets Moa up. A value
 * already on disk (either way) is never changed, and a corrupt store is left
 * alone.
 *
 * The decision takes effect in memory at once (synchronously, before the deck
 * runtime starts) and is then written through the store's serial chain. If
 * that write fails the in-memory value keeps answering, so a new install
 * stays off until the operator turns Moa on. Returns the persist promise
 * alongside the reason, for callers (tests) that need to wait for it.
 */
export function ensureMoaDefault(dir?: string): { reason: 'new-install' | 'existing-brain'; persisted: Promise<boolean> } | null {
  const { file, corrupt } = loadStored(dir);
  const p = getDeckHqPath(dir);
  if (corrupt || file.moaEnabled !== undefined || pendingDefault.has(p)) return null;
  const reason = hasExistingBrain(file, dir) ? 'existing-brain' : 'new-install';
  const enabled = reason === 'existing-brain';
  pendingDefault.set(p, { enabled, reason });
  const persisted = serialize(async () => {
    const stored = loadStored(dir);
    if (stored.corrupt) return false;
    if (stored.file.moaEnabled === undefined) {
      await write(dir, { ...stored.file, moaEnabled: enabled, moaDefault: reason });
    }
    pendingDefault.delete(p);
    return true;
  }).catch((err) => {
    console.warn(`[deck:hq] could not save Moa's default (${reason}); it holds in memory: ${String(err)}`);
    return false;
  });
  return { reason, persisted };
}

export function getMoaConfig(dir?: string): MoaConfig {
  const { file, corrupt } = load(dir);
  return {
    enabled: !corrupt && file.moaEnabled !== false,
    onboarded: file.moaOnboarded === true,
    level: file.moaLevel ?? 1,
    maxTurnsPerHour: file.hqMaxTurnsPerHour ?? DEFAULT_HQ_MAX_TURNS_PER_HOUR,
    bubbles: file.moaBubbles !== false,
    reduceMotion: file.moaReduceMotion === true,
    defaultReason: file.moaDefault ?? null,
    approvalPress: file.hqApprovalPress === true,
    memoryProposals: file.moaMemoryProposals !== false,
    issueProposals: file.moaIssueProposals === true,
    autoHandoff: file.moaAutoHandoff !== false,
    readWithoutAsking: file.moaReadWithoutAsking !== false,
    shadowJudge: file.moaShadowJudge === true,
    trustedAuthors: file.moaTrustedAuthors ?? [],
    issuePollMinutes: file.moaIssuePollMinutes ?? MOA_ISSUE_POLL_MINUTES_DEFAULT,
    ignoredRepos: file.moaIgnoredRepos ?? [],
    askMode: corrupt ? 'off' : file.moaAskMode ?? 'off',
    autoRules: file.moaAutoRules ?? [],
    autoDailyCap: file.moaAutoDailyCap ?? MOA_AUTO_DAILY_CAP_DEFAULT,
    autoPaused: file.moaAutoPaused === true,
  };
}

/** A whole number within the auto cap's range, or null. */
function autoDailyCap(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n)
    && n >= MOA_AUTO_DAILY_CAP_RANGE.min && n <= MOA_AUTO_DAILY_CAP_RANGE.max ? n : null;
}

/** The owner's per-rule auto toggles (renderer IPC only, through the Moa
 *  delegate service). Returns false while the store is corrupt. */
export async function setMoaAutoRules(ids: readonly string[], dir?: string): Promise<boolean> {
  const next = sanitizeAutoRules([...ids]);
  try {
    await mutate(dir, (file) => write(dir, { ...file, moaAutoRules: next }));
    return true;
  } catch (err) {
    if (err instanceof HqStoreCorruptError) return false;
    throw err;
  }
}

/** A whole number of minutes within the accepted range, or null. */
function issuePollMinutes(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n)
    && n >= MOA_ISSUE_POLL_MINUTES_RANGE.min && n <= MOA_ISSUE_POLL_MINUTES_RANGE.max ? n : null;
}

/** Add a repo to the proposals' ignore list. Returns false while the store is
 *  corrupt (nothing written). */
export async function addMoaIgnoredRepo(repoKey: string, dir?: string): Promise<boolean> {
  const [key] = parseIgnoredRepos([repoKey]);
  if (!key) return false;
  try {
    await mutate(dir, (file) => {
      const list = file.moaIgnoredRepos ?? [];
      if (list.includes(key)) return Promise.resolve();
      // A full list drops its oldest entry, so the new key always lands.
      return write(dir, { ...file, moaIgnoredRepos: [...list, key].slice(-MOA_ISSUE_LIST_MAX) });
    });
    return true;
  } catch (err) {
    if (err instanceof HqStoreCorruptError) return false;
    throw err;
  }
}

/** Bounds on the HQ turn cap the settings accept. */
export const HQ_MAX_TURNS_PER_HOUR_RANGE = MOA_MAX_TURNS_PER_HOUR_RANGE;

/** Persist a settings patch. Invalid fields are ignored. Returns false while
 *  the store is corrupt (nothing written). */
export async function setMoaConfig(patch: MoaConfigPatch, dir?: string): Promise<boolean> {
  const next: Partial<HqFile> = {};
  if (typeof patch.onboarded === 'boolean') next.moaOnboarded = patch.onboarded;
  if (patch.level === 1 || patch.level === 2 || patch.level === 3) next.moaLevel = patch.level;
  if (typeof patch.maxTurnsPerHour === 'number' && Number.isInteger(patch.maxTurnsPerHour)
    && patch.maxTurnsPerHour >= HQ_MAX_TURNS_PER_HOUR_RANGE.min
    && patch.maxTurnsPerHour <= HQ_MAX_TURNS_PER_HOUR_RANGE.max) next.hqMaxTurnsPerHour = patch.maxTurnsPerHour;
  if (typeof patch.bubbles === 'boolean') next.moaBubbles = patch.bubbles;
  if (typeof patch.reduceMotion === 'boolean') next.moaReduceMotion = patch.reduceMotion;
  if (typeof patch.approvalPress === 'boolean') next.hqApprovalPress = patch.approvalPress;
  if (typeof patch.memoryProposals === 'boolean') next.moaMemoryProposals = patch.memoryProposals;
  if (typeof patch.issueProposals === 'boolean') next.moaIssueProposals = patch.issueProposals;
  if (typeof patch.autoHandoff === 'boolean') next.moaAutoHandoff = patch.autoHandoff;
  if (typeof patch.readWithoutAsking === 'boolean') next.moaReadWithoutAsking = patch.readWithoutAsking;
  if (typeof patch.shadowJudge === 'boolean') next.moaShadowJudge = patch.shadowJudge;
  if (patch.trustedAuthors !== undefined) next.moaTrustedAuthors = parseTrustedAuthors(patch.trustedAuthors);
  const minutes = issuePollMinutes(patch.issuePollMinutes);
  if (minutes !== null) next.moaIssuePollMinutes = minutes;
  if (patch.ignoredRepos !== undefined) next.moaIgnoredRepos = parseIgnoredRepos(patch.ignoredRepos);
  if (typeof patch.askMode === 'string' && (MOA_ASK_MODES as readonly string[]).includes(patch.askMode)) next.moaAskMode = patch.askMode;
  const cap = autoDailyCap(patch.autoDailyCap);
  if (cap !== null) next.moaAutoDailyCap = cap;
  if (typeof patch.autoPaused === 'boolean') next.moaAutoPaused = patch.autoPaused;
  try {
    await mutate(dir, (file) => write(dir, { ...file, ...next }));
    return true;
  } catch (err) {
    if (err instanceof HqStoreCorruptError) return false;
    throw err;
  }
}

/** Archived decisions the operator has not acknowledged yet. */
export function countUnackedArchivedDecisions(dir?: string): number {
  const { file } = load(dir);
  const ackedAt = file.archiveAckedAt ?? -Infinity;
  return (file.archivedDecisions ?? []).filter((a) => a.archivedAt > ackedAt).length;
}

/** Acknowledge every archived decision so far (the one-time notice). */
export async function ackArchivedDecisions(dir?: string): Promise<boolean> {
  try {
    await mutate(dir, (file) => {
      const latest = Math.max(file.archiveAckedAt ?? 0, ...(file.archivedDecisions ?? []).map((a) => a.archivedAt));
      return write(dir, { ...file, archiveAckedAt: latest });
    });
    return true;
  } catch (err) {
    if (err instanceof HqStoreCorruptError) return false;
    throw err;
  }
}

/**
 * Recovery from a corrupt store: move the unreadable file and its backups
 * aside (quarantine, nothing deleted) and start over with Moa off and no HQ.
 * A no-op when the store is readable.
 */
export function resetCorruptHqStore(dir?: string): boolean {
  const p = getDeckHqPath(dir);
  if (!loadStored(dir).corrupt) return false;
  // Prepare the fresh "off" file BEFORE touching the corrupt one. If that
  // write fails, nothing moved: the store stays corrupt, which is fail-closed
  // (moving the bad files first and then failing would leave no file at all,
  // which reads as unset — every workspace eligible).
  const staged = `${p}.reset`;
  try {
    writeSync(staged, { hqWorkspaceId: null, moaEnabled: false });
  } catch (err) {
    console.warn(`[deck:hq] could not prepare a fresh deck-hq.json; it stays unreadable: ${String(err)}`);
    return false;
  }
  try {
    // Keep a copy of the unreadable primary, then swap the fresh file in
    // (one rename: there is never a moment with no primary).
    try {
      fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`);
    } catch {
      // a primary that cannot be copied is still replaced
    }
    fs.renameSync(staged, p);
  } catch (err) {
    console.warn(`[deck:hq] could not swap in a fresh deck-hq.json; it stays unreadable: ${String(err)}`);
    return false;
  } finally {
    cache.delete(p);
  }
  // The backups are still unreadable; move them aside so a later fallback
  // never lands on one. Best effort: the primary is readable now.
  for (const f of BACKUP_SUFFIXES.map((x) => `${p}${x}`)) {
    try {
      quarantineFileSync(f, 'deck-hq.json reset from Settings → Moa');
    } catch {
      // best effort
    }
  }
  cache.delete(p);
  corruptWarned = false;
  return true;
}

/** The hourly cap on the HQ's automatic turns. */
export function getHqMaxTurnsPerHour(dir?: string): number {
  return load(dir).file.hqMaxTurnsPerHour ?? DEFAULT_HQ_MAX_TURNS_PER_HOUR;
}

/** True once the non-HQ migration has completed for the CURRENT HQ. */
export function isHqMigrationDone(dir?: string): boolean {
  const { file } = load(dir);
  return file.migration !== undefined && file.migration.hqWorkspaceId === file.hqWorkspaceId;
}

/** The decisions the migration archived, oldest first. */
export function loadArchivedHqDecisions(dir?: string): ArchivedHqDecision[] {
  return load(dir).file.archivedDecisions ?? [];
}

/**
 * The HQ half of brain eligibility. No HQ designated → every workspace passes
 * (each call site keeps its existing mode / task-workspace checks, so today's
 * behaviour is unchanged). An HQ designated → only the HQ passes.
 */
export function hqAllowsBrain(workspaceId: string, hq: string | null): boolean {
  return hq === null || workspaceId === hq;
}

// ── HQ presence (from the renderer's workspace mirror) ─────────────────────

export type HqPresence = 'unset' | 'unknown' | 'present' | 'missing';

type MirrorView = Pick<ReturnType<typeof getWorkspaceMirror>, 'peek' | 'isSessionRestored'>;

/** How old the workspace mirror may be to count as a fresh observation:
 *  three of the renderer's 30s periodic refreshes. */
const HQ_MIRROR_MAX_AGE_MS = 90_000;

/** The last thing this process observed about the HQ, latched until a fresh
 *  observation contradicts it. */
let observed: { hq: string; state: 'present' | 'missing' } | null = null;

/**
 * Where the designated HQ stands:
 *   - 'present'  a fresh mirror lists it;
 *   - 'missing'  a fresh mirror does not, and that absence is trustworthy
 *                (restored session, or this process saw it before). Latched
 *                until the HQ is listed again — a stale or empty mirror never
 *                clears it;
 *   - 'unknown'  nothing trustworthy has been observed yet (cold boot, a
 *                session that restored nothing). No brain runs in this state.
 */
export function hqPresence(hq: string | null, mirror: MirrorView = getWorkspaceMirror(), maxAgeMs = HQ_MIRROR_MAX_AGE_MS): HqPresence {
  if (hq === null) return 'unset';
  const memo = observed?.hq === hq ? observed.state : null;
  const peek = mirror.peek();
  if (peek && peek.entries.length > 0 && peek.ageMs <= maxAgeMs) {
    if (peek.entries.some((e) => e.id === hq)) {
      observed = { hq, state: 'present' };
      return 'present';
    }
    if (mirror.isSessionRestored() || memo !== null) {
      observed = { hq, state: 'missing' };
      return 'missing';
    }
    return 'unknown';
  }
  return memo ?? 'unknown';
}

/** Tests only. */
export function __resetHqMemoryForTest(): void {
  observed = null;
  cache.clear();
  pendingDefault.clear();
  corruptWarned = false;
}

/**
 * The store half of brain eligibility, applied at every site that decides
 * whether a workspace may run a brain: the master switch (off when the store
 * is corrupt), then the HQ gate, and for the HQ itself, that its workspace is
 * known to exist. With the switch on and no HQ designated it is true for every
 * workspace.
 */
export function brainEligible(workspaceId: string, dir?: string): boolean {
  const { file, corrupt } = load(dir);
  if (corrupt || file.moaEnabled === false) return false;
  const hq = file.hqWorkspaceId;
  if (hq === null) return true;
  return workspaceId === hq && hqPresence(hq) === 'present';
}

// ── Runtime hook (registered by the deck handler, which owns the brains) ────

export interface HqRuntime {
  /** A brain for this workspace is in the middle of a turn. */
  isBrainBusy: (workspaceId: string) => boolean;
  /** Dispose every brain except the HQ's (session files are kept). */
  retireBrainsExcept: (hqWorkspaceId: string) => void;
  /** The HQ changed: queued turns re-check eligibility now. */
  onHqChanged?: () => void;
}

let runtime: HqRuntime | null = null;

/** Register the live-brain hook. Returns the unregister function. */
export function setHqRuntime(r: HqRuntime): () => void {
  runtime = r;
  return () => {
    if (runtime === r) runtime = null;
  };
}

// ── Setter (internal API) ────────────────────────────────────────────────────

export type SetHqResult =
  | { ok: true; hqWorkspaceId: string | null; migration: HqMigrationReport | null }
  | { ok: false; code: 'invalid_workspace' | 'brain_running' | 'store_corrupt'; workspaceId?: string };

/**
 * Designate (or clear, with null) the HQ workspace. Refused while the old or
 * the new HQ's brain is mid-turn (an idle brain does not block it). On a
 * designation, the non-HQ migration runs (once per HQ) and every non-HQ brain
 * is retired.
 */
export async function setHqWorkspaceId(next: string | null, dir?: string): Promise<SetHqResult> {
  if (next !== null && !WORKSPACE_ID_RE.test(next)) return { ok: false, code: 'invalid_workspace' };
  let refused: SetHqResult | null;
  try {
    refused = await mutate(dir, async (file): Promise<SetHqResult | null> => {
      for (const ws of [file.hqWorkspaceId, next]) {
        if (ws !== null && runtime?.isBrainBusy(ws)) {
          return { ok: false, code: 'brain_running', workspaceId: ws };
        }
      }
      await write(dir, { ...file, hqWorkspaceId: next });
      return null;
    });
  } catch (err) {
    if (err instanceof HqStoreCorruptError) return { ok: false, code: 'store_corrupt' };
    throw err;
  }
  if (refused) return refused;
  try {
    runtime?.onHqChanged?.();
  } catch (err) {
    console.warn(`[deck:hq] HQ change hook failed: ${String(err)}`);
  }
  if (next === null) return { ok: true, hqWorkspaceId: null, migration: null };
  const migration = await runNonHqMigration(next, dir);
  try {
    runtime?.retireBrainsExcept(next);
  } catch (err) {
    console.warn(`[deck:hq] could not retire non-HQ brains: ${String(err)}`);
  }
  return { ok: true, hqWorkspaceId: next, migration };
}

// ── Non-HQ migration (once per HQ) ───────────────────────────────────────────

export interface HqMigrationReport {
  /** False when the marker for this HQ was already present (nothing touched). */
  ran: boolean;
  schedulesPaused: string[];
  loopsPaused: string[];
  /** The non-HQ pending decisions, archived and returned so the caller can
   *  show them once. */
  decisionsArchived: ArchivedHqDecision[];
  workArchived: string[];
}

/**
 * Park everything that would drive a non-HQ workspace: disable its schedules
 * (they would otherwise fail every tick), pause its running loops, archive its
 * pending decisions and its live work record. Brains, memory and session files
 * are left alone. Clearing the HQ re-opens the gate, but what this parked stays
 * parked — schedules stay disabled and loops paused until the operator turns
 * them back on.
 *
 * Runs once per HQ (the marker names the HQ it ran for). Every step is
 * idempotent and the marker is written only when every step succeeded, so a
 * crash or IO failure re-runs it (on the next designation or at deck handler
 * start). Never throws.
 */
export async function runNonHqMigration(
  hq: string,
  dir?: string,
  log: (line: string) => void = (line) => console.log(`[deck:hq] ${line}`),
  now: () => number = Date.now,
): Promise<HqMigrationReport> {
  const report: HqMigrationReport = {
    ran: false,
    schedulesPaused: [],
    loopsPaused: [],
    decisionsArchived: [],
    workArchived: [],
  };
  const loaded = load(dir);
  if (loaded.corrupt) {
    log('migration skipped: deck-hq.json is unreadable');
    return report;
  }
  if (loaded.file.migration?.hqWorkspaceId === hq) return report;
  report.ran = true;
  let failed = false;

  // 1. Schedules: disable every enabled schedule owned by a non-HQ workspace.
  try {
    await mutateDeckSchedules((schedules) => {
      let changed = false;
      const next = schedules.map((s) => {
        if (!s.enabled || !s.workspaceId || s.workspaceId === hq) return s;
        changed = true;
        report.schedulesPaused.push(s.id);
        return { ...s, enabled: false };
      });
      return changed ? next : null;
    }, dir);
  } catch (err) {
    failed = true;
    log(`[schedule] failed to pause non-HQ schedules: ${String(err)}`);
  }

  // 2. Loops: pause each running non-HQ loop the way the loop pause control
  //    does (its cadence schedule was disabled above; caps back to the mode).
  try {
    for (const [ws, loop] of Object.entries(loadDeckLoopState(dir))) {
      if (ws === hq || loop.status !== 'running') continue;
      await setLoopStatus(ws, 'paused', dir);
      await setWorkspaceAutonomy(ws, modeToCaps(loadWorkspaceMode(ws, dir)), dir);
      report.loopsPaused.push(ws);
    }
  } catch (err) {
    failed = true;
    log(`[loop] failed to pause non-HQ loops: ${String(err)}`);
  }

  // 3. Pending decisions: archive here first (skipping an id already archived
  //    — a crash between the two writes), then clear only if the decision is
  //    still exactly what was archived. One answered or replaced in between is
  //    kept, and the migration re-runs later to pick up a replacement.
  try {
    for (const [ws, decision] of Object.entries(loadDeckDecisions(dir))) {
      if (ws === hq || ws === MOA_MEMORY_DECISION_KEY || decision.status !== 'pending') continue;
      const entry: ArchivedHqDecision = { workspaceId: ws, decision, archivedAt: now() };
      await mutate(dir, async (file) => {
        const list = file.archivedDecisions ?? [];
        if (list.some((a) => a.decision.id === decision.id && a.workspaceId === ws)) return;
        await write(dir, { ...file, archivedDecisions: [...list, entry].slice(-MAX_ARCHIVED_DECISIONS) });
      });
      if (await clearPendingDecisionIfUnchanged(ws, decision, dir)) {
        report.decisionsArchived.push(entry);
        log(`[decision] archived pending decision ${decision.id} of ${ws}: ${decision.question}`);
      } else {
        failed = true;
        log(`[decision] kept decision of ${ws}: it changed while it was being archived`);
      }
    }
  } catch (err) {
    failed = true;
    log(`[decision] failed to archive non-HQ decisions: ${String(err)}`);
  }

  // 4. Live work: archive, then clear. Kept when the archive write fails.
  for (const [ws, work] of Object.entries(loadLiveDeckWorks(dir))) {
    if (ws === hq) continue;
    try {
      archiveDeckWork(work, dir);
      clearActiveDeckWork(ws, dir);
      report.workArchived.push(ws);
    } catch (err) {
      failed = true;
      log(`[work] kept live work ${work.id} of ${ws}: ${String(err)}`);
    }
  }

  if (failed) {
    log('migration incomplete; it will run again');
    return report;
  }
  try {
    await mutate(dir, (file) => write(dir, { ...file, migration: { doneAt: now(), hqWorkspaceId: hq } }));
    log(
      `non-HQ migration done for HQ ${hq}: ${report.schedulesPaused.length} schedule(s) paused, ` +
        `${report.loopsPaused.length} loop(s) paused, ${report.decisionsArchived.length} decision(s) archived, ` +
        `${report.workArchived.length} work record(s) archived`,
    );
  } catch (err) {
    log(`failed to record the migration marker: ${String(err)}`);
  }
  return report;
}
