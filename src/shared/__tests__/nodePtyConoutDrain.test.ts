// #2398 — node-pty's conout drain is one worker for every pty, not a worker
// per pty (patches/node-pty+1.2.0-beta.17.patch). Each worker is a whole V8
// isolate, about 12 MB private on Windows, so a daemon with 120 panes held
// 1.4 GB in idle drain workers.
//
// What these cover, against the installed (patched) module with the Worker
// class swapped for a fake: the connections share one worker, the worker's
// messages reach only the connection they name, a disposed connection closes
// its own drain after the flush delay, and the worker ends with the last
// connection. Real ptys draining through it: nodePtyConoutDrain.os.test.ts.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nodeRequire = createRequire(__filename);
const workerThreads = nodeRequire('worker_threads') as { Worker: unknown };
const MODULE = 'node-pty/lib/windowsConoutConnection';

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];
  readonly posted: Array<{ type: string; id: number; conoutPipeName?: string }> = [];
  terminated = false;
  constructor(readonly script: string) {
    super();
    FakeWorker.instances.push(this);
  }
  postMessage(message: { type: string; id: number; conoutPipeName?: string }): void {
    this.posted.push(message);
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(1);
  }
}

interface Connection {
  onReady: (listener: () => void) => void;
  onError: (listener: (error: Error) => void) => void;
  connectSocket: (socket: { connect: (path: string) => void }) => void;
  dispose: () => void;
}
type ConnectionClass = new (pipe: string, useConptyDll: boolean) => Connection;

let realWorker: unknown;
let ConoutConnection: ConnectionClass;

beforeEach(() => {
  vi.useFakeTimers();
  realWorker = workerThreads.Worker;
  workerThreads.Worker = FakeWorker;
  FakeWorker.instances = [];
  // A fresh module per test: its shared worker is module state.
  delete nodeRequire.cache[nodeRequire.resolve(MODULE)];
  ({ ConoutConnection } = nodeRequire(MODULE) as { ConoutConnection: ConnectionClass });
});

afterEach(() => {
  workerThreads.Worker = realWorker;
  vi.useRealTimers();
});

function open(count: number): Connection[] {
  return Array.from({ length: count }, (_, i) => new ConoutConnection(`\\\\.\\pipe\\conout-${i}`, true));
}

describe('node-pty conout drain (patched)', () => {
  it('drains every pty through one worker', () => {
    open(3);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].script).toMatch(/conoutSocketWorker\.js$/);
    const opens = FakeWorker.instances[0].posted;
    expect(opens.map((m) => m.type)).toEqual(['open', 'open', 'open']);
    expect(new Set(opens.map((m) => m.id)).size).toBe(3);
    expect(opens.map((m) => m.conoutPipeName)).toEqual(['\\\\.\\pipe\\conout-0', '\\\\.\\pipe\\conout-1', '\\\\.\\pipe\\conout-2']);
  });

  it('tells only the connection a message names that it is ready, or failed', () => {
    const [a, b] = open(2);
    const [idA, idB] = FakeWorker.instances[0].posted.map((m) => m.id);
    const ready = { a: vi.fn(), b: vi.fn() };
    const failed = { a: vi.fn(), b: vi.fn() };
    a.onReady(ready.a); b.onReady(ready.b);
    a.onError(failed.a); b.onError(failed.b);

    FakeWorker.instances[0].emit('message', { type: 1, id: idB });
    expect(ready.b).toHaveBeenCalledOnce();
    expect(ready.a).not.toHaveBeenCalled();

    FakeWorker.instances[0].emit('message', { type: 2, id: idA, error: 'pipe gone' });
    expect(failed.a).toHaveBeenCalledWith(expect.objectContaining({ message: 'pipe gone' }));
    expect(failed.b).not.toHaveBeenCalled();
  });

  it('connects a pty\'s output socket to its own worker pipe', () => {
    const [connection] = open(1);
    const socket = { connect: vi.fn() };
    connection.connectSocket(socket);
    expect(socket.connect).toHaveBeenCalledWith('\\\\.\\pipe\\conout-0-worker');
  });

  it('closes a disposed pty\'s drain after the flush delay, and ends the worker with the last one', () => {
    const [a, b] = open(2);
    const worker = FakeWorker.instances[0];
    const [idA, idB] = worker.posted.map((m) => m.id);

    a.dispose();
    vi.advanceTimersByTime(999);
    expect(worker.posted.filter((m) => m.type === 'close')).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(worker.posted.filter((m) => m.type === 'close')).toEqual([{ type: 'close', id: idA }]);
    expect(worker.terminated).toBe(false);

    b.dispose();
    vi.advanceTimersByTime(1000);
    expect(worker.posted.filter((m) => m.type === 'close').map((m) => m.id)).toEqual([idA, idB]);
    expect(worker.terminated).toBe(true);

    // A pty opened after that starts a new worker.
    open(1);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('fails connections still waiting when the worker exits, and an old worker\'s exit leaves the new one alone', () => {
    const [a] = open(1);
    const failed = vi.fn();
    a.onError(failed);
    FakeWorker.instances[0].emit('exit', 1);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('code 1') }));

    const [b] = open(1);
    expect(FakeWorker.instances).toHaveLength(2);
    const failedB = vi.fn();
    b.onError(failedB);
    FakeWorker.instances[0].emit('exit', 1);
    expect(failedB).not.toHaveBeenCalled();
  });

  it('releases a ready connection whose drain failed, and ends the worker with the last one', () => {
    const [a] = open(2);
    const worker = FakeWorker.instances[0];
    const [idA, idB] = worker.posted.map((m) => m.id);
    const failed = vi.fn();
    a.onError(failed);
    worker.emit('message', { type: 1, id: idA });
    worker.emit('message', { type: 1, id: idB });

    // The worker closed A's drain after READY: A is released, not reported.
    worker.emit('message', { type: 2, id: idA, error: 'pipe broken' });
    expect(failed).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(false);
    // A's later dispose finds nothing left to close.
    a.dispose();
    vi.advanceTimersByTime(1000);
    expect(worker.posted.filter((m) => m.type === 'close' && m.id === idA)).toHaveLength(1);

    worker.emit('message', { type: 2, id: idB, error: 'pipe broken' });
    expect(worker.terminated).toBe(true);
  });

  it('releases a connection whose conout pipe the worker reports closed, and ends the worker with the last one', () => {
    // A shell that exits by itself on the ConPTY DLL path: nothing disposes
    // its connection, so the worker's CLOSED is what lets it go.
    const [a] = open(2);
    const worker = FakeWorker.instances[0];
    const [idA, idB] = worker.posted.map((m) => m.id);
    const failed = vi.fn();
    a.onError(failed);
    worker.emit('message', { type: 1, id: idA });
    worker.emit('message', { type: 1, id: idB });

    worker.emit('message', { type: 3, id: idA });
    expect(failed).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(false);
    worker.emit('message', { type: 3, id: idB });
    expect(worker.terminated).toBe(true);
  });

  it('drops ready connections with a worker that dies, so the next pty gets a fresh worker of its own', () => {
    const [a, b] = open(2);
    const first = FakeWorker.instances[0];
    const [idA, idB] = first.posted.map((m) => m.id);
    first.emit('message', { type: 1, id: idA });
    first.emit('message', { type: 1, id: idB });
    first.emit('exit', 1);

    const [c] = open(1);
    expect(FakeWorker.instances).toHaveLength(2);
    const second = FakeWorker.instances[1];
    // The dead worker's ptys are not the new worker's: disposing them sends it
    // nothing, and they do not keep it alive.
    a.dispose();
    b.dispose();
    vi.advanceTimersByTime(1000);
    expect(second.posted.map((m) => m.type)).toEqual(['open']);
    c.dispose();
    vi.advanceTimersByTime(1000);
    expect(second.terminated).toBe(true);
  });

  it('logs one line when the worker dies under live connections, and none when it ends with the last one', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      open(2);
      const first = FakeWorker.instances[0];
      const [idA, idB] = first.posted.map((m) => m.id);
      first.emit('message', { type: 1, id: idA });
      first.emit('message', { type: 1, id: idB });
      // A crash: 'error' and then 'exit', one line for both.
      first.emit('error', new Error('isolate gone'));
      first.emit('exit', 1);
      expect(logged).toHaveBeenCalledOnce();
      expect(String(logged.mock.calls[0][0])).toMatch(/2 pty/);
      expect(logged.mock.calls[0].map(String).join(' ')).toContain('isolate gone');

      // The worker ending with its last connection is not a crash.
      logged.mockClear();
      const [c] = open(1);
      const second = FakeWorker.instances[1];
      c.dispose();
      vi.advanceTimersByTime(1000);
      expect(second.terminated).toBe(true);
      second.emit('exit', 1);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('does not fail the new worker\'s connections over an error from the worker it replaced', () => {
    open(1);
    const first = FakeWorker.instances[0];
    first.emit('exit', 1);
    const [b] = open(1);
    const failed = vi.fn();
    b.onError(failed);
    first.emit('error', new Error('old worker'));
    expect(failed).not.toHaveBeenCalled();
  });

  it('does not report an error for a connection that is already ready', () => {
    const [a] = open(1);
    const failed = vi.fn();
    a.onError(failed);
    const id = FakeWorker.instances[0].posted[0].id;
    FakeWorker.instances[0].emit('message', { type: 1, id });
    FakeWorker.instances[0].emit('error', new Error('late'));
    expect(failed).not.toHaveBeenCalled();
  });
});
