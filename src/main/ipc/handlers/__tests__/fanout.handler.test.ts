// normalizeRequest — titles·taskPrompts 인덱스 정렬 회귀 방지(3자 리뷰 발견: Codex).
//
// titles가 .filter()로 비문자열 항목을 압축하고 taskPrompts는 .map()으로 원본 인덱스를
// 보존하던 예전 구현은, titles에 비문자열이 섞이면 압축으로 인덱스가 밀려 다른 태스크의
// 프롬프트가 오배달됐다. 페어링 후 필터링으로 고쳤으므로 그 회귀를 여기서 고정한다.

import { describe, it, expect } from 'vitest';
import { normalizeRequest } from '../fanout.handler';

function baseRaw(overrides?: Record<string, unknown>) {
  return {
    idempotencyKey: 'k1',
    prompt: '',
    repoPath: '/repo',
    agentCmd: 'claude',
    verifiedWorkspaceId: 'ws-1',
    ...overrides,
  };
}

describe('normalizeRequest — titles/taskPrompts 인덱스 정렬 (§7 리뷰)', () => {
  it('titles에 비문자열이 섞여도 taskPrompts가 올바른 태스크와 페어링된다', () => {
    const res = normalizeRequest(
      baseRaw({ titles: ['A', null, 'B'], taskPrompts: ['pa', 'ignored', 'pb'] }),
    );
    if ('error' in res) throw new Error(`unexpected error: ${res.error}`);
    expect(res.titles).toEqual(['A', 'B']);
    // B는 원본 인덱스 2의 'pb'를 받아야 한다 — 압축된 titles[1]과 자리만 맞춰
    // taskPrompts[1]='ignored'를 받으면 오배달.
    expect(res.taskPrompts).toEqual(['pa', 'pb']);
  });

  it('정상 입력(비문자열 없음)은 그대로 정렬 유지', () => {
    const res = normalizeRequest(baseRaw({ titles: ['A', 'B'], taskPrompts: ['pa', 'pb'] }));
    if ('error' in res) throw new Error(`unexpected error: ${res.error}`);
    expect(res.titles).toEqual(['A', 'B']);
    expect(res.taskPrompts).toEqual(['pa', 'pb']);
  });

  it('taskPrompts가 아예 없으면 undefined(빈 배열과 구분)', () => {
    const res = normalizeRequest(baseRaw({ titles: ['A', 'B'] }));
    if ('error' in res) throw new Error(`unexpected error: ${res.error}`);
    expect(res.taskPrompts).toBeUndefined();
  });

  it('taskPrompts가 빈 배열로 명시되면 빈 배열 그대로 전달', () => {
    const res = normalizeRequest(baseRaw({ titles: ['A', 'B'], taskPrompts: [] }));
    if ('error' in res) throw new Error(`unexpected error: ${res.error}`);
    expect(res.taskPrompts).toEqual(['', '']);
  });

  it('repoPath 없으면 거부', () => {
    const res = normalizeRequest({ titles: ['A'] });
    expect('error' in res).toBe(true);
  });
});
