// Review and squash-merge a PR from the Git page's detail pane. Both are tied
// to the head the detail is pinned to: while newer commits are known (or the
// PR is closed) they are off, and main refuses a write when the PR moved; the
// text is kept either way. Unsent text lives in the session's drafts, so
// leaving the page keeps it.
import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { draftKey, getDraft, getPrReviewBridge, pinLocked, updateDraft, writeErrorText, type PrPin } from './prReviewState';
import { mergeBlock, squashSubject, type PrCheck, type PrReviewHead, type ReviewEvent } from '../../../shared/prReview';

type Note = { ok: boolean; text: string } | null;

/** "This draft was written for an older version of the PR (abc1234)", when
 *  the draft field's head is not the pinned one. */
function DraftWarning({ written, head }: { written: string | undefined; head: string }): React.ReactElement | null {
  const t = useT();
  if (!written || written === head) return null;
  return (
    <div className="wmux-git-note" role="status" data-pr-draft-old>
      {t('git.review.draftOld', { sha: written.slice(0, 7) })}
    </div>
  );
}

function NoteLine({ note }: { note: Note }): React.ReactElement | null {
  if (!note) return null;
  return <div className={note.ok ? 'wmux-git-note' : 'wmux-git-ship-error'} role="status" data-pr-note>{note.text}</div>;
}

const REVIEW_LABEL: Record<ReviewEvent, string> = {
  APPROVE: 'git.review.approve',
  REQUEST_CHANGES: 'git.review.requestChanges',
  COMMENT: 'git.review.comment',
};

export function PrReviewActions({ repoPath, prUrl, number, head, checks, pin, onMoved }: {
  repoPath: string;
  prUrl: string;
  number: number;
  /** The newest head read (state, title, mergeability). */
  head: PrReviewHead;
  /** The head writes are tied to. */
  pin: PrPin;
  checks: readonly PrCheck[];
  /** The PR moved or changed: read its head and checks again. */
  onMoved: () => void;
}): React.ReactElement | null {
  const t = useT();
  const key = draftKey(repoPath, number);
  const [review, setReview] = useState(() => getDraft(key)?.review?.text ?? '');
  const [merge, setMerge] = useState(() => {
    const m = getDraft(key)?.merge;
    return m ? { subject: m.subject, body: m.body } : null;
  });
  const [busy, setBusy] = useState<ReviewEvent | 'merge' | null>(null);
  const [reviewNote, setReviewNote] = useState<Note>(null);
  const [mergeNote, setMergeNote] = useState<Note>(null);
  const bridge = getPrReviewBridge();
  if (!bridge) return null;

  const sha = pin.head;
  const locked = pinLocked(pin);
  const block = mergeBlock(head, checks);
  const draft = getDraft(key);
  // A field keeps the head it was started at until it is cleared.
  const editReview = (text: string) => {
    setReview(text);
    updateDraft(key, { review: { head: getDraft(key)?.review?.head ?? sha, text } });
  };
  const editMerge = (next: { subject: string; body: string } | null) => {
    setMerge(next);
    updateDraft(key, { merge: next ? { head: getDraft(key)?.merge?.head ?? sha, ...next } : undefined });
  };
  /** Refuses a write that would go out while a newer head is known. */
  const refuseStale = (note: (n: Note) => void): boolean => {
    if (!pinLocked(pin) && !pin.stale()) return false;
    note({ ok: false, text: t(pin.closed ? 'git.review.notOpen' : 'git.review.moved') });
    onMoved();
    return true;
  };

  const submitReview = async (event: ReviewEvent) => {
    if (busy || refuseStale(setReviewNote)) return;
    if (event !== 'APPROVE' && !review.trim()) {
      setReviewNote({ ok: false, text: t('git.review.needsBody') });
      return;
    }
    setBusy(event);
    setReviewNote(null);
    // Always the pinned head, even for a draft written at an older one.
    const res = await bridge.prSubmitReview(repoPath, prUrl, { expectHead: sha, event, body: review });
    setBusy(null);
    if (res.ok) {
      editReview('');
      setReviewNote({ ok: true, text: t('git.review.sent') });
      return;
    }
    setReviewNote({ ok: false, text: writeErrorText(res, t) });
    if (res.code === 'moved' || res.code === 'blocked') onMoved();
  };

  const submitMerge = async () => {
    if (busy || !merge || !merge.subject.trim() || refuseStale(setMergeNote)) return;
    setBusy('merge');
    setMergeNote(null);
    const res = await bridge.prMerge(repoPath, prUrl, { expectHead: sha, subject: merge.subject.trim(), body: merge.body });
    setBusy(null);
    if (res.ok) {
      editMerge(null);
      setMergeNote({ ok: true, text: t('git.merge.done') });
      onMoved();
      return;
    }
    setMergeNote({ ok: false, text: writeErrorText(res, t) });
    if (res.code === 'moved' || res.code === 'blocked') onMoved();
  };

  return (
    <section className="wmux-git-section" aria-label={t('git.review.title')} data-pr-review>
      <h3 className="wmux-git-section-title">{t('git.review.title')}</h3>
      <div className="wmux-git-review-head" data-pr-head>
        {t('git.review.atCommit')} <code className="wmux-git-sha">{sha.slice(0, 7)}</code>
      </div>
      {pin.closed && <div className="wmux-git-note" role="status" data-pr-closed>{t(pin.closed === 'MERGED' ? 'git.review.merged' : 'git.review.closed')}</div>}
      <DraftWarning written={draft?.review?.head} head={sha} />
      <textarea
        className={`wmux-git-ship-input ${FOCUS_RING}`}
        rows={3}
        value={review}
        placeholder={t('git.review.placeholder')}
        aria-label={t('git.review.bodyLabel')}
        onChange={(e) => editReview(e.target.value)}
        data-pr-review-body
      />
      <div className="wmux-git-review-actions">
        {(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const).map((ev) => (
          <button
            key={ev}
            type="button"
            className={`wmux-git-button ${FOCUS_RING}`}
            disabled={busy !== null || locked || (ev !== 'APPROVE' && !review.trim())}
            onClick={() => void submitReview(ev)}
            data-pr-review-event={ev}
          >
            {t(REVIEW_LABEL[ev])}
          </button>
        ))}
      </div>
      <NoteLine note={reviewNote} />

      {!merge ? (
        <div className="wmux-git-merge-row">
          <button
            type="button"
            className={`wmux-git-primary ${FOCUS_RING}`}
            disabled={block !== null || busy !== null || locked}
            onClick={() => { setMergeNote(null); editMerge({ subject: squashSubject(head.title, number), body: '' }); }}
            data-pr-squash
          >
            {t('git.merge.squash')}
          </button>
          {block && !pin.closed && <span className="wmux-git-ship-reason" data-pr-merge-block={block}>{t(`git.merge.block.${block}`)}</span>}
        </div>
      ) : (
        <div className="wmux-git-merge-editor" data-pr-merge-editor>
          <DraftWarning written={draft?.merge?.head} head={sha} />
          <label className="wmux-git-field">
            <span>{t('git.merge.subject')}</span>
            <input
              type="text"
              className={`wmux-git-ship-input ${FOCUS_RING}`}
              value={merge.subject}
              onChange={(e) => editMerge({ ...merge, subject: e.target.value })}
              data-pr-merge-subject
            />
          </label>
          <label className="wmux-git-field">
            <span>{t('git.merge.body')}</span>
            <textarea
              className={`wmux-git-ship-input ${FOCUS_RING}`}
              rows={3}
              value={merge.body}
              placeholder={t('git.merge.bodyPlaceholder')}
              onChange={(e) => editMerge({ ...merge, body: e.target.value })}
              data-pr-merge-body
            />
          </label>
          {block && !pin.closed && <span className="wmux-git-ship-reason" data-pr-merge-block={block}>{t(`git.merge.block.${block}`)}</span>}
          <div className="wmux-git-review-actions">
            <button type="button" className={`wmux-git-button ${FOCUS_RING}`} disabled={busy !== null} onClick={() => editMerge(null)} data-pr-merge-cancel>
              {t('git.ship.cancel')}
            </button>
            <button
              type="button"
              className={`wmux-git-primary ${FOCUS_RING}`}
              disabled={busy !== null || locked || block !== null || !merge.subject.trim()}
              onClick={() => void submitMerge()}
              data-pr-merge-submit
            >
              {busy === 'merge' ? t('git.merge.merging') : t('git.merge.merge')}
            </button>
          </div>
        </div>
      )}
      <NoteLine note={mergeNote} />
    </section>
  );
}
