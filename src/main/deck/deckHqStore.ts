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
//
// UNREADABLE FILE: atomicReadJSONSync already falls back to the backup copy, so
// only a file whose primary AND backup are both unreadable lands here. It reads
// as UNSET (today's behaviour) with one warning, rather than inventing an HQ id
// that matches no workspace.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { createSerialChain } from './serialChain';
import { mutateDeckSchedules } from './deckScheduleStore';
import { loadDeckLoopState, setLoopStatus } from './deckLoopStateStore';
import { loadDeckDecisions, clearDecision, type WorkspaceDecision } from './deckDecisionStore';
import { loadLiveDeckWorks, archiveDeckWork, clearActiveDeckWork } from './deckWorkStore';
import { loadWorkspaceMode, modeToCaps, setWorkspaceAutonomy } from './deckAutonomyStore';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { DEFAULT_MAX_SNAPSHOT_AGE_MS } from './stopGate';

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/** Non-HQ pending decisions archived by the migration, kept for reference. */
const MAX_ARCHIVED_DECISIONS = 200;

export interface ArchivedHqDecision {
  workspaceId: string;
  decision: WorkspaceDecision;
  archivedAt: number;
}

interface HqFile {
  hqWorkspaceId: string | null;
  /** Set once the one-time non-HQ migration has completed. */
  migration?: { doneAt: number; hqWorkspaceId: string };
  archivedDecisions?: ArchivedHqDecision[];
}

export function getDeckHqPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-hq.json');
}

const serialize = createSerialChain();
let unreadableWarned = false;

function loadFile(dir?: string): HqFile {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getDeckHqPath(dir));
  } catch (err) {
    if (!unreadableWarned) {
      unreadableWarned = true;
      console.warn(`[deck:hq] deck-hq.json is unreadable; treating the HQ as unset: ${String(err)}`);
    }
    return { hqWorkspaceId: null };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { hqWorkspaceId: null };
  const o = raw as Record<string, unknown>;
  const hq = typeof o.hqWorkspaceId === 'string' && WORKSPACE_ID_RE.test(o.hqWorkspaceId)
    ? o.hqWorkspaceId
    : null;
  const out: HqFile = { hqWorkspaceId: hq };
  const m = o.migration as Record<string, unknown> | undefined;
  if (m && typeof m.doneAt === 'number' && typeof m.hqWorkspaceId === 'string') {
    out.migration = { doneAt: m.doneAt, hqWorkspaceId: m.hqWorkspaceId };
  }
  if (Array.isArray(o.archivedDecisions)) {
    out.archivedDecisions = o.archivedDecisions as ArchivedHqDecision[];
  }
  return out;
}

/** The designated HQ workspace id, or null when none is designated. Never throws. */
export function getHqWorkspaceId(dir?: string): string | null {
  return loadFile(dir).hqWorkspaceId;
}

/** True once the one-time non-HQ migration has completed. */
export function isHqMigrationDone(dir?: string): boolean {
  return loadFile(dir).migration !== undefined;
}

/** The decisions the migration archived, oldest first. */
export function loadArchivedHqDecisions(dir?: string): ArchivedHqDecision[] {
  return loadFile(dir).archivedDecisions ?? [];
}

/**
 * The HQ half of brain eligibility. No HQ designated → every workspace passes
 * (each call site keeps its existing mode / task-workspace checks, so today's
 * behaviour is unchanged). An HQ designated → only the HQ passes.
 */
export function hqAllowsBrain(workspaceId: string, hq: string | null): boolean {
  return hq === null || workspaceId === hq;
}

/**
 * The HQ is designated but its workspace is gone. Only a mirror that can be
 * trusted to list every workspace answers true — the renderer restored its
 * saved session, pushed a non-empty list, and pushed it recently — so a cold
 * boot (no push yet) or a failed session load never reads as "missing".
 */
export function isHqWorkspaceMissing(
  hq: string | null,
  mirror: Pick<ReturnType<typeof getWorkspaceMirror>, 'peek' | 'isSessionRestored'> = getWorkspaceMirror(),
  maxAgeMs: number = DEFAULT_MAX_SNAPSHOT_AGE_MS,
): boolean {
  if (hq === null) return false;
  const peek = mirror.peek();
  if (!peek || peek.entries.length === 0 || peek.ageMs > maxAgeMs) return false;
  if (!mirror.isSessionRestored()) return false;
  return !peek.entries.some((e) => e.id === hq);
}

// ── Runtime hook (registered by the deck handler, which owns the brains) ────

export interface HqRuntime {
  /** A brain manager exists for this workspace. */
  isBrainRunning: (workspaceId: string) => boolean;
  /** Dispose every brain except the HQ's (session files are kept). */
  retireBrainsExcept: (hqWorkspaceId: string) => void;
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
  | { ok: false; code: 'invalid_workspace' | 'brain_running'; workspaceId?: string };

/**
 * Designate (or clear, with null) the HQ workspace. Refused while a brain is
 * running for the old or the new HQ. On a designation, the one-time non-HQ
 * migration runs (if it has not yet) and every non-HQ brain is retired.
 */
export async function setHqWorkspaceId(next: string | null, dir?: string): Promise<SetHqResult> {
  if (next !== null && !WORKSPACE_ID_RE.test(next)) return { ok: false, code: 'invalid_workspace' };
  const refused = await serialize(async (): Promise<SetHqResult | null> => {
    const file = loadFile(dir);
    for (const ws of [file.hqWorkspaceId, next]) {
      if (ws !== null && runtime?.isBrainRunning(ws)) {
        return { ok: false, code: 'brain_running', workspaceId: ws };
      }
    }
    await atomicWriteJSON(getDeckHqPath(dir), { ...file, hqWorkspaceId: next });
    return null;
  });
  if (refused) return refused;
  if (next === null) return { ok: true, hqWorkspaceId: null, migration: null };
  const migration = await runNonHqMigration(next, dir);
  try {
    runtime?.retireBrainsExcept(next);
  } catch (err) {
    console.warn(`[deck:hq] could not retire non-HQ brains: ${String(err)}`);
  }
  return { ok: true, hqWorkspaceId: next, migration };
}

// ── One-time non-HQ migration ────────────────────────────────────────────────

export interface HqMigrationReport {
  /** False when the done marker was already present (nothing touched). */
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
 * are left alone, so clearing the HQ undoes the gate.
 *
 * Every step is idempotent and the done marker is written only when every step
 * succeeded, so a crash or IO failure re-runs it (on the next designation or
 * at deck handler start). Never throws.
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
  if (loadFile(dir).migration) return report;
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

  // 3. Pending decisions: archive (here) before clearing; a decision whose
  //    archive write failed is kept.
  try {
    const pending: ArchivedHqDecision[] = [];
    for (const [ws, decision] of Object.entries(loadDeckDecisions(dir))) {
      if (ws === hq || decision.status !== 'pending') continue;
      pending.push({ workspaceId: ws, decision, archivedAt: now() });
    }
    if (pending.length > 0) {
      await serialize(async () => {
        const file = loadFile(dir);
        const list = [...(file.archivedDecisions ?? []), ...pending].slice(-MAX_ARCHIVED_DECISIONS);
        await atomicWriteJSON(getDeckHqPath(dir), { ...file, archivedDecisions: list });
      });
      for (const a of pending) {
        await clearDecision(a.workspaceId, dir);
        report.decisionsArchived.push(a);
        log(`[decision] archived pending decision ${a.decision.id} of ${a.workspaceId}: ${a.decision.question}`);
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
    await serialize(async () => {
      const file = loadFile(dir);
      await atomicWriteJSON(getDeckHqPath(dir), { ...file, migration: { doneAt: now(), hqWorkspaceId: hq } });
    });
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
