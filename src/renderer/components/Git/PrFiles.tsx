// A PR's changed files on the Git page's detail pane, read at the head shown
// (and again when it moves), each folded until clicked. An open file draws its
// hunks with old/new line numbers; review threads sit under their line, and
// threads whose line is gone are listed under the file as Outdated. A line's
// gutter opens a comment composer tied to the head; a thread takes a reply.
// Comment bodies go through the app's text-only markdown, never HTML.
import { useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import { renderBrainMarkdown } from '../Deck/BrainMarkdown';
import { HunkGutter, HunkLines } from '../Diff/HunkLines';
import { DetailError, useDetail } from './useDetail';
import { relTime } from './useGitList';
import { DraftWarning } from './PrReviewActions';
import { draftKey, getDraft, getPrReviewBridge, updateDraft, writeErrorText } from './prReviewState';
import {
  commentAnchor, numberHunkLines,
  type DiffLine, type PrFilesState, type PrReviewThread, type PrThreadsState,
} from '../../../shared/prReview';
import type { DiffFile } from '../../../shared/diffParse';

const md = (s: string) => renderBrainMarkdown(s, { links: true, githubHtml: true });

type Anchor = { line: number; side: 'LEFT' | 'RIGHT' };
type Composer = Anchor & { path: string; text: string };
const anchorKey = (a: Anchor) => `${a.side}:${a.line}`;

/** The thread keys a line carries: its new line on the right, its old line on the left. */
function lineKeys(line: DiffLine): string[] {
  const keys: string[] = [];
  if (line.newLine !== undefined) keys.push(`RIGHT:${line.newLine}`);
  if (line.oldLine !== undefined) keys.push(`LEFT:${line.oldLine}`);
  return keys;
}

function fileStat(file: Pick<DiffFile, 'hunks'>): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of file.hunks) for (const l of h.bodyLines) {
    if (l[0] === '+') add++;
    else if (l[0] === '-') del++;
  }
  return { add, del };
}

interface Ctx {
  repoPath: string;
  number: number;
  head: string;
  composer: Composer | null;
  setComposer: (c: Composer | null) => void;
  reloadThreads: () => void;
  onMoved: () => void;
}

export function PrFiles({ repoPath, number, head, refreshKey, onMoved }: {
  repoPath: string;
  number: number;
  /** The head shown (from the checks read). */
  head: string;
  refreshKey: number;
  onMoved: () => void;
}): React.ReactElement | null {
  const t = useT();
  const key = draftKey(repoPath, number);
  const files = useDetail<PrFilesState>(async () => {
    const bridge = getPrReviewBridge();
    if (!bridge) return { ok: false, message: t('git.bridgeUnavailable') };
    const res = await bridge.prFiles(repoPath, number, head);
    if (res.ok) return { ok: true, value: res.value };
    return { ok: false, message: res.message, ...(res.code === 'rate-limited' ? { retryAt: res.retryAt } : {}) };
  }, `${head}\0${refreshKey}`);
  // A reply, a new comment or the page's refresh reads threads past main's cache.
  const [threadsGen, setThreadsGen] = useState(0);
  const forceThreads = useRef(false);
  const seenRefresh = useRef(refreshKey);
  const threads = useDetail<PrThreadsState>(async () => {
    const bridge = getPrReviewBridge();
    if (!bridge) return { ok: false, message: t('git.bridgeUnavailable') };
    const force = forceThreads.current || seenRefresh.current !== refreshKey;
    forceThreads.current = false;
    seenRefresh.current = refreshKey;
    const res = await bridge.prThreads(repoPath, number, force);
    if (res.ok) return { ok: true, value: res.value };
    return { ok: false, message: res.message, ...(res.code === 'rate-limited' ? { retryAt: res.retryAt } : {}) };
  }, `${head}\0${refreshKey}\0${threadsGen}`);
  const [composer, setComposerState] = useState<Composer | null>(() => getDraft(key)?.comment ?? null);
  if (!getPrReviewBridge()) return null;

  const setComposer = (c: Composer | null) => {
    setComposerState(c);
    updateDraft(key, head, { comment: c ?? undefined });
  };
  const reloadThreads = () => {
    forceThreads.current = true;
    setThreadsGen((n) => n + 1);
  };
  const ctx: Ctx = { repoPath, number, head, composer, setComposer, reloadThreads, onMoved };

  const list = files.value?.files ?? [];
  const allThreads = threads.value?.threads ?? [];
  // Threads on files the (capped) diff left out still get a row.
  const paths = new Set(list.map((f) => f.path));
  const extra = [...new Set(allThreads.map((th) => th.path).filter((p) => !paths.has(p)))];

  return (
    <section className="wmux-git-section" aria-label={t('git.files.title')} data-pr-files>
      <h3 className="wmux-git-section-title">{t('git.files.title')}</h3>
      {files.loading && !files.value && <div className="wmux-git-note">{t('git.loading')}</div>}
      {!files.loading && files.error && <DetailError label={t('git.files.failed')} error={files.error} retry={files.retry} />}
      {!threads.loading && threads.error && <DetailError label={t('git.files.threadsFailed')} error={threads.error} retry={threads.retry} />}
      {files.value?.truncated && <div className="wmux-git-note" data-pr-files-truncated>{t('git.files.truncated')}</div>}
      {threads.value?.truncated && <div className="wmux-git-note">{t('git.files.threadsTruncated')}</div>}
      {files.value && list.length === 0 && extra.length === 0 && <div className="wmux-git-note">{t('git.files.none')}</div>}
      {(list.length > 0 || extra.length > 0) && (
        <ul className="wmux-git-files">
          {list.map((f) => <PrFile key={f.path} file={f} threads={allThreads.filter((th) => th.path === f.path)} ctx={ctx} />)}
          {extra.map((p) => <PrFile key={p} file={{ path: p, kind: 'modify', hunks: [] }} threads={allThreads.filter((th) => th.path === p)} ctx={ctx} />)}
        </ul>
      )}
    </section>
  );
}

function PrFile({ file, threads, ctx }: {
  file: Pick<DiffFile, 'path' | 'kind' | 'hunks'>;
  threads: PrReviewThread[];
  ctx: Ctx;
}): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(() => ctx.composer?.path === file.path);
  const stat = fileStat(file);
  const kindWord = file.kind === 'add' || file.kind === 'delete' || file.kind === 'rename' ? t(`git.files.kind.${file.kind}`) : '';
  // The lines on screen, so a thread whose line is not among them is listed below.
  const shown = new Set(file.hunks.flatMap((h) => numberHunkLines(h).flatMap(lineKeys)));
  const placed = (th: PrReviewThread) => th.line !== null && shown.has(anchorKey({ line: th.line, side: th.side }));
  const outdated = threads.filter((th) => th.line === null);
  const notInDiff = threads.filter((th) => th.line !== null && !placed(th));
  const c = ctx.composer;

  const below = (line: DiffLine) => {
    const keys = lineKeys(line);
    const here = threads.filter((th) => th.line !== null && keys.includes(anchorKey({ line: th.line, side: th.side })));
    const a = commentAnchor(line);
    const composing = !!a && !!c && c.path === file.path && c.line === a.line && c.side === a.side;
    if (here.length === 0 && !composing) return null;
    return (
      <>
        {here.map((th) => <Thread key={th.id} thread={th} ctx={ctx} />)}
        {composing && <LineComposer ctx={ctx} />}
      </>
    );
  };
  const gutter = (line: DiffLine) => {
    const a = commentAnchor(line);
    if (!a) return <HunkGutter line={line} />;
    return (
      <button
        type="button"
        className={`wmux-hunk-gutter-btn ${FOCUS_RING}`}
        aria-label={t('git.files.commentOn', { line: a.line })}
        onClick={() => { if (c?.path !== file.path || c.line !== a.line || c.side !== a.side) ctx.setComposer({ ...a, path: file.path, text: '' }); }}
        data-line-comment={anchorKey(a)}
      >
        <HunkGutter line={line} />
      </button>
    );
  };

  return (
    <li className="wmux-git-file" data-pr-file={file.path}>
      <button type="button" className={`wmux-git-file-head ${FOCUS_RING}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="wmux-git-chevron" data-open={open ? 'true' : undefined} aria-hidden="true"><IconChevron size={11} /></span>
        <span className="wmux-git-file-path">{file.path}</span>
        {kindWord && <span className="wmux-git-file-kind">{kindWord}</span>}
        {threads.length > 0 && <span className="wmux-git-count">{t('git.files.threads', { count: threads.length })}</span>}
        <span className="wmux-git-stat">
          {stat.add > 0 && <span className="text-[var(--accent-green)]">+{stat.add}</span>}
          {stat.del > 0 && <span className="text-[var(--accent-red)]">−{stat.del}</span>}
        </span>
      </button>
      {open && (
        <div className="wmux-git-file-body">
          {file.hunks.map((h, i) => (
            <div key={i} className="wmux-git-hunk">
              <div className="wmux-git-hunk-head">{h.header}</div>
              <HunkLines bodyLines={h.bodyLines} numbered={{ oldStart: h.oldStart, newStart: h.newStart }} gutter={gutter} below={below} />
            </div>
          ))}
          {notInDiff.length > 0 && (
            <div className="wmux-git-threads-aside" data-pr-not-in-diff>
              <div className="wmux-git-section-title">{t('git.files.notInDiff')}</div>
              {notInDiff.map((th) => <Thread key={th.id} thread={th} ctx={ctx} />)}
            </div>
          )}
          {outdated.length > 0 && (
            <div className="wmux-git-threads-aside" data-pr-outdated>
              <div className="wmux-git-section-title">{t('git.files.outdated')}</div>
              {outdated.map((th) => <Thread key={th.id} thread={th} ctx={ctx} />)}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Thread({ thread, ctx }: { thread: PrReviewThread; ctx: Ctx }): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(!thread.isResolved);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = thread.comments[0];

  const send = async () => {
    const bridge = getPrReviewBridge();
    if (!bridge || !first || busy || !reply.trim()) return;
    setBusy(true);
    setError(null);
    const res = await bridge.prReply(ctx.repoPath, ctx.number, first.id, reply);
    setBusy(false);
    if (res.ok) {
      setReply('');
      ctx.reloadThreads();
    } else {
      setError(writeErrorText(res, t));
    }
  };

  return (
    <div className="wmux-git-thread" data-thread-id={thread.id} data-resolved={thread.isResolved ? 'true' : undefined}>
      {thread.isResolved && (
        <button type="button" className={`wmux-git-link-btn ${FOCUS_RING}`} aria-expanded={open} onClick={() => setOpen((v) => !v)} data-thread-toggle>
          {t('git.files.resolved', { count: thread.comments.length })}
        </button>
      )}
      {open && (
        <>
          {thread.comments.map((cm) => (
            <div key={cm.id} className="wmux-git-thread-comment">
              <div className="wmux-git-issue-byline">
                <span className="font-medium">@{cm.author}</span>
                {cm.createdAt && ` · ${relTime(cm.createdAt, t)}`}
              </div>
              <div className="wmux-git-issue-body">{md(cm.body)}</div>
            </div>
          ))}
          {first && (
            <div className="wmux-git-reply">
              <textarea
                className={`wmux-git-ship-input ${FOCUS_RING}`}
                rows={1}
                value={reply}
                placeholder={t('git.files.replyPlaceholder')}
                aria-label={t('git.files.reply')}
                onChange={(e) => setReply(e.target.value)}
                data-thread-reply-body
              />
              <button type="button" className={`wmux-git-button ${FOCUS_RING}`} disabled={busy || !reply.trim()} onClick={() => void send()} data-thread-reply>
                {t('git.files.reply')}
              </button>
            </div>
          )}
          {error && <div className="wmux-git-ship-error" role="status">{error}</div>}
        </>
      )}
    </div>
  );
}

function LineComposer({ ctx }: { ctx: Ctx }): React.ReactElement | null {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = ctx.composer;
  if (!c) return null;

  const send = async () => {
    const bridge = getPrReviewBridge();
    if (!bridge || busy || !c.text.trim()) return;
    setBusy(true);
    setError(null);
    // The head on screen now, even for a draft written at an older one.
    const res = await bridge.prComment(ctx.repoPath, ctx.number, { expectHead: ctx.head, path: c.path, line: c.line, side: c.side, body: c.text });
    setBusy(false);
    if (res.ok) {
      ctx.setComposer(null);
      ctx.reloadThreads();
      return;
    }
    setError(writeErrorText(res, t));
    if (res.code === 'moved') ctx.onMoved();
  };

  return (
    <div className="wmux-git-composer" data-line-composer>
      <DraftWarning draft={getDraft(draftKey(ctx.repoPath, ctx.number))} head={ctx.head} />
      <textarea
        className={`wmux-git-ship-input ${FOCUS_RING}`}
        rows={2}
        autoFocus
        value={c.text}
        aria-label={t('git.files.commentOn', { line: c.line })}
        onChange={(e) => ctx.setComposer({ ...c, text: e.target.value })}
        data-line-composer-body
      />
      <div className="wmux-git-review-actions">
        <button type="button" className={`wmux-git-button ${FOCUS_RING}`} disabled={busy} onClick={() => ctx.setComposer(null)}>
          {t('git.ship.cancel')}
        </button>
        <button type="button" className={`wmux-git-button ${FOCUS_RING}`} disabled={busy || !c.text.trim()} onClick={() => void send()} data-line-composer-send>
          {t('git.files.addComment')}
        </button>
      </div>
      {error && <div className="wmux-git-ship-error" role="status">{error}</div>}
    </div>
  );
}
