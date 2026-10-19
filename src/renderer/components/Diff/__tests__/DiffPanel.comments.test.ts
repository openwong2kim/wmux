// J2 F10 — diff 코멘트 역조회 추출 로직 테스트.
//
// 미션 채널 메시지에서 이 태스크의 diff-comment 앵커(data.kind==='diff-comment'
// && taskId 일치)만 추출하는 순수 함수를 검증한다.
//
// J4 — diff 주석 자동 멘션(§S1) + 텍스트 앵커(§S2) 순수 함수 검증. 멘션→wake 전달
// 자체는 데몬 테스트(ChannelService.unreadFor / wake worker)가 이미 커버하므로 여기선
// "포스트가 어떤 mentions/text를 실었는가"만 박제한다.
import { describe, it, expect } from 'vitest';
import {
  extractDiffComments,
  resolveDiffMentionTargets,
  formatDiffCommentText,
  staleSelectionPaths,
  placeDiffComments,
  formatDiffReviewNote,
} from '../DiffPanel';
import { HUMAN_WORKSPACE_ID, CHANNEL_MENTIONS_MAX } from '../../../../shared/channels';

describe('extractDiffComments — F10 앵커 역조회', () => {
  it('taskId·kind 일치하는 diff-comment만 추출(작성자·본문·시각 포함)', () => {
    const messages = [
      // 대상 코멘트.
      {
        text: 'looks good',
        memberName: 'alice',
        postedAt: 1000,
        data: { kind: 'diff-comment', taskId: 'wtask-1', file: 'a.txt', hunkHeader: '@@ -1,3 +1,4 @@' },
      },
      // 다른 태스크 — 제외.
      {
        text: 'other task',
        memberName: 'bob',
        postedAt: 2000,
        data: { kind: 'diff-comment', taskId: 'wtask-2', file: 'x.txt', hunkHeader: '' },
      },
      // 일반 채팅(kind 없음) — 제외.
      { text: 'hi', memberName: 'carol', postedAt: 3000, data: undefined },
    ];
    const out = extractDiffComments(messages, 'wtask-1');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      file: 'a.txt',
      hunkHeader: '@@ -1,3 +1,4 @@',
      author: 'alice',
      text: 'looks good',
      postedAt: 1000,
    });
  });

  it('file 없는 앵커·kind 불일치는 무시', () => {
    const messages = [
      { text: 'no file', memberName: 'a', postedAt: 1, data: { kind: 'diff-comment', taskId: 'wtask-1' } },
      { text: 'wrong kind', memberName: 'b', postedAt: 2, data: { kind: 'other', taskId: 'wtask-1', file: 'a.txt' } },
    ];
    expect(extractDiffComments(messages, 'wtask-1')).toEqual([]);
  });

  it('memberName·hunkHeader 결측 시 안전 기본값', () => {
    const messages = [
      { text: 't', postedAt: 5, data: { kind: 'diff-comment', taskId: 'wtask-1', file: 'a.txt' } },
    ];
    const out = extractDiffComments(messages, 'wtask-1');
    expect(out[0].author).toBe('(unknown)');
    expect(out[0].hunkHeader).toBe('');
  });
});

describe('resolveDiffMentionTargets — J4 §S1 자동 멘션 대상', () => {
  const SELF = 'ws-owner'; // 미션 채널 createdBy = owner = 코멘터 자신.

  it('비-사람 멤버 전원을 멘션하고 사람·자신은 제외한다', () => {
    const members = [
      { workspaceId: SELF, memberId: 'owner', memberName: 'Owner' }, // 자신 → 제외.
      { workspaceId: HUMAN_WORKSPACE_ID, memberId: 'local-ui', memberName: 'Me' }, // 사람 → 제외.
      { workspaceId: 'ws-claude', memberId: 'claude', memberName: 'claude' },
      { workspaceId: 'ws-codex', memberId: 'codex', memberName: 'codex' },
    ];
    const out = resolveDiffMentionTargets(members, SELF);
    expect(out).toEqual([
      { workspaceId: 'ws-claude', name: 'claude' },
      { workspaceId: 'ws-codex', name: 'codex' },
    ]);
    // 멘션은 워크스페이스-레벨(memberId 미부착): 같은 WS의 형제 팬까지 wake 집계에
    // 잡히도록 — memberId를 붙이면 데몬 dedup이 형제 멘션을 collapse한다.
    expect(out.every((m) => !('memberId' in m))).toBe(true);
  });

  it('멤버가 사람뿐이면 빈 배열(멘션 없이 포스트)', () => {
    const members = [
      { workspaceId: SELF, memberId: 'owner', memberName: 'Owner' },
      { workspaceId: HUMAN_WORKSPACE_ID, memberId: 'local-ui', memberName: 'Me' },
    ];
    expect(resolveDiffMentionTargets(members, SELF)).toEqual([]);
  });

  it('같은 워크스페이스의 멤버 여러 명은 워크스페이스 단위로 1개만(첫 이름)', () => {
    const members = [
      { workspaceId: 'ws-4', memberId: 'claude', memberName: 'claude' },
      { workspaceId: 'ws-4', memberId: 'codex', memberName: 'codex' },
    ];
    const out = resolveDiffMentionTargets(members, SELF);
    expect(out).toEqual([{ workspaceId: 'ws-4', name: 'claude' }]);
  });

  it('memberName 결측이면 memberId를 이름으로, 그마저 없으면 workspaceId', () => {
    const members = [
      { workspaceId: 'ws-a', memberId: 'agent-a' },
      { workspaceId: 'ws-b' },
    ];
    const out = resolveDiffMentionTargets(members, SELF);
    expect(out).toEqual([
      { workspaceId: 'ws-a', name: 'agent-a' },
      { workspaceId: 'ws-b', name: 'ws-b' },
    ]);
  });

  it('workspaceId 없는 행은 건너뛴다(방어)', () => {
    const members = [
      { memberId: 'orphan' },
      { workspaceId: '', memberId: 'blank' },
      { workspaceId: 'ws-a', memberId: 'a', memberName: 'a' },
    ];
    expect(resolveDiffMentionTargets(members, SELF)).toEqual([{ workspaceId: 'ws-a', name: 'a' }]);
  });

  it('CHANNEL_MENTIONS_MAX로 사전 절단한다', () => {
    const members = Array.from({ length: CHANNEL_MENTIONS_MAX + 5 }, (_, i) => ({
      workspaceId: `ws-${i}`,
      memberId: `m-${i}`,
      memberName: `m-${i}`,
    }));
    expect(resolveDiffMentionTargets(members, SELF)).toHaveLength(CHANNEL_MENTIONS_MAX);
  });
});

describe('formatDiffCommentText — J4 §S2 텍스트 앵커', () => {
  it('[diff: file @ hunk] prefix로 코멘트를 감싼다', () => {
    expect(formatDiffCommentText('src/a.ts', '@@ -1,3 +1,4 @@', 'reflect this')).toBe(
      '[diff: src/a.ts @ @@ -1,3 +1,4 @@] reflect this',
    );
  });

  it('hunkHeader가 비면 @ 파트를 생략한다', () => {
    expect(formatDiffCommentText('src/a.ts', '', 'note')).toBe('[diff: src/a.ts] note');
  });

  it('긴 hunkHeader는 text 쪽만 80자로 절단한다(data 앵커는 호출부가 원형 유지)', () => {
    const longHeader = '@@ -1,1 +1,1 @@ ' + 'x'.repeat(200);
    const out = formatDiffCommentText('f.ts', longHeader, 'c');
    const anchor = out.slice(out.indexOf('@ ') + 2, out.indexOf('] '));
    expect(anchor).toBe(longHeader.slice(0, 80));
    expect(anchor.length).toBe(80);
  });
});

// The adoption integrity gate is only worth having if the digest it sends is
// the one the hunks were ticked against. A reload deliberately keeps the
// selection, so a file that moved underneath must lose its ticks — otherwise
// indices from the old rendering ride into the new one and main, handed a
// digest read from that same new entry, has nothing to compare against.
describe('staleSelectionPaths — which ticks a reload invalidates', () => {
  const loaded = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([path, digest]) => [path, { digest }]));

  it('keeps a path whose file did not move', () => {
    expect(staleSelectionPaths({ 'a.ts': 'd1' }, loaded({ 'a.ts': 'd1' }))).toEqual([]);
  });

  it('drops a path the agent rewrote while the selection was held', () => {
    expect(staleSelectionPaths({ 'a.ts': 'd1' }, loaded({ 'a.ts': 'd2' }))).toEqual(['a.ts']);
  });

  it('drops a path that left the diff entirely', () => {
    expect(staleSelectionPaths({ 'a.ts': 'd1' }, loaded({ 'b.ts': 'd9' }))).toEqual(['a.ts']);
  });

  it('drops only what moved, so an untouched file keeps its ticks', () => {
    const recorded = { 'a.ts': 'd1', 'b.ts': 'd2', 'c.ts': 'd3' };
    expect(staleSelectionPaths(recorded, loaded({ 'a.ts': 'd1', 'b.ts': 'CHANGED', 'c.ts': 'd3' }))).toEqual([
      'b.ts',
    ]);
  });

  it('treats a path recorded with no digest as stale rather than adoptable', () => {
    expect(staleSelectionPaths({ 'a.ts': '' }, loaded({ 'a.ts': 'd1' }))).toEqual(['a.ts']);
  });
});

// Line comments: an anchor carries the line (and range end) it was written on;
// an anchor posted before line comments existed (`line: 0`) stays a hunk comment.
describe('line comment anchors', () => {
  const hunk = { header: '@@ -10,2 +10,3 @@', oldStart: 10, newStart: 10, bodyLines: [' keep', '-gone', '+one', '+two'] };
  const msg = (data: Record<string, unknown>) => ({
    text: 't', memberName: 'me', postedAt: 1,
    data: { kind: 'diff-comment', taskId: 'wtask-1', file: 'a.ts', hunkHeader: hunk.header, ...data },
  });

  it('reads line, side and range end, and keeps a line-0 anchor a hunk comment', () => {
    const out = extractDiffComments(
      [msg({ side: 'new', line: 0 }), msg({ side: 'new', line: 11, endLine: 12 }), msg({ side: 'old', line: 11 }), msg({ line: 'x' })],
      'wtask-1',
    );
    expect(out.map((c) => [c.line, c.side, c.endLine])).toEqual([
      [undefined, undefined, undefined],
      [11, 'new', 12],
      [11, 'old', undefined],
      [undefined, undefined, undefined],
    ]);
  });

  it('names the line range in the post text', () => {
    expect(formatDiffCommentText('a.ts', '@@ -1 +1 @@', 'fix', { side: 'new', line: 11, endLine: 12 })).toBe(
      '[diff: a.ts:11-12 @ @@ -1 +1 @@] fix',
    );
    expect(formatDiffCommentText('a.ts', '', 'fix', { side: 'old', line: 11 })).toBe('[diff: a.ts:11 (old)] fix');
  });

  it('places a line comment under its last line and moves one whose line is gone', () => {
    const [hunkC, rangeC, oldC] = extractDiffComments(
      [msg({ line: 0 }), msg({ side: 'new', line: 11, endLine: 12 }), msg({ side: 'old', line: 11 })],
      'wtask-1',
    );
    const missing = { ...rangeC, endLine: 40 };
    const placed = placeDiffComments({ path: 'a.ts', hunks: [hunk] }, [hunkC, rangeC, oldC, missing]);
    expect(placed.byHunk.get(hunk.header)).toEqual([hunkC]);
    expect(placed.byLine.get(`${hunk.header}\0new:12`)).toEqual([rangeC]);
    expect(placed.byLine.get(`${hunk.header}\0old:11`)).toEqual([oldC]);
    expect(placed.moved).toEqual([missing]);
  });
});

describe('formatDiffReviewNote — workspace review handed to the agent', () => {
  const drafts = [
    { id: 'd1', file: 'a.ts', hunkHeader: '@@ -1 +1 @@', anchor: { side: 'new' as const, line: 3, endLine: 5 }, text: 'rename\nthis', snippet: 'const x = 1;' },
    { id: 'd2', file: 'b.ts', hunkHeader: '@@ -7 +7 @@', text: 'drop \x1b[31mthis\x1b[0m hunk', snippet: '' },
  ];

  it('types one line with no control sequences into the agent input', () => {
    const note = formatDiffReviewNote('/repo', drafts, false);
    expect(note).toBe(
      '[diff review] Review comments on the uncommitted changes in /repo: (1) a.ts:3-5 at "const x = 1;": rename this · (2) b.ts (hunk @@ -7 +7 @@): drop this hunk',
    );
    expect(/[\n\r]/.test(note) || note.includes('\x1b')).toBe(false);
  });

  it('copies a multi-line note to the clipboard and caps a long comment', () => {
    const note = formatDiffReviewNote('/repo', [{ ...drafts[0], text: 'y'.repeat(5000) }], true);
    expect(note.split('\n')[2]).toBe('1. a.ts:3-5 at "const x = 1;"');
    expect(note.length).toBeLessThan(1200);
  });
});
