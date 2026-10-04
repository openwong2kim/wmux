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
    case 'blocked': return t(`git.merge.block.${res.reason}`);
    case 'rate-limited': return t('git.review.rateLimited', { time: clockTime(res.retryAt) });
    default: return res.message;
  }
}

/** Unsent text on a PR, kept for the session (leaving the page keeps it). */
export interface PrDraft {
  /** The head the draft was started at: text written for an older head is
   *  kept, with a warning, and still sent against the current head. */
  headRefOid: string;
  review?: string;
  /** The open squash editor. */
  merge?: { subject: string; body: string };
  /** The open line-comment composer. */
  comment?: { path: string; line: number; side: 'LEFT' | 'RIGHT'; text: string };
}

const drafts = new Map<string, PrDraft>();

export const draftKey = (repoPath: string, number: number): string => `${repoPath}#${number}`;

export function getDraft(key: string): PrDraft | undefined {
  return drafts.get(key);
}

/** Sets draft fields (undefined clears one); a draft with nothing left is dropped,
 *  so the next one starts at the head it is written for. */
export function updateDraft(key: string, head: string, patch: Omit<Partial<PrDraft>, 'headRefOid'>): void {
  const next: PrDraft = { ...(drafts.get(key) ?? { headRefOid: head }), ...patch };
  if (!next.review) delete next.review;
  if (!next.merge) delete next.merge;
  if (!next.comment?.text) delete next.comment;
  if (next.review || next.merge || next.comment) drafts.set(key, next);
  else drafts.delete(key);
}
