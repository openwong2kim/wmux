// Real-call verification of the in-process Windows snapshot (issue #1051):
// loads the real koffi binary and drives the real Win32 APIs. This is the
// evidence the fixture tests cannot give — that the struct offsets match the
// running OS, that the port byte order is right, and that a listener this
// process opens is attributed to this pid. Runs under system Node on CI
// (windows-latest) — the same runtime the headless daemon CLI uses.
import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import { tryNativeSnapshot } from '../winSnapshotNative';

const onWindows = process.platform === 'win32';

interface Listener {
  port: number;
  close: () => Promise<void>;
}

function listen(host: string): Promise<Listener | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(0, host, () => {
      const addr = srv.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

describe.skipIf(!onWindows)('winSnapshotNative (real Win32 calls)', () => {
  it('sees this process with its real ppid and attributes our listeners to our pid', async () => {
    const v4 = await listen('127.0.0.1');
    const v6 = await listen('::1'); // null when IPv6 is administratively off
    try {
      const snap = tryNativeSnapshot();
      expect(snap).not.toBeNull();

      const me = snap!.procs.find((p) => p.pid === process.pid);
      expect(me).toBeDefined();
      expect(me!.ppid).toBe(process.ppid);

      expect(v4).not.toBeNull();
      expect(
        snap!.conns.some((c) => c.port === v4!.port && c.pid === process.pid),
      ).toBe(true);
      if (v6) {
        expect(
          snap!.conns.some((c) => c.port === v6.port && c.pid === process.pid),
        ).toBe(true);
      }
    } finally {
      await v4?.close();
      await v6?.close();
    }
  });

  it('stays within a sane per-call latency budget', () => {
    // The load cost was paid by the test above; steady-state calls must be
    // far below the 8 s the old subprocess path was budgeted. The ceiling is
    // generous for cold CI runners — a real regression (hang, unbounded
    // retry) still fails.
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) {
      expect(tryNativeSnapshot()).not.toBeNull();
    }
    const perCall = (performance.now() - t0) / 3;
    expect(perCall).toBeLessThan(1000);
  });
});
