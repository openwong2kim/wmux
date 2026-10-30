// Company mode: a workspace becomes a company. One of its panes is the
// coordinator (shown as the CEO) and its other panes are the staff. This holds
// the record a company workspace carries, the brief a task to a staff pane
// must hold, and the decisions built on them.
//
// Shared by the renderer (which resolves the target pane and creates the task)
// and the daemon (which holds the task log), so the two can never disagree
// about who may assign or cancel company work.
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
 * pane needs a sender pane and the receiver pinned. The coordinator takes a
 * request from anyone, brief or not, since it writes the briefs; any other
 * pane of the company takes a complete brief, and only from inside the
 * company. The human's own lane is exempt.
 */
export function decideCompanySend(input: {
  workspaces: readonly CompanyWorkspaceView[];
  targetWorkspaceId: string;
  /** The receiver pane, or null when no single pane was resolved. */
  targetPaneId: string | null;
  /** The caller's own pty, already checked against its pane tree ('' if none). */
  senderPtyId: string;
  operator: boolean;
  data: unknown;
}): CompanySendDecision {
  const target = companyOfWorkspace(input.workspaces, input.targetWorkspaceId);
  if (!target) return { kind: 'allow', companyTask: false };
  const hasBrief = missingBriefFields(input.data).length === 0;
  if (input.operator) return { kind: 'allow', companyTask: hasBrief };
  const where = `company "${target.name}"`;
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
