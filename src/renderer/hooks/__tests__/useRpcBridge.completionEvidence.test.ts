import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeCompletionEvidenceWire } from '../../../shared/completionEvidence';

/**
 * §6.M P1 PR-D′ — a2a.task.update 의 완료증거 배선 가드. useRpcBridge 는 store/window 를
 * 끌어와 vitest 에서 import 불가라, 핸들러 배선은 a2aPaneIdentity 테스트와 같은 소스-구조
 * 어서션으로 잠근다. 실제 normalize 경계 계약(malformed→차단 / recordedBy 드롭)은
 * 브릿지가 호출하는 순수 함수를 직접 구동해 확인한다.
 */
describe('useRpcBridge — a2a.task.update 완료증거 배선 (소스-구조)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');

  function region(start: string, end: string): string {
    const m = src.match(new RegExp(`${start}[\\s\\S]*?${end}`));
    if (!m) throw new Error(`region ${start} → ${end} not found in useRpcBridge.ts`);
    return m[0];
  }

  it('import 로 normalizeCompletionEvidenceWire 를 끌어온다', () => {
    // PR-C 가 같은 import 에 isVerifiedItem 을 추가하므로 named-import 목록에
    // 관용적으로 매칭한다(정확 브레이스 매칭은 순서·동반 import 에 취약).
    expect(src).toMatch(/import \{[^}]*\bnormalizeCompletionEvidenceWire\b[^}]*\} from '\.\.\/\.\.\/shared\/completionEvidence'/);
  });

  it('전이 전에 params.evidence 를 wire normalize 하고, null 이면 completion_evidence_malformed 로 전이 미적용', () => {
    const block = region("method === 'a2a\\.task\\.update'", "method === 'a2a\\.task\\.cancel'");
    // normalize 호출
    expect(block).toMatch(/normalizeCompletionEvidenceWire\(params\.evidence\)/);
    // 실패 시 malformed 사유코드 조기 반환(전이 미적용)
    expect(block).toMatch(/completion_evidence_malformed/);
    // 순서 불변식: normalize + malformed 반환이 store.updateTaskStatus 전이 앞에 온다.
    const normalizeIdx = block.indexOf('normalizeCompletionEvidenceWire');
    const malformedIdx = block.indexOf('completion_evidence_malformed');
    const transitionIdx = block.indexOf('store.updateTaskStatus(');
    expect(normalizeIdx).toBeGreaterThan(-1);
    expect(malformedIdx).toBeGreaterThan(normalizeIdx);
    expect(transitionIdx).toBeGreaterThan(malformedIdx);
  });

  it('정규화된 evidence 를 store.updateTaskStatus 로 전달한다', () => {
    const block = region("method === 'a2a\\.task\\.update'", "method === 'a2a\\.task\\.cancel'");
    expect(block).toMatch(/store\.updateTaskStatus\(\s*taskId, nextState, workspaceId, callerAddrUpdate, undefined, evidence,/);
  });
});

/**
 * §6.M P1 PR-C — emitA2aTaskEvent(주 a2a.task 방출자 — teardown/채널멘션은 별도
 * 경로다)가 **종단 전이(completed/failed)**에서 task.status.evidence의
 * verifiedItemCount 를 파생해 publishA2aTask 로 전달하는 배선을 잠근다. useRpcBridge 는
 * import 불가라 소스-구조 어서션으로 확인한다(위 배선 테스트와 동일 패턴).
 */
describe('useRpcBridge — emitA2aTaskEvent verifiedItemCount 파생 (§6.M PR-C, 소스-구조)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');

  it('isVerifiedItem 을 completionEvidence 에서 끌어온다', () => {
    expect(src).toMatch(/import \{[^}]*\bisVerifiedItem\b[^}]*\} from '\.\.\/\.\.\/shared\/completionEvidence'/);
  });

  it('종단 전이(completed/failed)에서만 evidence 로부터 파생해 publishA2aTask 로 전달한다', () => {
    const m = src.match(/function emitA2aTaskEvent\([\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const fn = m![0];
    // state 게이트(리뷰 Codex+GLM): completed/failed 일 때만 파생 — working 이벤트가
    // 등급을 달고 나가지 않게. evidence 게이트만으론 비종단 전이가 등급을 실을 수 있다.
    expect(fn).toMatch(/effectiveState === 'completed' \|\| effectiveState === 'failed'/);
    expect(fn).toMatch(/task\.status\.evidence/);
    expect(fn).toMatch(/\.filter\(isVerifiedItem\)\.length/);
    // items 방어(?.): 타입상 배열이나 폴백 wire 변형에서 undefined면 부재로 안전.
    expect(fn).toMatch(/evidence\?\.items/);
    // 파생 카운트를 publishA2aTask 마지막 인자로 전달(messagePreview 자리는 undefined).
    expect(fn).toMatch(/publishA2aTask\([\s\S]*undefined,\s*verifiedItemCount\)/);
  });
});

describe('useRpcBridge — normalize 경계 계약 (브릿지가 의존하는 순수 함수)', () => {
  it('malformed(미지 kind / 비-plain) → null ⇒ 브릿지가 전이 미적용', () => {
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [{ kind: 'vibe', status: 'ok', summary: 'x' }] })).toBeNull();
    expect(normalizeCompletionEvidenceWire('not-an-object')).toBeNull();
  });

  it('유효 evidence → 새 객체로 정규화, recordedBy 밀수는 드롭되어 스토어에 닿음', () => {
    const out = normalizeCompletionEvidenceWire({
      summary: 'ok',
      items: [{ kind: 'inspection', status: 'unverified', summary: 'self-reported' }],
      recordedBy: 'ws-forged', // 서버 전용 스탬프 위조 시도
      sneaky: 'x', // 미지 키
    });
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('recordedBy');
    expect(out).not.toHaveProperty('sneaky');
    expect(out?.summary).toBe('ok');
    expect(out?.items).toHaveLength(1);
  });
});
