import { describe, expect, it, vi } from 'vitest';
import { AgentProcessTracker } from '../AgentProcessTracker';
import {
  checkWslAgentRunning, parseWslAgentReport, parseWslProbeOutput, pickReportedAgent,
  WslPidWatcher, type WslProbe, type WslProbeResult, type WslWatchedAgent,
} from '../wslAgentProcess';

const RS = '\x1e';
const US = '\x1f';
const BOOT = '0f6a7c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const report = (...records: string[]) => [`1:${BOOT}`, ...records].join(RS);
const TARGET = { distribution: 'Ubuntu', user: 'dev' };
const LOCATION = { shell: 'C:\\Windows\\System32\\wsl.exe', target: TARGET, hostPid: 4068 };
const agent = (over: Partial<WslWatchedAgent> = {}): WslWatchedAgent =>
  ({ ...LOCATION, pid: 4321, start: '991739', bootId: BOOT, ...over });
const result = (procs: Array<[number, string, string]>, bootId = BOOT): WslProbeResult =>
  ({ bootId, procs: new Map(procs.map(([pid, state, start]) => [pid, { state, start }])) });

describe('parseWslAgentReport', () => {
  it('reads the boot id and the ancestor chain, nearest first', () => {
    expect(parseWslAgentReport(report(`512:1000:/bin/sh${US}-c${US}x`, `400:900:claude${US}--resume${US}a:b`))).toEqual({
      bootId: BOOT,
      chain: [
        { pid: 512, start: '1000', cmdline: '/bin/sh -c x' },
        // A ':' inside the command line belongs to the command line.
        { pid: 400, start: '900', cmdline: 'claude --resume a:b' },
      ],
    });
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['unknown version', `2:${BOOT}${RS}1:2:claude`],
    ['bad boot id', `1:not-a-uuid${RS}400:900:claude`],
    ['no ancestors', `1:${BOOT}`],
    ['non-numeric pid', report('abc:900:claude')],
    ['non-numeric start', report('400:9x:claude')],
    ['pid 1 (init)', report('1:900:init')],
    ['pid beyond pid_max', report('99999999:900:claude')],
    ['missing fields', report('400:claude')],
    ['oversized', report(`400:900:${'x'.repeat(5000)}`)],
  ])('rejects %s', (_label, raw) => {
    expect(parseWslAgentReport(raw)).toBeUndefined();
  });
});

describe('pickReportedAgent', () => {
  it('skips a shell hop and picks the nearest ancestor naming the agent', () => {
    const parsed = parseWslAgentReport(report(`512:1000:/bin/sh${US}-c${US}hook`, `400:900:/home/dev/.local/bin/claude`, `300:800:-bash`));
    expect(pickReportedAgent(parsed, 'claude')).toEqual({ pid: 400, start: '900', bootId: BOOT, slug: 'claude' });
  });

  it('resolves an npm-installed claude running under node', () => {
    const parsed = parseWslAgentReport(report(`400:900:node${US}/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js`));
    expect(pickReportedAgent(parsed, 'claude')?.pid).toBe(400);
  });

  it('never accepts a different agent, or a chain without the agent', () => {
    expect(pickReportedAgent(parseWslAgentReport(report('400:900:codex')), 'claude')).toBeUndefined();
    expect(pickReportedAgent(parseWslAgentReport(report('400:900:-bash')), 'claude')).toBeUndefined();
    expect(pickReportedAgent(undefined, 'claude')).toBeUndefined();
  });
});

describe('parseWslProbeOutput', () => {
  it('reads the boot id and each stat line', () => {
    const out = parseWslProbeOutput(`B ${BOOT.toUpperCase()}\nP 4321 S 991739\nP 4400 Z 12\ngarbage\n`);
    expect(out.bootId).toBe(BOOT);
    expect([...out.procs]).toEqual([[4321, { state: 'S', start: '991739' }], [4400, { state: 'Z', start: '12' }]]);
  });

  it('refuses output with no boot id', () => {
    expect(() => parseWslProbeOutput('P 4321 S 1\n')).toThrow();
  });
});

describe('checkWslAgentRunning', () => {
  const probeWith = (r: WslProbeResult | Error): WslProbe => vi.fn(async () => { if (r instanceof Error) throw r; return r; });

  it('is true only for the same, running process', async () => {
    expect(await checkWslAgentRunning(agent(), probeWith(result([[4321, 'S', '991739']])), () => true)).toBe(true);
    expect(await checkWslAgentRunning(agent(), probeWith(result([[4321, 'R', '991739']])), () => true)).toBe(true);
  });

  it.each([
    ['gone', result([])],
    ['reused pid (other starttime)', result([[4321, 'S', '5']])],
    ['rebooted distro', result([[4321, 'S', '991739']], 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')],
    ['zombie', result([[4321, 'Z', '991739']])],
    ['stopped (Ctrl+Z)', result([[4321, 'T', '991739']])],
    ['probe failure', new Error('interop down')],
  ])('is false when %s', async (_label, r) => {
    expect(await checkWslAgentRunning(agent(), probeWith(r), () => true)).toBe(false);
  });

  it('never probes (never boots the distro) once the pane wsl.exe is gone', async () => {
    const probe = probeWith(result([[4321, 'S', '991739']]));
    expect(await checkWslAgentRunning(agent(), probe, () => false)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('WslPidWatcher', () => {
  it('batches one probe per distro+user and fires only the dead', async () => {
    const probe = vi.fn<WslProbe>(async (_shell, target) => target.distribution === 'Ubuntu'
      ? result([[4321, 'S', '991739']])
      : result([[77, 'S', '1']]));
    const watcher = new WslPidWatcher(probe, () => true, 60_000);
    const dead: string[] = [];
    watcher.watch('a', agent(), () => dead.push('a'));
    watcher.watch('b', agent({ pid: 9999 }), () => dead.push('b'));
    watcher.watch('c', agent({ pid: 77, start: '1', target: { distribution: 'Debian', user: 'dev' } }), () => dead.push('c'));

    await watcher.tick();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls.find(([, t]) => t.distribution === 'Ubuntu')?.[2]).toEqual([4321, 9999]);
    expect(dead).toEqual(['b']);
    watcher.unwatch('a');
    watcher.unwatch('c');
  });

  it('treats a stopped agent as alive and a zombie as dead', async () => {
    const watcher = new WslPidWatcher(async () => result([[4321, 'T', '991739'], [5000, 'Z', '1']]), () => true, 60_000);
    const dead: string[] = [];
    watcher.watch('stopped', agent(), () => dead.push('stopped'));
    watcher.watch('zombie', agent({ pid: 5000, start: '1' }), () => dead.push('zombie'));
    await watcher.tick();
    expect(dead).toEqual(['zombie']);
    watcher.unwatch('stopped');
  });

  it('fires without spawning when the pane wsl.exe is gone', async () => {
    const probe = vi.fn<WslProbe>(async () => result([]));
    const watcher = new WslPidWatcher(probe, () => false, 60_000);
    const onDead = vi.fn();
    watcher.watch('a', agent(), onDead);
    await watcher.tick();
    expect(onDead).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
  });

  it('never calls a failed probe a death', async () => {
    const watcher = new WslPidWatcher(async () => { throw new Error('timeout'); }, () => true, 60_000);
    const onDead = vi.fn();
    watcher.watch('a', agent(), onDead);
    await watcher.tick();
    expect(onDead).not.toHaveBeenCalled();
    watcher.unwatch('a');
  });

  it('does not fire an entry replaced while its probe ran', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const watcher = new WslPidWatcher(async () => { await gate; return result([]); }, () => true, 60_000);
    const first = vi.fn();
    const second = vi.fn();
    watcher.watch('a', agent(), first);
    const pass = watcher.tick();
    watcher.watch('a', agent({ pid: 5555 }), second);
    release();
    await pass;
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    watcher.unwatch('a');
  });
});

describe('AgentProcessTracker in a WSL pane', () => {
  function setup(running = true) {
    const windowsWalk = vi.fn(async () => [{ pid: 9, ppid: 4068, name: 'wmux.exe', cmdline: 'wmux.exe mcp-bundle' }]);
    const watches = new Map<string, () => void>();
    const isRunning = vi.fn(async () => running);
    const tracker = new AgentProcessTracker(
      { watch: () => undefined, unwatch: () => undefined }, windowsWalk, async () => undefined, '/home/dev', {
        isWslSession: (id) => id.startsWith('wsl-'),
        watcher: { watch: (key, _a, onDead) => watches.set(key, onDead), unwatch: (key) => watches.delete(key) },
        isRunning,
      });
    const states: unknown[] = [];
    tracker.setStateChangeListener((_id, s) => states.push(s));
    return { tracker, windowsWalk, watches, isRunning, states };
  }
  const reported = { pid: 4321, start: '991739', bootId: BOOT, slug: 'claude' as const };

  it('never takes the Windows tree walk', async () => {
    const { tracker, windowsWalk } = setup();
    tracker.arm('wsl-1', 4068);
    tracker.rearm('wsl-1', 4068);
    tracker.armIfAgent('wsl-1', 4068);
    await new Promise((r) => setTimeout(r, 0));
    expect(windowsWalk).not.toHaveBeenCalled();
    expect(tracker.identityFor('wsl-1')).toBeUndefined();
  });

  it('attributes the reported agent, ignores a repeat, and flips on its death edge', () => {
    const { tracker, watches, states } = setup();
    tracker.armWsl('wsl-1', LOCATION, reported);
    tracker.armWsl('wsl-1', LOCATION, reported); // hook storm: no re-watch, no event
    expect(tracker.identityFor('wsl-1')).toEqual({ slug: 'claude', alive: true });
    expect(states).toEqual([{ slug: 'claude', alive: true }]);
    // A Linux pid must never reach a Windows process check.
    expect(tracker.pidFor('wsl-1')).toBeUndefined();

    watches.get('agent:wsl-1')!();
    expect(tracker.statusFor('wsl-1')).toBe(false);
    expect(states).toEqual([{ slug: 'claude', alive: true }, { slug: 'claude', alive: false }]);
  });

  it('a relaunched agent replaces the old one, and the old death edge is ignored', () => {
    const { tracker, watches } = setup();
    tracker.armWsl('wsl-1', LOCATION, reported);
    const oldEdge = watches.get('agent:wsl-1')!;
    tracker.armWsl('wsl-1', LOCATION, { ...reported, pid: 5000, start: '2' });
    oldEdge();
    expect(tracker.statusFor('wsl-1')).toBe(true);
  });

  it('disarm drops the WSL watch', () => {
    const { tracker, watches } = setup();
    tracker.armWsl('wsl-1', LOCATION, reported);
    tracker.disarm('wsl-1');
    expect(watches.has('agent:wsl-1')).toBe(false);
    expect(tracker.identityFor('wsl-1')).toBeUndefined();
  });

  it('isAgentRunning checks inside the distro, and refuses the wrong agent or a dead one', async () => {
    const { tracker, isRunning, watches } = setup();
    const windowsCheck = vi.fn(async () => true);
    expect(await tracker.isAgentRunning('wsl-1', 'claude', windowsCheck)).toBe(false); // never attributed
    tracker.armWsl('wsl-1', LOCATION, reported);
    expect(await tracker.isAgentRunning('wsl-1', 'claude', windowsCheck)).toBe(true);
    expect(isRunning).toHaveBeenCalledWith(expect.objectContaining({ pid: 4321, start: '991739', bootId: BOOT, hostPid: 4068 }));
    expect(windowsCheck).not.toHaveBeenCalled();
    expect(await tracker.isAgentRunning('wsl-1', 'codex', windowsCheck)).toBe(false);
    watches.get('agent:wsl-1')!();
    expect(await tracker.isAgentRunning('wsl-1', 'claude', windowsCheck)).toBe(false);
  });

  it('isAgentRunning is false when the fresh in-distro check says no', async () => {
    const { tracker } = setup(false);
    tracker.armWsl('wsl-1', LOCATION, reported);
    expect(await tracker.isAgentRunning('wsl-1', 'claude', async () => true)).toBe(false);
  });

  it('leaves Windows panes on the existing walk', async () => {
    const { tracker, windowsWalk } = setup();
    tracker.arm('win-1', 4068);
    await new Promise((r) => setTimeout(r, 0));
    expect(windowsWalk).toHaveBeenCalledOnce();
  });
});
