// A PR's checks on the Git page's detail pane, read fresh with its head and
// mergeability. The read is useGitList's: every 30s while the Git page is on
// screen, the window is visible and the PR is open, and on the page's refresh.
// A failed GitHub Actions run can show the tail of its log (plain text in a
// <pre>, never markup) and rerun its failed jobs, on an explicit click only.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { Icon, IconCheck, IconX } from '../icons';
import { ListFreshness, clockTime } from './ListFreshness';
import { useGitList, type GitListState } from './useGitList';
import { getPrReviewBridge, writeErrorText } from './prReviewState';
import type { PrSummary } from '../../../shared/prSurface';
import type { PrCheck, PrCheckBucket, PrChecksState, PrReviewRead, PrRunLog } from '../../../shared/prReview';

export type PrChecksRead = GitListState<PrChecksState> & {
  reload: (force?: boolean) => void;
  /** The newest head any read answered, set as the answer arrives (before it
   *  is drawn), so a click racing a new head can be refused. */
  latestHead: React.MutableRefObject<string | null>;
};

/** The PR's head and checks; polls only while the PR is open. */
export function usePrChecks(repoPath: string, pr: PrSummary, refreshKey: number): PrChecksRead {
  const t = useT();
  const bridge = getPrReviewBridge();
  const [open, setOpen] = useState(pr.state === 'open' || pr.state === 'draft');
  const latestHead = useRef<string | null>(null);
  const read = useGitList<PrChecksState>({
    listKey: bridge ? `${repoPath}#${pr.number}` : null,
    read: async (force) => {
      const b = getPrReviewBridge();
      if (!b) return { ok: false, kind: 'error', message: t('git.bridgeUnavailable') };
      const res = await b.prChecks(repoPath, pr.url, force);
      if (!res.ok) return res.code === 'rate-limited' ? { ok: false, kind: 'rate', retryAt: res.retryAt } : { ok: false, kind: 'error', message: res.message };
      latestHead.current = res.value.head.headRefOid;
      return { ok: true, data: res.value };
    },
    shown: true,
    poll: open,
    lazy: false,
    refreshKey,
  });
  const headState = read.data?.head.state;
  useEffect(() => {
    if (headState) setOpen(headState === 'OPEN');
  }, [headState]);
  return { ...read, latestHead };
}

const https = (url: string) => url.startsWith('https://');
const openUrl = (url: string) => { if (https(url)) window.open(url, '_blank'); };

/** A check's state as a mark: green pass and red fail; the rest muted. */
function CheckMark({ bucket }: { bucket: PrCheckBucket }): React.ReactElement {
  const t = useT();
  const glyph = bucket === 'pass' ? <IconCheck size={12} />
    : bucket === 'fail' ? <IconX size={12} />
      : bucket === 'pending' ? <Icon size={12}><circle cx="7" cy="7" r="4" /></Icon>
        : bucket === 'cancel' ? <Icon size={12}><circle cx="7" cy="7" r="4.5" /><line x1="4" y1="10" x2="10" y2="4" /></Icon>
          : <Icon size={12}><line x1="3.5" y1="7" x2="10.5" y2="7" /></Icon>;
  return (
    <span className="wmux-git-check-mark" data-bucket={bucket} role="img" aria-label={t(`git.checks.bucket.${bucket}`)}>
      {glyph}
    </span>
  );
}

/** The failed checks of one GitHub Actions run (its log and rerun are per run). */
function failedRuns(checks: readonly PrCheck[]): { runId: string; checks: PrCheck[] }[] {
  const byRun = new Map<string, PrCheck[]>();
  for (const c of checks) {
    if (c.bucket !== 'fail' || !c.runId) continue;
    byRun.set(c.runId, [...(byRun.get(c.runId) ?? []), c]);
  }
  return [...byRun].map(([runId, cs]) => ({ runId, checks: cs }));
}

export function PrChecks({ repoPath, prUrl, read }: { repoPath: string; prUrl: string; read: PrChecksRead }): React.ReactElement | null {
  const t = useT();
  if (!getPrReviewBridge()) return null;
  const checks = read.data?.checks ?? null;
  return (
    <section className="wmux-git-section" aria-label={t('git.checks.title')} data-pr-checks>
      <h3 className="wmux-git-section-title">{t('git.checks.title')}</h3>
      {(read.error !== null || read.retryAt !== null) && (
        <ListFreshness fetchedAt={read.fetchedAt} error={read.error} retryAt={read.retryAt} onRetry={() => read.reload(true)} />
      )}
      {read.loading && !checks && <div className="wmux-git-note">{t('git.loading')}</div>}
      {checks?.length === 0 && <div className="wmux-git-note">{t('git.checks.none')}</div>}
      {checks && checks.length > 0 && (
        <ul className="wmux-git-checks">
          {checks.map((c, i) => (
            <li key={`${c.name}\0${i}`} className="wmux-git-check" data-check-bucket={c.bucket}>
              <CheckMark bucket={c.bucket} />
              <span className="wmux-git-check-name">{c.name}</span>
              {c.workflow && c.workflow !== c.name && <span className="wmux-git-check-wf">{c.workflow}</span>}
              {https(c.link) && (
                <button type="button" className={`wmux-git-link-btn ${FOCUS_RING}`} onClick={() => openUrl(c.link)} data-check-open>
                  {t('git.issues.openOnGithub')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {checks && failedRuns(checks).map((run) => (
        <FailedRun key={run.runId} repoPath={repoPath} prUrl={prUrl} runId={run.runId} checks={run.checks} />
      ))}
    </section>
  );
}

type Rerun = { state: 'idle' } | { state: 'running' } | { state: 'done'; text: string; ok: boolean };

/** One failed run: its log tail, read once on first open, and Rerun failed jobs. */
function FailedRun({ repoPath, prUrl, runId, checks }: { repoPath: string; prUrl: string; runId: string; checks: PrCheck[] }): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<PrReviewRead<PrRunLog> | 'loading' | null>(null);
  const [rerun, setRerun] = useState<Rerun>({ state: 'idle' });
  const link = checks.find((c) => https(c.link))?.link ?? '';

  const readLog = async () => {
    const bridge = getPrReviewBridge();
    if (!bridge) return;
    setLog('loading');
    setLog(await bridge.prRunLog(repoPath, prUrl, runId));
  };
  const toggle = () => {
    setOpen((v) => !v);
    if (log === null) void readLog();
  };
  const runRerun = async () => {
    const bridge = getPrReviewBridge();
    if (!bridge || rerun.state === 'running') return;
    setRerun({ state: 'running' });
    const res = await bridge.prRerunFailed(repoPath, prUrl, runId);
    setRerun(res.ok ? { state: 'done', ok: true, text: t('git.checks.rerunRequested') } : { state: 'done', ok: false, text: writeErrorText(res, t) });
  };

  return (
    <div className="wmux-git-run" data-run-id={runId}>
      <div className="wmux-git-run-head">
        <span className="wmux-git-run-title">{t('git.checks.failedRun', { names: checks.map((c) => c.name).join(', ') })}</span>
        <button type="button" className={`wmux-git-button ${FOCUS_RING}`} aria-expanded={open} onClick={toggle} data-run-log-toggle>
          {open ? t('git.checks.hideLog') : t('git.checks.showLog')}
        </button>
        <button
          type="button"
          className={`wmux-git-button ${FOCUS_RING}`}
          disabled={rerun.state === 'running' || (rerun.state === 'done' && rerun.ok)}
          onClick={() => void runRerun()}
          data-run-rerun
        >
          {rerun.state === 'running' ? t('git.checks.rerunning') : t('git.checks.rerun')}
        </button>
      </div>
      {rerun.state === 'done' && (
        <div className={rerun.ok ? 'wmux-git-note' : 'wmux-git-ship-error'} role="status" data-run-rerun-result>{rerun.text}</div>
      )}
      {open && log === 'loading' && <div className="wmux-git-note">{t('git.loading')}</div>}
      {open && log !== null && log !== 'loading' && !log.ok && (
        <div className="wmux-git-fresh break-words" role="status" data-run-log-error>
          <span>
            {log.code === 'rate-limited'
              ? t('git.review.rateLimited', { time: clockTime(log.retryAt) })
              : `${t('git.checks.logFailed')}: ${log.message}`}
          </span>
          <button type="button" className={`wmux-git-link-btn ${FOCUS_RING}`} onClick={() => void readLog()}>{t('git.list.retry')}</button>
        </div>
      )}
      {open && log !== null && log !== 'loading' && log.ok && (
        log.value.tooLarge ? (
          <div className="wmux-git-note" data-run-log-too-large>
            {t('git.checks.logTooLarge')}{' '}
            {link && (
              <button type="button" className={`wmux-git-link-btn ${FOCUS_RING}`} onClick={() => openUrl(link)}>
                {t('git.issues.openOnGithub')}
              </button>
            )}
          </div>
        ) : (
          <>
            {log.value.truncated && <div className="wmux-git-note" data-run-log-truncated>{t('git.checks.logTail')}</div>}
            {/* The log is untrusted: a text node in a <pre>, never markup. */}
            <pre className="wmux-git-log" data-run-log>{log.value.text}</pre>
          </>
        )
      )}
    </div>
  );
}
