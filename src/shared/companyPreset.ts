// Company presets: one pick makes a company workspace with a pane per seat,
// each seat named, given what it owns and started with its agent, the CEO
// seat set, and every agent told its seat on its first turn. Pure, so the
// renderer (the dialog and the store) and main (the brief files) share it.

import { COMPANY_BRIEF_KIND, BRIEF_FIELDS } from './company';
import { createLeafPane, PANE_METADATA_LABEL_MAX, type Pane, type PaneLeaf } from './types';
import { createBranchPane } from './layoutPresets';
import { normalizePaneLabel, paneLabelShapeError } from './paneLabelRules';
import type { AgentSlug } from './agentIdentity';

export interface CompanyPresetSeat {
  /** The pane name (#tag) and title: pane-label rules, no spaces. */
  label: string;
  /** What the seat owns, free text; empty when the company decides. */
  owns: string;
  /** The agent the seat starts; undefined leaves a plain shell. */
  agent?: AgentSlug;
}

export interface CompanyPreset {
  id: string;
  /** Index into `seats` of the CEO seat. */
  ceo: number;
  seats: CompanyPresetSeat[];
  standingOrders: string;
}

/** What the store needs to make a company workspace from a preset: every
 *  seat's final name, what it owns and its launch line (null: a plain shell). */
export interface CompanyWorkspaceInput {
  id: string;
  name: string;
  /** Absolute folder every seat starts in; the usual start folder when absent. */
  cwd?: string;
  mission?: string;
  standingOrders?: string;
  ceo: number;
  /** `cwd`: the seat's own worktree; absent, the seat starts in `cwd` above. */
  seats: { label: string; owns: string; command: string | null; cwd?: string }[];
}

/** Seats a preset may hold: the CEO and up to five more. */
export const COMPANY_PRESET_MAX_SEATS = 6;

/** The built-in presets. Names and descriptions are i18n keys
 *  (`companyPreset.<id>.name` / `.description`). */
export const BUILTIN_COMPANY_PRESETS: readonly CompanyPreset[] = [
  {
    id: 'researcher-devs',
    ceo: 0,
    seats: [
      { label: 'ceo', owns: 'Plans and hands out the work', agent: 'claude' },
      { label: 'researcher', owns: 'Research', agent: 'claude' },
      { label: 'dev-1', owns: '', agent: 'claude' },
      { label: 'dev-2', owns: '', agent: 'claude' },
      { label: 'dev-3', owns: '', agent: 'claude' },
    ],
    standingOrders: 'The CEO plans, hands out the work and checks the results, and writes no code. The researcher investigates; developers build and report back with test output.',
  },
  {
    id: 'lead-reviewer',
    ceo: 0,
    seats: [
      { label: 'lead', owns: 'Plan and merges', agent: 'claude' },
      { label: 'builder', owns: '', agent: 'claude' },
      { label: 'reviewer', owns: 'Reviews', agent: 'codex' },
    ],
    standingOrders: 'Every change gets a review from the reviewer before it merges.',
  },
];

/**
 * The pane tree for `count` seats: `leaves[0]` on the left at half the width,
 * for the CEO (its board tab opens there), the other leaves stacked top to
 * bottom on the right. One seat is a single pane.
 */
export function companyPresetTree(count: number): { root: Pane; leaves: PaneLeaf[] } {
  const leaves = Array.from({ length: Math.max(1, count) }, () => createLeafPane());
  if (leaves.length === 1) return { root: leaves[0], leaves };
  const staff = leaves.slice(1);
  const right = staff.length === 1
    ? staff[0]
    : createBranchPane('vertical', staff, staff.map(() => 100 / staff.length));
  return { root: createBranchPane('horizontal', [leaves[0], right], [50, 50]), leaves };
}

/** A seat name leaves room for the `-<n>` a taken name gets. */
export const SEAT_LABEL_MAX = PANE_METADATA_LABEL_MAX - 4;

/**
 * The seat labels as panes will carry them: a label another pane already
 * uses (or an earlier seat took) gets the first free `-2`, `-3`… suffix, so a
 * second company from the same preset does not collide on `#researcher`.
 * companySeatsError keeps out a name whose suffixed form is not a pane label.
 */
export function freeSeatLabels(labels: readonly string[], taken: Iterable<string>): string[] {
  const used = new Set([...taken].map(normalizePaneLabel));
  return labels.map((label) => {
    let next = label;
    for (let n = 2; used.has(normalizePaneLabel(next)); n += 1) next = `${label}-${n}`;
    used.add(normalizePaneLabel(next));
    return next;
  });
}

/**
 * The seats that work in a worktree of their own: every seat but the CEO that
 * starts an agent. Agents sharing one checkout overwrite each other's
 * changes; the CEO plans and checks and works in the folder itself.
 */
export function ownWorktreeSeats(seats: readonly { agent?: string }[], ceo: number): number[] {
  return seats.flatMap((seat, i) => (i !== ceo && seat.agent ? [i] : []));
}

/** Why the seats cannot be made, or null: a missing or bad label, two seats
 *  with one name, too many seats, or no CEO seat. `made`: the labels are the
 *  final ones from freeSeatLabels, so a suffix may already be on them. */
export function companySeatsError(seats: readonly CompanyPresetSeat[], ceo: number, opts: { made?: boolean } = {}): string | null {
  if (seats.length === 0 || seats.length > COMPANY_PRESET_MAX_SEATS) return 'seat-count';
  if (!Number.isInteger(ceo) || ceo < 0 || ceo >= seats.length) return 'ceo';
  const seen = new Set<string>();
  const max = opts.made ? PANE_METADATA_LABEL_MAX : SEAT_LABEL_MAX;
  for (const seat of seats) {
    const label = seat.label.trim();
    // `w1` would become `w1-2` once taken, which reads as a pane's own coordinate.
    if (!label || label.length > max || paneLabelShapeError(label) || (!opts.made && paneLabelShapeError(`${label}-2`))) return 'label';
    if (seen.has(normalizePaneLabel(label))) return 'duplicate';
    seen.add(normalizePaneLabel(label));
  }
  return null;
}

export interface SeatBriefInput {
  company: string;
  mission?: string;
  standingOrders?: string;
  /** Every seat as made (labels after suffixing), CEO included, with the
   *  worktree and branch of a seat that has its own. */
  seats: readonly { label: string; owns: string; worktree?: { path: string; branch: string } }[];
  ceo: number;
  /** The seat this brief is for. */
  seat: number;
}

/**
 * The first message a seat's agent gets: who it is, what it owns, the
 * mission and standing orders, and how work moves. The CEO also gets the
 * other seats and the shape of a brief, which wmux requires on every task it
 * sends to a staff seat (shared/company.ts decideCompanySend). A seat reports
 * with input-required and only the CEO or the owner marks the task done
 * (companyDoneRefusal); both briefs say so.
 */
export function seatBrief(input: SeatBriefInput): string {
  const me = input.seats[input.seat];
  const ceo = input.seats[input.ceo];
  const lines: string[] = [];
  const owns = me.owns.trim();
  if (input.seat === input.ceo) {
    lines.push(`You are #${me.label}, the CEO of the company "${input.company}" in wmux.`);
    if (owns) lines.push(`You own: ${owns}.`);
  } else {
    lines.push(`You are #${me.label} in the company "${input.company}" in wmux. Your CEO is #${ceo.label}.`);
    if (owns) lines.push(`You own: ${owns}.`);
  }
  if (input.mission?.trim()) lines.push(`Mission: ${input.mission.trim()}`);
  if (input.standingOrders?.trim()) lines.push(`Standing orders: ${input.standingOrders.trim()}`);
  if (input.seat === input.ceo) {
    const staff = input.seats.filter((_, i) => i !== input.ceo).map((s) => {
      const notes = [s.owns.trim() && `owns ${s.owns.trim()}`, s.worktree && `branch ${s.worktree.branch}`].filter(Boolean);
      return notes.length > 0 ? `#${s.label} (${notes.join('; ')})` : `#${s.label}`;
    });
    if (staff.length > 0) {
      lines.push('You run the company: plan the work, hand it to your seats and check what comes back. Do not do a seat\'s work yourself.');
      lines.push(`Your seats: ${staff.join(', ')}.`);
      lines.push(
        `Hand work to a seat with the wmux send_message tool, to its #name, with a brief in data: ` +
        `{"kind":"${COMPANY_BRIEF_KIND}","v":1,${BRIEF_FIELDS.map((f) => `"${f}":"…"`).join(',')}}. ` +
        'A task to a seat without a full brief is refused. Follow the work with a2a_task_query.',
      );
      lines.push(
        'A seat reports finished work with status input-required. Read the report and check it, then mark the task done ' +
        'with a2a_task_update status completed and evidence. Only you or the owner can.',
      );
    }
    lines.push('Wait for the owner\'s first request.');
  } else {
    if (me.worktree) {
      lines.push(`Your worktree is ${me.worktree.path}, on branch ${me.worktree.branch}. Work and commit only there, and open your pull request from that branch.`);
    }
    lines.push(
      `Take briefs from #${ceo.label}. When one arrives, do the work. When it is ready, report it with a2a_task_update ` +
      'status input-required and a message naming the PR URL, its head commit, what you ran, and who ran the live check and what they saw. ' +
      `#${ceo.label} marks it done; you cannot.`,
    );
    lines.push('Wait for a brief.');
  }
  return lines.join('\n');
}
