// ─── Trash group in the channels sidebar ─────────────────────────────────────
//
// The reported failure was that archived mission channels keep their slot in
// the list with no way to remove or collapse them. These tests pin the two
// things that fix it: a trashed channel leaves every visible group, and the
// Trash group it lands in is collapsed by default (so N leftovers cost one
// line, not N). Same node-env / renderToStaticMarkup pattern as
// ChannelsPanel.test.tsx.

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Channel } from '../../../../shared/channels';
import { ChannelsPanelView, groupChannels } from '../ChannelsPanel';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    companyId: 'co-1',
    name: 'general',
    visibility: 'public',
    status: 'active',
    createdAt: 1_700_000_000_000,
    createdBy: 'ws-1',
    nextSeq: 1,
    ...overrides,
  };
}

function renderPanel(channels: Channel[], props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(ChannelsPanelView, {
      channels: Object.fromEntries(channels.map((c) => [c.id, c])),
      channelUnread: {},
      channelMentions: {},
      activeChannelId: null,
      company: null,
      onSelect: () => {},
      onCreate: () => true,
      ...props,
    } as never),
  );
}

describe('groupChannels — trash', () => {
  it('routes trashed channels out of active AND archived', () => {
    const active = makeChannel({ id: 'ch-a', name: 'alpha' });
    const archived = makeChannel({ id: 'ch-b', name: 'beta', status: 'archived', archivedAt: 2 });
    const trashed = makeChannel({
      id: 'ch-c',
      name: 'mission-gamma',
      status: 'archived',
      archivedAt: 3,
      trashedAt: 4,
    });

    const groups = groupChannels([active, archived, trashed]);

    expect(groups.active.map((c) => c.id)).toEqual(['ch-a']);
    expect(groups.archived.map((c) => c.id)).toEqual(['ch-b']);
    expect(groups.trashed.map((c) => c.id)).toEqual(['ch-c']);
  });

  it('sorts the trash most-recently-trashed first', () => {
    const older = makeChannel({ id: 'ch-old', status: 'archived', trashedAt: 10 });
    const newer = makeChannel({ id: 'ch-new', status: 'archived', trashedAt: 20 });
    expect(groupChannels([older, newer]).trashed.map((c) => c.id)).toEqual(['ch-new', 'ch-old']);
  });

  it('keeps an untrashed private observed channel in the active list (regression)', () => {
    // The 관전/observed mission rooms the operator watches must stay visible
    // until they are explicitly trashed — the trash marker is the ONLY thing
    // that removes a row.
    const observed = makeChannel({ id: 'ch-o', visibility: 'private', observed: true });
    const groups = groupChannels([observed], () => false);
    expect(groups.active.map((c) => c.id)).toEqual(['ch-o']);
    expect(groups.trashed).toEqual([]);
  });
});

describe('ChannelsPanelView — trash group', () => {
  it('renders the trash group collapsed: the count shows, the rows do not', () => {
    const html = renderPanel([
      makeChannel({ id: 'ch-a', name: 'alpha' }),
      makeChannel({ id: 'ch-t1', name: 'mission-one', status: 'archived', trashedAt: 1 }),
      makeChannel({ id: 'ch-t2', name: 'mission-two', status: 'archived', trashedAt: 2 }),
    ]);

    expect(html).toContain('data-channels-trash-group');
    // The default `t` is identity, so the label renders as its key.
    expect(html).toContain('channels.trash (2)');
    // Collapsed by default — N leftovers cost exactly one line.
    expect(html).not.toContain('mission-one');
    expect(html).not.toContain('mission-two');
    // The live channel is unaffected.
    expect(html).toContain('alpha');
  });

  it('omits the trash group entirely when nothing is trashed', () => {
    const html = renderPanel([makeChannel({ id: 'ch-a', name: 'alpha' })]);
    expect(html).not.toContain('data-channels-trash-group');
  });

  it('renders the per-row trash affordance only when onTrash is wired', () => {
    const channels = [makeChannel({ id: 'ch-a', name: 'alpha' })];
    expect(renderPanel(channels)).not.toContain('data-channel-trash');
    expect(renderPanel(channels, { onTrash: () => {} })).toContain('data-channel-trash');
  });

  it('does not offer empty-trash without a confirm step', () => {
    const html = renderPanel(
      [makeChannel({ id: 'ch-t1', name: 'mission-one', status: 'archived', trashedAt: 1 })],
      { onEmptyTrash: () => {} },
    );
    // Collapsed, so neither the action nor its confirmation is reachable yet.
    expect(html).not.toContain('data-channels-empty-trash-yes');
  });
});
