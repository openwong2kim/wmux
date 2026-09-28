/**
 * §6.M P1 완료증거 계약 — 검증기 코어 (순수 함수, 도메인 무관).
 * 설계 정본: plans/completion-evidence-design-2026-07-06.md v1.1
 *
 * 게이트 = 구조, verified = 등급(E9): 전이 게이트는 구조(summary + well-formed
 * items + 새니타이즈 + 캡)만 강제하고, "검증됨" 여부는 verifiedItemCount로 정직
 * 산출·표기한다 — verified≥1은 전이 요건이 아니다(P2 게이트7의 의존성 술어로 소비).
 * run-success 자동 passed 승격 같은 세탁이 게이트를 오염시키지 못하게 하는 구조.
 */
import type { CompletionEvidence, EvidenceItem } from './types';

// E12: DoS 캡 — append-only 정본 로그에 거대 증거 영구 증폭 방지.
// 권위 검증기(validateCompletionEvidence)와 wire 가드(normalize) 양쪽에서 강제.
export const EVIDENCE_MAX_ITEMS = 64;
export const EVIDENCE_MAX_STR_BYTES = 4 * 1024; // summary/command/location/output 각각
export const EVIDENCE_MAX_FILES = 256;
export const EVIDENCE_MAX_FILE_PATH_BYTES = 1024;
export const EVIDENCE_MAX_TOTAL_BYTES = 64 * 1024; // JSON.stringify(evidence) 총량

// renderer(Electron)·데몬·vitest 전부에서 동작하도록 Buffer 대신 TextEncoder 사용
// (utf8 바이트 수 — Buffer.byteLength와 동일 의미).
const utf8 = new TextEncoder();
function byteLen(s: unknown): number {
  return typeof s === 'string' ? utf8.encode(s).length : 0;
}

/**
 * "검증됨" = (command && passed) | (inspection|artifact && verified).
 * 등급 산출 전용 — 전이 게이트 아님(E9).
 */
export function isVerifiedItem(it: EvidenceItem): boolean {
  if (it.kind === 'command') return it.status === 'passed';
  return it.status === 'verified'; // union이 kind를 닫아둠
}

function isWellFormedItem(it: unknown): it is EvidenceItem {
  if (it === null || typeof it !== 'object') return false;
  const o = it as Record<string, unknown>;
  if (typeof o.summary !== 'string' || o.summary.trim() === '') return false;
  if (o.kind === 'command') {
    return (
      (o.status === 'passed' || o.status === 'failed') &&
      typeof o.command === 'string' &&
      o.command.trim() !== ''
    );
  }
  if (o.kind === 'inspection' || o.kind === 'artifact') {
    return o.status === 'verified' || o.status === 'unverified';
  }
  return false; // 알 수 없는 kind/status = 형태 불량(fail-closed)
}

function withinCaps(ev: CompletionEvidence): boolean {
  if ((ev.items ?? []).length > EVIDENCE_MAX_ITEMS) return false;
  if (byteLen(ev.summary) > EVIDENCE_MAX_STR_BYTES) return false;
  for (const it of ev.items ?? []) {
    const io = it as { summary?: string; output?: string; command?: string; location?: string };
    if (byteLen(io.summary) > EVIDENCE_MAX_STR_BYTES || byteLen(io.output) > EVIDENCE_MAX_STR_BYTES) return false;
    if (byteLen(io.command) > EVIDENCE_MAX_STR_BYTES || byteLen(io.location) > EVIDENCE_MAX_STR_BYTES) return false;
  }
  if ((ev.files ?? []).length > EVIDENCE_MAX_FILES) return false;
  return byteLen(JSON.stringify(ev)) <= EVIDENCE_MAX_TOTAL_BYTES;
}

export type EvidenceVerdict =
  | { ok: true; verifiedItemCount: number }
  | { ok: false; code: string };

/**
 * 완료증거 게이트. to는 completed|failed, plus canceled when the RECEIVER cancels
 * through a2a.task.update (reason required, like failed). The sender/receiver
 * a2a.task.cancel path and the teardown force-fail (E10) do not call this gate.
 * 형태 검증은 completed·failed 공통(X8: malformed 진단 아이템의 감사 로그 잔류 차단),
 * verified 요구는 어느 전이에도 없다(E9 — 등급으로만 산출).
 */
export function validateCompletionEvidence(
  to: 'completed' | 'failed' | 'canceled',
  ev: CompletionEvidence | undefined,
): EvidenceVerdict {
  // A receiver's cancel (a2a.task.update status 'canceled') follows the failed
  // rule: the summary is the reason, items are optional.
  const reasonMissing = to === 'canceled' ? 'cancel_reason_missing' : 'failure_reason_missing';
  if (!ev) {
    return { ok: false, code: to === 'completed' ? 'completion_evidence_missing' : reasonMissing };
  }
  if (typeof ev.summary !== 'string' || ev.summary.trim() === '') {
    return { ok: false, code: to === 'completed' ? 'completion_evidence_empty_summary' : reasonMissing };
  }
  // 권위 검증기는 타입 표기를 신뢰하지 않는다 — items가 비배열(예: {})이면 아래
  // for..of가 verdict 대신 TypeError를 던져 게이트가 예외로 붕괴한다. fail-closed.
  if (ev.items !== undefined && !Array.isArray(ev.items)) {
    return { ok: false, code: 'completion_evidence_invalid_item' };
  }
  if (ev.files !== undefined && !Array.isArray(ev.files)) {
    return { ok: false, code: 'completion_evidence_bad_file_path' };
  }
  if (!withinCaps(ev)) return { ok: false, code: 'completion_evidence_too_large' }; // E12
  for (const f of ev.files ?? []) {
    if (!isSafeRelPath(f)) return { ok: false, code: 'completion_evidence_bad_file_path' };
  }
  const items = ev.items ?? [];
  for (const it of items) {
    if (!isWellFormedItem(it)) return { ok: false, code: 'completion_evidence_invalid_item' };
  }
  if (to === 'completed' && items.length === 0) {
    return { ok: false, code: 'completion_evidence_no_items' };
  }
  // E9: verified≥1은 전이 요건이 아니라 등급 — 정직 산출해 반환(0 허용)
  return { ok: true, verifiedItemCount: items.filter(isVerifiedItem).length };
}

/**
 * files[] 경로 새니타이즈. 저장소-상대 경로만 허용, 파일시스템 접근 없는 순수 문자열
 * 판정. 정책: 디코드도 정규화도 하지 않는다 — 입력을 리터럴 코드유닛으로 판정·저장하며,
 * 소비자도 사용 전 URL-디코드·유니코드 정규화를 해서는 안 된다(그 순간 이 가드의
 * 판정이 무효가 된다 — 계약). '..'은 ASCII라 유니코드 정규화로 위장 불가;
 * percent-encoded('%2e%2e%2f')는 디코드 안 하므로 무해한 리터럴 세그먼트명이다.
 */
export function isSafeRelPath(p: unknown): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (byteLen(p) > EVIDENCE_MAX_FILE_PATH_BYTES) return false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false; // C0 제어문자(null 포함)·DEL
  }
  // 콜론 한 규칙으로 일괄 거부: 드라이브 절대('C:\x'), drive-relative('C:foo'),
  // NTFS ADS('a.txt:ads'), URL 스킴('file://x'). 이식 가능한 상대경로에 콜론은
  // 불필요하다(Windows 파일명 원천 금지 문자).
  if (p.includes(':')) return false;
  // 선행 구분자 거부: POSIX 절대 '/x', UNC '\\host', NT 네임스페이스 '\\?\' 전부 커버
  if (/^[/\\]/.test(p)) return false;
  const segs = p.split(/[/\\]/); // 양 OS 구분자 모두로 분할
  if (segs.some((s) => s === '..')) return false;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null; // JSON.parse 산물 + null-proto만
}

/**
 * untrusted-wire 완료증거 가드+정규화. isTaskState(types.ts, LanLink C10)의 위협 모델
 * (hostile wire 값이 lookup 키·스토어 레코드가 되기 전 차단)을 계승·강화.
 * 실패 시 null(→ 사유코드 completion_evidence_malformed). 성공 시 알려진 필드만 복사한
 * **새 객체** 반환 — 미지 키는 드롭되고(프로토타입 오염·밀수 필드 원천 차단), 원본
 * 객체의 getter/프로토타입이 하류에서 작동할 여지를 제거한다. recordedBy/recordedAt도
 * 여기서 드롭된다(서버 전용 스탬프 — 정본 writer가 authContext로 기록).
 * 형태(shape)만 판정한다 — 빈 summary 등 업무 불변식은 권위 검증기
 * (validateCompletionEvidence)가 재검증한다(wire 통과 = 신뢰 아님).
 */
export function normalizeCompletionEvidenceWire(v: unknown): CompletionEvidence | null {
  if (!isPlainObject(v)) return null;
  if (!Object.hasOwn(v, 'summary') || typeof v.summary !== 'string') return null;

  const items: EvidenceItem[] = [];
  if (Object.hasOwn(v, 'items')) {
    if (!Array.isArray(v.items) || v.items.length > EVIDENCE_MAX_ITEMS) return null;
    for (const raw of v.items) {
      if (!isPlainObject(raw)) return null;
      if (raw.kind === 'command') {
        if (raw.status !== 'passed' && raw.status !== 'failed') return null;
        if (!Object.hasOwn(raw, 'command') || typeof raw.command !== 'string') return null;
        if (typeof raw.summary !== 'string') return null;
        items.push({
          kind: 'command',
          status: raw.status,
          summary: raw.summary,
          command: raw.command,
          ...(typeof raw.output === 'string' ? { output: raw.output } : {}),
        });
      } else if (raw.kind === 'inspection' || raw.kind === 'artifact') {
        if (raw.status !== 'verified' && raw.status !== 'unverified') return null;
        if (typeof raw.summary !== 'string') return null;
        items.push({
          kind: raw.kind,
          status: raw.status,
          summary: raw.summary,
          ...(typeof raw.location === 'string' ? { location: raw.location } : {}),
          ...(typeof raw.output === 'string' ? { output: raw.output } : {}),
        });
      } else {
        return null; // 알 수 없는 kind = 전체 거부(fail-closed)
      }
    }
  }
  let files: string[] | undefined;
  if (Object.hasOwn(v, 'files')) {
    if (!Array.isArray(v.files) || v.files.length > EVIDENCE_MAX_FILES) return null;
    // 경로 새니타이즈를 wire에서도 강제한다(권위 검증기와 이중) — 게이트가 아직
    // 배선되지 않은 additive-inert 창에서도 비상대 경로('/etc/x', 'a/../b')가
    // 스토어 레코드로 영속되지 못하게(isTaskState 선례: 저장 전 검증).
    if ((v.files as unknown[]).some((f) => !isSafeRelPath(f))) return null;
    files = [...(v.files as string[])];
  }
  const out: CompletionEvidence = { summary: v.summary, items, ...(files ? { files } : {}) };
  return byteLen(JSON.stringify(out)) <= EVIDENCE_MAX_TOTAL_BYTES ? out : null;
}
