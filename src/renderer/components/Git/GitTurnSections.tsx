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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  viewerLogin?: (repoPath: string, force?: boolean) => Promise<{ login: string | null }>;
  repoPermission?: (repoPath: string, force?: boolean) => Promise<{ permission: RepoPermission | null; login: string | null }>;
}

// Kept for the session (main caches them too): each host's login, and each
// repo's role with the login it was read under (null when main could not
// read the login). A role read under another login than the host's current
// one is not used (gh auth switch). A failed
// read is not kept, so the next page show asks again; the page's refresh
// reads both again.
const loginByHost = new Map<string, string>();
const permissionByKey = new Map<string, { permission: RepoPermission; login: string | null }>();

/** Test hook: forget the session's logins and roles. */
export function clearGitViewerCache(): void {
  loginByHost.clear();
  permissionByKey.clear();
}

const hostOf = (groupKey: string): string => groupKey.split('/')[0];

/** Reads each shown repo's host login and role when the page shows (mount),
 *  and again, forced, on the page's refresh. The version changes when an
 *  answer arrives. */
function useGitViewer(groups: RepoGroup[] | null, refreshKey: number): number {
  const [version, setVersion] = useState(0);
  const remotes = (groups ?? []).filter((g) => !g.key.startsWith('path:'));
  const sig = remotes.map((g) => `${g.key}\0${g.prPath}`).join('\n');
  const lastRefresh = useRef(refreshKey);
  // A layout effect, so a replaced read is marked stale at commit, before
  // any of its answers can land after the new render.
  useLayoutEffect(() => {
    const api = (window as unknown as { electronAPI?: { github?: ViewerBridge } }).electronAPI?.github;
    if (!api) return undefined;
    const force = lastRefresh.current !== refreshKey;
    lastRefresh.current = refreshKey;
    // An answer to an effect that has been replaced (a refresh, other repos)
    // is dropped: it may be older than the answer the newer read gets.
    let alive = true;
    const bump = () => setVersion((v) => v + 1);
    const askedHosts = new Set<string>();
    for (const g of remotes) {
      const host = hostOf(g.key);
      if ((force || !loginByHost.has(host)) && !askedHosts.has(host) && api.viewerLogin) {
        askedHosts.add(host);
        void api.viewerLogin(g.prPath, force).then((r) => {
          if (alive && r.login) { loginByHost.set(host, r.login); bump(); }
        }, () => undefined);
      }
      // Asked again whenever the kept role is not usable (none, or read under
      // another login than the host's current one).
      if ((force || groupPermission(g.key) === null) && api.repoPermission) {
        void api.repoPermission(g.prPath, force).then((r) => {
          if (alive && r.permission) {
            // main read the role under its current login for the host, if any.
            permissionByKey.set(g.key, { permission: r.permission, login: r.login });
            if (r.login) loginByHost.set(host, r.login);
            bump();
          }
        }, () => undefined);
      }
    }
    return () => { alive = false; };
    // The shown repos (sig spells them) and the page's refresh are the signal.
  }, [sig, refreshKey]);
  return version;
}

/** The signed-in login on a repo group's host, null while unknown. Never
 *  another host's: an Enterprise host can sign the viewer in as someone else. */
export const groupLogin = (groupKey: string): string | null => loginByHost.get(hostOf(groupKey)) ?? null;

/** The viewer's role on a repo group (its remote key), read under the host's
 *  current login; null while unknown. */
export function groupPermission(groupKey: string): RepoPermission | null {
  const hit = permissionByKey.get(groupKey);
  // A role read with no login matches only while the host's login is unknown.
  return hit && hit.login === groupLogin(groupKey) ? hit.permission : null;
}

/** Everything classifyGitTurn needs for the shown repos, except the login
 *  and the role, which each row takes from its own group (groupLogin,
 *  groupPermission). The version changes the context when either arrives. */
export function useGitTurnContext(groups: RepoGroup[] | null, refreshKey: number): GitTurnContext {
  const links = useActiveLinks();
  const statuses = useStore(useShallow(selectAgentStatusByParty));
  const version = useGitViewer(groups, refreshKey);
  return useMemo<GitTurnContext>(() => ({
    now: Date.now(),
    links,
    paneStatus: (party: WorkLinkParty) => (party.paneId ? statuses[`p:${party.paneId}`] : statuses[`w:${party.workspaceId}`]) ?? null,
    // version: a login or a role arrived (the row lookups read the session cache).
  }), [links, statuses, version]);
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

/** A header summary line: each entry's name and count, each a jump. The
 *  flat list's (`turn`) and the Worktrees tab's (`wt`) share it; `kind`
 *  names the data attributes. */
export function SectionSummary({ kind, label, entries, onJump }: {
  kind: 'turn' | 'wt';
  label: string;
  entries: readonly { key: string; name: string; count: number }[];
  onJump: (key: string) => void;
}): React.ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <p className="wmux-git-page-summary wmux-git-turn-summary" aria-label={label} {...{ [`data-git-${kind}-summary`]: '' }}>
      {entries.map((e, i) => (
        <span key={e.key}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <button
            type="button"
            className={`wmux-git-turn-jump ${FOCUS_RING}`}
            onClick={() => onJump(e.key)}
            {...{ [`data-git-${kind}-jump`]: e.key }}
          >{`${e.name} ${e.count}`}</button>
        </span>
      ))}
    </p>
  );
}

/** The header line: each non-empty section and its count, each a jump. */
export function GitTurnSummary({ counts }: { counts: Record<ShownTurn, number> }): React.ReactElement | null {
  const t = useT();
  const entries = SHOWN_TURNS.filter((turn) => counts[turn] > 0).map((turn) => ({ key: turn, name: t(`git.turn.${turn}`), count: counts[turn] }));
  return <SectionSummary kind="turn" label={t('git.turn.summaryLabel')} entries={entries} onJump={(k) => openTurnSection(k as ShownTurn)} />;
}

/** A folding section: its header (fold toggle, an optional mark, name,
 *  count) over its list. The flat list's (`turn`) and the Worktrees tab's
 *  (`wt`) share it; `kind` names the data attributes. */
export function FoldSection({ kind, sectionKey, name, count, collapsed, onToggle, mark, listLabel, listProps, caption, children }: {
  kind: 'turn' | 'wt';
  sectionKey: string;
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  mark?: React.ReactNode;
  listLabel: string;
  /** Extra attributes for the list (its class and data attributes). */
  listProps?: React.HTMLAttributes<HTMLUListElement> & Record<`data-${string}`, string>;
  /** A muted line under the header while open. */
  caption?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      className="wmux-git-turn"
      aria-label={name}
      {...{ [`data-git-${kind}-section`]: sectionKey }}
      data-collapsed={collapsed ? 'true' : undefined}
    >
      <button
        type="button"
        className={`wmux-git-turn-head ${FOCUS_RING}`}
        aria-expanded={!collapsed}
        onClick={onToggle}
        {...{ [`data-git-${kind}-head`]: '' }}
      >
        <span className="wmux-git-chevron" data-open={collapsed ? undefined : 'true'} aria-hidden="true"><IconChevron size={12} /></span>
        {mark}
        <span className="wmux-git-turn-name">{name}</span>
        <span className="wmux-git-turn-count" {...{ [`data-git-${kind}-count`]: '' }}>{count}</span>
      </button>
      {!collapsed && caption}
      {!collapsed && (
        <ul aria-label={`${name}: ${listLabel}`} {...listProps}>
          {children}
        </ul>
      )}
    </section>
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
  return (
    <FoldSection
      kind="turn"
      sectionKey={turn}
      name={t(`git.turn.${turn}`)}
      count={count}
      collapsed={collapsed}
      onToggle={toggle}
      mark={turn === 'needs_you'
        ? <span className="wmux-git-turn-dot" aria-hidden="true" />
        : turn === 'ready_to_merge' ? <span className="wmux-git-turn-check" aria-hidden="true"><IconCheck size={12} /></span> : undefined}
      listLabel={listLabel}
      listProps={{ className: 'wmux-git-list', 'data-git-flat-rows': '', 'data-git-turn-rows': turn }}
    >
      {children}
    </FoldSection>
  );
}
