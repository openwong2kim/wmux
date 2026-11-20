import type { BrowserPolicyStore } from './BrowserPolicyStore';
import type { CallerIdentity } from './CdpPipeMux';
import type { ChromePaneBindings } from '../../shared/chromePaneBinding';
import type { WorkspaceListEntry } from '../../shared/workspaceMirror';
import type { WorkspaceMirror } from '../workspace/WorkspaceMirror';

// ---------------------------------------------------------------------------
// When main ends relay clients (CdpPipeRelay.closeClients): each time what a
// client's grant was minted on stops holding. Every trigger is an event main
// already receives; nothing here polls.
//  (a) the browser policy epoch moves: on every lane, a client whose epoch is
//      not its profile's current one (the epoch is one counter for the whole
//      policy file, so any change ends every protected profile's clients);
//  (b) a pane closes or moves to another workspace: that pane's pane-script
//      clients;
//  (c) a workspace closes: every client of that workspace, on every lane;
//  (d) the user holds a surface (Stop or Take over): the pane-script clients
//      of the surface's workspace, or every pane-script client when main
//      cannot say which workspace the surface is in;
//  (e) a pane's claim is revoked, retired or minted anew: that pane's
//      pane-script clients.
// ---------------------------------------------------------------------------

export interface RelayClientTriggerDeps {
  /** CdpPipeRelay.closeClients, through the relay that serves every piped Chrome. */
  closeClients: (match: (identity: CallerIdentity) => boolean, reason: string) => number;
  /** (a) The browser policy: its change event, its epoch, and whether a profile runs protected. */
  policy: Pick<BrowserPolicyStore, 'onChange' | 'epoch' | 'profileDecision'>;
  /** (a) paneId → its exclusive Chrome profile (ChromeProfileStore), for profileDecision. */
  paneBindings: () => ChromePaneBindings;
  /** (b), (c) The renderer's workspace tree, pushed on every structural change. */
  mirror: Pick<WorkspaceMirror, 'onSnapshot' | 'getEntries'>;
  /** (d) The workspace a surface lives in, or undefined when main cannot say. */
  surfaceWorkspace: (surfaceId: string) => string | undefined;
  /** (e) Pane claim revocations and new pane claims, by pane (workspaceClaimTrust.onPaneClaimChange). */
  onPaneClaimChange: (listener: (ptyId: string) => void) => () => void;
}

export interface RelayClientTriggers {
  /** (d) A user hold landed on `surfaceId` (BrowserAgentControl's cancelInFlight). */
  userHold(surfaceId: string): void;
  dispose(): void;
}

/** Where every workspace and pane was, by one push of the tree. */
interface Layout {
  readonly workspaces: ReadonlySet<string>;
  /** ptyId → the workspace it is in. */
  readonly panes: ReadonlyMap<string, string>;
}

function layoutOf(entries: readonly WorkspaceListEntry[] | null): Layout | null {
  if (entries === null) return null;
  const workspaces = new Set<string>();
  const panes = new Map<string, string>();
  for (const entry of entries) {
    workspaces.add(entry.id);
    for (const ptyId of entry.ptyIds ?? []) panes.set(ptyId, entry.id);
    if (entry.activePtyId) panes.set(entry.activePtyId, entry.id);
  }
  return { workspaces, panes };
}

const paneScript = (identity: CallerIdentity): boolean => identity.lane === 'pane-script';

export function wireRelayClientTriggers(deps: RelayClientTriggerDeps): RelayClientTriggers {
  const { closeClients } = deps;

  // (a) The epoch a client of `profile` carries while it is current: the
  // policy's, on a protected profile; none on any other. A client minted before
  // its profile became protected carries none, so it goes too.
  const lookup = { paneBindings: deps.paneBindings };
  const currentEpoch = (profile: string | undefined): number | undefined =>
    profile !== undefined && deps.policy.profileDecision(profile, lookup).kind === 'protected' ? deps.policy.epoch() : undefined;
  const offPolicy = deps.policy.onChange(() => {
    closeClients((id) => id.protectedEpoch !== currentEpoch(id.profile), 'browser policy changed');
  });

  // (b), (c): what was in the last push and is gone or elsewhere in this one.
  // Only what an earlier push showed counts: a pane or workspace this push is
  // the first to show is new, not moved. An empty push is taken as it says.
  let last = layoutOf(deps.mirror.getEntries());
  const offLayout = deps.mirror.onSnapshot(() => {
    const next = layoutOf(deps.mirror.getEntries());
    if (next === null) return;
    const prev = last;
    last = next;
    if (prev === null) return;
    const goneWorkspaces = new Set([...prev.workspaces].filter((id) => !next.workspaces.has(id)));
    if (goneWorkspaces.size > 0) {
      closeClients((id) => id.workspaceId !== undefined && goneWorkspaces.has(id.workspaceId), 'workspace closed');
    }
    const leftPanes = new Set([...prev.panes].filter(([ptyId, workspaceId]) => next.panes.get(ptyId) !== workspaceId).map(([ptyId]) => ptyId));
    if (leftPanes.size > 0) {
      closeClients((id) => paneScript(id) && id.ptyId !== undefined && leftPanes.has(id.ptyId), 'pane closed or moved');
    }
  });

  // (e)
  const offClaims = deps.onPaneClaimChange((ptyId) => {
    closeClients((id) => paneScript(id) && id.ptyId === ptyId, 'pane claim changed');
  });

  return {
    userHold(surfaceId) {
      const workspaceId = deps.surfaceWorkspace(surfaceId);
      closeClients((id) => paneScript(id) && (workspaceId === undefined || id.workspaceId === workspaceId), 'user hold on a browser surface');
    },
    dispose() {
      offPolicy();
      offLayout();
      offClaims();
    },
  };
}
