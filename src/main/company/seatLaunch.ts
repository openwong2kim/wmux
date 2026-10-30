// The seats a company preset makes, settled in main: each seat's final pane
// name and its launch line. Main holds every pane label (MetadataStore), so it
// is the one place a name can be checked free before the agents are told it.
// A seat's first turn is its brief (shared/companyPreset.ts seatBrief): the
// brief is written to a file and the agent starts with that file as its first
// prompt, the way a fan-out worker does, so the text never passes through a
// shell's quoting, and pty.create reshapes the line for a WSL or cmd pane.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { agentLauncherStem, agentRow, isAgentSlug } from '../../shared/agentIdentity';
import { companySeatsError, freeSeatLabels, seatBrief } from '../../shared/companyPreset';
import { metadataStore } from '../metadata/MetadataStore';
import { buildInitialCommand } from '../worktask/FanOutService';

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
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
  seats: { label: string; owns: string; agent?: string }[];
}

export type SeatLaunchResult =
  | { ok: true; labels: string[]; commands: (string | null)[] }
  | { ok: false; error: string };

export interface SeatLaunchDeps {
  dir?: string;
  platform?: NodeJS.Platform;
  /** Every label a pane carries now. */
  takenLabels?: () => Iterable<string>;
  now?: () => number;
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
 * Each seat's final name (a name another pane carries gets `-2`, `-3`…) and
 * its launch line: null for a seat with no agent, the bare launcher when the
 * seats are not told, and otherwise the launcher with the seat's brief file
 * as its first prompt. The briefs name the final labels. Files are
 * `<wmux data dir>/company-briefs/<workspaceId>/seat-<n>.md`.
 */
export function seatLaunches(req: unknown, deps: SeatLaunchDeps = {}): SeatLaunchResult {
  if (!req || typeof req !== 'object') return { ok: false, error: 'bad request' };
  const r = req as Partial<SeatLaunchRequest>;
  if (typeof r.workspaceId !== 'string' || !WORKSPACE_ID_RE.test(r.workspaceId)) return { ok: false, error: 'bad workspace id' };
  if (!isText(r.company, TEXT_MAX.company) || !r.company.trim()) return { ok: false, error: 'bad company name' };
  if (r.mission !== undefined && !isText(r.mission, TEXT_MAX.mission)) return { ok: false, error: 'bad mission' };
  if (r.standingOrders !== undefined && !isText(r.standingOrders, TEXT_MAX.standingOrders)) return { ok: false, error: 'bad standing orders' };
  if (!Array.isArray(r.seats) || typeof r.ceo !== 'number') return { ok: false, error: 'bad seats' };
  const seats = r.seats;
  for (const seat of seats) {
    if (!seat || typeof seat.label !== 'string' || !isText(seat.owns, TEXT_MAX.owns)) return { ok: false, error: 'bad seats' };
    if (seat.agent !== undefined && !isAgentSlug(seat.agent)) return { ok: false, error: `unknown agent ${String(seat.agent)}` };
  }
  const trimmed = seats.map((s) => ({ label: s.label.trim(), owns: s.owns.trim() }));
  const invalid = companySeatsError(trimmed, r.ceo);
  if (invalid) return { ok: false, error: `seats: ${invalid}` };

  const labels = freeSeatLabels(trimmed.map((s) => s.label), (deps.takenLabels ?? labelsInUse)());
  const made = trimmed.map((s, i) => ({ label: labels[i], owns: s.owns }));
  const root = path.join(deps.dir ?? getWmuxDir(), 'company-briefs');
  const folder = path.join(root, r.workspaceId);
  pruneOldBriefs(root, (deps.now ?? Date.now)());
  try {
    const commands = seats.map((seat, i) => {
      const row = seat.agent ? agentRow(seat.agent) : undefined;
      if (!row) return null;
      const launcher = agentLauncherStem(row);
      if (r.tellSeats !== true) return launcher;
      const file = path.join(folder, `seat-${i + 1}.md`);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(file, seatBrief({
        company: r.company!.trim(), mission: r.mission, standingOrders: r.standingOrders, seats: made, ceo: r.ceo!, seat: i,
      }), 'utf8');
      return buildInitialCommand(launcher, file, deps.platform);
    });
    return { ok: true, labels, commands };
  } catch (err) {
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* left for the prune */ }
    return { ok: false, error: `could not write the briefs: ${err instanceof Error ? err.message : String(err)}` };
  }
}
