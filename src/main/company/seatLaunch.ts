// The seats a company preset makes, settled in main: each seat's final pane
// name, its own worktree and its launch line. Main holds every pane label
// (MetadataStore), so it is the one place a name can be checked free before
// the agents are told it.
// A seat's first turn is its brief (shared/companyPreset.ts seatBrief): the
// brief is written to a file and the agent starts with that file as its first
// prompt, the way a fan-out worker does, so the text never passes through a
// shell's quoting, and pty.create reshapes the line for a WSL or cmd pane.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { getWmuxHomeDir } from '../../shared/constants';
import { agentLauncherStem, agentRow, isAgentSlug } from '../../shared/agentIdentity';
import { firstRunEnvForAgent } from '../../shared/agentFirstRun';
import { companySeatsError, freeSeatLabels, ownWorktreeSeats, seatBrief } from '../../shared/companyPreset';
import { normalizePaneLabel, paneLabelShapeError } from '../../shared/paneLabelRules';
import { PANE_METADATA_LABEL_MAX } from '../../shared/types';
import { ensureSecretHook } from '../git/secretHookHost';
import { metadataStore } from '../metadata/MetadataStore';
import { buildInitialCommand } from '../worktask/FanOutService';
import { buildTaskSlug, TaskWorktreeManager } from '../worktask/TaskWorktreeManager';

// Not dots alone: `.` or `..` would name the briefs root or the data folder.
const WORKSPACE_ID_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,80}$/;
const FOLDER_MAX = 4096;
const TEXT_MAX = { company: 200, owns: 200, mission: 2000, standingOrders: 8000 } as const;
/** A workspace holds at most 20 panes (the renderer's MAX_PANES_PER_WORKSPACE). */
const HIRE_STAFF_MAX = 20;
/** Brief folders older than this are removed when the next company is made. */
export const SEAT_BRIEF_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Written to each seat worktree's meta folder (`<repoHash>/.meta/<slug>`). */
export const SEAT_STAMP_FILE = 'seat.json';

/** What a seat worktree was made for, read back by its cleanup (seatCleanup.ts). */
export interface SeatStamp {
  v: 1;
  workspaceId: string;
  company: string;
  label: string;
  branch: string;
  /** The commit `branch` was made at; absent when it could not be read. */
  baseOid?: string;
  createdAt: number;
}

export interface SeatLaunchRequest {
  workspaceId: string;
  company: string;
  mission?: string;
  standingOrders?: string;
  ceo: number;
  /** Start each agent with its brief as the first prompt. */
  tellSeats: boolean;
  /** Absolute folder the company works in; its repository gets the seats' worktrees. */
  folder?: string;
  seats: { label: string; owns: string; agent?: string }[];
}

export type SeatLaunchResult =
  /** `cwds[i]`: seat i's own worktree, or null to start in the company folder. */
  | { ok: true; labels: string[]; commands: (string | null)[]; cwds: (string | null)[] }
  | { ok: false; error: string };

/** One seat added to a company that already runs ("Add a seat on this PC…"). */
export interface HireSeatRequest {
  workspaceId: string;
  company: string;
  mission?: string;
  standingOrders?: string;
  /** Absolute folder the company works in; its repository gets the seat's worktree. */
  folder?: string;
  /** The CEO pane's name, as a seat addresses it (`#<label>`). */
  ceo: { label: string };
  /** The company's staff seats now; `agent`: an agent runs in that pane. */
  staff: { label: string; owns: string; agent?: boolean }[];
  seat: { label: string; owns: string; agent: string };
}

export type HireSeatResult =
  /** `cwd`: the seat's own worktree, else the company folder, else null (where panes start). */
  /** `env`: what the seat's pane starts with so its agent skips the first-run
   *  screens in a folder wmux made (absent when there is none, or it is off). */
  | { ok: true; label: string; command: string; cwd: string | null; branch?: string; env?: Record<string, string> }
  | { ok: false; error: string };

export interface SeatLaunchDeps {
  dir?: string;
  platform?: NodeJS.Platform;
  /** Every label a pane carries now. */
  takenLabels?: () => Iterable<string>;
  now?: () => number;
  worktrees?: TaskWorktreeManager;
  /** Read for the first-run opt-out (agentFirstRun.ts); process.env when absent. */
  env?: NodeJS.ProcessEnv;
}

// Not the fan-out root: a folder there with no open task reads as a leftover
// to the worktree scan. One instance, shared with the seat cleanup, so both
// go through the same per-repository lock.
let companyWorktrees: TaskWorktreeManager | undefined;
export function seatWorktrees(): TaskWorktreeManager {
  companyWorktrees ??= new TaskWorktreeManager({ onCreated: ensureSecretHook, worktreesRoot: path.join(getWmuxHomeDir(), 'company-worktrees') });
  return companyWorktrees;
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

function labelsInUse(): string[] {
  return metadataStore.snapshot().entries.flatMap((e) => (e.metadata.label ? [e.metadata.label] : []));
}

/** Best effort: a seat without a stamp is cleaned up by the same rules, only
 *  without its base commit. */
function writeSeatStamp(metaDir: string, stamp: SeatStamp): void {
  try {
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, SEAT_STAMP_FILE), JSON.stringify(stamp), 'utf8');
  } catch {
    // the seat works without it
  }
}

/** Remove brief folders nobody will read again: their agents started long ago. */
function pruneOldBriefs(root: string, now: number): void {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    const folder = path.join(root, name);
    try {
      if (now - fs.statSync(folder).mtimeMs > SEAT_BRIEF_KEEP_MS) fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // another one next time
    }
  }
}

/**
 * Each seat's final name (a name another pane carries gets `-2`, `-3`…), its
 * worktree and its launch line. Every seat in ownWorktreeSeats gets a
 * worktree of the folder's repository on its own branch, from origin's
 * default branch; a lone such seat shares a folder that is not a repository
 * with the CEO, and two or more are refused there. The launch line is null
 * for a seat with no agent, the bare launcher when the seats are not told,
 * and otherwise the launcher with the seat's brief file as its first prompt.
 * The briefs name the final labels and each seat's worktree. Files are
 * `<wmux data dir>/company-briefs/<workspaceId>/seat-<n>.md`. Each worktree
 * gets a stamp (SEAT_STAMP_FILE) in its meta folder. A failure removes the
 * worktrees, their stamps and the briefs already made.
 */
export async function seatLaunches(req: unknown, deps: SeatLaunchDeps = {}): Promise<SeatLaunchResult> {
  if (!req || typeof req !== 'object') return { ok: false, error: 'bad request' };
  const r = req as Partial<SeatLaunchRequest>;
  if (typeof r.workspaceId !== 'string' || !WORKSPACE_ID_RE.test(r.workspaceId)) return { ok: false, error: 'bad workspace id' };
  if (!isText(r.company, TEXT_MAX.company) || !r.company.trim()) return { ok: false, error: 'bad company name' };
  if (r.mission !== undefined && !isText(r.mission, TEXT_MAX.mission)) return { ok: false, error: 'bad mission' };
  if (r.standingOrders !== undefined && !isText(r.standingOrders, TEXT_MAX.standingOrders)) return { ok: false, error: 'bad standing orders' };
  if (r.folder !== undefined && !(isText(r.folder, FOLDER_MAX) && path.isAbsolute(r.folder))) return { ok: false, error: 'bad folder' };
  if (!Array.isArray(r.seats) || typeof r.ceo !== 'number') return { ok: false, error: 'bad seats' };
  const seats = r.seats;
  for (const seat of seats) {
    if (!seat || typeof seat.label !== 'string' || !isText(seat.owns, TEXT_MAX.owns)) return { ok: false, error: 'bad seats' };
    if (seat.agent !== undefined && !isAgentSlug(seat.agent)) return { ok: false, error: `unknown agent ${String(seat.agent)}` };
  }
  const trimmed = seats.map((s) => ({ label: s.label.trim(), owns: s.owns.trim() }));
  const invalid = companySeatsError(trimmed, r.ceo);
  if (invalid) return { ok: false, error: `seats: ${invalid}` };
  const own = ownWorktreeSeats(seats, r.ceo);
  if (own.length > 1 && !r.folder) return { ok: false, error: 'choose the folder: each seat but the CEO works in its own worktree of it' };

  const labels = freeSeatLabels(trimmed.map((s) => s.label), (deps.takenLabels ?? labelsInUse)());
  const made: { label: string; owns: string; worktree?: { path: string; branch: string } }[] = trimmed.map((s, i) => ({ label: labels[i], owns: s.owns }));
  const root = path.join(deps.dir ?? getWmuxDir(), 'company-briefs');
  const folder = path.join(root, r.workspaceId);
  const worktrees = deps.worktrees ?? seatWorktrees();
  const created: { repoRoot: string; repoHash: string; path: string; branch: string; oid?: string; metaDir: string }[] = [];
  let madeFolder = false;
  const undo = async () => {
    for (const w of created.reverse()) {
      await worktrees.removeWorktree(w.repoRoot, w.repoHash, w.path, undefined, { force: true });
      if (w.oid) await worktrees.deleteBranchIfAt(w.repoRoot, w.repoHash, w.branch, w.oid);
      try { fs.rmSync(w.metaDir, { recursive: true, force: true }); } catch { /* a stamp with no worktree is never read */ }
    }
    if (madeFolder) {
      try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* left for the prune */ }
    }
  };
  const fail = async (error: string): Promise<SeatLaunchResult> => {
    await undo();
    return { ok: false, error };
  };

  pruneOldBriefs(root, (deps.now ?? Date.now)());
  if (r.tellSeats === true && seats.some((s) => s.agent)) {
    // Made here and only here: a workspace id seen before is refused, so
    // nothing below writes into or removes another company's briefs.
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(folder);
      madeFolder = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, error: code === 'EEXIST' ? 'this workspace id already has seat briefs' : `could not make the seats: ${(err as Error).message}` };
    }
  }

  try {
    if (r.folder && own.length > 0) {
      let base: { oid?: string; error?: string } | undefined;
      for (const i of own) {
        const pf = await worktrees.preflight(r.folder, labels[i], r.workspaceId, { branch: `company/${buildTaskSlug(labels[i], r.workspaceId)}` });
        if (!pf.ok) {
          if (own.length === 1) break;
          return await fail(pf.error);
        }
        base ??= await worktrees.resolveBase(pf.plan.repoRoot);
        if (base.error) return await fail(base.error);
        const wt = await worktrees.createWorktree(pf.plan, base.oid);
        if (!wt.ok) return await fail(wt.error);
        created.push({ repoRoot: pf.plan.repoRoot, repoHash: pf.plan.repoHash, path: wt.worktreePath, branch: wt.branch, oid: wt.branchOid, metaDir: pf.plan.metaDir });
        writeSeatStamp(pf.plan.metaDir, {
          v: 1, workspaceId: r.workspaceId, company: r.company.trim(), label: labels[i], branch: wt.branch,
          ...(wt.branchOid ? { baseOid: wt.branchOid } : {}), createdAt: (deps.now ?? Date.now)(),
        });
        made[i].worktree = { path: wt.worktreePath, branch: wt.branch };
      }
    }
    const commands = seats.map((seat, i) => {
      const row = seat.agent ? agentRow(seat.agent) : undefined;
      if (!row) return null;
      const launcher = agentLauncherStem(row);
      if (r.tellSeats !== true) return launcher;
      const file = path.join(folder, `seat-${i + 1}.md`);
      fs.writeFileSync(file, seatBrief({
        company: r.company!.trim(), mission: r.mission, standingOrders: r.standingOrders, seats: made, ceo: r.ceo!, seat: i,
      }), 'utf8');
      return buildInitialCommand(launcher, file, deps.platform);
    });
    return { ok: true, labels, commands, cwds: made.map((s) => s.worktree?.path ?? null) };
  } catch (err) {
    return await fail(`could not make the seats: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A pane name as a brief addresses it (`#<name>`): one word. */
const isPaneName = (v: unknown): v is string =>
  isText(v, PANE_METADATA_LABEL_MAX) && v.trim().length > 0 && !/\s/.test(v.trim());

/**
 * One seat added to a company that already runs: its own worktree, its brief
 * and its launch line, made the way a preset makes a seat's. The name is the
 * one asked for: a name another pane carries is refused, never suffixed (the
 * dialog offers a free one). The seat gets a worktree of the folder's
 * repository on `company/<slug>`, stamped like a preset seat's. Outside a
 * repository, or with no folder, it starts in the folder (null: where panes
 * start), unless another staff seat's agent already works there: that is
 * refused, as a preset refuses a second agent seat there. The agent starts
 * with its brief (seatBrief's staff text) as its first prompt, from
 * `<wmux data dir>/company-briefs/<workspaceId>/hire-<label>-<ts>.md`. A
 * failure removes the worktree, its branch and its stamp.
 */
export async function hireSeat(req: unknown, deps: SeatLaunchDeps = {}): Promise<HireSeatResult> {
  if (!req || typeof req !== 'object') return { ok: false, error: 'bad request' };
  const r = req as Partial<HireSeatRequest>;
  if (typeof r.workspaceId !== 'string' || !WORKSPACE_ID_RE.test(r.workspaceId)) return { ok: false, error: 'bad workspace id' };
  if (!isText(r.company, TEXT_MAX.company) || !r.company.trim()) return { ok: false, error: 'bad company name' };
  if (r.mission !== undefined && !isText(r.mission, TEXT_MAX.mission)) return { ok: false, error: 'bad mission' };
  if (r.standingOrders !== undefined && !isText(r.standingOrders, TEXT_MAX.standingOrders)) return { ok: false, error: 'bad standing orders' };
  if (r.folder !== undefined && !(isText(r.folder, FOLDER_MAX) && path.isAbsolute(r.folder))) return { ok: false, error: 'bad folder' };
  if (!r.ceo || typeof r.ceo !== 'object' || !isPaneName(r.ceo.label)) return { ok: false, error: 'bad CEO' };
  const staff = r.staff;
  if (!Array.isArray(staff) || staff.length > HIRE_STAFF_MAX || !staff.every((s) =>
    !!s && isPaneName(s.label) && isText(s.owns, TEXT_MAX.owns) && (s.agent === undefined || typeof s.agent === 'boolean'))) {
    return { ok: false, error: 'bad staff' };
  }
  const seat = r.seat;
  if (!seat || typeof seat !== 'object' || typeof seat.label !== 'string' || !isText(seat.owns, TEXT_MAX.owns)) return { ok: false, error: 'bad seat' };
  const row = isAgentSlug(seat.agent) ? agentRow(seat.agent) : undefined;
  if (!row) return { ok: false, error: `unknown agent ${String(seat.agent)}` };
  const label = seat.label.trim();
  if (!label || label.length > PANE_METADATA_LABEL_MAX || paneLabelShapeError(label)) return { ok: false, error: 'seats: label' };
  const taken = new Set([...(deps.takenLabels ?? labelsInUse)()].map(normalizePaneLabel));
  if (taken.has(normalizePaneLabel(label))) return { ok: false, error: `another pane is named ${label}` };
  // Agents sharing one checkout overwrite each other's changes.
  const shared = staff.some((s) => s.agent === true);
  if (!r.folder && shared) return { ok: false, error: 'choose the company folder: another seat\'s agent already works where panes start' };

  const workspaceId = r.workspaceId;
  const now = deps.now ?? Date.now;
  const worktrees = deps.worktrees ?? seatWorktrees();
  let made: { repoRoot: string; repoHash: string; path: string; branch: string; oid?: string; metaDir: string } | undefined;
  const fail = async (error: string): Promise<HireSeatResult> => {
    if (made) {
      await worktrees.removeWorktree(made.repoRoot, made.repoHash, made.path, undefined, { force: true });
      if (made.oid) await worktrees.deleteBranchIfAt(made.repoRoot, made.repoHash, made.branch, made.oid);
      try { fs.rmSync(made.metaDir, { recursive: true, force: true }); } catch { /* a stamp with no worktree is never read */ }
    }
    return { ok: false, error };
  };

  try {
    if (r.folder) {
      const pf = await worktrees.preflight(r.folder, label, workspaceId, { branch: `company/${buildTaskSlug(label, workspaceId)}` });
      if (pf.ok) {
        const base = await worktrees.resolveBase(pf.plan.repoRoot);
        if (base.error) return await fail(base.error);
        const wt = await worktrees.createWorktree(pf.plan, base.oid);
        if (!wt.ok) return await fail(wt.error);
        made = { repoRoot: pf.plan.repoRoot, repoHash: pf.plan.repoHash, path: wt.worktreePath, branch: wt.branch, oid: wt.branchOid, metaDir: pf.plan.metaDir };
        writeSeatStamp(pf.plan.metaDir, {
          v: 1, workspaceId, company: r.company.trim(), label, branch: wt.branch,
          ...(wt.branchOid ? { baseOid: wt.branchOid } : {}), createdAt: now(),
        });
      } else if (shared) {
        return await fail(pf.error);
      }
    }
    // Beside a preset's seat briefs when the company came from one; a hire
    // never replaces a file there.
    const folder = path.join(deps.dir ?? getWmuxDir(), 'company-briefs', workspaceId);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `hire-${label.replace(/[^A-Za-z0-9_-]+/g, '-')}-${now()}.md`);
    const seats = [
      { label: r.ceo.label.trim(), owns: '' },
      ...staff.map((s) => ({ label: s.label.trim(), owns: s.owns })),
      { label, owns: seat.owns, ...(made ? { worktree: { path: made.path, branch: made.branch } } : {}) },
    ];
    fs.writeFileSync(file, seatBrief({
      company: r.company.trim(), mission: r.mission, standingOrders: r.standingOrders, seats, ceo: 0, seat: seats.length - 1,
    }), { encoding: 'utf8', flag: 'wx' });
    // As a remote start's pane: the agent was asked for here, so it does not
    // stop on the first-run screens in a folder wmux just made.
    const env = firstRunEnvForAgent(agentLauncherStem(row), deps.env);
    return {
      ok: true,
      label,
      command: buildInitialCommand(agentLauncherStem(row), file, deps.platform),
      cwd: made?.path ?? r.folder ?? null,
      ...(made ? { branch: made.branch } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  } catch (err) {
    return await fail(`could not add the seat: ${err instanceof Error ? err.message : String(err)}`);
  }
}
