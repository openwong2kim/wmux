// All repos on the Git page, flat: every repo's Issues or Pull requests in
// one list, newest update first, each row tagged with its repo. A row of repo
// chips above it filters by repo (none on = every repo); a row's tag toggles
// its repo's chip. Each repo is read the way its own list reads it (one
// headless reader per repo, only the active repo polling), so a chip can say
// that repo's count, that it is still loading, or that its read failed.
// The shown rows are split into who-acts-next sections (GitTurnSections),
// newest first within each.
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { FOCUS_RING } from '../focusRing';
import { IconClock, IconX } from '../icons';
import { ListFreshness, clockTime } from './ListFreshness';
import { PrRow, usePrList } from './PrSection';
import { IssueFilterBar, IssueRow, useIssueList } from './IssueSection';
import { groupOfPath, repoOwnerWorkspace, type RepoGroup } from './repoGroups';
import { hostPlatform } from './GitTab';
import type { GitListState } from './useGitList';
import { saveGitRepoChips, type GitPageTab, type GitSelection } from './gitPageState';
import { GitTurnSection, SHOWN_TURNS, shownTurnOf, useGitTurnContext, type ShownTurn } from './GitTurnSections';
import type { PrSummary } from '../../../shared/prSurface';
import type { IssueFilter, IssueSummary } from '../../../shared/issueSurface';

type Item = PrSummary | IssueSummary;

/** What a repo's reader last said, with the path it read and how to read it again. */
export interface RepoFeedState extends Omit<GitListState<Item[]>, 'data'> {
  repoPath: string;
  data: Item[] | null;
  reload: (force?: boolean) => void;
}

/** One repo's list, read and reported up; draws nothing. */
function RepoFeed({ tab, repoPath, active, filter, refreshKey, onState, onItems }: {
  tab: GitPageTab;
  repoPath: string;
  active: boolean;
  filter: IssueFilter;
  refreshKey: number;
  onState: (s: RepoFeedState) => void;
  onItems: (list: PrSummary[] | IssueSummary[]) => void;
}) {
  const opts = { refreshKey, shown: true, poll: active, lazy: false };
  // Only the shown tab's reader runs: the other is handed no path.
  const prs = usePrList(tab === 'prs' ? repoPath : null, opts);
  const issues = useIssueList(tab === 'issues' ? repoPath : null, filter, opts);
  const list: GitListState<Item[]> & { reload: (force?: boolean) => void } = tab === 'prs' ? prs : issues;
  useEffect(() => {
    onState({ ...list, repoPath });
    // A new answer (or a new state of the read) is the signal.
  }, [list.data, list.loading, list.error, list.gate, list.retryAt, list.fetchedAt, repoPath]);
  useEffect(() => {
    if (list.data) onItems(list.data as PrSummary[] | IssueSummary[]);
  }, [list.data]);
  return null;
}

/** The most a list reads (main's gh list caps); a repo this long says "100+". */
const LIST_READ_CAP = 100;

const updatedMs = (item: Item) => {
  const ms = Date.parse(item.updatedAt);
  return Number.isFinite(ms) ? ms : 0;
};

export function FlatLists({ groups, tab, refreshKey, filter, onFilter, sel, onSelect, publish, onOwners, labelOf, onTurnCounts }: {
  groups: RepoGroup[] | null;
  tab: GitPageTab;
  refreshKey: number;
  filter: IssueFilter;
  onFilter: (f: IssueFilter) => void;
  sel: GitSelection | null;
  onSelect: (repoPath: string, n: number) => void;
  publish: (repoPath: string) => (list: PrSummary[] | IssueSummary[]) => void;
  onOwners?: (owners: Record<string, string | undefined>) => void;
  /** A repo's full name (owner/repo, or its folder without a remote). */
  labelOf: (g: RepoGroup) => string;
  /** Rows per who-acts-next section over the chip-filtered list, for the header summary. */
  onTurnCounts?: (counts: Record<ShownTurn, number> | null) => void;
}) {
  const t = useT();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const storedChips = useStore((s) => s.gitPage.repoChips);
  const setGitPage = useStore((s) => s.setGitPage);
  const [feeds, setFeeds] = useState<Record<string, RepoFeedState>>({});
  const owners = useMemo(
    () => Object.fromEntries((groups ?? []).map((g) => [g.prPath, repoOwnerWorkspace(g, activeWorkspaceId)])),
    [groups, activeWorkspaceId],
  );
  useEffect(() => { onOwners?.(owners); }, [owners, onOwners]);
  const turnCtx = useGitTurnContext(groups);

  // A stored chip whose repo has no open workspace left is ignored.
  const chips = (groups ?? []).filter((g) => storedChips.includes(g.key)).map((g) => g.key);
  const toggleChip = (key: string) => {
    // Read the store, not this render: two clicks before a re-render both count.
    const keys = new Set((groups ?? []).map((g) => g.key));
    const cur = useStore.getState().gitPage.repoChips.filter((k) => keys.has(k));
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    setGitPage({ repoChips: next });
    saveGitRepoChips(next);
  };
  // While the flat list is shown, the selection never sits in a repo the
  // chips leave out: the detail and its writes (merge, review, hand-off) would
  // act on a row nobody can see. Checked on mount (entering All repos or the
  // flat layout), on a chip change and on a new selection, by the repo's chip,
  // never by the row being in the last answer, so a refresh never clears it.
  // The selection is read from the store at check time.
  const selected = useStore((s) => s.gitPage.selected);
  useEffect(() => {
    if (!groups) return;
    const cur = useStore.getState().gitPage;
    if (!cur.selected) return;
    const on = groups.filter((g) => cur.repoChips.includes(g.key)).map((g) => g.key);
    if (on.length === 0) return;
    const g = groupOfPath(groups, cur.selected.repoPath, hostPlatform());
    if (!g || !on.includes(g.key)) setGitPage({ selected: null });
  }, [groups, storedChips, selected, setGitPage]);
  // The selection's group, matched by any of its paths (a clone, a worktree).
  const selGroupKey = sel && groups ? groupOfPath(groups, sel.repoPath, hostPlatform())?.key : undefined;

  if (groups === null) return <div className="wmux-git-note">{t('git.loading')}</div>;
  if (groups.length === 0) return <div className="wmux-git-note" data-git-all-empty>{t('git.allRepos.empty')}</div>;

  // A feed is kept per repo and tab, and counts only while it reads the path
  // its group reads now.
  const feedOf = (g: RepoGroup) => {
    const f = feeds[`${g.key}\0${tab}`];
    return f && f.repoPath === g.prPath ? f : undefined;
  };
  const shownGroups = chips.length === 0 ? groups : groups.filter((g) => chips.includes(g.key));
  const rows = shownGroups
    .flatMap((g) => (feedOf(g)?.data ?? []).map((item) => ({ g, item })))
    .sort((a, b) => updatedMs(b.item) - updatedMs(a.item)
      || a.g.key.localeCompare(b.g.key)
      || b.item.number - a.item.number);
  const shownFeeds = shownGroups.map(feedOf);
  const waiting = shownFeeds.some((f) => !f || f.loading);
  // What stops a repo's list: a gate (no remote, another host...) or a failed read.
  const problemOf = (f: RepoFeedState | undefined) => (f?.gate
    ? (f.gate.code === 'no-remote' ? t('git.noRemote') : f.gate.message || t('git.list.failed'))
    : f?.error ?? null);
  // One freshness line for the shown repos: the oldest answer, a rate limit,
  // or a failed read (Retry reads the failed repos again). A failed repo that
  // never answered makes it "Could not load the list", not "showing the last
  // list": there is no last list of that repo to show.
  const answered = shownFeeds.filter((f): f is RepoFeedState => !!f && !f.gate);
  const failed = answered.filter((f) => f.error !== null);
  const fetched = answered.map((f) => f.fetchedAt).filter((x): x is number => x !== null);
  const fetchedAt = failed.length > 0
    ? (failed.some((f) => f.fetchedAt === null) ? null : Math.min(...failed.map((f) => f.fetchedAt as number)))
    : fetched.length > 0 ? Math.min(...fetched) : null;
  const retryAt = answered.map((f) => f.retryAt).find((x) => x !== null) ?? null;
  // No shown repo has a list (each is gated or failed): "No open ..." would be
  // wrong, so a gated repo says why, as its group does in By repo; a failed
  // read is on the freshness line already.
  const listed = shownFeeds.some((f) => !!f?.data);
  const gated = shownGroups.filter((g) => !!feedOf(g)?.gate);
  // Who acts next on each shown row; the sort above holds within a section.
  const byTurn = Object.fromEntries(SHOWN_TURNS.map((turn) => [turn, [] as typeof rows])) as Record<ShownTurn, typeof rows>;
  for (const row of rows) {
    const turn = shownTurnOf(tab === 'prs' ? { kind: 'pr', pr: row.item as PrSummary } : { kind: 'issue', issue: row.item as IssueSummary }, turnCtx);
    byTurn[turn].push(row);
  }
  const turnCounts = Object.fromEntries(SHOWN_TURNS.map((turn) => [turn, byTurn[turn].length])) as Record<ShownTurn, number>;
  const listLabel = tab === 'prs' ? t('git.pullRequests') : t('git.issues.listLabel');

  return (
    <div data-git-flat-list>
      {groups.map((g) => (
        <RepoFeed
          key={`${g.key}\0${tab}`}
          tab={tab}
          repoPath={g.prPath}
          active={g.active}
          filter={filter}
          refreshKey={refreshKey}
          onState={(s) => setFeeds((m) => ({ ...m, [`${g.key}\0${tab}`]: s }))}
          onItems={publish(g.prPath)}
        />
      ))}
      <div className="wmux-git-chips" role="group" aria-label={t('git.flat.chipsLabel')} data-git-repo-chips>
        {groups.map((g) => {
          const f = feedOf(g);
          const count = f?.data?.length;
          const problem = problemOf(f);
          // Never "empty" before a first answer: a first read held by the rate
          // limit says so, anything else still reading spins.
          const state = problem ? 'error' : !f?.data ? (f?.retryAt ? 'rate' : 'loading') : count ? 'ok' : 'empty';
          const rateLabel = f?.retryAt ? t('git.issues.rateLimited', { time: clockTime(f.retryAt) }) : '';
          const shownCount = count ? (count >= LIST_READ_CAP ? `${LIST_READ_CAP}+` : String(count)) : '';
          return (
            <button
              key={g.key}
              type="button"
              className={`wmux-git-chip ${FOCUS_RING}`}
              aria-pressed={chips.includes(g.key)}
              title={problem ? `${labelOf(g)}: ${problem}` : state === 'rate' ? `${labelOf(g)}: ${rateLabel}` : labelOf(g)}
              onClick={() => toggleChip(g.key)}
              data-git-repo-chip={g.key}
              data-state={state}
            >
              <span className="wmux-git-chip-name">{g.name}</span>
              {state === 'loading' && <span className="wmux-git-chip-spin motion-safe:animate-spin" aria-label={t('git.loading')} data-git-chip-loading />}
              {shownCount && <span className="wmux-git-chip-count">{shownCount}</span>}
              {state === 'rate' && <span className="wmux-git-chip-rate" role="img" aria-label={rateLabel} data-git-chip-rate><IconClock size={11} /></span>}
              {state === 'error' && <span className="wmux-git-chip-error" role="img" aria-label={problem ?? ''} data-git-chip-error><IconX size={10} /></span>}
            </button>
          );
        })}
      </div>
      {tab === 'issues' && <IssueFilterBar filter={filter} onFilter={onFilter} />}
      <ListFreshness
        fetchedAt={fetchedAt}
        error={failed[0]?.error ?? null}
        retryAt={retryAt}
        onRetry={() => failed.forEach((f) => f.reload(true))}
      />
      {rows.length === 0 && (waiting
        ? <div className="wmux-git-note">{t('git.loading')}</div>
        : listed
          ? <div className="wmux-git-note" data-git-flat-empty>
            {tab === 'prs' ? t('git.noPrs') : filter.kind !== 'all' ? t('git.issues.noneFiltered') : t('git.issues.none')}
          </div>
          : gated.map((g) => (
            <div key={g.key} className="wmux-git-note" data-git-flat-gate={g.key}>{`${labelOf(g)}: ${problemOf(feedOf(g))}`}</div>
          )))}
      {onTurnCounts && <TurnCountsReport counts={turnCounts} onTurnCounts={onTurnCounts} />}
      {rows.length > 0 && (
        <div data-git-turn-sections>
          {SHOWN_TURNS.filter((turn) => turnCounts[turn] > 0).map((turn) => (
            <GitTurnSection key={turn} turn={turn} count={turnCounts[turn]} listLabel={listLabel}>
              {byTurn[turn].map(({ g, item }) => {
                const repoPath = g.prPath;
                const selected = !!sel && selGroupKey === g.key && sel.number === item.number;
                const dragContext = { repoPath, ...(owners[repoPath] ? { workspaceId: owners[repoPath] } : {}) };
                const tag = (
                  <button
                    type="button"
                    className={`wmux-git-repo-tag ${FOCUS_RING}`}
                    title={labelOf(g)}
                    aria-label={t('git.flat.tagLabel', { repo: labelOf(g) })}
                    aria-pressed={chips.includes(g.key)}
                    onClick={() => toggleChip(g.key)}
                    data-git-repo-tag={g.key}
                  >{g.name}</button>
                );
                return tab === 'prs' ? (
                  <PrRow key={`${g.key}\0${item.number}`} pr={item as PrSummary} repoPath={repoPath} selected={selected}
                    onSelect={() => onSelect(repoPath, item.number)} dragContext={dragContext} tag={tag} />
                ) : (
                  <IssueRow key={`${g.key}\0${item.number}`} issue={item as IssueSummary} repoPath={repoPath} selected={selected}
                    onSelect={() => onSelect(repoPath, item.number)} dragContext={dragContext} tag={tag} />
                );
              })}
            </GitTurnSection>
          ))}
        </div>
      )}
    </div>
  );
}

/** Hands the section counts up to the page header whenever they change;
 *  gone (null) when the flat list is. */
function TurnCountsReport({ counts, onTurnCounts }: {
  counts: Record<ShownTurn, number>;
  onTurnCounts: (counts: Record<ShownTurn, number> | null) => void;
}) {
  const sig = SHOWN_TURNS.map((turn) => counts[turn]).join(',');
  useEffect(() => { onTurnCounts(counts); }, [sig]);
  useEffect(() => () => onTurnCounts(null), [onTurnCounts]);
  return null;
}
