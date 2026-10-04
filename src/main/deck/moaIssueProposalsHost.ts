// The production wiring of Moa's issue proposals lane (moaIssueProposals.ts):
// the workspace mirror, the Git page's GitHub readers, the work links, the
// decision store and the Moa settings. deck.handler owns the lifetime.

import { MoaProposalService, ProposalStore, getMoaHandoffPort } from './moaIssueProposals';
import {
  getHqWorkspaceId,
  getMoaConfig,
  hqPresence,
  isMoaEnabled,
  addMoaIgnoredRepo,
  onHqStoreWritten,
} from './deckHqStore';
import { loadWorkspaceMode } from './deckAutonomyStore';
import {
  clearPendingDecisionIfUnchanged,
  clearResolvedDecision,
  loadDeckDecisions,
  loadWorkspaceDecision,
  onDecisionsChanged,
  raiseDecisionIfFree,
} from './deckDecisionStore';
import { getTaskLedger } from './taskLedgerHost';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { getWorkLinkStore } from '../workLink/workLinkStore';
import { detectRemote, isGithubHost } from '../github/PrProvider';
import { ghPrService } from '../github/GhPrService';
import { ghIssueService } from '../github/GhIssueService';
import { MOA_ISSUE_POLL_MINUTES_DEFAULT } from '../../shared/moa';

export function createMoaProposalService(opts: { notifyCard?: (workspaceId: string) => void } = {}): MoaProposalService {
  return new MoaProposalService({
    moaReady: () => {
      const hq = getHqWorkspaceId();
      return isMoaEnabled() && hq !== null && hqPresence(hq) === 'present';
    },
    hqWorkspaceId: () => getHqWorkspaceId(),
    config: () => {
      const c = getMoaConfig();
      return {
        issueProposals: c.issueProposals === true,
        trustedAuthors: c.trustedAuthors ?? [],
        issuePollMinutes: c.issuePollMinutes ?? MOA_ISSUE_POLL_MINUTES_DEFAULT,
        ignoredRepos: c.ignoredRepos ?? [],
      };
    },
    workspaces: () =>
      (getWorkspaceMirror().getEntries() ?? []).map((e) => ({ id: e.id, name: e.name, cwd: e.metadata?.cwd ?? null })),
    // Any fan-out task workspace, open or closed: it sits in a worktree.
    isTaskWorkspace: (id) => {
      try {
        return getTaskLedger().findByTaskWorkspace(id) !== null;
      } catch {
        return false;
      }
    },
    remote: (cwd) => detectRemote(cwd),
    isGithubHost,
    gate: async (cwd, host) => (await ghPrService.gate(cwd, host)).ok,
    viewerLogin: (cwd, host) => ghIssueService.signedInLogin(host, cwd),
    // The Git page's 'all' list: the same cache entry, TTL and breaker.
    listItems: async (cwd, key) => {
      const res = await ghIssueService.listIssues(cwd, { kind: 'all' }, key);
      return res.ok ? res.items : null;
    },
    hasWorkLink: (item) => {
      const ref = { host: item.host, owner: item.owner, repo: item.repo, number: item.number };
      return getWorkLinkStore().list(item.kind === 'issue' ? { issue: ref } : { pr: ref }).length > 0;
    },
    modeOf: (id) => loadWorkspaceMode(id),
    decisions: {
      raiseIfFree: (id, card) => raiseDecisionIfFree(id, card),
      load: (id) => loadWorkspaceDecision(id),
      all: () => loadDeckDecisions(),
      clearResolved: (id, decisionId) => clearResolvedDecision(id, decisionId),
      clearPendingIfUnchanged: (id, expected) => clearPendingDecisionIfUnchanged(id, expected),
    },
    ignoreRepo: (key) => addMoaIgnoredRepo(key),
    handoff: getMoaHandoffPort,
    store: new ProposalStore(),
    ...(opts.notifyCard ? { notifyCard: opts.notifyCard } : {}),
  });
}

/** The change feeds the lane follows; injectable for tests. */
export interface MoaIssueProposalFeeds {
  onSettingsWritten: (fn: () => void) => () => void;
  onDecisionsChanged: (fn: () => void) => () => void;
  onMirrorSnapshot: (fn: () => void) => () => void;
}

const defaultFeeds = (): MoaIssueProposalFeeds => ({
  onSettingsWritten: onHqStoreWritten,
  onDecisionsChanged,
  onMirrorSnapshot: (fn) => getWorkspaceMirror().onSnapshot(fn),
});

/**
 * Start the lane: a sync on every settings write and every workspace mirror
 * push (a cold boot learns the HQ is present only from the mirror, with no
 * settings write), a sweep on every decision write. `mirrorFeed: false` leaves
 * the mirror to the caller (deck.handler syncs from its own runtime-only
 * mirror listener, so Moa off holds no listener). Returns the service and the
 * dispose.
 */
export function startMoaIssueProposals(opts: {
  notifyCard?: (workspaceId: string) => void;
  service?: MoaProposalService;
  feeds?: MoaIssueProposalFeeds;
  mirrorFeed?: boolean;
} = {}): { service: MoaProposalService; dispose: () => void } {
  const service = opts.service ?? createMoaProposalService({ ...(opts.notifyCard ? { notifyCard: opts.notifyCard } : {}) });
  const feeds = opts.feeds ?? defaultFeeds();
  const offs = [
    feeds.onSettingsWritten(() => service.sync()),
    ...(opts.mirrorFeed === false ? [] : [feeds.onMirrorSnapshot(() => service.sync())]),
    feeds.onDecisionsChanged(() => service.sweep()),
  ];
  service.sync();
  return {
    service,
    dispose: () => {
      for (const off of offs) off();
      service.stop();
    },
  };
}
