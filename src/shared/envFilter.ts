/**
 * 자식 프로세스(PTY 셸, 데몬 스폰 셸 등) env를 만드는 필터.
 *
 * env 개입은 두 클래스로 나뉜다 (실행 컨텍스트 정책, spawnKind 참조):
 *
 *   INTERNAL — wmux/Electron/빌드 툴링 내부 변수. 사람 셸이든 에이전트든
 *     **무조건** strip. (ELECTRON_*, VITE_*, WMUX_AUTH*, ORIGINAL_XDG_*,
 *     NODE_OPTIONS, ELECTRON_RUN_AS_NODE) — Electron 감지 누설·RPC 토큰 유출·
 *     커스텀 플래그로의 재진입을 막는다.
 *
 *   CREDENTIAL — 자격증명 이름(`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/`*_CREDENTIALS`/
 *     `*_KEY` + well-known 정확 이름). **gated(에이전트/자동화) 스폰에서만** strip;
 *     사용자가 직접 연 셸(passthrough)에서는 투과한다 — 타 터미널과 동형.
 *
 * SAFE_PASSTHROUGH는 자격증명 패턴에 걸리지만 값이 아닌 소켓 경로/터미널 능력
 * 플래그라 안전한 이름(SSH_AUTH_SOCK, COLORTERM).
 *
 * 두 스폰 경로(main PTYManager · daemon DaemonSessionManager)가 이 모듈을 공유해
 * 하드닝이 lockstep으로 진화한다. 정책 선택(어느 빌더를 쓸지)은 resolveSpawnEnv가
 * spawnKind로 결정한다.
 */

// ── INTERNAL: 항상 strip ──────────────────────────────────────────────────
const INTERNAL_PATTERNS: ReadonlyArray<RegExp> = [
  /^ELECTRON_/,
  /^VITE_/,
  /^WMUX_AUTH/,     // 데몬 RPC 토큰
  /^ORIGINAL_XDG_/, // Electron 주입 XDG override
];

const INTERNAL_EXACT: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
]);

// ── CREDENTIAL: gated 스폰에서만 strip ───────────────────────────────────
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  /_TOKEN$/,        // GITHUB_TOKEN, NPM_TOKEN, …
  /_SECRET$/,       // *_CLIENT_SECRET, …
  /_PASSWORD$/,
  /_CREDENTIALS$/,
  /_KEY$/,          // ANTHROPIC_API_KEY, OPENAI_API_KEY, …
];

const CREDENTIAL_EXACT: ReadonlySet<string> = new Set([
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',  // _ID로 끝나 _KEY$ 패턴에 안 걸림 (AWS 자격증명)
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'DOCKER_PASSWORD',
  // 선행 밑줄이 없어 패턴(`_PASSWORD$`/`_SECRET$` 등)에 안 걸리는 well-known 비밀
  // (3모델 리뷰 확정). `/PASSWORD$/`로 패턴을 넓히면 ENABLE_PASSWORD 같은 비자격
  // 키를 오탐하므로, exact 이름으로만 추가한다.
  'PGPASSWORD',
  'MYSQL_PWD',
  'SECRET_KEY_BASE',
  'LDAPPASSWORD',
  // URL/URI에 자격증명을 임베드하는 연결 문자열 (DATABASE_URL과 동류)
  'DATABASE_URL',
  'REDIS_URL',
  'MONGO_URL',
  'MONGODB_URI',
]);

const SAFE_PASSTHROUGH: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',      // SSH agent 소켓 경로 — 비밀 아님
  'COLORTERM',          // 터미널 능력 힌트
]);

/**
 * wmux/Electron/빌드 내부 변수인가 — 두 정책 모두에서 strip 대상.
 * 매칭은 case-insensitive(키를 대문자화) — 소문자 우회를 막는다.
 */
export function isInternalEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  if (INTERNAL_EXACT.has(k)) return true;
  return INTERNAL_PATTERNS.some((re) => re.test(k));
}

/**
 * 자격증명 이름인가 — gated(에이전트/자동화) 스폰에서만 strip 대상.
 * SAFE_PASSTHROUGH는 이름이 패턴에 걸려도 통과. case-insensitive.
 */
export function isCredentialEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  if (SAFE_PASSTHROUGH.has(k)) return false;
  if (CREDENTIAL_EXACT.has(k)) return true;
  return CREDENTIAL_PATTERNS.some((re) => re.test(k));
}

/**
 * 자식 프로세스로의 상속을 막아야 하는 키인가 (INTERNAL ∪ CREDENTIAL).
 * gated 정책의 strip 술어이자, 하위호환 술어(기존 호출부·workspaceProfile
 * dropSecretKeys가 이 의미에 의존). 테스트용으로 노출.
 */
export function isSensitiveEnvKey(key: string): boolean {
  return isInternalEnvKey(key) || isCredentialEnvKey(key);
}

/** baseEnv에서 `drop(key)`가 참인 키와 undefined 값을 뺀 fresh 사본. */
function buildFilteredEnv(
  baseEnv: NodeJS.ProcessEnv,
  drop: (key: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (drop(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 사람이 연 인터랙티브 셸용 env: wmux/Electron 내부만 strip하고 자격증명은
 * **투과**한다 (tmux/Windows Terminal 동형). 신고 사건 — 사용자가 자기 셸에서
 * 손수 돌린 Claude Code/MCP가 `${KAD_GATEWAY_KEY}`를 빈 값으로 치환하던 문제 —
 * 는 이 빌더가 자격증명을 안 지우므로 사라진다.
 */
export function buildInteractiveShellEnv(
  baseEnv: NodeJS.ProcessEnv = globalThis.process.env,
): Record<string, string> {
  return buildFilteredEnv(baseEnv, isInternalEnvKey);
}

/**
 * 에이전트/자동화 스폰용 env: 내부 + 자격증명을 모두 strip한다. wmux가 자율
 * 스폰한 반신뢰 에이전트 pane 안 임의 코드로 자격증명이 ambient하게 새는 걸 막는다.
 */
export function buildGatedAutomationEnv(
  baseEnv: NodeJS.ProcessEnv = globalThis.process.env,
): Record<string, string> {
  return buildFilteredEnv(baseEnv, isSensitiveEnvKey);
}

/**
 * 하위호환 별칭 — 기존 호출부(resolveSpawnEnv 폴백, DaemonSessionManager
 * process.env 폴백)가 이 이름으로 gated 동작을 기대한다. fail-closed 기본값과도
 * 일치: 정책 미지정 시 gated로 떨어진다.
 */
export const buildSafeChildEnv = buildGatedAutomationEnv;

/**
 * gated 스폰에서 제거될 자격증명 **이름** 목록 (값이 아님 — 관측/진단용).
 * INTERNAL 키는 제외한다: 사용자가 기대하지 않는 wmux 내부 변수를 "withheld
 * 자격증명"으로 보고하면 노이즈다. "왜 없지?"를 5분 안에 끝내기 위한 신호.
 */
export function withheldCredentialNames(
  baseEnv: NodeJS.ProcessEnv = globalThis.process.env,
): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!isInternalEnvKey(key) && isCredentialEnvKey(key)) names.push(key);
  }
  return names;
}

/**
 * 자격증명 *값*을 뺀 **fresh** env 사본 — 디스크/RPC 직렬화 경계에서 쓴다
 * (sessions.json 영속, daemon.listSessions/createSession 응답). INTERNAL 키는
 * 건드리지 않고(스폰에서 이미 처리) 자격증명 이름만 제거하며, 비자격 env(PATH·LANG·
 * WMUX_* identity)는 보존한다.
 *
 * env가 없거나 객체가 아니면 빈 객체를 돌려준다 — 레거시/손상 sessions.json 스크럽이
 * total·non-throwing이어야 세션을 잃지 않는다.
 *
 * **반드시 반환값으로 교체할 것.** 입력 객체를 in-place로 수정하지 않으므로, 호출부는
 * `{ ...s, env: stripCredentialValues(s.env) }`처럼 참조를 교체해야 한다. listSessions가
 * 넘기는 env는 live 인메모리 meta.env와 동일 참조라, in-place 삭제 시 스폰이 깨진다.
 */
export function stripCredentialValues(
  env: Record<string, string> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== 'object') return out;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isCredentialEnvKey(key)) continue;
    out[key] = value as string;
  }
  return out;
}
