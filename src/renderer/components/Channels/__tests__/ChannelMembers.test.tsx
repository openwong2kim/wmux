// ─── Channel members roster (membership v1) ──────────────────────────────────
//
// Two layers:
//  1. Pure-view render (renderToStaticMarkup) — the count button reflects the
//     member count and is keyboard-operable (a real <button>, not a drag).
//  2. Source-scan wiring guard — the popover internals + container wiring live
//     behind a useState-gated popover and store reads that the node-env harness
//     can't drive, so we pin the load-bearing wiring in source (same lockstep
//     pattern as the dock + company-mode guards). Protects the spec-review
//     fixes from silent regression: self-only leave, member-can-invite (P1b),
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
        onJoin={() => undefined}
        onLeave={() => undefined}
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

describe('ChannelMembersView — every member counts (pure view)', () => {
  it('counts the creating workspace as a member (no more "0 members" lie)', () => {
    // The creating workspace's human placeholder used to be hidden, so an
    // owner-only channel read as "0 members". The roster now shows every member
    // with no privileged owner, so the same channel reads as 1.
    const html = renderToStaticMarkup(
      <ChannelMembersView
        members={[member('ws-owner', 'local-ui')]}
        workspaceLabel={(id) => id}
        selfWorkspaceId="ws-2"
        selfMemberId="local-ui"
        joinableWorkspaces={[]}
        canJoin={false}
        onJoin={() => undefined}
        onLeave={() => undefined}
        t={(k) => k}
      />,
    );
    expect(html).toContain('>1<');
  });
});

describe('ChannelMembers — wiring regression guard', () => {
  const members = read('ChannelMembers.tsx');
  const view = read('ChannelView.tsx');

  it('container wires join + invite + leave daemon thunks', () => {
    expect(members).toContain('joinChannelDaemon');
    expect(members).toContain('inviteChannelDaemon');
    expect(members).toContain('leaveChannelDaemon');
  });

  it('container wires kick (humans-only eject) via kickChannelDaemon, gated by canKick', () => {
    expect(members).toContain('kickChannelDaemon');
    expect(members).toMatch(/const canKick =/);
    // kick is gated on the actor being a member (or company CEO) + non-archived,
    // mirroring the daemon kick() authz so non-members don't see dead buttons.
    expect(members).toMatch(/const canKick = \(selfIsMember \|\| isCeo\) && channel\.status !== 'archived'/);
  });

  it('view renders kick on NON-self rows and leave on the self row', () => {
    // The roster rows sit behind a useState-gated popover, so renderToStaticMarkup
    // can't reach them — pin the per-row branch in source instead (same lockstep
    // pattern as the self-only-leave guard above). Every member is treated the
    // same — there is no privileged owner row.
    expect(members).toContain('data-channel-member-leave');
    expect(members).toContain('data-channel-member-kick');
    // self ? <leave> : (onKick && <kick>) — leave is self-only, kick renders for
    // any OTHER member when onKick was provided.
    expect(members).toMatch(/\{self \?/);
    expect(members).toMatch(/onKick && \(/);
  });

  it('self-leave of the active channel clears the view (no dead pane)', () => {
    expect(members).toContain('setActiveChannel(null)');
    expect(members).toMatch(/activeChannelId === channel\.id/);
  });

  it('remove (leave) is self-only: exact (self workspace, self member) row', () => {
    expect(members).toMatch(/m\.workspaceId === selfWorkspaceId && m\.memberId === selfMemberId/);
  });

  it('operator model: the picker offers EVERY non-member workspace (not self-only)', () => {
    // The human GUI operates every local workspace, so the picker is no longer
    // gated to the active workspace. The old self-only filter is gone, and the
    // joinable list starts from the full workspace set.
    expect(members).not.toContain('w.id === selfWorkspaceId');
    expect(members).toMatch(/const joinableWorkspaces: JoinableWorkspace\[\] = workspaces/);
  });

  it('add routes by channel visibility: public → self-join, private → invite', () => {
    expect(members).toMatch(/channel\.visibility === 'public'/);
    expect(members).toContain('joinChannelDaemon');
    expect(members).toContain('inviteChannelDaemon');
    // The picker still excludes archived channels.
    expect(members).toMatch(/status !== 'archived'/);
  });

  it('operator model: roster shows every member, no privileged owner (count no longer lies)', () => {
    // The owner-hiding rosterParticipants helper is gone; rosterMembers === members
    // and there is no special owner concept in the panel.
    expect(members).toMatch(/const rosterMembers = members;/);
    expect(members).not.toContain('rosterParticipants');
    expect(members).not.toContain('data-channel-member-owner');
    expect(members).not.toContain('ownerWorkspaceId');
  });

  it('ChannelView mounts the members control in the header slot', () => {
    expect(view).toContain('membersSlot');
    expect(view).toMatch(/<ChannelMembersControl\s+channel=\{channel\}\s*\/>/);
  });

  it('Channels v2: agent rows show a cursor-derived "behind" badge, never a fabricated one', () => {
    // The badge exists and is derived from the durable cursor vs the head…
    expect(members).toContain('data-channel-member-behind');
    expect(members).toMatch(/headSeq - m\.lastReadSeq/);
    // …only for agent rows (humans advance the ws cursor by reading the dock)…
    expect(members).toMatch(/!self && m\.memberId !== selfMemberId/);
    // …and NEVER invented: a pre-v2 row without lastReadSeq shows no badge.
    expect(members).toMatch(/typeof m\.lastReadSeq === 'number'/);
    // Container derives the head from the loaded message tail (render-capped
    // array, last element = highest seq the renderer knows).
    expect(members).toMatch(/channelMessages\[channel\.id\]/);
    expect(members).toMatch(/msgs\[msgs\.length - 1\]\.seq/);
  });
});
