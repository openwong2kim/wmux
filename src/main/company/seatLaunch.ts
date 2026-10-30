// The launch line of each seat a company preset makes. A seat's first turn is
// its brief (shared/companyPreset.ts seatBrief), so the brief is written to a
// file and the agent starts with that file as its first prompt, the way a
// fan-out worker does: the text never passes through a shell's quoting, and
// pty.create reshapes the line for a WSL or cmd pane.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { agentLauncherStem, agentRow, isAgentSlug } from '../../shared/agentIdentity';
import { paneLabelShapeError } from '../../shared/paneLabelRules';
import { buildInitialCommand } from '../worktask/FanOutService';

/** A brief is a few paragraphs; anything longer is not one. */
export const SEAT_BRIEF_MAX_BYTES = 16 * 1024;

const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export interface SeatLaunchRequest {
  workspaceId: string;
  seats: { label: string; agent?: string; brief?: string }[];
}

export type SeatLaunchResult =
  | { ok: true; commands: (string | null)[] }
  | { ok: false; error: string };

/**
 * One launch line per seat, in order: null for a seat with no agent, the bare
 * launcher for one with no brief, and otherwise the launcher with the brief
 * file as its first prompt. The files go under
 * `<wmux data dir>/company-briefs/<workspaceId>/<label>.md`. Nothing is
 * written unless every seat is valid.
 */
export function seatLaunches(
  req: unknown,
  opts: { dir?: string; platform?: NodeJS.Platform; writeFile?: (file: string, text: string) => void } = {},
): SeatLaunchResult {
  if (!req || typeof req !== 'object') return { ok: false, error: 'bad request' };
  const { workspaceId, seats } = req as Partial<SeatLaunchRequest>;
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) return { ok: false, error: 'bad workspace id' };
  if (!Array.isArray(seats) || seats.length === 0 || seats.length > 16) return { ok: false, error: 'bad seats' };
  for (const seat of seats) {
    if (!seat || typeof seat.label !== 'string' || !seat.label || paneLabelShapeError(seat.label)) return { ok: false, error: 'bad seat label' };
    if (seat.agent !== undefined && !isAgentSlug(seat.agent)) return { ok: false, error: `unknown agent ${String(seat.agent)}` };
    if (seat.brief !== undefined && (typeof seat.brief !== 'string' || Buffer.byteLength(seat.brief, 'utf8') > SEAT_BRIEF_MAX_BYTES)) {
      return { ok: false, error: 'bad brief' };
    }
  }
  const folder = path.join(opts.dir ?? getWmuxDir(), 'company-briefs', workspaceId);
  const writeFile = opts.writeFile ?? ((file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  });
  const commands = seats.map((seat) => {
    const row = seat.agent ? agentRow(seat.agent) : undefined;
    if (!row) return null;
    const launcher = agentLauncherStem(row);
    if (!seat.brief?.trim()) return launcher;
    const file = path.join(folder, `${seat.label}.md`);
    writeFile(file, seat.brief);
    return buildInitialCommand(launcher, file, opts.platform);
  });
  return { ok: true, commands };
}
