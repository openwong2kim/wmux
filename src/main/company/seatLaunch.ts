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
import { companySeatsError, freeSeatLabels, ownWorktreeSeats, seatBrief } from '../../shared/companyPreset';
import { ensureSecretHook } from '../git/secretHookHost';
import { metadataStore } from '../metadata/MetadataStore';
import { buildInitialCommand } from '../worktask/FanOutService';
import { buildTaskSlug, TaskWorktreeManager } from '../worktask/TaskWorktreeManager';

// Not dots alone: `.` or `..` would name the briefs root or the data folder.
const WORKSPACE_ID_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,80}$/;
const FOLDER_MAX = 4096;
const TEXT_MAX = { company: 200, owns: 200, mission: 2000, standingOrders: 8000 } as const;
/** Brief folders older than this are removed when the next company is made. */
export const SEAT_BRIEF_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface SeatLaunchDeps {
  dir?: string;
  platform?: NodeJS.Platform;
  /** Every label a pane carries now. */
  takenLabels?: () => Iterable<string>;
  now?: () => number;
  worktrees?: TaskWorktreeManager;
}

// Not the fan-out root: a folder there with no open task reads as a leftover
// to the worktree scan.
let companyWorktrees: TaskWorktreeManager | undefined;
function seatWorktrees(): TaskWorktreeManager {
  companyWorktrees ??= new TaskWorktreeManager({ onCreated: ensureSecretHook, worktreesRoot: path.join(getWmuxHomeDir(), 'company-worktrees') });
  return companyWorktrees;
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

function labelsInUse(): string[] {
  return metadataStore.snapshot().entries.flatMap((e) => (e.metadata.label ? [e.metadata.label] : []));
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
 * `<wmux data dir>/company-briefs/<workspaceId>/seat-<n>.md`. A failure
 * removes the worktrees and briefs already made.
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
  const created: { repoRoot: string; repoHash: string; path: string; branch: string; oid?: string }[] = [];
  let madeFolder = false;
  const undo = async () => {
    for (const w of created.reverse()) {
      await worktrees.removeWorktree(w.repoRoot, w.repoHash, w.path, undefined, { force: true });
      if (w.oid) await worktrees.deleteBranchIfAt(w.repoRoot, w.repoHash, w.branch, w.oid);
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
        created.push({ repoRoot: pf.plan.repoRoot, repoHash: pf.plan.repoHash, path: wt.worktreePath, branch: wt.branch, oid: wt.branchOid });
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
