import { describe, it, expect, vi } from 'vitest';
import { AGENT_DEATH_LAG_MS, paneForegroundProbe, type PaneForegroundApi } from '../paneForegroundProbe';

function api(over: Partial<PaneForegroundApi>): PaneForegroundApi {
  return {
    resources: vi.fn(async () => ({})),
    list: vi.fn(async () => []),
    ...over,
  };
}

describe('paneForegroundProbe (#1794 review item 1)', () => {
  it('Windows: a shell with no descendant is gone', async () => {
    // Even while pty.list still says a command runs (a reading from before the prompt).
    const a = api({
      resources: async () => ({ p1: { rss: 1 } }),
      list: async () => [{ id: 'p1', commandRunning: true }],
    });
    expect(await paneForegroundProbe('p1', a)({ promptAt: 0 })).toBe(true);
  });

  it('WSL pane: the Windows tree cannot see its Linux processes, so it is not asked', async () => {
    const resources = vi.fn(async () => ({ p1: { rss: 1 } }));
    const a = api({
      resources,
      list: async () => [{ id: 'p1', commandRunning: false, wslTarget: { distro: 'Ubuntu' }, liveAgent: 'claude' }],
    });
    expect(await paneForegroundProbe('p1', a, () => AGENT_DEATH_LAG_MS)({ promptAt: 0 })).toBe(false);
    expect(resources).not.toHaveBeenCalled();
    const b = api({ resources, list: async () => [{ id: 'p1', commandRunning: false, wslTarget: { distro: 'Ubuntu' } }] });
    expect(await paneForegroundProbe('p1', b)({ promptAt: 0 })).toBe(true);
  });

  it('a failing pty.list still lets the tree answer; neither answering is unknown', async () => {
    const a = api({ list: async () => { throw new Error('x'); }, resources: async () => ({ p1: { rss: 1, image: 'node.exe' } }) });
    expect(await paneForegroundProbe('p1', a)({ promptAt: 0 })).toBe(false);
    const b = api({ list: async () => { throw new Error('x'); } });
    expect(await paneForegroundProbe('p1', b)({ promptAt: 0 })).toBeUndefined();
  });

  it('Windows: any descendant (a Start-Process background TUI) is alive', async () => {
    const a = api({ resources: async () => ({ p1: { rss: 9, image: 'node.exe' } }) });
    expect(await paneForegroundProbe('p1', a)({ promptAt: 0 })).toBe(false);
  });

  it('no tree (non-Windows / failure): at a prompt with no live agent is gone', async () => {
    const a = api({ list: async () => [{ id: 'p1', commandRunning: false }] });
    expect(await paneForegroundProbe('p1', a)({ promptAt: 0 })).toBe(true);
  });

  it('a failing tree request falls back to pty.list', async () => {
    const a = api({
      resources: async () => { throw new Error('ipc'); },
      list: async () => [{ id: 'p1', commandRunning: false }],
    });
    expect(await paneForegroundProbe('p1', a)({ promptAt: 0 })).toBe(true);
  });

  it('OSC 133 state that is unknown or predates the prompt is unknown', async () => {
    expect(await paneForegroundProbe('p1', api({ list: async () => [{ id: 'p1' }] }))({ promptAt: 0 })).toBeUndefined();
    expect(await paneForegroundProbe('p1', api({ list: async () => [{ id: 'p1', commandRunning: true }] }))({ promptAt: 0 })).toBeUndefined();
    expect(await paneForegroundProbe('p1', api({ list: async () => [] }))({ promptAt: 0 })).toBeUndefined();
    expect(await paneForegroundProbe('p1', api({ list: async () => { throw new Error('x'); } }))({ promptAt: 0 })).toBeUndefined();
  });

  it('a live agent (Ctrl+Z / background) is unknown inside the tracker lag, alive after it', async () => {
    const a = api({ list: async () => [{ id: 'p1', commandRunning: false, liveAgent: 'claude' }] });
    expect(await paneForegroundProbe('p1', a, () => 1000)({ promptAt: 0 })).toBeUndefined();
    expect(await paneForegroundProbe('p1', a, () => AGENT_DEATH_LAG_MS)({ promptAt: 0 })).toBe(false);
    const b = api({ list: async () => [{ id: 'p1', commandRunning: false, agentProcessAlive: true }] });
    expect(await paneForegroundProbe('p1', b, () => AGENT_DEATH_LAG_MS + 1)({ promptAt: 0 })).toBe(false);
  });

  it('an agent the tracker saw die is gone', async () => {
    const a = api({ list: async () => [{ id: 'p1', commandRunning: false, agentProcessAlive: false }] });
    expect(await paneForegroundProbe('p1', a)({ promptAt: 0 })).toBe(true);
  });
});
