// ─── Channel members roster (membership v1) ──────────────────────────────────
//
// Two layers:
//  1. Pure-view render (renderToStaticMarkup) — the count button reflects the
//     member count and is keyboard-operable (a real <button>, not a drag).
//  2. Source-scan wiring guard — the popover internals + container wiring live
//     behind a useState-gated popover and store reads that the node-env harness
//     can't drive, so we pin the load-bearing wiring in source (same lockstep
//     pattern as the dock + company-mode guards). Protects the spec-review
//     fixes from silent regression: self-only leave, public-only join,
//     setActiveChannel(null) on self-leave.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChannelMembersView } from '../ChannelMembers';
import type { ChannelMember } from '../../../../shared/channels';

const SRC = resolve(process.cwd(), 'src/renderer/components/Channels');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');

function member(workspaceId: string, memberId: string): ChannelMember {
  return { workspaceId, memberId, joinedAt: 1_700_000_000_000, historyFromSeq: 0 };
}

describe('ChannelMembersView — pure view', () => {
  it('renders a keyboard-operable count button reflecting the member count', () => {
    const html = renderToStaticMarkup(
      <ChannelMembersView
        members={[member('ws-1', 'local-ui'), member('ws-2', 'lead')]}
        workspaceLabel={(id) => id}
        selfWorkspaceId="ws-1"
        selfMemberId="local-ui"
        joinableWorkspaces={[]}
        canJoin={false}
        onJoin={() => {}}
        onLeave={() => {}}
        t={(k) => k}
      />,
    );
    // A real button (not a mouse-only drag) → keyboard + screen-reader operable.
    expect(html).toContain('data-channel-members-button');
    expect(html).toContain('aria-expanded');
    expect(html).toContain('data-channel-members-count');
    expect(html).toContain('>2<'); // member count
  });
});

describe('ChannelMembers — wiring regression guard', () => {
  const members = read('ChannelMembers.tsx');
  const view = read('ChannelView.tsx');

  it('container wires join + leave daemon thunks', () => {
    expect(members).toContain('joinChannelDaemon');
    expect(members).toContain('leaveChannelDaemon');
  });

  it('self-leave of the active channel clears the view (no dead pane)', () => {
    expect(members).toContain('setActiveChannel(null)');
    expect(members).toMatch(/activeChannelId === channel\.id/);
  });

  it('remove (leave) is self-only: exact (self workspace, self member) row', () => {
    expect(members).toMatch(/m\.workspaceId === selfWorkspaceId && m\.memberId === selfMemberId/);
  });

  it('join is public, non-archived channels only (private join deferred)', () => {
    expect(members).toMatch(/visibility === 'public'/);
    expect(members).toMatch(/status !== 'archived'/);
  });

  it('ChannelView mounts the members control in the header slot', () => {
    expect(view).toContain('membersSlot');
    expect(view).toMatch(/<ChannelMembersControl\s+channel=\{channel\}\s*\/>/);
  });
});
