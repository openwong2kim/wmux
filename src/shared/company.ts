// Company mode companies: the record a workspace carries, the brief a task
// to a company pane must hold, and the decisions built on them.
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
 * A workspace's place in a company. The company's own record lives on
 * its home workspace; a member workspace only names the company it joined.
 * The coordinator is a pane of the home workspace, named by its ptyId, which a
 * daemon respawn or session restore never re-mints (workspace ids can change).
 */
export type WorkspaceCompany =
  | {
      v: 1;
      kind: 'home';
      id: string;
      name: string;
      /** null while no pane is the coordinator (a vacant seat). */
      coordinatorPtyId: string | null;
      standingOrders?: string;
    }
  | { v: 1; kind: 'member'; id: string };

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
  if (raw.kind === 'member') return { v: 1, kind: 'member', id: raw.id };
  if (raw.kind !== 'home' || !nonEmptyString(raw.name)) return undefined;
  const coordinatorPtyId = nonEmptyString(raw.coordinatorPtyId) ? raw.coordinatorPtyId : null;
  return {
    v: 1,
    kind: 'home',
    id: raw.id,
    name: raw.name,
    coordinatorPtyId,
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
  company?: WorkspaceCompany;
  /** Every terminal pty in the workspace, stashed panes included. */
  ptyIds: readonly string[];
}

export interface CompanyPlacement {
  id: string;
  name: string;
  homeWorkspaceId: string;
  /** The coordinator's pty while it is still a pane of the home workspace. */
  coordinatorPtyId: string | null;
}

/**
 * The company a workspace belongs to, or null. A member whose company
 * has no home any more (the home workspace was deleted) belongs to none: the
 * company dissolved with its home.
 */
export function companyOfWorkspace(
  workspaces: readonly CompanyWorkspaceView[],
  workspaceId: string,
): CompanyPlacement | null {
  const ws = workspaces.find((w) => w.id === workspaceId);
  const dept = ws?.company;
  if (!dept) return null;
  const home = dept.kind === 'home'
    ? ws
    : workspaces.find((w) => w.company?.kind === 'home' && w.company.id === dept.id);
  if (!home || home.company?.kind !== 'home') return null;
  const seat = home.company.coordinatorPtyId;
  return {
    id: home.company.id,
    name: home.company.name,
    homeWorkspaceId: home.id,
    coordinatorPtyId: seat && home.ptyIds.includes(seat) ? seat : null,
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
 * a pane outside every company takes any task as before. A task to a
 * company pane needs a sender pane, the receiver pinned, and a complete
 * brief, and work from outside the company enters through its coordinator.
 * The human's own lane is exempt.
 */
export function decideCompanySend(input: {
  workspaces: readonly CompanyWorkspaceView[];
  targetWorkspaceId: string;
  /** The receiver pane's pty, or null when no single pane was resolved. */
  targetPtyId: string | null;
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
  if (!input.targetPtyId) {
    return { kind: 'refuse', error: `a task to a pane in ${where} must name that pane (pane_id)` };
  }
  const senderWs = workspaceOwningPty(input.workspaces, input.senderPtyId);
  if (!senderWs) {
    return { kind: 'refuse', error: `wmux cannot tie the caller to a pane, and a task to ${where} needs one` };
  }
  const missing = missingBriefFields(input.data);
  if (missing.length > 0) {
    return {
      kind: 'refuse',
      error: `a task to ${where} needs a brief in data ({"kind":"${COMPANY_BRIEF_KIND}","v":1,…}); missing: ${missing.join(', ')}`,
    };
  }
  const sender = companyOfWorkspace(input.workspaces, senderWs);
  if (sender?.id === target.id) return { kind: 'allow', companyTask: true };
  if (target.coordinatorPtyId && input.targetPtyId === target.coordinatorPtyId) {
    return { kind: 'allow', companyTask: true };
  }
  return {
    kind: 'refuse',
    error: target.coordinatorPtyId
      ? `${where} takes work from outside through its coordinator; send it there`
      : `${where} takes work from outside through its coordinator, and it has none right now`,
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
