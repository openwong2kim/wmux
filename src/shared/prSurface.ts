// Git 탭 PR 섹션의 정규화 wire 타입 — main(GhPrService)과 렌더러(PrSection)가
// 공유한다. 호스트 중립: GitHub(gh)이 v1 구현, GitLab(glab)은 후속 구현체가
// 같은 shape로 채운다.

/** 정규화된 PR 요약 — 목록 행 렌더에 필요한 전부. */
export interface PrSummary {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'draft' | 'merged' | 'closed';
  readonly author: string;
  readonly headRefName: string;
  /** ISO 8601 — 코멘트 재fetch 생략 판단(updatedAt 불변 → skip)에도 쓰인다. */
  readonly updatedAt: string;
  readonly url: string;
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / '' — 호스트 원문 유지. */
  readonly reviewDecision: string;
  /** CI 롤업 — 3상. 체크 없으면 null. */
  readonly checks: 'passing' | 'pending' | 'failing' | null;
  /** 머지 가능성 — 호스트 원문 유지(gh: MERGEABLE/CONFLICTING/UNKNOWN).
   *  구현체가 미지원이면 ''. 충돌 라우팅(PrReviewRouter)의 엣지 소스. */
  readonly mergeable: string;
}

/** 정규화된 코멘트/리뷰 한 건. 리뷰는 state(APPROVED 등)를 함께 담는다. */
export interface PrComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly kind: 'comment' | 'review';
  readonly reviewState: string;
  /** 본문이 캡(PR_COMMENT_BODY_CAP)에서 절단됐는가 — UI가 "브라우저에서 보기" 유도. */
  readonly truncated: boolean;
}

export interface PrDetail {
  readonly number: number;
  readonly comments: PrComment[];
}

/** 코멘트 본문 캡 — 초과분은 절단 + truncated 마킹(브라우저 유도). */
export const PR_COMMENT_BODY_CAP = 16 * 1024;
