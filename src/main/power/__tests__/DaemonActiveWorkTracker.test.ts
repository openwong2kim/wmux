import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ActiveWorkPowerBlocker } from '../ActiveWorkPowerBlocker';
import { DaemonActiveWorkTracker } from '../DaemonActiveWorkTracker';

type RpcImplementation = () => Promise<unknown>;

class FakeDaemonClient extends EventEmitter {
  rpc = vi.fn<(...args: [string, Record<string, unknown>?]) => Promise<unknown>>();

  constructor(implementation: RpcImplementation = async () => []) {
    super();
    this.rpc.mockImplementation(implementation);
  }
}

function harness(rpc?: RpcImplementation) {
  const power = { start: vi.fn(() => 73), stop: vi.fn() };
  const blocker = new ActiveWorkPowerBlocker(power, true);
  const client = new FakeDaemonClient(rpc);
  const log = vi.fn();
  const tracker = new DaemonActiveWorkTracker(blocker, log);
  return { power, blocker, client, log, tracker };
}

describe('DaemonActiveWorkTracker', () => {
  it('hydrates running commands and exec sessions', async () => {
    const h = harness(async () => [
      { id: 'idle', state: 'attached', commandRunning: false },
      { id: 'command', state: 'detached', commandRunning: true },
      { id: 'exec', state: 'attached', exec: { command: 'npm test' } },
      { id: 'dead', state: 'dead', commandRunning: true },
    ]);

    await h.tracker.attach(h.client);
    expect(h.client.rpc).toHaveBeenCalledWith('daemon.listSessions', {});
    expect(h.power.start).toHaveBeenCalledOnce();
    h.client.emit('session:died', { sessionId: 'command' });
    expect(h.power.stop).not.toHaveBeenCalled();
    h.client.emit('session:destroyed', { sessionId: 'exec' });
    expect(h.power.stop).toHaveBeenCalledWith(73);
  });

  it('tracks prompt boundaries independently across multiple sessions', async () => {
    const h = harness();
    await h.tracker.attach(h.client);
    h.client.emit('session:prompt', { sessionId: 'a', event: { type: 'command_start' } });
    h.client.emit('session:prompt', { sessionId: 'b', event: { type: 'command_start' } });
    expect(h.power.start).toHaveBeenCalledOnce();
    h.client.emit('session:prompt', { sessionId: 'a', event: { type: 'command_end' } });
    expect(h.power.stop).not.toHaveBeenCalled();
    h.client.emit('session:prompt', { sessionId: 'b', event: { type: 'prompt_start' } });
    expect(h.power.stop).toHaveBeenCalledWith(73);
  });

  it('releases active work when a session dies', async () => {
    const h = harness();
    await h.tracker.attach(h.client);
    h.client.emit('session:prompt', { sessionId: 'pane', event: { type: 'command_start' } });
    h.client.emit('session:died', { sessionId: 'pane' });
    expect(h.power.stop).toHaveBeenCalledWith(73);
  });

  it('tracks exec sessions created and destroyed after hydration', async () => {
    const h = harness();
    await h.tracker.attach(h.client);
    h.client.emit('event', {
      type: 'session.created',
      sessionId: 'workflow',
      data: { hasExec: true },
    });
    expect(h.power.start).toHaveBeenCalledOnce();
    h.client.emit('session:destroyed', { sessionId: 'workflow' });
    expect(h.power.stop).toHaveBeenCalledWith(73);
  });

  it('retries hydration when a live event makes the first snapshot stale', async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => { resolveFirst = resolve; });
    let call = 0;
    const h = harness(async () => ++call === 1
      ? first
      : [{ id: 'live', state: 'attached', commandRunning: true }]);

    const attaching = h.tracker.attach(h.client);
    h.client.emit('session:prompt', { sessionId: 'live', event: { type: 'command_start' } });
    resolveFirst([]);
    await attaching;

    expect(h.client.rpc).toHaveBeenCalledTimes(2);
    expect(h.power.start).toHaveBeenCalledOnce();
    expect(h.power.stop).not.toHaveBeenCalled();
  });

  it('detaches old listeners when attaching a replacement client', async () => {
    const h = harness();
    await h.tracker.attach(h.client);
    const replacement = new FakeDaemonClient();
    await h.tracker.attach(replacement);
    h.client.emit('session:prompt', { sessionId: 'old', event: { type: 'command_start' } });
    expect(h.power.start).not.toHaveBeenCalled();
    replacement.emit('session:prompt', { sessionId: 'new', event: { type: 'command_start' } });
    expect(h.power.start).toHaveBeenCalledOnce();
  });
});
