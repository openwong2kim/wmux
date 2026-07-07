import { describe, expect, it } from 'vitest';
import { resolveEnvPolicy } from '../spawnKind';

// ★ 이 파일이 실행컨텍스트 정책의 핵심 회귀 가드다: 오분류의 기본값이 "사람 셸"이
// 아니라 "게이트"여야 한다(fail-closed). 새 스폰 경로가 스탬프를 빠뜨려도 자격증명이
// 새는 방향이 아니라 막히는 방향으로 실패함을 고정한다.
describe('resolveEnvPolicy — fail-closed execution-context classification', () => {
  it('user-shell 스탬프만 passthrough', () => {
    expect(resolveEnvPolicy({ spawnKind: 'user-shell' })).toBe('passthrough');
  });

  it('agent/exec 스탬프는 gated', () => {
    expect(resolveEnvPolicy({ spawnKind: 'agent' })).toBe('gated');
    expect(resolveEnvPolicy({ spawnKind: 'exec' })).toBe('gated');
  });

  it('미스탬프(스폰 경로가 표시를 빠뜨림)는 fail-closed로 gated', () => {
    expect(resolveEnvPolicy({})).toBe('gated');
    expect(resolveEnvPolicy({ spawnKind: undefined })).toBe('gated');
  });

  it('exec/supervision이 있으면 user-shell 스탬프여도 gated(자동화가 스탬프보다 우선)', () => {
    // 감독 exec 리프는 wmux가 돌리는 자동화 — 잘못된 user-shell 스탬프가 붙어도 게이트.
    expect(resolveEnvPolicy({ spawnKind: 'user-shell', hasExec: true })).toBe('gated');
    expect(resolveEnvPolicy({ spawnKind: 'user-shell', hasSupervision: true })).toBe('gated');
  });

  it('알 수 없는 spawnKind 값도 gated(정확히 "user-shell" 리터럴만 passthrough)', () => {
    expect(resolveEnvPolicy({ spawnKind: 'nonsense' as never })).toBe('gated');
  });
});
