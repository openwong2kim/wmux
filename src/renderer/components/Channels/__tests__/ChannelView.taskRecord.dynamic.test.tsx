// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelViewContent } from '../ChannelView';
import type { WorkTask } from '../../../../shared/workTask';
import type { ChannelViewContentProps } from '../ChannelView';

let host: HTMLDivElement;
let root: Root;
const openTask = vi.fn();
const base: ChannelViewContentProps = {
  channel: { id: 'ch-task', companyId: 'co', name: 'mission-123', status: 'active', visibility: 'private', createdBy: 'agent', createdAt: 1, nextSeq: 3 },
  task: { id: 'task', title: 'Fix session recovery', status: 'open', missionChannelId: 'ch-task', createdAt: 1, branch: 'wtask/recovery', createdBy: { principalId: 'agent', verifiedWorkspaceId: 'ws' }, owner: { principalId: 'agent', verifiedWorkspaceId: 'ws' } },
  viewer: { workspaceId: 'ws', memberId: 'viewer', joinedAt: 1, historyFromSeq: 2 },
  messages: [1, 2].map((seq) => ({ channelId: 'ch-task', seq, workspaceId: 'ws', memberId: 'agent', memberName: 'Worker', postedAt: seq, text: seq === 1 ? 'Restricted old context' : 'Review requested', deliveryStatus: 'delivered' as const })),
  onClose: () => undefined,
  onOpenTask: openTask,
  composerSlot: createElement('div', { 'data-composer': true }),
};
const render = (props = base) => act(() => root.render(createElement(ChannelViewContent, props)));
const click = (selector: string) => act(() => (host.querySelector(selector) as HTMLElement).click());
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); openTask.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('task record channel', () => {
  it('starts with task context, respects history visibility, and reveals discussion on demand', () => {
    render();
    expect(host.textContent).toContain('Fix session recovery');
    expect(host.textContent).not.toContain('Restricted old context');
    expect(host.querySelector('[data-channel-latest-activity]')?.textContent).toBe('Review requested');
    expect((host.querySelector('[data-channel-view-messages]') as HTMLElement).hidden).toBe(true);
    click('[data-channel-open-task]');
    expect(openTask).toHaveBeenCalledOnce();
    click('[data-channel-activity-toggle]');
    expect((host.querySelector('[data-channel-view-messages]') as HTMLElement).hidden).toBe(false);
    click('[data-channel-activity-toggle]');
    click('[data-channel-search-toggle]');
    expect((host.querySelector('[data-channel-view-messages]') as HTMLElement).hidden).toBe(false);
  });
  it('does not present a detached or closed mission as verified completion', () => {
    render({ ...base, task: { ...(base.task as WorkTask), status: 'closed', detachedAt: 10 } });
    expect(host.querySelector('[data-channel-task-status]')?.textContent).toBe('channels.taskDetached');
    render({ ...base, task: { ...(base.task as WorkTask), status: 'closed' } });
    expect(host.querySelector('[data-channel-task-status]')?.textContent).toBe('channels.taskClosed');
  });
  it('resets disclosure when switching tasks and leaves ordinary discussions open', () => {
    render();
    click('[data-channel-activity-toggle]');
    render({ ...base, channel: { ...base.channel, id: 'second' } });
    expect((host.querySelector('[data-channel-view-messages]') as HTMLElement).hidden).toBe(true);
    render({ ...base, task: undefined });
    expect(host.querySelector('[data-channel-task-summary]')).toBeNull();
    expect((host.querySelector('[data-channel-view-messages]') as HTMLElement).hidden).toBe(false);
  });
  it('collapses long reports while keeping the full report available', () => {
    const report = 'Review findings. '.repeat(60);
    render({ ...base, messages: [{ ...base.messages[1], text: report }] });
    click('[data-channel-activity-toggle]');
    const details = host.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(report);
    act(() => details.querySelector('summary')?.click());
    expect(details.open).toBe(true);
  });

  it('keeps system notices separate from attributed activity', () => {
    render({ ...base, messages: [{ ...base.messages[1], systemKind: 'operator-join' }] });
    click('[data-channel-activity-toggle]');
    const notice = host.querySelector('[data-channel-system-message]');
    expect(notice?.textContent).toContain('channels.systemOperatorJoin');
    expect(notice?.hasAttribute('data-author-kind')).toBe(false);
  });

});
