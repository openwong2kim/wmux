import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RingBuffer } from '../RingBuffer';
import { StateWriter } from '../StateWriter';
import { createBufferHibernation, hibernationBlocker, type BufferHibernationDeps } from '../BufferHibernation';
import { collectDaemonMemoryDiagnostics } from '../memoryDiagnostics';
import type { ManagedSession } from '../DaemonSessionManager';

const MB = 1024 * 1024;
const HOUR = 3_600_000;
const NOW = Date.now();

interface FakeSession {
  meta: { id: string; state: string; lastActivity: string; exec?: unknown };
  ringBuffer: RingBuffer;
  viewerVisible: boolean;
  bridge: { getAgentStatus: () => string };
  promptLog: { commandRunningIfKnown: () => boolean | undefined };
  agentStatus: string;
  commandRunning: boolean | undefined;
}

function fakeSession(id: string, ring: RingBuffer, overrides: Partial<FakeSession['meta']> = {}): FakeSession {
  const s: FakeSession = {
    meta: { id, state: 'detached', lastActivity: new Date(NOW - 48 * HOUR).toISOString(), ...overrides },
    ringBuffer: ring,
    viewerVisible: true,
    agentStatus: 'idle',
    commandRunning: undefined,
    bridge: { getAgentStatus: () => s.agentStatus },
    promptLog: { commandRunningIfKnown: () => s.commandRunning },
  };
  return s;
}

/** Two MB of distinct, ANSI-laden lines, written in chunks with a resize in between. */
function fillRing(ring: RingBuffer): void {
  ring.noteGeometry(120, 30);
  for (let i = 0; i < 20_000; i++) {
    if (i === 10_000) ring.noteGeometry(90, 40);
    ring.write(Buffer.from(`\x1b[32mline ${i}\x1b[0m ${'x'.repeat(80)}\r\n`));
  }
}

let dir: string;
let sessions: FakeSession[];
let agentAlive: Map<string, boolean>;
let remote: Set<string>;
let logs: string[];

function deps(overrides: Partial<BufferHibernationDeps> = {}): BufferHibernationDeps {
  return {
    sessions: () => sessions as unknown as ManagedSession[],
    bufferPath: (id) => path.join(dir, 'buffers', `${id}.buf`),
    ensureBufferDir: () => fs.mkdirSync(path.join(dir, 'buffers'), { recursive: true }),
    idleHours: () => 24,
    agentProcessAlive: (id) => agentAlive.get(id),
    remoteViewer: (id) => remote.has(id),
    log: (_level, msg) => logs.push(msg),
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hibernate-test-'));
  sessions = [];
  agentAlive = new Map();
  remote = new Set();
  logs = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buffer hibernation', () => {
  it('releases an idle ring and serves identical scrollback, geometry and offsets after wake', async () => {
    const ring = new RingBuffer(8 * MB, 'node');
    fillRing(ring);
    const before = ring.readAllWithGeometry();
    const sizeBefore = ring.size;
    sessions.push(fakeSession('p1', ring));

    const result = await createBufferHibernation(deps()).sweep();

    expect(result.hibernated).toBe(1);
    expect(result.freedBytes).toBeGreaterThanOrEqual(2 * MB);
    expect(ring.isHibernated).toBe(true);
    expect(ring.allocatedBytes).toBe(0);
    // Counters stay readable without waking the ring.
    expect(ring.size).toBe(sizeBefore);
    expect(ring.totalBytesWritten).toBe(before.writtenAt);
    expect(ring.hasGeometryChanges).toBe(true);
    expect(ring.isHibernated).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'buffers', 'p1.buf')).equals(before.data)).toBe(true);

    const diag = collectDaemonMemoryDiagnostics(sessions as unknown as ManagedSession[], new Map());
    expect(diag.hibernation).toMatchObject({ sessions: 1, freedBytes: result.freedBytes });
    expect(diag.sessions[0].ringHibernated).toBe(true);
    expect(ring.isHibernated).toBe(true);

    // An attach flush reads the ring: identical bytes, geometry and offsets.
    const after = ring.readAllWithGeometry();
    expect(ring.isHibernated).toBe(false);
    expect(after.data.equals(before.data)).toBe(true);
    expect(after.geometry).toEqual(before.geometry);
    expect(after.writtenAt).toBe(before.writtenAt);
  });

  it('appends output that arrives while hibernated after the restored history', async () => {
    const ring = new RingBuffer(8 * MB, 'node');
    fillRing(ring);
    const history = ring.readAll();
    const total = ring.totalBytesWritten;
    sessions.push(fakeSession('p1', ring));
    await createBufferHibernation(deps()).sweep();
    expect(ring.isHibernated).toBe(true);

    ring.write(Buffer.from('new output\r\n'));

    expect(ring.isHibernated).toBe(false);
    expect(ring.readAll().equals(Buffer.concat([history, Buffer.from('new output\r\n')]))).toBe(true);
    expect(ring.totalBytesWritten).toBe(total + 12);
  });

  it('keeps the newest bytes when a full, wrapped ring hibernates and wakes', async () => {
    const ring = new RingBuffer(1.5 * MB, 'node');
    fillRing(ring); // ~2 MB into 1.5 MB: wraps
    const before = ring.readAll();
    expect(before.length).toBe(1.5 * MB);
    sessions.push(fakeSession('p1', ring));
    await createBufferHibernation(deps({ minBytes: MB })).sweep();
    expect(ring.isHibernated).toBe(true);
    ring.write(Buffer.from('tail'));
    const after = ring.readAll();
    expect(after.length).toBe(1.5 * MB);
    expect(after.equals(Buffer.concat([before.subarray(4), Buffer.from('tail')]))).toBe(true);
  });

  it('does not release a ring that a viewer attached to, or that got output, while the dump was in flight', async () => {
    const attached = new RingBuffer(8 * MB, 'node');
    fillRing(attached);
    const attachedBytes = attached.readAll();
    sessions = [fakeSession('a', attached)];
    let sweep = createBufferHibernation(deps()).sweep();
    // The dump is in flight: the attach lands now, and its flush reads memory.
    sessions[0].meta.state = 'attached';
    sessions[0].viewerVisible = true;
    expect(attached.readAll().equals(attachedBytes)).toBe(true);
    expect((await sweep).hibernated).toBe(0);
    expect(attached.isHibernated).toBe(false);
    expect(attached.readAll().equals(attachedBytes)).toBe(true);

    const written = new RingBuffer(8 * MB, 'node');
    fillRing(written);
    sessions = [fakeSession('w', written)];
    sweep = createBufferHibernation(deps()).sweep();
    written.write(Buffer.from('late'));
    expect((await sweep).hibernated).toBe(0);
    expect(written.isHibernated).toBe(false);
    expect(written.readAll().subarray(-4).toString()).toBe('late');

    // Once quiet again, the next sweep releases it, with the late bytes on disk.
    expect((await createBufferHibernation(deps()).sweep()).hibernated).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'buffers', 'w.buf')).subarray(-4).toString()).toBe('late');
  });

  it('keeps the ring in memory when the dump fails, and retries later', async () => {
    const ring = new RingBuffer(8 * MB, 'node');
    fillRing(ring);
    const before = ring.readAll();
    sessions.push(fakeSession('p1', ring));
    let now = NOW;
    const failing = createBufferHibernation(deps({
      ensureBufferDir: () => { /* the directory never appears: the dump fails */ },
      now: () => now,
    }));

    const result = await failing.sweep();

    expect(result).toMatchObject({ hibernated: 0, failed: 1 });
    expect(ring.isHibernated).toBe(false);
    expect(ring.readAll().equals(before)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]); // no tmp left behind
    expect(logs.some((l) => l.includes('dump failed'))).toBe(true);

    // Backed off on the next tick, retried once the window passes.
    expect((await failing.sweep()).failed).toBe(0);
    now += 11 * 60_000;
    expect((await failing.sweep()).failed).toBe(1);
  });

  it('never hibernates a pane with an agent, a running command, a viewer, recent output or a small ring', () => {
    const ring = new RingBuffer(8 * MB, 'node');
    fillRing(ring);
    const d = deps();
    const check = (mutate: (s: FakeSession) => void): string | null => {
      const s = fakeSession('p', ring);
      mutate(s);
      return hibernationBlocker(s as unknown as ManagedSession, d, NOW);
    };

    expect(check(() => undefined)).toBeNull();
    // The desk's background workspace keeps panes attached but hidden: eligible.
    expect(check((s) => { s.meta.state = 'attached'; s.viewerVisible = false; })).toBeNull();
    expect(check((s) => { s.meta.state = 'attached'; s.viewerVisible = true; })).toBe('visible');
    expect(check((s) => { remote.add(s.meta.id); })).toBe('remote-viewer');
    remote.clear();
    expect(check((s) => { agentAlive.set(s.meta.id, true); })).toBe('agent');
    agentAlive.clear();
    expect(check((s) => { s.agentStatus = 'running'; })).toBe('agent');
    expect(check((s) => { s.agentStatus = 'awaiting_input'; })).toBe('agent');
    expect(check((s) => { s.meta.exec = { command: 'claude' }; })).toBe('agent');
    expect(check((s) => { s.commandRunning = true; })).toBe('command');
    expect(check((s) => { s.meta.lastActivity = new Date(NOW - HOUR).toISOString(); })).toBe('recent-output');
    expect(check((s) => { s.meta.state = 'dead'; })).toBe('not-live');
    expect(hibernationBlocker(fakeSession('p', ring) as unknown as ManagedSession, deps({ idleHours: () => 0 }), NOW)).toBe('off');
    const small = new RingBuffer(8 * MB, 'node');
    small.write(Buffer.alloc(512 * 1024, 0x61));
    expect(hibernationBlocker(fakeSession('s', small) as unknown as ManagedSession, d, NOW)).toBe('small');
  });

  it('is not woken by periodic snapshot dumps, and a dead pane gets its bytes back before the .buf is deleted', async () => {
    const ring = new RingBuffer(8 * MB, 'node');
    fillRing(ring);
    const before = ring.readAll();
    sessions.push(fakeSession('p1', ring));
    await createBufferHibernation(deps()).sweep();
    const bufPath = path.join(dir, 'buffers', 'p1.buf');

    await ring.dumpToFile(bufPath); // the forced 30 s snapshot
    ring.dumpToFileSyncAtomic(bufPath); // the Windows exit-path dump
    expect(ring.isHibernated).toBe(true);
    expect(fs.readFileSync(bufPath).equals(before)).toBe(true);

    // session:died wakes the ring, then deletes the file.
    ring.wake();
    fs.unlinkSync(bufPath);
    expect(ring.readAll().equals(before)).toBe(true);
  });

  it('a read-only wake holds the ring for an idle window, then it re-hibernates without rewriting the .buf', async () => {
    const ring = new RingBuffer(8 * MB, 'node');
    fillRing(ring);
    sessions.push(fakeSession('p1', ring));
    let now = NOW;
    const hibernation = createBufferHibernation(deps({ now: () => now }));
    await hibernation.sweep();
    const bufPath = path.join(dir, 'buffers', 'p1.buf');
    const marker = new Date(Math.floor((NOW - 10 * HOUR) / 1000) * 1000);
    fs.utimesSync(bufPath, marker, marker);

    ring.readAll(); // e.g. a phone screen poll woke it
    expect(ring.isHibernated).toBe(false);
    expect(hibernationBlocker(sessions[0] as unknown as ManagedSession, deps(), now)).toBe('recent-wake');
    expect((await hibernation.sweep()).hibernated).toBe(0);

    now = NOW + 25 * HOUR; // no read for a whole idle window
    expect((await hibernation.sweep()).hibernated).toBe(1);
    expect(fs.statSync(bufPath).mtimeMs).toBe(marker.getTime());
  });

  it('a restart recovers a hibernated pane from its .buf, which the orphan sweep keeps', async () => {
    const writer = new StateWriter(dir);
    writer.ensureBufferDir();
    const ring = new RingBuffer(8 * MB, 'node');
    fillRing(ring);
    const before = ring.readAll();
    sessions.push(fakeSession('live', ring));
    await createBufferHibernation(deps({ bufferPath: (id) => writer.getBufferDumpPath(id) })).sweep();
    expect(ring.isHibernated).toBe(true);
    fs.writeFileSync(writer.getBufferDumpPath('orphan'), 'stale');

    // Shutdown dumps every live ring: a no-op for the hibernated one.
    await ring.dumpToFile(writer.getBufferDumpPath('live'));
    // Recovery preserves the ids of every non-dead persisted session.
    writer.cleanOrphanedBuffers(new Set(['live']));

    expect(fs.existsSync(writer.getBufferDumpPath('orphan'))).toBe(false);
    const recovered = RingBuffer.loadFromFile(writer.getBufferDumpPath('live'), 8 * MB);
    expect(recovered.readAll().equals(before)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the .buf and the hibernation when the file cannot be read back yet',
    async () => {
      const ring = new RingBuffer(8 * MB, 'node');
      fillRing(ring);
      const before = ring.readAll();
      sessions.push(fakeSession('p1', ring));
      await createBufferHibernation(deps()).sweep();
      const bufPath = path.join(dir, 'buffers', 'p1.buf');
      fs.chmodSync(bufPath, 0o000); // a transient read failure (EACCES)

      // Output still lands, a read serves what it can, nothing is overwritten.
      const failuresBefore = RingBuffer.wakeFailures;
      for (const ch of 'during') ring.write(Buffer.from(ch));
      expect(RingBuffer.wakeFailures).toBe(failuresBefore + 1); // one episode, one count
      expect(ring.isHibernated).toBe(true);
      expect(ring.readAll().toString()).toBe('during');
      expect(ring.readAllWithGeometry()).toMatchObject({ geometry: undefined, writtenAt: before.length + 6 });
      // Neither readable nor writable: the dump fails and the file is untouched.
      await expect(ring.dumpToFile(bufPath)).rejects.toThrow();
      expect(ring.wake()).toBe(false); // session:died keeps the file
      expect(ring.totalBytesWritten).toBe(before.length + 6);

      // A shutdown dump appends the new bytes instead of replacing the file,
      // so a recovery from it holds every byte.
      fs.chmodSync(bufPath, 0o200); // writable, still unreadable
      await ring.dumpToFile(bufPath);
      expect(ring.isHibernated).toBe(true);
      fs.chmodSync(bufPath, 0o600);
      const full = Buffer.concat([before, Buffer.from('during')]);
      expect(fs.readFileSync(bufPath).equals(full)).toBe(true);

      ring.write(Buffer.from('+after'));
      expect(ring.readAll().equals(Buffer.concat([full, Buffer.from('+after')]))).toBe(true);
      expect(ring.isHibernated).toBe(false);
      expect(ring.totalBytesWritten).toBe(full.length + 6);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a dump retried after a partial write overwrites it instead of repeating it',
    async () => {
      const ring = new RingBuffer(8 * MB, 'node');
      fillRing(ring);
      const before = ring.readAll();
      sessions.push(fakeSession('p1', ring));
      await createBufferHibernation(deps()).sweep();
      const bufPath = path.join(dir, 'buffers', 'p1.buf');
      fs.chmodSync(bufPath, 0o200); // writable, unreadable

      ring.write(Buffer.from('ABCD'));
      // A first attempt wrote 'AB' and then failed, rollback included.
      fs.appendFileSync(bufPath, 'AB');
      await ring.dumpToFile(bufPath);
      ring.write(Buffer.from('EF'));
      fs.appendFileSync(bufPath, 'E'); // and once more, past the committed end
      await ring.dumpToFile(bufPath);

      fs.chmodSync(bufPath, 0o600);
      const full = Buffer.concat([before, Buffer.from('ABCDEF')]);
      expect(fs.readFileSync(bufPath).equals(full)).toBe(true);
      expect(ring.readAll().equals(full)).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable .buf stays bounded while output keeps arriving, and the wake keeps only what fits',
    async () => {
      const capacity = 2 * MB;
      const ring = new RingBuffer(capacity, 'node');
      fillRing(ring);
      let stream = ring.readAll();
      sessions.push(fakeSession('p1', ring));
      await createBufferHibernation(deps({ minBytes: MB })).sweep();
      expect(ring.isHibernated).toBe(true);
      const bufPath = path.join(dir, 'buffers', 'p1.buf');
      fs.chmodSync(bufPath, 0o200);

      let maxFile = 0;
      for (let i = 0; i < 20; i++) {
        const chunk = Buffer.alloc(300 * 1024, 0x41 + (i % 26));
        ring.write(chunk);
        stream = Buffer.concat([stream, chunk]).subarray(-capacity);
        await ring.dumpToFile(bufPath); // the 30 s snapshot
        maxFile = Math.max(maxFile, fs.statSync(bufPath).size);
        expect(ring.allocatedBytes).toBeLessThanOrEqual(capacity);
      }

      expect(maxFile).toBeLessThan(2 * capacity);
      fs.chmodSync(bufPath, 0o600);
      expect(ring.readAll().equals(stream)).toBe(true);
      await ring.dumpToFile(bufPath);
      expect(fs.statSync(bufPath).size).toBe(capacity);
    },
  );

  it('skips rust rings', () => {
    const ring = new RingBuffer(8 * MB, 'node');
    fillRing(ring);
    const s = fakeSession('r', ring);
    Object.defineProperty(ring, 'backend', { value: 'rust' });
    expect(hibernationBlocker(s as unknown as ManagedSession, deps(), NOW)).toBe('rust-ring');
  });
});
