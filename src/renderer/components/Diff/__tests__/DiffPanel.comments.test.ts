// J2 F10 — diff comment reverse-lookup extraction logic tests.
//
// Validates pure function that extracts this task's diff-comment anchors from mission channel messages
// (data.kind==='diff-comment' && matching taskId).
//
// J4 — diff comment auto-mention (§S1) + text anchor (§S2) pure function tests. mention→wake delivery
// is already covered by daemon tests (ChannelService.unreadFor / wake worker) so here we only
// pin "what mentions/text the post carried".
import { describe, it, expect } from 'vitest';
import { extractDiffComments, resolveDiffMentionTargets, formatDiffCommentText } from '../DiffPanel';
import { HUMAN_WORKSPACE_ID, CHANNEL_MENTIONS_MAX } from '../../../../shared/channels';

describe('extractDiffComments — F10 anchor reverse lookup', () => {
  it('extracts only diff-comments matching taskId·kind (author·body·time included)', () => {
    const messages = [
      // Target comment.
      {
        text: 'looks good',
        memberName: 'alice',
        postedAt: 1000,
        data: { kind: 'diff-comment', taskId: 'wtask-1', file: 'a.txt', hunkHeader: '@@ -1,3 +1,4 @@' },
      },
      // Different task — exclude.
      {
        text: 'other task',
        memberName: 'bob',
        postedAt: 2000,
        data: { kind: 'diff-comment', taskId: 'wtask-2', file: 'x.txt', hunkHeader: '' },
      },
      // Plain chat (no kind) — exclude.
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

  it('ignores anchors without file·kind mismatch', () => {
    const messages = [
      { text: 'no file', memberName: 'a', postedAt: 1, data: { kind: 'diff-comment', taskId: 'wtask-1' } },
      { text: 'wrong kind', memberName: 'b', postedAt: 2, data: { kind: 'other', taskId: 'wtask-1', file: 'a.txt' } },
    ];
    expect(extractDiffComments(messages, 'wtask-1')).toEqual([]);
  });

  it('safe defaults when memberName·hunkHeader missing', () => {
    const messages = [
      { text: 't', postedAt: 5, data: { kind: 'diff-comment', taskId: 'wtask-1', file: 'a.txt' } },
    ];
    const out = extractDiffComments(messages, 'wtask-1');
    expect(out[0].author).toBe('(unknown)');
    expect(out[0].hunkHeader).toBe('');
  });
});

describe('resolveDiffMentionTargets — J4 §S1 auto-mention targets', () => {
  const SELF = 'ws-owner'; // mission channel createdBy = owner = commenter self.

  it('mentions all non-human members, excludes humans and self', () => {
    const members = [
      { workspaceId: SELF, memberId: 'owner', memberName: 'Owner' }, // self → exclude.
      { workspaceId: HUMAN_WORKSPACE_ID, memberId: 'local-ui', memberName: 'Me' }, // human → exclude.
      { workspaceId: 'ws-claude', memberId: 'claude', memberName: 'claude' },
      { workspaceId: 'ws-codex', memberId: 'codex', memberName: 'codex' },
    ];
    const out = resolveDiffMentionTargets(members, SELF);
    expect(out).toEqual([
      { workspaceId: 'ws-claude', name: 'claude' },
      { workspaceId: 'ws-codex', name: 'codex' },
    ]);
    // Mentions are workspace-level (no memberId): sibling fans in same WS also hit wake aggregation —
    // attaching memberId causes daemon dedup to collapse sibling mentions.
    expect(out.every((m) => !('memberId' in m))).toBe(true);
  });

  it('empty array when all members are human (post without mentions)', () => {
    const members = [
      { workspaceId: SELF, memberId: 'owner', memberName: 'Owner' },
      { workspaceId: HUMAN_WORKSPACE_ID, memberId: 'local-ui', memberName: 'Me' },
    ];
    expect(resolveDiffMentionTargets(members, SELF)).toEqual([]);
  });

  it('multiple members in same workspace → one per workspace (first name)', () => {
    const members = [
      { workspaceId: 'ws-4', memberId: 'claude', memberName: 'claude' },
      { workspaceId: 'ws-4', memberId: 'codex', memberName: 'codex' },
    ];
    const out = resolveDiffMentionTargets(members, SELF);
    expect(out).toEqual([{ workspaceId: 'ws-4', name: 'claude' }]);
  });

  it('missing memberName → memberId as name, else workspaceId', () => {
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

  it('skips rows without workspaceId (defensive)', () => {
    const members = [
      { memberId: 'orphan' },
      { workspaceId: '', memberId: 'blank' },
      { workspaceId: 'ws-a', memberId: 'a', memberName: 'a' },
    ];
    expect(resolveDiffMentionTargets(members, SELF)).toEqual([{ workspaceId: 'ws-a', name: 'a' }]);
  });

  it('pre-truncates at CHANNEL_MENTIONS_MAX', () => {
    const members = Array.from({ length: CHANNEL_MENTIONS_MAX + 5 }, (_, i) => ({
      workspaceId: `ws-${i}`,
      memberId: `m-${i}`,
      memberName: `m-${i}`,
    }));
    expect(resolveDiffMentionTargets(members, SELF)).toHaveLength(CHANNEL_MENTIONS_MAX);
  });
});

describe('formatDiffCommentText — J4 §S2 text anchor', () => {
  it('wraps comment with [diff: file @ hunk] prefix', () => {
    expect(formatDiffCommentText('src/a.ts', '@@ -1,3 +1,4 @@', 'reflect this')).toBe(
      '[diff: src/a.ts @ @@ -1,3 +1,4 @@] reflect this',
    );
  });

  it('omits @ part when hunkHeader is empty', () => {
    expect(formatDiffCommentText('src/a.ts', '', 'note')).toBe('[diff: src/a.ts] note');
  });

  it('long hunkHeader truncates text side to 80 chars only (data anchor kept intact by caller)', () => {
    const longHeader = '@@ -1,1 +1,1 @@ ' + 'x'.repeat(200);
    const out = formatDiffCommentText('f.ts', longHeader, 'c');
    const anchor = out.slice(out.indexOf('@ ') + 2, out.indexOf('] '));
    expect(anchor).toBe(longHeader.slice(0, 80));
    expect(anchor.length).toBe(80);
  });
});
