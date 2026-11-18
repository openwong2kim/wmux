import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/fake' } }));
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../brokerProbe', () => ({ canConnectBrokerPipe: vi.fn(async () => false), probeBrokerPipe: vi.fn() }));

import * as fs from 'fs';
import { spawn } from 'child_process';
import { probeBrokerPipe } from '../brokerProbe';
import { BrokerSupervisor, isMcpBrokerEnabled, resetBrokerSettingForTests } from '../BrokerSupervisor';
import { BROKER_DEFAULT_ON } from '../../../shared/mcpBroker';

interface FakeChild extends EventEmitter {
  pid: number;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  connected: boolean;
  send: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.pid = 4321;
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  c.connected = true;
  c.send = vi.fn();
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(true);
});

describe('isMcpBrokerEnabled', () => {
  beforeEach(() => resetBrokerSettingForTests({ setting: 'default' }));

  // On whichever OS runs the suite (CI covers all three): '1' and '0' win, and
  // unset (or any other value) follows the platform default — on for macOS
  // and Linux, off for Windows.
  const platformOn = BROKER_DEFAULT_ON.includes(process.platform);
  it.each([[undefined, platformOn], ['0', false], ['false', false], ['1', true], ['true', true], ['', platformOn]] as const)(
    'WMUX_MCP_BROKER=%s → %s',
    (value, on) => {
      const saved = process.env.WMUX_MCP_BROKER;
      try {
        if (value === undefined) delete process.env.WMUX_MCP_BROKER;
        else process.env.WMUX_MCP_BROKER = value;
        expect(isMcpBrokerEnabled()).toBe(on);
      } finally {
        if (saved === undefined) delete process.env.WMUX_MCP_BROKER;
        else process.env.WMUX_MCP_BROKER = saved;
      }
    },
  );
});

describe('isMcpBrokerEnabled with a Settings choice', () => {
  it.each([
    ['on', undefined, true],
    ['off', undefined, false],
    ['on', '0', false],
    ['off', '1', true],
  ] as const)('Settings %s, WMUX_MCP_BROKER=%s → %s', (setting, value, on) => {
    const saved = process.env.WMUX_MCP_BROKER;
    try {
      resetBrokerSettingForTests({ setting });
      if (value === undefined) delete process.env.WMUX_MCP_BROKER;
      else process.env.WMUX_MCP_BROKER = value;
      expect(isMcpBrokerEnabled()).toBe(on);
    } finally {
      resetBrokerSettingForTests();
      if (saved === undefined) delete process.env.WMUX_MCP_BROKER;
      else process.env.WMUX_MCP_BROKER = saved;
    }
  });
});

describe('BrokerSupervisor.whenReady', () => {
  it('resolves true once the pipe accepts a connection', async () => {
    vi.mocked(probeBrokerPipe).mockResolvedValue('ours');
    const sup = new BrokerSupervisor();
    await expect(sup.whenReady(4000)).resolves.toBe(true);
  });

  it('resolves false when the deadline elapses with no connection', async () => {
    vi.useFakeTimers();
    vi.mocked(probeBrokerPipe).mockResolvedValue('none');
    const sup = new BrokerSupervisor();
    const p = sup.whenReady(600);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('resolves false promptly when the broker script was missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false); // getBrokerScriptPath → null
    const sup = new BrokerSupervisor();
    sup.start(); // bails, sets scriptMissing
    expect(spawn).not.toHaveBeenCalled();
    await expect(sup.whenReady(4000)).resolves.toBe(false);
    expect(probeBrokerPipe).not.toHaveBeenCalled();
  });
});

describe('BrokerSupervisor: something that is not a socket at the broker path', () => {
  it('does not restart a broker that exited for it (78), and reports the broker down', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('none');
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('exit', 78, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sup.status().running).toBe(false);
    expect(sup.status().downReason).toBe('path-occupied');
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor: a pipe another owner holds (Windows owner verdicts)', () => {
  it('whenReady is never true for it, and stops waiting at once', async () => {
    vi.mocked(probeBrokerPipe).mockResolvedValue('foreign');
    const sup = new BrokerSupervisor();
    await expect(sup.whenReady(4000)).resolves.toBe(false);
    expect(probeBrokerPipe).toHaveBeenCalledTimes(1);
  });

  it('whenReady keeps polling through busy, and is true once the pipe is ours', async () => {
    vi.useFakeTimers();
    vi.mocked(probeBrokerPipe).mockResolvedValueOnce('busy').mockResolvedValueOnce('none').mockResolvedValue('ours');
    const sup = new BrokerSupervisor();
    const p = sup.whenReady(4000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(true);
    expect(probeBrokerPipe).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('a stood-down supervisor whose probe finds another owner stops for good (path-occupied), with no restart loop', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('foreign');
    const off = { clear: vi.fn(), tripped: vi.fn(async () => undefined) };
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    first.emit('exit', 75, null);
    expect(sup.status().downReason).toBe('standing-down');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(sup.status()).toMatchObject({ running: false, standingDown: false, downReason: 'path-occupied' });
    expect(off.tripped).toHaveBeenCalledTimes(1);
    const probes = vi.mocked(probeBrokerPipe).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(probeBrokerPipe).mock.calls.length).toBe(probes);
    sup.stop();
    vi.useRealTimers();
  });

  it('a busy probe keeps standing down for up to 7 probes in a row: no reclaim, no terminal state', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('busy');
    const off = { clear: vi.fn(), tripped: vi.fn(async () => undefined) };
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    first.emit('exit', 75, null);
    await vi.advanceTimersByTimeAsync(7 * 15_000 + 1000);
    expect(probeBrokerPipe).toHaveBeenCalledTimes(7);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sup.status().downReason).toBe('standing-down');
    expect(off.tripped).not.toHaveBeenCalled();
    sup.stop();
    vi.useRealTimers();
  });

  it('a pipe that stays busy for 8 probes in a row counts as held elsewhere (path-occupied), without marking the broker off', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('busy');
    const off = { clear: vi.fn(), tripped: vi.fn(async () => undefined) };
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    first.emit('exit', 75, null);
    await vi.advanceTimersByTimeAsync(8 * 15_000 + 1000);
    expect(sup.status()).toMatchObject({ running: false, standingDown: false, downReason: 'path-occupied' });
    // A busy pipe may be our own broker at its instance cap: launchers keep
    // dialling it (a busy name costs them at most a short wait).
    expect(off.tripped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(probeBrokerPipe).toHaveBeenCalledTimes(8);
    expect(spawn).toHaveBeenCalledTimes(1);
    sup.stop();
    vi.useRealTimers();
  });

  it('an owner check that cannot run (unknown) never ends in the terminal state; 8 in a row start a broker to bind the pipe', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    const third = makeChild();
    vi.mocked(spawn)
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never)
      .mockReturnValueOnce(third as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('unknown');
    const off = { clear: vi.fn(), tripped: vi.fn(async () => undefined) };
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    first.emit('exit', 75, null);
    await vi.advanceTimersByTimeAsync(7 * 15_000 + 1000);
    expect(probeBrokerPipe).toHaveBeenCalledTimes(7);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sup.status().downReason).toBe('standing-down');
    // The 8th: the broker's own check decides. It finds the pipe held and
    // stands down again, and the count starts over.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    second.emit('exit', 75, null);
    expect(sup.status().downReason).toBe('standing-down');
    await vi.advanceTimersByTimeAsync(7 * 15_000 + 1000);
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(off.tripped).not.toHaveBeenCalled();
    expect(sup.status().downReason).not.toBe('path-occupied');
    sup.stop();
    vi.useRealTimers();
  });

  it('unknown probes between busy ones neither count nor reset: 8 busy still end it', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    const answers = ['busy', 'unknown', 'busy', 'unknown', 'busy', 'busy', 'unknown', 'busy', 'busy', 'busy', 'unknown', 'busy'] as const;
    let i = 0;
    vi.mocked(probeBrokerPipe).mockImplementation(async () => answers[Math.min(i++, answers.length - 1)]);
    const sup = new BrokerSupervisor({ brokerOff: { clear: vi.fn(), tripped: vi.fn(async () => undefined) } });
    sup.start();
    first.emit('exit', 75, null);
    await vi.advanceTimersByTimeAsync(11 * 15_000 + 1000);
    expect(sup.status().downReason).toBe('standing-down');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sup.status().downReason).toBe('path-occupied');
    sup.stop();
    vi.useRealTimers();
  });

  it('busy probes count only in a row: one answer in between starts the count again', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    const answers = ['busy', 'busy', 'busy', 'busy', 'busy', 'busy', 'busy', 'ours', 'busy', 'busy', 'busy', 'busy', 'busy', 'busy', 'busy'] as const;
    let i = 0;
    vi.mocked(probeBrokerPipe).mockImplementation(async () => answers[Math.min(i++, answers.length - 1)]);
    const sup = new BrokerSupervisor({ brokerOff: { clear: vi.fn(), tripped: vi.fn(async () => undefined) } });
    sup.start();
    first.emit('exit', 75, null);
    await vi.advanceTimersByTimeAsync(answers.length * 15_000 + 1000);
    expect(sup.status().downReason).toBe('standing-down');
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor: a broker whose peer self-check never passed', () => {
  it('does not restart a broker that exited for it (79), marks it off, and reports why', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    const off = { clear: vi.fn(), tripped: vi.fn(async () => undefined) };
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    first.emit('exit', 79, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(off.tripped).toHaveBeenCalledTimes(1);
    expect(sup.status()).toMatchObject({ running: false, downReason: 'peer-unavailable', crashExits: 0 });
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor exit-75 reclaim (W2)', () => {
  it('reclaims the pipe when a probe finds the other broker gone', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('none'); // pipe orphaned
    const sup = new BrokerSupervisor();
    sup.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    first.emit('exit', 75, null); // stand down + arm reclaim probe
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probeBrokerPipe).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2); // reclaimed
    sup.stop();
    vi.useRealTimers();
  });

  it('keeps standing down while the pipe stays owned', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('ours'); // still owned
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('exit', 75, null);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(spawn).toHaveBeenCalledTimes(1); // never reclaimed
    sup.stop();
    vi.useRealTimers();
  });

  it('start() while a reclaim timer is armed clears it (no interval leak)', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    // Broker stays reachable, so reclaimTick would never clear the timer itself.
    vi.mocked(probeBrokerPipe).mockResolvedValue('ours');
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('exit', 75, null); // arm reclaim probe, child now null
    // Directly re-invoking start() (defensive path) must tear the timer down.
    sup.start();
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probeBrokerPipe).not.toHaveBeenCalled(); // interval was cleared, never ticked
    sup.stop();
    vi.useRealTimers();
  });

  it('stop() clears the reclaim probe timer', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('none');
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('exit', 75, null); // arm reclaim probe
    sup.stop(); // must clear it before the first tick
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probeBrokerPipe).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor status', () => {
  it('spawns the broker with an IPC channel and stdout still ignored', () => {
    vi.mocked(spawn).mockReturnValue(makeChild() as never);
    const sup = new BrokerSupervisor();
    sup.start();
    const opts = vi.mocked(spawn).mock.calls[0][2] as { stdio: unknown[] };
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe', 'ipc']);
    sup.stop();
  });

  it('spawns the broker without a WMUX_SOCKET_PATH main inherited, keeping the data suffix', () => {
    const saved = { path: process.env.WMUX_SOCKET_PATH, suffix: process.env.WMUX_DATA_SUFFIX };
    process.env.WMUX_SOCKET_PATH = '/tmp/another-instance.sock';
    process.env.WMUX_DATA_SUFFIX = '-x';
    try {
      vi.mocked(spawn).mockReturnValue(makeChild() as never);
      const sup = new BrokerSupervisor();
      sup.start();
      const opts = vi.mocked(spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect('WMUX_SOCKET_PATH' in opts.env).toBe(false);
      expect(opts.env.WMUX_DATA_SUFFIX).toBe('-x');
      expect(opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
      sup.stop();
    } finally {
      for (const [key, value] of [['WMUX_SOCKET_PATH', saved.path], ['WMUX_DATA_SUFFIX', saved.suffix]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('passes config.json mcp.broker limits at each start, and reports them', () => {
    vi.mocked(spawn).mockReturnValue(makeChild() as never);
    const readLimits = vi.fn(() => ({
      limits: { maxSessions: 10, maxRssMb: null, maxBrowserReplRunners: null },
      ignored: ['mcp.broker.maxRssMb'],
    }));
    const sup = new BrokerSupervisor({ readLimits });
    expect(sup.status().limits).toBeUndefined();
    sup.start();
    const opts = vi.mocked(spawn).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(JSON.parse(opts.env.WMUX_MCP_BROKER_LIMITS as string)).toEqual({ maxSessions: 10, maxRssMb: null, maxBrowserReplRunners: null });
    expect(sup.status()).toMatchObject({
      limits: { maxSessions: 10, maxRssMb: null, maxBrowserReplRunners: null },
      ignoredLimits: ['mcp.broker.maxRssMb'],
    });
    expect(readLimits).toHaveBeenCalledTimes(1);
    sup.stop();
  });

  it('spawns the broker with the signal-opened inspector off, before its script', () => {
    vi.mocked(spawn).mockReturnValue(makeChild() as never);
    const sup = new BrokerSupervisor();
    sup.start();
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args[0]).toBe('--disable-sigusr1');
    expect(args).toHaveLength(2);
    sup.stop();
  });

  it('takes the connection count only from the exact report shape', () => {
    const child = makeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const sup = new BrokerSupervisor();
    sup.start();
    child.emit('message', { wmuxBroker: 'connections', open: 3 });
    expect(sup.status().connections).toBe(3);
    for (const bad of [
      { wmuxBroker: 'connections', open: -1 },
      { wmuxBroker: 'connections', open: 1.5 },
      { wmuxBroker: 'connections', open: '7' },
      { wmuxBroker: 'connections', open: 7, extra: 1 },
      { wmuxBroker: 'other', open: 7 },
      [7],
      'connections=7',
      null,
    ]) {
      child.emit('message', bad);
    }
    expect(sup.status().connections).toBe(3);
    sup.stop();
  });

  it('counts crash exits and stand-downs apart, and an exit drops the connections', () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('ours');
    const sup = new BrokerSupervisor();
    sup.start();
    expect(sup.status()).toMatchObject({ running: true, pid: 4321, crashExits: 0, standDowns: 0, standingDown: false });
    first.emit('message', { wmuxBroker: 'connections', open: 2 });
    first.emit('exit', 1, null);
    expect(sup.status()).toMatchObject({ running: false, pid: null, connections: 0, crashExits: 1 });
    vi.advanceTimersByTime(500); // backoff restart
    second.emit('exit', 75, null);
    expect(sup.status()).toMatchObject({ running: false, crashExits: 1, standDowns: 1, standingDown: true });
    sup.stop();
    vi.useRealTimers();
  });

  it('counts a failed spawn once, apart from crashes, and an exit after stop() not at all', () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('error', new Error('EPERM'));
    first.emit('exit', null, null);
    expect(sup.status()).toMatchObject({ spawnFailures: 1, crashExits: 0 });
    vi.advanceTimersByTime(500);
    sup.stop();
    second.emit('exit', null, 'SIGTERM');
    expect(sup.status()).toMatchObject({ spawnFailures: 1, crashExits: 0 });
    vi.useRealTimers();
  });

  it('reports uptime from the current child start', () => {
    vi.useFakeTimers();
    vi.mocked(spawn).mockReturnValue(makeChild() as never);
    const sup = new BrokerSupervisor();
    expect(sup.status()).toMatchObject({ running: false, uptimeS: null });
    sup.start();
    vi.advanceTimersByTime(65_000);
    expect(sup.status().uptimeS).toBe(65);
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor down reason', () => {
  it('names why the broker is not running, and nothing while it runs', () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    const sup = new BrokerSupervisor();
    expect(sup.status().downReason).toBe('not-started');
    sup.start();
    expect(sup.status().downReason).toBeNull();
    first.emit('exit', 1, null);
    expect(sup.status().downReason).toBe('restarting');
    vi.advanceTimersByTime(500);
    expect(sup.status().downReason).toBeNull();
    sup.stop();
    expect(sup.status().downReason).toBe('stopped');
    vi.useRealTimers();
  });

  it('says the script is missing when there is none to start', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const sup = new BrokerSupervisor();
    sup.start();
    expect(sup.status().downReason).toBe('script-missing');
  });

  it('says it stands down while another broker serves the pipe', () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('ours');
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('exit', 75, null);
    expect(sup.status().downReason).toBe('standing-down');
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor after an aborted teardown', () => {
  // stop() then resume() spawns a replacement before the old child has exited.
  // The old child's late exit or error must not touch the replacement.
  it.each([
    ['a crash exit', (old: FakeChild) => old.emit('exit', 1, null)],
    ['a stand-down exit', (old: FakeChild) => old.emit('exit', 75, null)],
    ['a spawn error', (old: FakeChild) => old.emit('error', new Error('EPERM'))],
  ])('ignores the old child\'s %s', async (_label, late) => {
    vi.useFakeTimers();
    const old = makeChild();
    const replacement = makeChild();
    replacement.pid = 5555;
    vi.mocked(spawn).mockReturnValueOnce(old as never).mockReturnValueOnce(replacement as never);
    vi.mocked(probeBrokerPipe).mockResolvedValue('none');
    const sup = new BrokerSupervisor();
    sup.start();
    sup.stop();
    sup.resume();
    replacement.emit('message', { wmuxBroker: 'connections', open: 2 });
    const before = sup.status();
    expect(before).toMatchObject({ running: true, pid: 5555, connections: 2 });

    late(old);
    expect(sup.status()).toEqual(before);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawn).toHaveBeenCalledTimes(2); // no restart scheduled
    expect(probeBrokerPipe).not.toHaveBeenCalled(); // no reclaim probe
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor crash-loop breaker', () => {
  function effects() {
    return { clear: vi.fn(), tripped: vi.fn(async () => undefined) };
  }

  /** Each spawn returns a fresh child; `children` holds them in order. */
  function spawning() {
    const children: FakeChild[] = [];
    vi.mocked(spawn).mockImplementation((() => {
      const c = makeChild();
      children.push(c);
      return c;
    }) as never);
    return children;
  }

  it('stops restarting after 5 failures in 60 s and reports the trip once', async () => {
    vi.useFakeTimers();
    const children = spawning();
    const off = effects();
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    for (let i = 0; i < 4; i++) {
      children.at(-1)!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(children).toHaveLength(5);
    expect(off.tripped).not.toHaveBeenCalled();
    children.at(-1)!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(5);
    expect(sup.status()).toMatchObject({ running: false, crashExits: 5, downReason: 'crash-loop' });
    expect(off.tripped).toHaveBeenCalledTimes(1);
    sup.stop();
    vi.useRealTimers();
  });

  it('catches a slow loop: 8 failures in 30 minutes, though no minute holds 5', async () => {
    vi.useFakeTimers();
    const children = spawning();
    const off = effects();
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(40_000); // outlives the stable window, so the backoff resets
      children.at(-1)!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(off.tripped).not.toHaveBeenCalled();
    expect(children).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(40_000);
    children.at(-1)!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(8);
    expect(sup.status().downReason).toBe('crash-loop');
    expect(off.tripped).toHaveBeenCalledTimes(1);
    sup.stop();
    vi.useRealTimers();
  });

  it('counts spawn failures toward the breaker', async () => {
    vi.useFakeTimers();
    const children = spawning();
    const off = effects();
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    for (let i = 0; i < 5; i++) {
      children.at(-1)!.emit('error', new Error('EPERM'));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(children).toHaveLength(5);
    expect(sup.status()).toMatchObject({ spawnFailures: 5, downReason: 'crash-loop' });
    sup.stop();
    vi.useRealTimers();
  });

  it('clears the marker whenever it starts a broker, a reclaim included', async () => {
    vi.useFakeTimers();
    const children = spawning();
    vi.mocked(probeBrokerPipe).mockResolvedValue('none');
    const off = effects();
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    expect(off.clear).toHaveBeenCalledTimes(1);
    children.at(-1)!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
    expect(off.clear).toHaveBeenCalledTimes(2);
    // Another instance's broker owned the pipe, then went: the reclaim starts one here.
    children.at(-1)!.emit('exit', 75, null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(children).toHaveLength(3);
    expect(off.clear).toHaveBeenCalledTimes(3);
    sup.stop();
    vi.useRealTimers();
  });

  it('keeps the tool names a crash interrupted, names only', async () => {
    vi.useFakeTimers();
    const children = spawning();
    const sup = new BrokerSupervisor({ brokerOff: effects() });
    sup.start();
    children[0].emit('message', { wmuxBroker: 'connections', open: 2, inflight: ['browser_click', 'terminal_send'] });
    expect(sup.status()).toMatchObject({ connections: 2, lastCrashTools: [] });
    children[0].emit('exit', 1, null);
    expect(sup.status().lastCrashTools).toEqual(['browser_click', 'terminal_send']);
    await vi.advanceTimersByTimeAsync(1_000);
    // A report naming anything but tool names is not taken.
    for (const inflight of [['../etc/passwd'], ['a b'], ['x'.repeat(65)], Array(9).fill('t'), 'browser_click', [1]]) {
      children[1].emit('message', { wmuxBroker: 'connections', open: 5, inflight });
    }
    expect(sup.status().connections).toBe(0);
    children[1].emit('exit', 1, null);
    expect(sup.status().lastCrashTools).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    // A failed spawn ran no tools: an older crash's names are not shown for it.
    children[2].emit('message', { wmuxBroker: 'connections', open: 1, inflight: ['browser_type'] });
    children[2].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sup.status().lastCrashTools).toEqual(['browser_type']);
    children[3].emit('error', new Error('EPERM'));
    expect(sup.status().lastCrashTools).toEqual([]);
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor.identity', () => {
  it('is the spawned pid with the start time read right after the spawn, until that child exits', () => {
    const child = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(child as never);
    const startTimeOf = vi.fn(() => 777n);
    const sup = new BrokerSupervisor({ startTimeOf });
    expect(sup.identity).toBeNull();
    sup.start();
    expect(startTimeOf).toHaveBeenCalledWith(4321);
    expect(sup.identity).toEqual({ pid: 4321, startedAt: '777' });
    sup.stop();
    child.emit('exit', 0, null);
    expect(sup.identity).toBeNull();
  });

  it('carries no start time when it could not be read', () => {
    vi.mocked(spawn).mockReturnValueOnce(makeChild() as never);
    const sup = new BrokerSupervisor({ startTimeOf: () => null });
    sup.start();
    expect(sup.identity).toEqual({ pid: 4321, startedAt: null });
    sup.stop();
  });
});

describe('BrokerSupervisor stamp', () => {
  const stampedChild = makeChild;
  const sentStamp = (c: FakeChild): string => (c.send.mock.calls[0][0] as { stamp: string }).stamp;

  it('sends each spawned broker a stamp of its own, and matches only the current one', () => {
    const first = stampedChild();
    const second = stampedChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    const sup = new BrokerSupervisor({ startTimeOf: () => 1n });
    expect(sup.stampMatches('a'.repeat(64))).toBe(false);
    sup.start();
    expect(first.send).toHaveBeenCalledTimes(1);
    const message = first.send.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual(['stamp', 'wmuxBroker']);
    expect(message.wmuxBroker).toBe('stamp');
    const one = sentStamp(first);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(sup.stampMatches(one)).toBe(true);
    expect(sup.stampMatches(one.slice(1))).toBe(false);
    expect(sup.stampMatches(`${one.slice(0, 63)}${one[63] === '0' ? '1' : '0'}`)).toBe(false);

    sup.stop();
    first.emit('exit', 0, null);
    expect(sup.stampMatches(one)).toBe(false);

    sup.resume();
    const two = sentStamp(second);
    expect(two).not.toBe(one);
    expect(sup.stampMatches(two)).toBe(true);
    expect(sup.stampMatches(one)).toBe(false);
    sup.stop();
  });

  it('matches nothing once the broker stands down for another (exit 75), nor after stop() before the old one exits', () => {
    vi.useFakeTimers();
    try {
      const first = stampedChild();
      const second = stampedChild();
      vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
      const sup = new BrokerSupervisor({ startTimeOf: () => 1n });
      sup.start();
      const one = sentStamp(first);
      first.emit('exit', 75, null);
      expect(sup.standingDown).toBe(true);
      expect(sup.stampMatches(one)).toBe(false);
      sup.stop();
      sup.resume();
      const two = sentStamp(second);
      expect(sup.stampMatches(two)).toBe(true);
      // stop() drops the stamp at once, before the child's exit arrives.
      sup.stop();
      expect(sup.stampMatches(two)).toBe(false);
      second.emit('exit', 0, null);
      expect(sup.stampMatches(two)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches nothing once the broker has crashed', () => {
    vi.useFakeTimers();
    try {
      const child = stampedChild();
      vi.mocked(spawn).mockReturnValueOnce(child as never);
      const sup = new BrokerSupervisor({ startTimeOf: () => 1n });
      sup.start();
      const stamp = sentStamp(child);
      child.emit('exit', 1, null);
      expect(sup.stampMatches(stamp)).toBe(false);
      sup.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a broker it could not hand its stamp to, so the restart gives the next one a stamp', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = stampedChild();
    failing.send.mockImplementation((_m: unknown, cb: (err: Error | null) => void) => cb(new Error('channel closed')));
    vi.mocked(spawn).mockReturnValueOnce(failing as never);
    const sup = new BrokerSupervisor({ startTimeOf: () => 1n });
    sup.start();
    expect(failing.kill).toHaveBeenCalledTimes(1);
    sup.stop();

    const unconnected = stampedChild();
    unconnected.connected = false;
    vi.mocked(spawn).mockReturnValueOnce(unconnected as never);
    const other = new BrokerSupervisor({ startTimeOf: () => 1n });
    other.start();
    expect(unconnected.send).not.toHaveBeenCalled();
    expect(unconnected.kill).toHaveBeenCalledTimes(1);
    other.stop();
  });
});
