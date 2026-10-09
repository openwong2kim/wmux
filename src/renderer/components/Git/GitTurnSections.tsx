// Git page, All repos flat: the who-acts-next sections (gitTurn.ts decides
// each row's section) and what they read. A section header carries its count
// and folds its rows; the header summary names every non-empty section and
// jumps to it. The inputs are wmux's own: the open lists, the work links
// (read once, re-read when main says they changed), each linked pane's live
// agent status from the store, and the signed-in login and the viewer's role
// per repo, read when the page shows and cached for the session. Nothing here
// polls.
//
// Settled is not drawn: the lists read open items only, so it would always
// be empty. A row the classifier calls settled (or drops) waits with others
// rather than vanishing.
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import { selectFleetPanes, selectHookRunningByPtyId } from '../../stores/selectors/fleet';
import { FOCUS_RING } from '../focusRing';
import { IconCheck, IconChevron } from '../icons';
import { classifyGitTurn, GIT_TURN_ORDER, type GitTurn, type GitTurnContext, type GitTurnItem } from './gitTurn';
import type { RepoGroup } from './repoGroups';
import type { AgentStatus } from '../../../shared/types';
import type { RepoPermission } from '../../../shared/issueSurface';
import type { WorkLink, WorkLinkParty, WorkLinkState } from '../../../shared/workLink';

export type ShownTurn = Exclude<GitTurn, 'settled'>;

/** The sections the page draws, in order. */
export const SHOWN_TURNS = GIT_TURN_ORDER.filter((t): t is ShownTurn => t !== 'settled');

/** Needs you and Ready to merge start open; the others start folded. */
export const TURN_COLLAPSED_DEFAULT: Record<ShownTurn, boolean> = {
  needs_you: false,
  ready_to_merge: false,
  agents_on_it: true,
  waiting_on_others: true,
};

export function isTurnCollapsed(turn: ShownTurn, stored: Partial<Record<GitTurn, boolean>>): boolean {
  return stored[turn] ?? TURN_COLLAPSED_DEFAULT[turn];
}

/** The section a row is drawn in. */
export function shownTurnOf(item: GitTurnItem, ctx: GitTurnContext): ShownTurn {
  const turn = classifyGitTurn(item, ctx);
  return turn === null || turn === 'settled' ? 'waiting_on_others' : turn;
}

const RANK: Partial<Record<AgentStatus, number>> = { awaiting_input: 0, running: 1 };

/** Each pane's live agent status (`p:<paneId>`) and each workspace's most
 *  urgent one (`w:<workspaceId>`), from the same selector Fleet and the
 *  sidebar read, with every running-state input (hook turns, command and
 *  process liveness), so a hook-driven turn never reads idle here. */
export function selectAgentStatusByParty(s: StoreState): Record<string, AgentStatus> {
  const out: Record<string, AgentStatus> = {};
  const panes = selectFleetPanes({ ...s, hookRunningByPtyId: selectHookRunningByPtyId(s) });
  for (const p of panes) {
    out[`p:${p.paneId}`] = p.agentStatus;
    const ws = out[`w:${p.workspaceId}`];
    if (ws === undefined || (RANK[p.agentStatus] ?? 9) < (RANK[ws] ?? 9)) out[`w:${p.workspaceId}`] = p.agentStatus;
  }
  return out;
}

const LINK_STATES: WorkLinkState[] = ['queued', 'running', 'needs-you', 'blocked', 'review'];

/** The active work links (WhoActsNext's read, for the whole list). */
function useActiveLinks(): WorkLink[] {
  const [links, setLinks] = useState<WorkLink[]>([]);
  useEffect(() => {
    const api = (window as Partial<Window>).electronAPI?.workLinks;
    if (!api?.list) return undefined;
    let alive = true;
    let req = 0;
    const read = async () => {
      const mine = ++req;
      try {
        const got = await api.list({ states: LINK_STATES });
        if (alive && mine === req) setLinks(got);
      } catch {
        // No links readable: nobody is known to be on anything.
        if (alive && mine === req) setLinks([]);
      }
    };
    void read();
    const off = api.onChanged?.(() => void read());
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return links;
}

interface ViewerBridge {
  viewerLogin?: (repoPath: string) => Promise<{ login: string | null }>;
  repoPermission?: (repoPath: string) => Promise<{ permission: RepoPermission | null }>;
}

// Kept for the session: a login or a role rarely changes, and main caches
// them too. A failed read is not kept, so the next page show asks again.
const loginByHost = new Map<string, string>();
const permissionByKey = new Map<string, RepoPermission>();

/** Test hook: forget the session's logins and roles. */
export function clearGitViewerCache(): void {
  loginByHost.clear();
  permissionByKey.clear();
}

/** The signed-in login and each shown repo's role, read once per repo when
 *  the page shows (mount) and kept. */
function useGitViewer(groups: RepoGroup[] | null): { login: string | null; version: number } {
  const [version, setVersion] = useState(0);
  const remotes = (groups ?? []).filter((g) => !g.key.startsWith('path:'));
  const sig = remotes.map((g) => `${g.key}\0${g.prPath}`).join('\n');
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { github?: ViewerBridge } }).electronAPI?.github;
    if (!api) return undefined;
    let alive = true;
    const bump = () => { if (alive) setVersion((v) => v + 1); };
    const askedHosts = new Set<string>();
    for (const g of remotes) {
      const host = g.key.split('/')[0];
      if (!loginByHost.has(host) && !askedHosts.has(host) && api.viewerLogin) {
        askedHosts.add(host);
        void api.viewerLogin(g.prPath).then((r) => {
          if (r.login) { loginByHost.set(host, r.login); bump(); }
        }, () => undefined);
      }
      if (!permissionByKey.has(g.key) && api.repoPermission) {
        void api.repoPermission(g.prPath).then((r) => {
          if (r.permission) { permissionByKey.set(g.key, r.permission); bump(); }
        }, () => undefined);
      }
    }
    return () => { alive = false; };
    // The shown repos are the signal (sig spells them).
  }, [sig]);
  const login = loginByHost.get('github.com') ?? loginByHost.values().next().value ?? null;
  return { login, version };
}

const permissionOf = (key: string): RepoPermission | null => permissionByKey.get(key) ?? null;

/** Everything classifyGitTurn needs for the shown repos. */
export function useGitTurnContext(groups: RepoGroup[] | null): GitTurnContext {
  const links = useActiveLinks();
  const statuses = useStore(useShallow(selectAgentStatusByParty));
  const { login, version } = useGitViewer(groups);
  return useMemo<GitTurnContext>(() => ({
    now: Date.now(),
    links,
    paneStatus: (party: WorkLinkParty) => (party.paneId ? statuses[`p:${party.paneId}`] : statuses[`w:${party.workspaceId}`]) ?? null,
    ghLogin: login,
    repoPermission: permissionOf,
    // version: a role arrived (the lookup reads the session cache).
  }), [links, statuses, login, version]);
}

/** Open a section and bring its header into view (the summary's jump). */
export function openTurnSection(turn: ShownTurn): void {
  const s = useStore.getState();
  if (isTurnCollapsed(turn, s.gitPage.turnCollapsed)) {
    s.setGitPage({ turnCollapsed: { ...s.gitPage.turnCollapsed, [turn]: false } });
  }
  requestAnimationFrame(() => {
    const head = document.querySelector<HTMLElement>(`[data-git-turn-section="${turn}"] [data-git-turn-head]`);
    head?.focus({ preventScroll: true });
    head?.scrollIntoView?.({ block: 'start' });
  });
}

/** The header line: each non-empty section and its count, each a jump. */
export function GitTurnSummary({ counts }: { counts: Record<ShownTurn, number> }): React.ReactElement | null {
  const t = useT();
  const shown = SHOWN_TURNS.filter((turn) => counts[turn] > 0);
  if (shown.length === 0) return null;
  return (
    <p className="wmux-git-page-summary wmux-git-turn-summary" aria-label={t('git.turn.summaryLabel')} data-git-turn-summary>
      {shown.map((turn, i) => (
        <span key={turn}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <button
            type="button"
            className={`wmux-git-turn-jump ${FOCUS_RING}`}
            onClick={() => openTurnSection(turn)}
            data-git-turn-jump={turn}
          >{`${t(`git.turn.${turn}`)} ${counts[turn]}`}</button>
        </span>
      ))}
    </p>
  );
}

/** One section: its header (fold toggle, mark, name, count) over its rows. */
export function GitTurnSection({ turn, count, listLabel, children }: {
  turn: ShownTurn;
  count: number;
  listLabel: string;
  children: React.ReactNode;
}): React.ReactElement {
  const t = useT();
  const stored = useStore((s) => s.gitPage.turnCollapsed);
  const collapsed = isTurnCollapsed(turn, stored);
  const toggle = () => {
    const cur = useStore.getState().gitPage.turnCollapsed;
    useStore.getState().setGitPage({ turnCollapsed: { ...cur, [turn]: !isTurnCollapsed(turn, cur) } });
  };
  const name = t(`git.turn.${turn}`);
  return (
    <section className="wmux-git-turn" aria-label={name} data-git-turn-section={turn} data-collapsed={collapsed ? 'true' : undefined}>
      <button
        type="button"
        className={`wmux-git-turn-head ${FOCUS_RING}`}
        aria-expanded={!collapsed}
        onClick={toggle}
        data-git-turn-head
      >
        <span className="wmux-git-chevron" data-open={collapsed ? undefined : 'true'} aria-hidden="true"><IconChevron size={12} /></span>
        {turn === 'needs_you' && <span className="wmux-git-turn-dot" aria-hidden="true" />}
        {turn === 'ready_to_merge' && <span className="wmux-git-turn-check" aria-hidden="true"><IconCheck size={12} /></span>}
        <span className="wmux-git-turn-name">{name}</span>
        <span className="wmux-git-turn-count" data-git-turn-count>{count}</span>
      </button>
      {!collapsed && (
        <ul className="wmux-git-list" aria-label={`${name}: ${listLabel}`} data-git-flat-rows data-git-turn-rows={turn}>
          {children}
        </ul>
      )}
    </section>
  );
}
