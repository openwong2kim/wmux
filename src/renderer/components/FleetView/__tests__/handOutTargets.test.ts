import { describe, expect, it } from 'vitest';
import type { HandoffTarget } from '../../../../shared/gitHandoff';
import {
  defaultHandOutOption,
  handOutOptions,
  handOutTargets,
  type HandOutPaneCandidate,
  type HandOutWorkspaceCandidate,
} from '../handOutTargets';

const target = (id: string, agentSlug?: string, workspaceId = `ws-${id}`): HandoffTarget => ({
  workspaceId, paneId: `p-${id}`, ptyId: `pty-${id}`, agentName: agentSlug ?? '', ...(agentSlug ? { agentSlug } : {}),
});
const pane = (id: string, over: Partial<HandOutPaneCandidate> & { agent?: string; workspaceId?: string } = {}): HandOutPaneCandidate => {
  const { agent = 'claude', workspaceId, ...rest } = over;
  return { target: target(id, agent, workspaceId), name: `#${id}`, workspaceName: 'wmux', section: 'idle', ...rest };
};
const names = (panes: { name: string }[]) => panes.map((p) => p.name);
const item = { folder: '/code/wmux', agent: 'claude' };

describe('handOutTargets — Send to an agent', () => {
  it('lists idle panes (a finished turn is idle) before running ones, and never a pane that needs you', () => {
    const { panes } = handOutTargets({ folder: '/code/wmux' }, [
      pane('run', { section: 'running' }),
      pane('asking', { section: 'needsYou' }),
      pane('done', { section: 'finished' }),
      pane('idle'),
    ], []);
    expect(names(panes)).toEqual(['#done', '#idle', '#run']);
    expect(panes.map((p) => p.running)).toEqual([false, false, true]);
  });

  it('dims a pane that runs another agent than the item asks for, offers it, and puts it after the matching ones', () => {
    const { panes } = handOutTargets(item, [
      pane('codex-idle', { agent: 'codex' }),
      pane('claude-run', { section: 'running' }),
      pane('claude-idle'),
    ], []);
    expect(names(panes)).toEqual(['#claude-idle', '#claude-run', '#codex-idle']);
    expect(panes.map((p) => p.otherAgent)).toEqual([false, false, true]);
  });

  it('dims nothing when the item asks for any agent', () => {
    const { panes } = handOutTargets({ folder: '/code/wmux' }, [pane('a', { agent: 'codex' }), pane('b')], []);
    expect(panes.every((p) => !p.otherAgent)).toBe(true);
  });

  it('marks a pane working in the item\'s folder, or inside it, and lists those first among equals', () => {
    const { panes } = handOutTargets(item, [
      pane('elsewhere', { folder: '/code/wmux-web' }),
      pane('inside', { folder: '/code/wmux/src' }),
      pane('unknown'),
      pane('same', { folder: '/code/wmux/' }),
    ], []);
    expect(names(panes)).toEqual(['#inside', '#same', '#elsewhere', '#unknown']);
    expect(panes.map((p) => p.thisFolder)).toEqual([true, true, false, false]);
  });

  it('offers a company\'s CEO pane as its company, not as a pane', () => {
    const ceo = target('ceo', 'claude', 'ws-co');
    const { panes, companies } = handOutTargets(item, [pane('ceo', { workspaceId: 'ws-co' }), pane('dev', { workspaceId: 'ws-co' })], [
      { workspaceId: 'ws-co', name: 'wmux co.', folder: '/code/wmux', company: { folder: '/code/wmux', ceo } },
    ]);
    expect(names(panes)).toEqual(['#dev']);
    expect(companies.map((c) => [c.name, c.target.paneId])).toEqual([['wmux co.', 'p-ceo']]);
  });

  it('never offers the coordinator pane as a pane, even when no CEO target resolved', () => {
    const { panes, companies } = handOutTargets(item, [pane('ceo', { workspaceId: 'ws-co' }), pane('dev', { workspaceId: 'ws-co' })], [
      { workspaceId: 'ws-co', name: 'wmux co.', folder: '/code/wmux', company: { folder: '/code/wmux', coordinatorPaneId: 'p-ceo' } },
    ]);
    expect(names(panes)).toEqual(['#dev']);
    expect(companies).toEqual([]);
  });
});

describe('handOutTargets — Start in a new worktree', () => {
  const ws = (id: string, folder?: string, company?: HandOutWorkspaceCandidate['company']): HandOutWorkspaceCandidate =>
    ({ workspaceId: id, name: id, ...(folder ? { folder } : {}), ...(company ? { company } : {}) });

  it('is offered only when an open workspace\'s folder holds the item\'s', () => {
    expect(handOutTargets(item, [], [ws('web', '/code/wmux-web'), ws('none')]).worktree).toBeNull();
    expect(handOutTargets({ folder: '/code/wmux/src' }, [], [ws('wmux', '/code/wmux')]).worktree)
      .toEqual({ kind: 'worktree', key: 'worktree:wmux', workspaceId: 'wmux', folder: '/code/wmux' });
  });

  it('runs from the workspace whose folder is closest, a plain one before a company on a tie', () => {
    const picked = handOutTargets({ folder: '/code/wmux/src' }, [], [
      ws('root', '/code'),
      ws('co', '/code/wmux', { folder: '/code/wmux' }),
      ws('plain', '/code/wmux'),
    ]).worktree;
    expect(picked?.workspaceId).toBe('plain');
  });
});

describe('handOutTargets — Give to a company', () => {
  const ceo = target('ceo', 'claude', 'ws-co');

  it('offers a company whose folder holds the item\'s and whose CEO pane runs an agent', () => {
    const companies = handOutTargets({ folder: '/code/wmux/docs' }, [], [
      { workspaceId: 'ws-co', name: 'wmux co.', company: { folder: '/code/wmux', ceo } },
      { workspaceId: 'ws-web', name: 'web co.', company: { folder: '/code/wmux-web', ceo: target('ceo2', 'claude', 'ws-web') } },
      { workspaceId: 'ws-vacant', name: 'vacant co.', company: { folder: '/code/wmux' } },
    ]).companies;
    expect(companies.map((c) => c.workspaceId)).toEqual(['ws-co']);
  });
});

describe('the popover\'s options', () => {
  it('run panes, the worktree, then the companies, and start on the first that is not dimmed', () => {
    const targets = handOutTargets(item, [pane('codex', { agent: 'codex' })], [
      { workspaceId: 'ws-plain', name: 'wmux', folder: '/code/wmux' },
    ]);
    const options = handOutOptions(targets);
    expect(options.map((o) => o.kind)).toEqual(['pane', 'worktree']);
    expect(defaultHandOutOption(options)?.kind).toBe('worktree');
    expect(defaultHandOutOption(handOutOptions(handOutTargets(item, [pane('codex', { agent: 'codex' })], [])))?.kind).toBe('pane');
    expect(defaultHandOutOption([])).toBeUndefined();
  });
});
