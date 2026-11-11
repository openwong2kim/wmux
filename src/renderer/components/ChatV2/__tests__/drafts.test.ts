import { describe, expect, it } from 'vitest';
import type { WorkspacePaneOwner } from '../../../../shared/paneUtils';
import { getDraft, setDraft } from '../Composer';
import { forgetChatV2PaneIfClosed } from '../useChatV2';

const leaf = (id: string, ptyId: string) => ({ type: 'leaf', id, surfaces: [{ id: `s-${id}`, ptyId }], activeSurfaceId: `s-${id}` });
const workspace = (root: unknown, stashed: unknown[] = []): WorkspacePaneOwner =>
  ({ rootPane: root, stashedPanes: stashed.map((pane) => ({ pane })) }) as unknown as WorkspacePaneOwner;

describe('forgetChatV2PaneIfClosed', () => {
  it('keeps the draft while a surface still holds the PTY (a split remounted it)', () => {
    setDraft('pty-1:chat-a', 'half-typed');
    const split = { type: 'branch', id: 'b', direction: 'horizontal', children: [leaf('p1', 'pty-1'), leaf('p2', 'pty-2')], sizes: [50, 50] };
    forgetChatV2PaneIfClosed('pty-1', { workspaces: [workspace(split)] });
    expect(getDraft('pty-1:chat-a')).toBe('half-typed');
    // A stashed pane still holds its PTY too.
    forgetChatV2PaneIfClosed('pty-1', { workspaces: [workspace(leaf('p2', 'pty-2'), [leaf('p1', 'pty-1')])] });
    expect(getDraft('pty-1:chat-a')).toBe('half-typed');
  });

  it('forgets the drafts once no surface holds the PTY (the surface closed)', () => {
    setDraft('pty-3:chat-b', 'gone soon');
    setDraft('pty-3:new', 'also gone');
    setDraft('pty-4:new', 'another pane');
    forgetChatV2PaneIfClosed('pty-3', { workspaces: [workspace(leaf('p4', 'pty-4'))] });
    expect(getDraft('pty-3:chat-b')).toBe('');
    expect(getDraft('pty-3:new')).toBe('');
    expect(getDraft('pty-4:new')).toBe('another pane');
  });
});
