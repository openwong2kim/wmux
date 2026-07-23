// Normalized wire types for the Git tab PR section — shared by main (GhPrService)
// and renderer (PrSection). Host-neutral: GitHub (gh) is v1; GitLab (glab) fills the
// same shape in a follow-up implementation.

/** Normalized PR summary — everything needed for a list row. */
export interface PrSummary {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'draft' | 'merged' | 'closed';
  readonly author: string;
  readonly headRefName: string;
  /** ISO 8601 — also used to skip comment re-fetch when updatedAt is unchanged. */
  readonly updatedAt: string;
  readonly url: string;
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / '' — host raw value preserved. */
  readonly reviewDecision: string;
  /** CI rollup — 3-state. null when no checks. */
  readonly checks: 'passing' | 'pending' | 'failing' | null;
  /** Mergeability — host raw value preserved (gh: MERGEABLE/CONFLICTING/UNKNOWN).
   *  '' when unsupported. Edge source for conflict routing (PrReviewRouter). */
  readonly mergeable: string;
}

/** Normalized comment/review entry. Reviews carry state (APPROVED etc.) together. */
export interface PrComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly kind: 'comment' | 'review';
  readonly reviewState: string;
  /** Body was truncated at PR_COMMENT_BODY_CAP — UI should nudge "view in browser". */
  readonly truncated: boolean;
}

export interface PrDetail {
  readonly number: number;
  readonly comments: PrComment[];
}

/** Comment body cap — excess truncated + truncated flag (browser nudge). */
export const PR_COMMENT_BODY_CAP = 16 * 1024;
