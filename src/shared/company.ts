// Company mode: a workspace becomes a company. One of its panes is the
// coordinator (shown as the CEO) and its other panes are the staff. This holds
// the record a company workspace carries, the brief a task to a staff pane
// must hold, and the decisions built on them.
//
// Shared by the renderer (which resolves the target pane and creates the task)
// and the daemon (which holds the task log), so the two can never disagree
// about who may assign, cancel or mark done company work.
//
// The scope rule is ADVISORY. Pane identity is the caller's senderPtyId, which
// a same-user process can forge (the #113 ceiling), so these checks are a brake
// on runaway agents, not a security boundary.
import type { Message, WmuxTaskMetadata } from './types';

/**
 * The record a company workspace carries; the company's name is the
 * workspace's. The coordinator is one of its panes, named by paneId: a pane
 * keeps its id across app restarts and when its agent restarts in a new tab,
 * while a pty id can be re-minted then (A2A pane links bind paneId for the
 * same reason).
 */
export interface WorkspaceCompany {
  v: 1;
  id: string;
  /** null while no pane is the coordinator (a vacant seat). */
  coordinatorPaneId: string | null;
  /** One line on what the company is for; the sidebar row shows it. */
  mission?: string;
  standingOrders?: string;
}

/** The `kind` of the DataPart that carries a company task's brief. */
export const COMPANY_BRIEF_KIND = 'wmux.company.brief';

/** The fields every brief must fill, in the order a refusal names them. */
export const BRIEF_FIELDS = ['goal', 'scope', 'acceptance', 'verify', 'report'] as const;

export interface CompanyBriefV1 {
  kind: typeof COMPANY_BRIEF_KIND;
  v: 1;
  goal: string;
  scope: string;
  acceptance: string;
  verify: string;
  report: string;
  /** Task ids this one waits on. */
  blockedBy?: string[];
  /** Reserved for delivery that retries without repeating itself. */
  deliveryKey?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * The saved company record, or undefined when the value is absent or not a
 * shape this version knows. A session from before companies, or a record a
 * hand edit broke, loads as an ordinary workspace.
 */
export function parseWorkspaceCompany(raw: unknown): WorkspaceCompany | undefined {
  if (!isRecord(raw) || raw.v !== 1 || !nonEmptyString(raw.id)) return undefined;
  const seat = raw.coordinatorPaneId;
  if (seat !== null && !nonEmptyString(seat)) return undefined;
  return {
    v: 1,
    id: raw.id,
    coordinatorPaneId: seat,
    ...(typeof raw.mission === 'string' && raw.mission ? { mission: raw.mission } : {}),
    ...(typeof raw.standingOrders === 'string' && raw.standingOrders ? { standingOrders: raw.standingOrders } : {}),
  };
}

/**
 * The brief fields `data` leaves out or leaves empty. A value that is not a
 * version-1 brief misses every field, so the refusal names what to send.
 */
export function missingBriefFields(data: unknown): string[] {
  if (!isRecord(data) || data.kind !== COMPANY_BRIEF_KIND || data.v !== 1) return [...BRIEF_FIELDS];
  return BRIEF_FIELDS.filter((f) => !nonEmptyString(data[f]));
}

/**
 * The brief in `data` with only the fields a brief has (`blockedBy` when it
 * is a list of strings), or null when `data` is not a complete version-1
 * brief.
 */
export function companyBriefOf(data: unknown): CompanyBriefV1 | null {
  if (!isRecord(data) || missingBriefFields(data).length > 0) return null;
  const blockedBy = data.blockedBy;
  return {
    kind: COMPANY_BRIEF_KIND,
    v: 1,
    goal: data.goal as string,
    scope: data.scope as string,
    acceptance: data.acceptance as string,
    verify: data.verify as string,
    report: data.report as string,
    ...(Array.isArray(blockedBy) && blockedBy.every((b) => typeof b === 'string') ? { blockedBy: [...blockedBy] as string[] } : {}),
  };
}

const BRIEF_HEADINGS: Record<(typeof BRIEF_FIELDS)[number], string> = {
  goal: 'Goal',
  scope: 'Scope',
  acceptance: 'Acceptance',
  verify: 'Verify',
  report: 'Report',
};

/** How a seat on another PC finishes a company task: it has no CEO there to report to. */
export const REMOTE_SEAT_FINISH_LINE = 'When it is done, finish this task as completed with evidence: the PR URL, '
  + 'its head commit, what you ran and who ran the live check. The CEO checks it and marks it done on its PC.';

/**
 * The text a company task to another PC carries: the CEO's message, the
 * brief's five fields each under its name, and how a seat there finishes.
 * That PC gets plain text; the brief itself stays on this PC.
 */
export function renderRemoteBrief(message: string, brief: CompanyBriefV1): string {
  const fields = BRIEF_FIELDS.map((f) => `${BRIEF_HEADINGS[f]}:\n${brief[f].trim()}`);
  return [message.trim(), ...fields, REMOTE_SEAT_FINISH_LINE].join('\n\n');
}

/** What a seat on another PC is told when it starts. */
export interface RemoteSeatIntroInput {
  /** The seat's name: the label the ask gives its link here. */
  name: string;
  company: string;
  mission?: string;
  owns?: string;
  /** The CEO pane's name on this PC. */
  ceo: string;
  standingOrders?: string;
}

/**
 * The first message a seat on another PC gets, sent with the ask that starts
 * it: who it is and for which company, what it owns, who its CEO is, that
 * briefs come as tasks with the five brief fields, how it finishes one
 * (REMOTE_SEAT_FINISH_LINE), and the standing orders. It holds no brief, and
 * no PC names: the send masks a host name such as `name.local`.
 */
export function remoteSeatIntro(input: RemoteSeatIntroInput): string {
  const mission = input.mission?.trim();
  const owns = input.owns?.trim().replace(/\.+$/, '');
  const orders = input.standingOrders?.trim();
  const headings = BRIEF_FIELDS.map((f) => BRIEF_HEADINGS[f]);
  const lines = [
    `You are ${input.name.trim()}, a seat of the company "${input.company.trim()}"${mission ? ` (mission: ${mission})` : ''}.`,
  ];
  if (owns) lines.push(`You own: ${owns}.`);
  lines.push(
    `Your CEO is ${input.ceo.trim()} on the PC that started you; its briefs come here as tasks with `
    + `${headings.slice(0, -1).join(', ')} and ${headings[headings.length - 1]}.`,
  );
  lines.push(`Each brief ends with how to finish it: ${REMOTE_SEAT_FINISH_LINE}`);
  if (orders) lines.push(`Standing orders: ${orders}`);
  lines.push('Wait for a brief.');
  return lines.join('\n');
}

/** True when the task's first message carries a brief: a company task. */
export function isCompanyTask(history: readonly Message[]): boolean {
  const first = history[0];
  if (!first) return false;
  return first.parts.some((p) => p.kind === 'data' && isRecord(p.data) && p.data.kind === COMPANY_BRIEF_KIND);
}

/** What the decisions need to know about one workspace. */
export interface CompanyWorkspaceView {
  id: string;
  name: string;
  company?: WorkspaceCompany;
  /** Every leaf pane in the workspace, stashed panes included. */
  paneIds: readonly string[];
  /** Every terminal pty in the workspace, stashed panes included. */
  ptyIds: readonly string[];
}

export interface CompanyPlacement {
  id: string;
  name: string;
  workspaceId: string;
  /** The coordinator's pane while it is still a pane of the workspace. */
  coordinatorPaneId: string | null;
}

/** The company a workspace is, or null. */
export function companyOfWorkspace(
  workspaces: readonly CompanyWorkspaceView[],
  workspaceId: string,
): CompanyPlacement | null {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws?.company) return null;
  const seat = ws.company.coordinatorPaneId;
  return {
    id: ws.company.id,
    name: ws.name,
    workspaceId: ws.id,
    coordinatorPaneId: seat && ws.paneIds.includes(seat) ? seat : null,
  };
}

/** The workspace whose panes hold `ptyId`, or null. */
export function workspaceOwningPty(
  workspaces: readonly CompanyWorkspaceView[],
  ptyId: string,
): string | null {
  if (!ptyId) return null;
  return workspaces.find((w) => w.ptyIds.includes(ptyId))?.id ?? null;
}

export type CompanySendDecision =
  | { kind: 'allow'; companyTask: boolean }
  | { kind: 'refuse'; error: string };

/**
 * May this new task go to the resolved receiver pane? Keyed on the receiver:
 * a pane outside every company takes any task as before. A task to a company
 * pane needs a sender pane and the receiver pinned, and runs in that pane
 * (never as a background execute worker). The coordinator takes a request
 * from anyone, brief or not, since it writes the briefs; any other pane of
 * the company takes a complete brief, and only from inside the company. The
 * human's own lane is exempt.
 */
export function decideCompanySend(input: {
  workspaces: readonly CompanyWorkspaceView[];
  targetWorkspaceId: string;
  /** The receiver pane, or null when no single pane was resolved. */
  targetPaneId: string | null;
  /** The caller's own pty, already checked against its pane tree ('' if none). */
  senderPtyId: string;
  operator: boolean;
  /** The send asked for a background worker (execute: true). */
  execute?: boolean;
  data: unknown;
}): CompanySendDecision {
  const target = companyOfWorkspace(input.workspaces, input.targetWorkspaceId);
  if (!target) return { kind: 'allow', companyTask: false };
  const hasBrief = missingBriefFields(input.data).length === 0;
  if (input.operator) return { kind: 'allow', companyTask: hasBrief };
  const where = `company "${target.name}"`;
  // A background worker would be the seat that marks the work done.
  if (input.execute) {
    return { kind: 'refuse', error: `a task to a pane in ${where} runs in that pane's own agent; send it without execute` };
  }
  if (!input.targetPaneId) {
    return { kind: 'refuse', error: `a task to a pane in ${where} must name that pane (pane_id)` };
  }
  const senderWs = workspaceOwningPty(input.workspaces, input.senderPtyId);
  if (!senderWs) {
    return { kind: 'refuse', error: `wmux cannot tie the caller to a pane, and a task to ${where} needs one` };
  }
  if (input.targetPaneId === target.coordinatorPaneId) return { kind: 'allow', companyTask: hasBrief };
  const missing = missingBriefFields(input.data);
  if (missing.length > 0) {
    return {
      kind: 'refuse',
      error: `a task to a staff pane in ${where} needs a brief in data ({"kind":"${COMPANY_BRIEF_KIND}","v":1,…}); missing: ${missing.join(', ')}`,
    };
  }
  if (senderWs === target.workspaceId) return { kind: 'allow', companyTask: true };
  return {
    kind: 'refuse',
    error: target.coordinatorPaneId
      ? `${where} takes work from outside through its coordinator pane; send it there`
      : `${where} takes work from outside through its coordinator pane, and it has none right now`,
  };
}

/**
 * Why this caller may not cancel the task, or null when it may. A company
 * task is canceled by the pane that created it (or the human); the receiver
 * ends it as failed, with evidence, instead.
 */
export function companyCancelRefusal(
  task: { history: readonly Message[]; metadata: Pick<WmuxTaskMetadata, 'from'> },
  caller: { workspaceId: string; paneId: string | undefined; trusted: boolean },
): string | null {
  if (caller.trusted || !isCompanyTask(task.history)) return null;
  const from = task.metadata.from;
  if (from.workspaceId === caller.workspaceId && !!from.paneId && caller.paneId === from.paneId) return null;
  return 'only the pane that created this company task can cancel it; the receiver reports failed with evidence instead';
}

/** A pane's place in its workspace's company: the coordinator, or staff. */
export type CompanySeat = 'coordinator' | 'staff';

export function parseCompanySeat(v: unknown): CompanySeat | undefined {
  return v === 'coordinator' || v === 'staff' ? v : undefined;
}

/** The pane's seat in the company, or undefined when there is no company. */
export function companySeatOf(company: WorkspaceCompany | undefined, paneId: string | undefined): CompanySeat | undefined {
  if (!company || !paneId) return undefined;
  return company.coordinatorPaneId === paneId ? 'coordinator' : 'staff';
}

/**
 * Why this caller may not mark the task completed, or null when it may. A
 * company task is marked done by the company's coordinator pane (the CEO) or
 * the human, never by the staff seat that did the work: that seat reports
 * with input-required and the coordinator checks the report. A receiver in no
 * company (a brief sent outside one, or to another PC) has no CEO to report
 * to and finishes the task itself. `failed` stays the receiver's.
 */
export function companyDoneRefusal(
  task: { history: readonly Message[] },
  caller: { trusted: boolean; seat: CompanySeat | undefined },
): string | null {
  if (caller.trusted || caller.seat !== 'staff' || !isCompanyTask(task.history)) return null;
  return 'a company task is marked done by the company\'s coordinator (CEO) pane or the human, not by the seat that did the work; '
    + 'report it with status input-required and a message naming the PR URL, its head commit, what was run and who ran the live check';
}
