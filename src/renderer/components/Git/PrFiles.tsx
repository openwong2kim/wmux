// A PR's changed files on the Git page's detail pane, read at the head the
// detail is pinned to (and again on Reload), each folded until clicked. An
// open file draws its hunks with old/new line numbers; file comments head the
// file, review threads sit under their line, and outdated threads (or ones
// whose line is not shown) are listed under the file. A line's gutter opens a
// comment composer tied to the pinned head, offered only while the diff shown
// is that head's and writes are on; a thread takes a reply. A comment drafted
// on an older head is not sent until it is re-anchored or discarded. Comment
// bodies go through the app's text-only markdown, never HTML.
import { useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import { renderBrainMarkdown } from '../Deck/BrainMarkdown';
import { HunkGutter, HunkLines } from '../Diff/HunkLines';
import { DetailError, useDetail } from './useDetail';
import { relTime } from './useGitList';
import { draftKey, getDraft, getPrReviewBridge, pinLocked, updateDraft, writeErrorText, type PrDraft, type PrPin } from './prReviewState';
import {
  commentAnchor, numberHunkLines,
  type DiffLine, type PrFilesState, type PrReviewThread, type PrThreadsState,
} from '../../../shared/prReview';
import type { DiffFile } from '../../../shared/diffParse';

const md = (s: string) => renderBrainMarkdown(s, { links: true, githubHtml: true });

type Anchor = { line: number; side: 'LEFT' | 'RIGHT' };
type Composer = NonNullable<PrDraft['comment']>;
const anchorKey = (a: Anchor) => `${a.side}:${a.line}`;

/** The thread keys a line carries: its new line on the right, its old line on the left. */
function lineKeys(line: DiffLine): string[] {
  const keys: string[] = [];
  if (line.newLine !== undefined) keys.push(`RIGHT:${line.newLine}`);
  if (line.oldLine !== undefined) keys.push(`LEFT:${line.oldLine}`);
  return keys;
}

/** Every line key a file's diff shows. */
const shownKeys = (file: Pick<DiffFile, 'hunks'>): Set<string> =>
  new Set(file.hunks.flatMap((h) => numberHunkLines(h).flatMap(lineKeys)));

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
  prUrl: string;
  pin: PrPin;
  /** A line comment can be written: the diff shown is the pinned head's and writes are on. */
  canComment: boolean;
  composer: Composer | null;
  setComposer: (c: Composer | null) => void;
  reloadThreads: () => void;
  onMoved: () => void;
}

export function PrFiles({ repoPath, prUrl, number, pin, readKey, onMoved }: {
  repoPath: string;
  prUrl: string;
  number: number;
  pin: PrPin;
  /** Changes on the page's refresh or a Reload: files and threads read again,
   *  threads past main's cache. */
  readKey: string;
  onMoved: () => void;
}): React.ReactElement | null {
  const t = useT();
  const key = draftKey(repoPath, number);
  const head = pin.head;
  const files = useDetail<PrFilesState>(async () => {
    const bridge = getPrReviewBridge();
    if (!bridge) return { ok: false, message: t('git.bridgeUnavailable') };
    const res = await bridge.prFiles(repoPath, prUrl, head);
    if (res.ok) return { ok: true, value: res.value };
    return { ok: false, message: res.message, ...(res.code === 'rate-limited' ? { retryAt: res.retryAt } : {}) };
  }, `${head}\0${readKey}`);
  // A reply, a new comment, the page's refresh or a Reload reads threads past main's cache.
  const [threadsGen, setThreadsGen] = useState(0);
  const forceThreads = useRef(false);
  const seenRead = useRef(readKey);
  const threads = useDetail<PrThreadsState>(async () => {
    const bridge = getPrReviewBridge();
    if (!bridge) return { ok: false, message: t('git.bridgeUnavailable') };
    const force = forceThreads.current || seenRead.current !== readKey;
    forceThreads.current = false;
    seenRead.current = readKey;
    const res = await bridge.prThreads(repoPath, prUrl, head, force);
    if (res.ok) return { ok: true, value: res.value };
    return { ok: false, message: res.message, ...(res.code === 'rate-limited' ? { retryAt: res.retryAt } : {}) };
  }, `${head}\0${readKey}\0${threadsGen}`);
  const [composer, setComposerState] = useState<Composer | null>(() => getDraft(key)?.comment ?? null);
  if (!getPrReviewBridge()) return null;

  const setComposer = (c: Composer | null) => {
    setComposerState(c);
    updateDraft(key, { comment: c ?? undefined });
  };
  const reloadThreads = () => {
    forceThreads.current = true;
    setThreadsGen((n) => n + 1);
  };
  const diffReady = files.value?.headRefOid === head;
  const ctx: Ctx = { repoPath, prUrl, pin, canComment: diffReady && !pinLocked(pin), composer, setComposer, reloadThreads, onMoved };

  const list = diffReady ? files.value?.files ?? [] : [];
  const allThreads = threads.value?.threads ?? [];
  // Threads on files the (capped) diff left out still get a row.
  const paths = new Set(list.map((f) => f.path));
  const extra = !diffReady ? [] : [...new Set(allThreads.map((th) => th.path).filter((p) => !paths.has(p)))];
  // The composer sits under its line in the first file that shows it; a
  // draft whose line is not in the diff any more is listed on its own.
  const c = composer;
  const composerAt = c ? list.findIndex((f) => f.path === c.path && shownKeys(f).has(anchorKey(c))) : -1;

  return (
    <section className="wmux-git-section" aria-label={t('git.files.title')} data-pr-files>
      <h3 className="wmux-git-section-title">{t('git.files.title')}</h3>
      {files.loading && !diffReady && <div className="wmux-git-note">{t('git.loading')}</div>}
      {!files.loading && files.error && <DetailError label={t('git.files.failed')} error={files.error} retry={files.retry} />}
      {!threads.loading && threads.error && <DetailError label={t('git.files.threadsFailed')} error={threads.error} retry={threads.retry} />}
      {diffReady && files.value?.truncated && <div className="wmux-git-note" data-pr-files-truncated>{t('git.files.truncated')}</div>}
      {threads.value?.truncated && <div className="wmux-git-note">{t('git.files.threadsTruncated')}</div>}
      {c && diffReady && composerAt < 0 && (
        <div className="wmux-git-composer" data-pr-orphan-draft>
          <div className="wmux-git-note">{t('git.files.removedLine', { path: c.path, line: c.line })}</div>
          <div className="wmux-git-issue-body whitespace-pre-wrap">{c.text}</div>
          <div className="wmux-git-review-actions">
            <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={() => setComposer(null)} data-pr-draft-discard>
              {t('git.files.discard')}
            </button>
          </div>
        </div>
      )}
      {diffReady && list.length === 0 && extra.length === 0 && <div className="wmux-git-note">{t('git.files.none')}</div>}
      {(list.length > 0 || extra.length > 0) && (
        <ul className="wmux-git-files">
          {list.map((f, i) => (
            <PrFile key={`${i}:${f.path}`} file={f} threads={allThreads.filter((th) => th.path === f.path)} composerHere={i === composerAt} ctx={ctx} />
          ))}
          {extra.map((p) => (
            <PrFile key={`extra:${p}`} file={{ path: p, kind: 'modify', hunks: [] }} threads={allThreads.filter((th) => th.path === p)} composerHere={false} ctx={ctx} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PrFile({ file, threads, composerHere, ctx }: {
  file: Pick<DiffFile, 'path' | 'kind' | 'hunks'>;
  threads: PrReviewThread[];
  /** The open composer's line is in this file. */
  composerHere: boolean;
  ctx: Ctx;
}): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(composerHere);
  const stat = fileStat(file);
  const kindWord = file.kind === 'add' || file.kind === 'delete' || file.kind === 'rename' ? t(`git.files.kind.${file.kind}`) : '';
  // File comments head the file; an outdated thread is listed below even when
  // it still has a line; a current one whose line is not shown is listed too.
  const shown = shownKeys(file);
  const fileThreads = threads.filter((th) => th.subject === 'file');
  const lineThreads = threads.filter((th) => th.subject !== 'file');
  const outdated = lineThreads.filter((th) => th.isOutdated || th.line === null);
  const current = lineThreads.filter((th): th is PrReviewThread & { line: number } => !th.isOutdated && th.line !== null);
  const notInDiff = current.filter((th) => !shown.has(anchorKey(th)));
  const c = ctx.composer;

  const below = (line: DiffLine) => {
    const keys = lineKeys(line);
    const here = current.filter((th) => keys.includes(anchorKey(th)));
    const a = commentAnchor(line);
    const composing = composerHere && !!a && !!c && c.line === a.line && c.side === a.side;
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
    if (!a || !ctx.canComment) return <HunkGutter line={line} />;
    const place = () => {
      if (c && c.path === file.path && c.line === a.line && c.side === a.side) return;
      // Text already written moves with the composer (keeping the head it was
      // written for); an empty composer starts over on this line.
      ctx.setComposer(c?.text.trim() ? { ...c, ...a, path: file.path } : { ...a, path: file.path, head: ctx.pin.head, text: '' });
    };
    return (
      <button
        type="button"
        className={`wmux-hunk-gutter-btn ${FOCUS_RING}`}
        aria-label={t(a.side === 'RIGHT' ? 'git.files.commentOnNew' : 'git.files.commentOnOld', { path: file.path, line: a.line })}
        onClick={place}
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
          {fileThreads.length > 0 && (
            <div className="wmux-git-threads-aside" data-pr-file-comments>
              <div className="wmux-git-section-title">{t('git.files.fileComments')}</div>
              {fileThreads.map((th) => <Thread key={th.id} thread={th} ctx={ctx} />)}
            </div>
          )}
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
  const locked = pinLocked(ctx.pin);

  const send = async () => {
    const bridge = getPrReviewBridge();
    if (!bridge || !first || busy || !reply.trim()) return;
    if (locked || ctx.pin.stale()) {
      setError(t(ctx.pin.closed ? 'git.review.notOpen' : 'git.review.moved'));
      ctx.onMoved();
      return;
    }
    setBusy(true);
    setError(null);
    const res = await bridge.prReply(ctx.repoPath, ctx.prUrl, first.id, reply);
    setBusy(false);
    if (res.ok) {
      setReply('');
      ctx.reloadThreads();
    } else {
      setError(writeErrorText(res, t));
      if (res.code === 'moved' || res.code === 'blocked') ctx.onMoved();
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
              <button type="button" className={`wmux-git-button ${FOCUS_RING}`} disabled={busy || locked || !reply.trim()} onClick={() => void send()} data-thread-reply>
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

/** The composer under its line. A draft written on an older head is not sent:
 *  it is discarded, or re-anchored to the pinned head on the same line (which
 *  is shown, or the composer would not be here). */
function LineComposer({ ctx }: { ctx: Ctx }): React.ReactElement | null {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = ctx.composer;
  if (!c) return null;
  const stale = c.head !== ctx.pin.head;
  const label = t(c.side === 'RIGHT' ? 'git.files.commentOnNew' : 'git.files.commentOnOld', { path: c.path, line: c.line });

  const send = async () => {
    const bridge = getPrReviewBridge();
    if (!bridge || busy || stale || !c.text.trim()) return;
    if (!ctx.canComment || ctx.pin.stale()) {
      setError(t(ctx.pin.closed ? 'git.review.notOpen' : 'git.review.moved'));
      ctx.onMoved();
      return;
    }
    setBusy(true);
    setError(null);
    const res = await bridge.prComment(ctx.repoPath, ctx.prUrl, { expectHead: ctx.pin.head, path: c.path, line: c.line, side: c.side, body: c.text });
    setBusy(false);
    if (res.ok) {
      ctx.setComposer(null);
      ctx.reloadThreads();
      return;
    }
    setError(writeErrorText(res, t));
    if (res.code === 'moved' || res.code === 'blocked') ctx.onMoved();
  };

  return (
    <div className="wmux-git-composer" data-line-composer data-stale={stale ? 'true' : undefined}>
      {stale && (
        <div className="wmux-git-note" role="status" data-pr-draft-old>
          {t('git.files.commentOld', { sha: c.head.slice(0, 7) })}
        </div>
      )}
      <textarea
        className={`wmux-git-ship-input ${FOCUS_RING}`}
        rows={2}
        autoFocus
        value={c.text}
        aria-label={label}
        onChange={(e) => ctx.setComposer({ ...c, text: e.target.value })}
        data-line-composer-body
      />
      <div className="wmux-git-review-actions">
        {stale ? (
          <>
            <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={() => ctx.setComposer(null)} data-pr-draft-discard>
              {t('git.files.discard')}
            </button>
            <button
              type="button"
              className={`wmux-git-button ${FOCUS_RING}`}
              disabled={!ctx.canComment}
              onClick={() => ctx.setComposer({ ...c, head: ctx.pin.head })}
              data-pr-draft-reanchor
            >
              {t('git.files.reanchor')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className={`wmux-git-button ${FOCUS_RING}`} disabled={busy} onClick={() => ctx.setComposer(null)}>
              {t('git.ship.cancel')}
            </button>
            <button
              type="button"
              className={`wmux-git-button ${FOCUS_RING}`}
              disabled={busy || !ctx.canComment || !c.text.trim()}
              onClick={() => void send()}
              data-line-composer-send
            >
              {t('git.files.addComment')}
            </button>
          </>
        )}
      </div>
      {error && <div className="wmux-git-ship-error" role="status">{error}</div>}
    </div>
  );
}
