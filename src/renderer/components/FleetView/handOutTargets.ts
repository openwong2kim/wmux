// Where the app can hand a To hand out item (HandOutPickTarget): an agent
// pane on this PC, a new worktree of a workspace whose folder holds the
// item's, or a company whose folder holds it (its CEO briefs a seat). Pure,
// so the order and the rules are tested without a store.
import { folderWithin, type HandOutItem } from '../../../shared/handOut';
import type { HandoffTarget } from '../../../shared/gitHandoff';
import type { FleetSection } from '../../stores/selectors/fleet';

export interface HandOutPaneCandidate {
  target: HandoffTarget;
  /** `#label`, else the pane's coordinate tag. */
  name: string;
  workspaceName: string;
  /** The pane's working folder, when known. */
  folder?: string;
  /** Its Fleet section. A pane that needs you is busy with you, so it is not offered. */
  section?: FleetSection;
  idleForMs?: number;
}

export interface HandOutWorkspaceCandidate {
  workspaceId: string;
  name: string;
  /** The folder the workspace stands for. */
  folder?: string;
  /** A company: its folder, its coordinator pane, and that pane as a target
   *  while an agent runs there and it is not stashed. */
  company?: { folder?: string; coordinatorPaneId?: string; ceo?: HandoffTarget };
}

export interface HandOutPaneOption extends HandOutPaneCandidate {
  kind: 'pane';
  key: string;
  /** Mid-turn: it gets the item after its turn. */
  running: boolean;
  /** The pane works in the item's folder or inside it. */
  thisFolder: boolean;
  /** The item asks for another agent: still offered, dimmed. */
  otherAgent: boolean;
}

export interface HandOutWorktreeOption {
  kind: 'worktree';
  key: string;
  workspaceId: string;
  folder: string;
}

export interface HandOutCompanyOption {
  kind: 'company';
  key: string;
  workspaceId: string;
  name: string;
  /** The CEO pane. */
  target: HandoffTarget;
}

export type HandOutOption = HandOutPaneOption | HandOutWorktreeOption | HandOutCompanyOption;

export interface HandOutTargets {
  panes: HandOutPaneOption[];
  /** A new worktree of the workspace whose folder holds the item's most closely. */
  worktree: HandOutWorktreeOption | null;
  companies: HandOutCompanyOption[];
}

const paneId = (t: Pick<HandoffTarget, 'workspaceId' | 'paneId'>) => `${t.workspaceId}\n${t.paneId}`;

/**
 * The targets for an item. Panes: those that run the item's agent (or any,
 * when it asks for none) first, the others dimmed after them; in each, idle
 * ones before running ones, and those working in the item's folder first.
 * A company's CEO pane is offered as its company, not as a pane.
 */
export function handOutTargets(
  item: Pick<HandOutItem, 'folder' | 'agent'>,
  panes: readonly HandOutPaneCandidate[],
  workspaces: readonly HandOutWorkspaceCandidate[],
): HandOutTargets {
  // A company's coordinator pane is offered as its company (or not at all).
  const ceos = new Set(workspaces.flatMap((ws) => [
    ...(ws.company?.coordinatorPaneId ? [paneId({ workspaceId: ws.workspaceId, paneId: ws.company.coordinatorPaneId })] : []),
    ...(ws.company?.ceo ? [paneId(ws.company.ceo)] : []),
  ]));
  const paneOptions = panes
    .filter((pane) => pane.section !== 'needsYou' && !ceos.has(paneId(pane.target)))
    .map((pane): HandOutPaneOption => ({
      ...pane,
      kind: 'pane',
      key: `pane:${pane.target.ptyId}`,
      running: pane.section === 'running',
      thisFolder: !!pane.folder && folderWithin(pane.folder, item.folder),
      otherAgent: !!item.agent && pane.target.agentSlug !== item.agent,
    }))
    .sort((a, b) => Number(a.otherAgent) - Number(b.otherAgent)
      || Number(a.running) - Number(b.running)
      || Number(b.thisFolder) - Number(a.thisFolder));

  // The closest folder wins; on a tie a plain workspace beats a company's,
  // whose work goes through its CEO.
  let worktree: HandOutWorktreeOption | null = null;
  let worktreeIsCompany = false;
  for (const ws of workspaces) {
    if (!ws.folder || !folderWithin(item.folder, ws.folder)) continue;
    const closer = !worktree || ws.folder.length > worktree.folder.length
      || (ws.folder.length === worktree.folder.length && worktreeIsCompany && !ws.company);
    if (!closer) continue;
    worktree = { kind: 'worktree', key: `worktree:${ws.workspaceId}`, workspaceId: ws.workspaceId, folder: ws.folder };
    worktreeIsCompany = !!ws.company;
  }

  const companies = workspaces.flatMap((ws): HandOutCompanyOption[] => {
    const company = ws.company;
    if (!company?.ceo || !company.folder || !folderWithin(item.folder, company.folder)) return [];
    return [{ kind: 'company', key: `company:${ws.workspaceId}`, workspaceId: ws.workspaceId, name: ws.name, target: company.ceo }];
  });

  return { panes: paneOptions, worktree, companies };
}

/** The targets in the popover's order: panes, the worktree, the companies. */
export function handOutOptions(targets: HandOutTargets): HandOutOption[] {
  return [...targets.panes, ...(targets.worktree ? [targets.worktree] : []), ...targets.companies];
}

/** The target chosen when the popover opens: the first that is not dimmed. */
export function defaultHandOutOption(options: readonly HandOutOption[]): HandOutOption | undefined {
  return options.find((option) => option.kind !== 'pane' || !option.otherAgent) ?? options[0];
}
