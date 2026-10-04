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
