// The PR detail pane's review bridge and what its writes answer, in words.
import { clockTime } from './ListFreshness';
import type { PrWriteResult } from '../../../shared/prReview';

export type PrReviewBridge = Pick<
  Window['electronAPI']['github'],
  'prChecks' | 'prFiles' | 'prThreads' | 'prComment' | 'prReply' | 'prSubmitReview' | 'prMerge' | 'prRunLog' | 'prRerunFailed'
>;

/** The review half of the github bridge, or null where it is not there. */
export function getPrReviewBridge(): PrReviewBridge | null {
  const gh = (window as Partial<Window>).electronAPI?.github as Partial<PrReviewBridge> | undefined;
  return gh?.prChecks ? (gh as PrReviewBridge) : null;
}

/** A refused write in a few words. */
export function writeErrorText(res: Exclude<PrWriteResult, { ok: true }>, t: (k: string, p?: Record<string, string | number>) => string): string {
  switch (res.code) {
    case 'moved': return t('git.review.moved');
    case 'blocked': return res.reason === 'not-open' ? t('git.review.notOpen') : t(`git.merge.block.${res.reason}`);
    case 'rate-limited': return t('git.review.rateLimited', { time: clockTime(res.retryAt) });
    default: return res.message;
  }
}

/** The head the PR detail is pinned to: the one it first showed (or the one
 *  the person reloaded to). Every write is tied to it, never to a newer head
 *  a poll brought in; while a newer one is known, writes are off. */
export interface PrPin {
  head: string;
  /** Newer commits were pushed since the pin (shown; Reload re-pins). */
  moved: boolean;
  /** The PR's state when it is not open (CLOSED or MERGED), else null. */
  closed: string | null;
  /** The newest head read differs from the pin, checked at click time (an
   *  answer that has not been drawn yet counts). */
  stale: () => boolean;
}

/** Writes are off: newer commits, or the PR is closed or merged. */
export const pinLocked = (pin: PrPin): boolean => pin.moved || pin.closed !== null;

/** Unsent text on a PR, kept for the session (leaving the page keeps it). Each
 *  field remembers the head it was started at, so text written for an older
 *  head is kept and flagged on its own. */
export interface PrDraft {
  review?: { head: string; text: string };
  /** The open squash editor. */
  merge?: { head: string; subject: string; body: string };
  /** The open line-comment composer. */
  comment?: { head: string; path: string; line: number; side: 'LEFT' | 'RIGHT'; text: string };
}

const drafts = new Map<string, PrDraft>();

export const draftKey = (repoPath: string, number: number): string => `${repoPath}#${number}`;

export function getDraft(key: string): PrDraft | undefined {
  return drafts.get(key);
}

/** Sets draft fields (undefined clears one); empty text drops its field, and a
 *  draft with nothing left is dropped. */
export function updateDraft(key: string, patch: Partial<PrDraft>): void {
  const next: PrDraft = { ...drafts.get(key), ...patch };
  if (!next.review?.text) delete next.review;
  if (!next.merge) delete next.merge;
  if (!next.comment?.text) delete next.comment;
  if (next.review || next.merge || next.comment) drafts.set(key, next);
  else drafts.delete(key);
}
