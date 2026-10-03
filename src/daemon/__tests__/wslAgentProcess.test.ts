import { execFileSync } from 'child_process';
import fs from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { AgentProcessTracker } from '../AgentProcessTracker';
import {
  checkWslAgentRunning, parseWslAgentReport, parseWslProbeOutput, pickReportedAgent, PROBE_SCRIPT,
  reportedAgentForPane, WslPidWatcher, type WslProbe, type WslProbeResult, type WslWatchedAgent,
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
    ['oversized', report(`400:900:${'x'.repeat(9000)}`)],
  ])('rejects %s', (_label, raw) => {
    expect(parseWslAgentReport(raw)).toBeUndefined();
  });
});

describe('pickReportedAgent', () => {
  it('skips a shell hop and picks the nearest ancestor naming the agent', () => {
    const parsed = parseWslAgentReport(report(`512:1000:/bin/sh${US}-c${US}hook`, `400:900:/home/dev/.local/bin/claude`, `300:800:-bash`));
    expect(pickReportedAgent(parsed, 'claude')).toEqual({ pid: 400, start: '900', bootId: BOOT, slug: 'claude', ancestors: [300] });
  });

  it('resolves an npm-installed claude running under node', () => {
    const parsed = parseWslAgentReport(report(`400:900:node${US}/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js`));
    expect(pickReportedAgent(parsed, 'claude')?.pid).toBe(400);
  });

  // #1727 — npm's codex is a node launcher running the native binary; the
  // notify hook's parent is the native binary, which dies with the session.
  it('picks the native codex binary under its node launcher', () => {
    const parsed = parseWslAgentReport(report(
      `5001:2000:/home/dev/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex${US}-c${US}notify=x`,
      `5000:1999:node${US}/home/dev/.npm-global/bin/codex${US}-c${US}notify=x`,
    ));
    expect(pickReportedAgent(parsed, 'codex')).toEqual({ pid: 5001, start: '2000', bootId: BOOT, slug: 'codex', ancestors: [5000] });
    expect(pickReportedAgent(parsed, 'claude')).toBeUndefined();
  });

  it('picks a natively installed codex', () => {
    const parsed = parseWslAgentReport(report(`6000:3000:/usr/local/bin/codex${US}--no-daemon`, '5999:2999:-bash'));
    expect(pickReportedAgent(parsed, 'codex')?.pid).toBe(6000);
  });

  it('never accepts a different agent, or a chain without the agent', () => {
    expect(pickReportedAgent(parseWslAgentReport(report('400:900:codex')), 'claude')).toBeUndefined();
    expect(pickReportedAgent(parseWslAgentReport(report('400:900:-bash')), 'claude')).toBeUndefined();
    expect(pickReportedAgent(undefined, 'claude')).toBeUndefined();
  });
});

describe('reportedAgentForPane (the trust gate)', () => {
  const raw = report(`512:1000:/bin/sh${US}-c${US}hook`, '400:900:/home/dev/.local/bin/claude');
  const signal = { ptyId: 'p1', agent: 'claude' as const, wslAgentProcess: raw };

  it('accepts the pane own hook naming its own agent', () => {
    expect(reportedAgentForPane('p1', true, signal)?.pid).toBe(400);
  });

  it.each([
    ['a Windows pane', 'p1', false, signal],
    ['another pane (non-exact ptyId)', 'p2', true, signal],
    ['a signal with no ptyId', 'p1', true, { ...signal, ptyId: undefined }],
    ['a different agent than the hook speaks for', 'p1', true, { ...signal, agent: 'codex' as const }],
    ['no report', 'p1', true, { ...signal, wslAgentProcess: undefined }],
    ['a malformed report', 'p1', true, { ...signal, wslAgentProcess: 'junk' }],
  ])('refuses %s', (_label, id, isWsl, sig) => {
    expect(reportedAgentForPane(id, isWsl, sig)).toBeUndefined();
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
  const reported = { pid: 4321, start: '991739', bootId: BOOT, slug: 'claude' as const, ancestors: [300] };

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
    tracker.armWsl('wsl-1', LOCATION, { ...reported, pid: 5000, start: '999999' });
    oldEdge();
    expect(tracker.statusFor('wsl-1')).toBe(true);
    expect(watches.size).toBe(1);
  });

  it('keeps the tracked agent against a nested agent or a late hook from an older one', () => {
    const { tracker, states } = setup();
    tracker.armWsl('wsl-1', LOCATION, reported);
    // `claude -p` run by the pane's claude: the tracked pid is its ancestor.
    tracker.armWsl('wsl-1', LOCATION, { ...reported, pid: 6000, start: '999999', ancestors: [5999, 4321, 300] });
    // A late hook from the previous run: an older process.
    tracker.armWsl('wsl-1', LOCATION, { ...reported, pid: 3000, start: '500' });
    expect(states).toHaveLength(1);
  });

  it('a report after a distro restart replaces the tracked agent even with a smaller starttime', () => {
    const { tracker, states } = setup();
    tracker.armWsl('wsl-1', LOCATION, reported);
    tracker.armWsl('wsl-1', LOCATION, { ...reported, pid: 700, start: '10', bootId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(states).toHaveLength(2);
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

  it('isAgentRunning on a Windows pane checks the Windows pid', async () => {
    const windowsCheck = vi.fn(async () => true);
    const tracker = new AgentProcessTracker({ watch: () => undefined, unwatch: () => undefined },
      async () => [{ pid: 50, ppid: 1, name: 'bash', cmdline: 'bash' }, { pid: 51, ppid: 50, name: 'claude', cmdline: 'claude' }],
      async () => undefined, '/home/dev', { isWslSession: () => false });
    tracker.arm('win-1', 50);
    await new Promise((r) => setTimeout(r, 0));
    expect(await tracker.isAgentRunning('win-1', 'claude', windowsCheck)).toBe(true);
    expect(windowsCheck).toHaveBeenCalledWith(51);
    windowsCheck.mockResolvedValueOnce(false);
    expect(await tracker.isAgentRunning('win-1', 'claude', windowsCheck)).toBe(false);
  });

  it('leaves Windows panes on the existing walk', async () => {
    const { tracker, windowsWalk } = setup();
    tracker.arm('win-1', 4068);
    await new Promise((r) => setTimeout(r, 0));
    expect(windowsWalk).toHaveBeenCalledOnce();
  });
});

// The real probe script, run the way wsl.exe runs it, against this process.
describe.runIf(process.platform === 'linux' && fs.existsSync('/proc/sys/kernel/random/boot_id'))('PROBE_SCRIPT on Linux', () => {
  it('reports the boot id and each live pid with its state and starttime, skipping the gone', () => {
    const out = parseWslProbeOutput(execFileSync('/bin/sh', ['-c', PROBE_SCRIPT, 'wmux-ps', String(process.pid), '4194303'], { encoding: 'utf8' }));
    expect(out.bootId).toBe(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    expect(out.procs.get(process.pid)).toEqual({ state: expect.stringMatching(/^[RS]$/), start: fields[19] });
    expect(out.procs.has(4194303)).toBe(false);
  });
});
