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
import { ChannelMembersView, rosterParticipants } from '../ChannelMembers';
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

describe('rosterParticipants (owner is not a roster member)', () => {
  it('drops the owner UI entry so a freshly created channel reads as 0 members', () => {
    // create() auto-adds the creator as (ownerWs, local-ui). That is the owner,
    // not a participant — the roster should be empty until agents are invited.
    const out = rosterParticipants([member('ws-owner', 'local-ui')], 'ws-owner');
    expect(out).toEqual([]);
  });

  it('keeps agents — including agents in the owner workspace — and other workspaces', () => {
    const members = [
      member('ws-owner', 'local-ui'), // owner human placeholder → dropped
      member('ws-owner', 'backend'), // an AGENT in the owner ws → kept
      member('ws-2', 'local-ui'), // another workspace explicitly added → kept
      member('ws-3', 'lead'), // an agent elsewhere → kept
    ];
    const out = rosterParticipants(members, 'ws-owner');
    expect(out.map((m) => `${m.workspaceId}:${m.memberId}`)).toEqual([
      'ws-owner:backend',
      'ws-2:local-ui',
      'ws-3:lead',
    ]);
  });

  it('is a no-op when the owner is not a UI member of the channel', () => {
    const members = [member('ws-9', 'lead')];
    expect(rosterParticipants(members, 'ws-owner')).toEqual(members);
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
    // kick is gated on a resolvable human identity + a non-archived channel.
    expect(members).toMatch(/!!selfWorkspaceId && channel\.status !== 'archived'/);
  });

  it('view renders kick on NON-self rows and leave on the self row (the popover lives in source)', () => {
    // The roster rows sit behind a useState-gated popover, so renderToStaticMarkup
    // can't reach them — pin the per-row branch in source instead (same lockstep
    // pattern as the self-only-leave guard above).
    expect(members).toContain('data-channel-member-leave');
    expect(members).toContain('data-channel-member-kick');
    // self ? <leave> : (onKick && <kick>) — the leave affordance is self-only and
    // kick only renders for OTHER members, and only when onKick was provided.
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

  it('P1b: a member may invite another workspace (incl. private); join no longer public-only', () => {
    // canJoin no longer gates on visibility==='public' — a member can invite to
    // a private channel too. The picker still excludes archived channels.
    expect(members).not.toMatch(/visibility === 'public'/);
    expect(members).toMatch(/status !== 'archived'/);
    // self-join vs invite branch: adding ANOTHER workspace routes through invite.
    expect(members).toContain('inviteChannelDaemon');
    expect(members).toMatch(/workspaceId === selfWorkspaceId/);
  });

  it('ChannelView mounts the members control in the header slot', () => {
    expect(view).toContain('membersSlot');
    expect(view).toMatch(/<ChannelMembersControl\s+channel=\{channel\}\s*\/>/);
  });
});
