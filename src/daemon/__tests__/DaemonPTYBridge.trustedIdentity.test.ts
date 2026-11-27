import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { AgentProcessTracker, type PidWatcher, type ProcessTreeEntry } from '../AgentProcessTracker';
import { RingBuffer } from '../RingBuffer';
import { PromptEventLog } from '../PromptEventLog';
import type { AgentSignal } from '../../shared/hooks/signal-types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APPROVAL = 'Would you like to run the following command?\r\n';
// Pi 1.4.0 live capture (src/main/pty/__tests__/fixtures): the raw trust selector and its rendered grid.
const piCapture = JSON.parse(readFileSync(join(__dirname, '../../main/pty/__tests__/fixtures/pi-1.4.0-capture.json'), 'utf8')) as {
  chunks: { trust: string };
  screens: { trust: string[] };
};
const SHELL_RETURN = '\x1b]133;D;0\x07\x1b]133;A\x07';

function fakePty() {
  let data: ((chunk: string) => void) | null = null;
  return {
    pty: {
      onData: (cb: (chunk: string) => void) => { data = cb; return { dispose: () => { data = null; } }; },
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty,
    // The bridge analyses a chunk after forwarding it (M3 A1): one turn of
    // the (fake) event loop lets that analysis run, as it did inside the call.
    feed: (chunk: string) => { data?.(chunk); vi.advanceTimersByTime(0); },
  };
}

describe('fresh authoritative identity enables bannerless detector patterns', () => {
  let bridge: DaemonPTYBridge;
  let pty: ReturnType<typeof fakePty>;
  let events: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let active: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    bridge = new DaemonPTYBridge();
    pty = fakePty();
    bridge.setupDataForwarding(pty.pty, new RingBuffer(65536), 'pane-a', new PromptEventLog());
    events = vi.fn();
    active = vi.fn();
    bridge.on('agent', events);
    bridge.on('active', active);
    vi.advanceTimersByTime(1);
  });
  afterEach(() => { bridge.cleanup(); vi.useRealTimers(); });

  const signal = (over: Partial<AgentSignal> = {}): AgentSignal => ({
    kind: 'agent.activity', agent: 'codex', ptyId: 'pane-a', cwd: '/repo', ts: Date.now(), payload: {}, ...over,
  });

  it('a live process edge emits no work or completion; its later approval is detected without a banner', () => {
    bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: Date.now() });
    expect(events).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
    expect(bridge.getAgentStatus()).toBe('idle');
    expect(bridge.isTurnOpen()).toBe(false);
    expect(bridge.getLastAgent()).toBeNull(); // process evidence is never screen evidence
    pty.feed(APPROVAL);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ agent: 'Codex CLI', status: 'awaiting_input' }) }));
    expect(bridge.getLastAgent()).toBeNull();
  });

  it('cached process reads and unknown/dead picks cannot open the pattern gate', () => {
    bridge.noteAgentProcess({ slug: 'codex', alive: true }); // identityFor cache has no observation timestamp
    bridge.noteAgentProcess({ alive: true, observedAt: Date.now() });
    bridge.noteAgentProcess({ slug: 'codex', alive: false });
    pty.feed(APPROVAL);
    expect(events).not.toHaveBeenCalled();
  });

  it('a guarded probe starting in the initial bridge millisecond can seed', async () => {
    vi.setSystemTime(100_000);
    const watcher: PidWatcher = { watch: () => undefined, unwatch: () => undefined };
    const tracker = new AgentProcessTracker(watcher, async () => [{ pid: 200, ppid: 100, name: 'codex' }]);
    tracker.setIdentityProbeGuard(() => bridge.captureIdentityProbe());
    tracker.setStateChangeListener((_id, state) => bridge.noteAgentProcess(state));
    tracker.armIfAgent('pane-a', 100);
    await vi.waitFor(() => expect(tracker.statusFor('pane-a')).toBe(true), { timeout: 5_000 });
    pty.feed(APPROVAL);
    expect(events).toHaveBeenCalledTimes(1);
    tracker.disarm('pane-a');
  });

  it('unknown and cached different-process reads do not revoke a fresh hook owner or its turn', () => {
    bridge.noteHookAgentIdentity(signal(), { slug: 'codex', source: 'hook' });
    bridge.noteAgentStatus('running', true);
    bridge.noteAgentProcess({ alive: true, observedAt: Date.now() });
    bridge.noteAgentProcess({ slug: 'claude', alive: true });
    expect(bridge.isTurnOpen()).toBe(true);
    pty.feed(APPROVAL);
    expect(events).toHaveBeenCalledTimes(1);
  });

  describe.each([
    ['different pid', 20, '200'],
    ['reused pid', 10, '200'],
  ] as const)('a WSL replacement with %s and no OSC 133', (_label, pid, start) => {
    it.each(['idle', 'mid-turn'] as const)('retires the previous %s owner without seeding from an untimed report', (phase) => {
      const watches = new Map<string, () => void>();
      const tracker = new AgentProcessTracker(
        { watch: () => undefined, unwatch: () => undefined }, async () => [], async () => undefined, '/home/dev', {
          watcher: { watch: (key, _agent, onDead) => watches.set(key, onDead), unwatch: (key) => watches.delete(key) },
        });
      const changed = vi.fn((_id: string, state: Parameters<DaemonPTYBridge['noteAgentProcess']>[0]) => bridge.noteAgentProcess(state));
      tracker.setStateChangeListener(changed);
      const location = { shell: 'wsl.exe', target: { distribution: 'Ubuntu', user: 'dev' }, hostPid: 100 };
      const first = { pid: 10, start: '100', bootId: '11111111-1111-4111-8111-111111111111', slug: 'claude' as const, ancestors: [1] };
      bridge.noteHookAgentIdentity(signal({ agent: 'claude' }), { slug: 'claude', source: 'hook' });
      tracker.armWsl('pane-a', location, first);
      const oldDeath = watches.get('agent:pane-a');
      expect(oldDeath).toBeDefined();
      bridge.noteAgentStatus('running', true);
      if (phase === 'idle') bridge.noteAgentStatus('complete', true);
      expect(bridge.hasHookReports()).toBe(true);
      expect(bridge.isTurnOpen()).toBe(phase === 'mid-turn');
      vi.advanceTimersByTime(5_000);

      tracker.armWsl('pane-a', location, { ...first, pid, start, slug: 'codex' });

      expect(changed).toHaveBeenLastCalledWith('pane-a', { slug: 'codex', alive: true, replacedLive: true });
      expect(bridge.hasHookReports()).toBe(false);
      expect(bridge.isTurnOpen()).toBe(false);
      expect(tracker.identityFor('pane-a')).toEqual({ slug: 'codex', alive: true });
      pty.feed(APPROVAL);
      expect(events).not.toHaveBeenCalled(); // replacement proof is not detector authority
      const edgeCount = changed.mock.calls.length;
      oldDeath?.();
      expect(changed).toHaveBeenCalledTimes(edgeCount);
      expect(tracker.statusFor('pane-a')).toBe(true);
      tracker.disarm('pane-a');
    });
  });

  it('exact fresh positive hook evidence enables patterns without making the pane working', () => {
    expect(bridge.noteHookAgentIdentity(signal(), { slug: 'codex', source: 'hook' })).toBe(true);
    expect(active).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(bridge.getAgentStatus()).toBe('idle');
    expect(bridge.getLastAgent()).toBeNull();
    pty.feed(APPROVAL);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ptyId: undefined }, { ptyId: 'pane-b' }, { kind: 'agent.stop' as const },
    { kind: 'agent.stop_failure' as const }, { kind: 'agent.subagent_stop' as const },
    { ts: 1 }, { ts: 200_000 }, { payload: { agent_id: 'child-1' } },
  ])('does not seed from a routed/stale/terminal/child hook: %j', (over) => {
    expect(bridge.noteHookAgentIdentity(signal(over), { slug: 'codex', source: 'hook' })).toBe(false);
    pty.feed(APPROVAL);
    expect(events).not.toHaveBeenCalled();
  });

  it('canonical contradiction rejects the hook and does not replace the process owner', () => {
    bridge.noteAgentProcess({ slug: 'claude', alive: true, observedAt: Date.now() });
    expect(bridge.noteHookAgentIdentity(signal(), { slug: 'claude', source: 'process' })).toBe(false);
    pty.feed(APPROVAL);
    expect(events).not.toHaveBeenCalled();
  });

  it('shell return revokes the seed; old hooks and cached process state cannot resurrect it', () => {
    const old = signal();
    bridge.noteHookAgentIdentity(old, { slug: 'codex', source: 'hook' });
    vi.advanceTimersByTime(1);
    pty.feed(SHELL_RETURN);
    vi.advanceTimersByTime(1);
    expect(bridge.noteHookAgentIdentity(old, { slug: 'codex', source: 'hook' })).toBe(false);
    bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: old.ts });
    pty.feed(APPROVAL);
    expect(events).not.toHaveBeenCalled();
    expect(bridge.noteHookAgentIdentity(signal(), { slug: 'codex', source: 'hook' })).toBe(true);
    pty.feed(APPROVAL);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('death and a live replacement revoke the previous owner', () => {
    bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: Date.now() });
    bridge.noteAgentProcess({ slug: 'codex', alive: false });
    pty.feed(APPROVAL);
    expect(events).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: Date.now() });
    vi.advanceTimersByTime(1);
    bridge.noteAgentProcess({ slug: 'claude', alive: true, observedAt: Date.now() });
    pty.feed(APPROVAL);
    expect(events).not.toHaveBeenCalled();
  });

  it('a process probe begun before shell return cannot seed when its async result arrives', async () => {
    let resolve!: (rows: ProcessTreeEntry[]) => void;
    const pending = new Promise<ProcessTreeEntry[]>((r) => { resolve = r; });
    const watcher: PidWatcher = { watch: () => undefined, unwatch: () => undefined };
    const tracker = new AgentProcessTracker(watcher, () => pending);
    const changed = vi.fn((_id: string, state: Parameters<DaemonPTYBridge['noteAgentProcess']>[0]) => bridge.noteAgentProcess(state));
    tracker.setIdentityProbeGuard(() => bridge.captureIdentityProbe());
    tracker.setStateChangeListener(changed);
    const observedAt = Date.now();
    tracker.armIfAgent('pane-a', 100);
    vi.advanceTimersByTime(1);
    pty.feed(SHELL_RETURN);
    vi.advanceTimersByTime(1);
    resolve([{ pid: 200, ppid: 100, name: 'codex' }]);
    await pending;
    await vi.waitFor(() => expect(tracker.statusFor('pane-a')).toBe(true), { timeout: 5_000 });
    expect(tracker.identityFor('pane-a')).toEqual({ slug: 'codex', alive: true });
    expect(changed).toHaveBeenCalledWith('pane-a', { slug: 'codex', alive: true, observedAt, identityEpoch: null });
    pty.feed(APPROVAL);
    expect(events).not.toHaveBeenCalled();
    tracker.disarm('pane-a');
  });

  it('two panes sharing a snapshot newer than both boundaries both receive identity', async () => {
    const other = new DaemonPTYBridge();
    const otherPty = fakePty();
    const otherEvents = vi.fn();
    other.setupDataForwarding(otherPty.pty, new RingBuffer(65536), 'pane-b', new PromptEventLog());
    other.on('agent', otherEvents);
    vi.advanceTimersByTime(1);
    let release!: (rows: ProcessTreeEntry[]) => void;
    const pending = new Promise<ProcessTreeEntry[]>((resolve) => { release = resolve; });
    const enumerate = vi.fn(() => pending);
    const tracker = new AgentProcessTracker({ watch: () => undefined, unwatch: () => undefined }, enumerate);
    tracker.setIdentityProbeGuard((id) => (id === 'pane-a' ? bridge : other).captureIdentityProbe());
    tracker.setStateChangeListener((id, state) => (id === 'pane-a' ? bridge : other).noteAgentProcess(state));
    try {
      tracker.armIfAgent('pane-a', 100);
      tracker.armIfAgent('pane-b', 300);
      release([{ pid: 200, ppid: 100, name: 'codex' }, { pid: 400, ppid: 300, name: 'codex' }]);
      await vi.waitFor(() => expect(tracker.statusFor('pane-b')).toBe(true), { timeout: 5_000 });
      expect(enumerate).toHaveBeenCalledTimes(1);
      pty.feed(APPROVAL);
      otherPty.feed(APPROVAL);
      expect(events).toHaveBeenCalledTimes(1);
      expect(otherEvents).toHaveBeenCalledTimes(1);
    } finally {
      tracker.disarm('pane-a');
      tracker.disarm('pane-b');
      other.cleanup();
    }
  });

  it('does not replay old bytes when no current-screen reader is available', () => {
    pty.feed(APPROVAL);
    expect(events).not.toHaveBeenCalled();
    bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: Date.now() });
    expect(events).not.toHaveBeenCalled();
    expect(bridge.getAgentStatus()).toBe('idle');
    pty.feed(APPROVAL);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('a replacement PTY ignores a hook emitted during the previous PTY lifetime', () => {
    const old = signal();
    bridge.cleanup();
    vi.advanceTimersByTime(1);
    pty = fakePty();
    bridge.setupDataForwarding(pty.pty, new RingBuffer(65536), 'pane-a', new PromptEventLog());
    bridge.on('agent', events);
    expect(bridge.noteHookAgentIdentity(old, { slug: 'codex', source: 'hook' })).toBe(false);
    pty.feed(APPROVAL);
    expect(events).not.toHaveBeenCalled();
  });
  const trustGrid = ['Do you trust the contents of this project?', '❯ Yes, I trust this folder', 'No, exit', '↑/↓ Navigate · enter Confirm'];

  it.each(['process', 'hook'] as const)('recovers a quiet current trust dialog after fresh %s identity', async (source) => {
    const read = vi.fn(async () => ({ rows: trustGrid, isCurrent: () => true }));
    bridge.setApprovalScreenReader(read);
    pty.feed(trustGrid.join('\r\n'));
    expect(events).not.toHaveBeenCalled();
    if (source === 'process') bridge.noteAgentProcess({ slug: 'agy', alive: true, observedAt: Date.now() });
    else bridge.noteHookAgentIdentity(signal({ agent: 'agy' }), { slug: 'agy', source: 'hook' });
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(events.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'pane-a', event: { agent: 'Antigravity CLI', status: 'awaiting_input' } });
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
    expect(bridge.getLastAgent()).toBeNull();
    expect(active).not.toHaveBeenCalled();
    bridge.noteAgentProcess({ slug: 'agy', alive: true, observedAt: Date.now() });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it.each(['identity first', 'selector first', 'selector first, after another agent'] as const)(
    'recovers Pi\'s trust selector drawn before or after its process identity (%s)', async (order) => {
      // The screen is read from the bridge's own ring, as the daemon's reader
      // does: a read before the chunk is written there sees no selector.
      bridge.cleanup();
      const ring = new RingBuffer(65536);
      pty = fakePty();
      bridge.setupDataForwarding(pty.pty, ring, 'pane-a', new PromptEventLog());
      bridge.on('agent', events);
      vi.advanceTimersByTime(1);
      const read = vi.fn(async () => ({
        rows: ring.readAll().toString().includes('Trust project folder') ? piCapture.screens.trust : [],
        isCurrent: () => true,
      }));
      bridge.setApprovalScreenReader(read);
      if (order === 'identity first') bridge.noteAgentProcess({ slug: 'pi', alive: true, observedAt: Date.now() });
      if (order === 'selector first, after another agent') bridge.noteAgentProcess({ slug: 'claude', alive: true, observedAt: Date.now() });
      pty.feed(piCapture.chunks.trust);
      if (order !== 'identity first') bridge.noteAgentProcess({ slug: 'pi', alive: true, observedAt: Date.now() });
      await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      expect(events.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'pane-a', event: { agent: 'Pi', status: 'awaiting_input' } });
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['input', 'resize', 'shell', 'death', 'replacement', 'dispose', 'same-id-reuse'] as const)(
    'rejects a quiet screen render overtaken by %s', async (change) => {
      let resolve: (value: { rows: string[]; isCurrent: () => boolean }) => void = () => undefined;
      const pending = new Promise<{ rows: string[]; isCurrent: () => boolean }>((done) => { resolve = done; });
      bridge.setApprovalScreenReader(() => pending);
      pty.feed(trustGrid.join('\r\n'));
      bridge.noteAgentProcess({ slug: 'agy', alive: true, observedAt: Date.now() });
      if (change === 'input') bridge.noteInput('y');
      if (change === 'resize') bridge.noteResize();
      if (change === 'shell') pty.feed(SHELL_RETURN);
      if (change === 'death') bridge.noteAgentProcess({ slug: 'agy', alive: false });
      if (change === 'replacement') bridge.noteAgentProcess({ slug: 'codex', alive: true, observedAt: Date.now() });
      if (change === 'dispose' || change === 'same-id-reuse') bridge.cleanup();
      if (change === 'same-id-reuse') {
        pty = fakePty();
        bridge.setupDataForwarding(pty.pty, new RingBuffer(65536), 'pane-a', new PromptEventLog());
        bridge.on('agent', events);
      }
      resolve({ rows: trustGrid, isCurrent: () => true });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(events).not.toHaveBeenCalled();
    },
  );

});
