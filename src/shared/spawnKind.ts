/**
 * pane 스폰 출처 분류 — env 정책의 입력.
 *
 *  'user-shell' : 사용자가 UI로 직접 연 인터랙티브 셸 (env 투과 — 타 터미널 동형).
 *  'agent'      : wmux가 자율 스폰한 에이전트 pane (자격 게이트).
 *  'exec'       : 감독 exec 리프 — 명령을 pane root 프로세스로 실행 (자격 게이트).
 *
 * 렌더러(PtyCreateOptions)·main(pty.handler / PTYManager)에서 공통으로 쓰이므로
 * env 빌더가 있는 envFilter와 분리된 순수 타입 모듈에 둔다.
 */
export type SpawnKind = 'user-shell' | 'agent' | 'exec';

/** env 정책 결정 결과. passthrough=사람 셸(투과), gated=에이전트/자동화(자격 strip). */
export type EnvPolicy = 'passthrough' | 'gated';

/**
 * 실행 컨텍스트 → env 정책. **fail-CLOSED** 규칙:
 *
 *   1. exec/supervision이 있으면 무조건 gated (스탬프보다 우선). 감독 exec 리프는
 *      정의상 wmux가 돌리는 자동화이므로 user-shell 스탬프가 잘못 붙어도 게이트.
 *   2. 명시적 'user-shell'만 passthrough.
 *   3. 그 외(미스탬프 · 'agent' · 알 수 없는 값)는 전부 gated.
 *
 * 새 스폰 경로가 스탬프를 빠뜨리면 자격이 새는 방향이 아니라 막히는 방향으로
 * 실패한다 — 즉 오분류의 기본값이 "사람 셸"이 아니라 "게이트"다.
 */
export function resolveEnvPolicy(opts: {
  spawnKind?: SpawnKind;
  hasExec?: boolean;
  hasSupervision?: boolean;
}): EnvPolicy {
  if (opts.hasExec || opts.hasSupervision) return 'gated';
  if (opts.spawnKind === 'user-shell') return 'passthrough';
  return 'gated';
}
