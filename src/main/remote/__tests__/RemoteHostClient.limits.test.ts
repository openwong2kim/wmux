import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteHostClient, normalizeWorkspaces } from '../RemoteHostClient';
import { RemoteBodyTooLargeError, readBoundedJson } from '../readBoundedJson';
import { REMOTE_LIMITS } from '../../../shared/remoteLimits';
import type { RemoteHost } from '../../../shared/remoteHosts';

const host: RemoteHost = {
  id: 'host-1',
  label: 'office-mac',
  origin: 'https://office-mac.example.ts.net:9600',
  token: 'secret-token',
  addedAt: 0,
};

/** A body that yields `chunk` until cancelled, counting what was pulled. */
function endlessBody(chunk: Uint8Array): { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

function sse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes);
      }
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('readBoundedJson', () => {
  it('refuses a body over the cap and stops reading it', async () => {
    const body = endlessBody(new Uint8Array(64 * 1024).fill(0x20));
    const res = new Response(body.stream);
    await expect(readBoundedJson(res, 1024 * 1024)).rejects.toBeInstanceOf(RemoteBodyTooLargeError);
    expect(body.cancelled()).toBe(true);
    // At most one chunk past the cap was ever pulled.
    expect(body.pulled()).toBeLessThanOrEqual(1024 * 1024 + 2 * 64 * 1024);
  });

  it('refuses up front when Content-Length is over the cap', async () => {
    const res = new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } });
    await expect(readBoundedJson(res, 1024)).rejects.toBeInstanceOf(RemoteBodyTooLargeError);
  });

  it('parses a body under the cap', async () => {
    await expect(readBoundedJson(new Response('{"a":1}'), 1024)).resolves.toEqual({ a: 1 });
  });
});

describe('RemoteHostClient — bounded reads', () => {
  it('listWorkspaces rejects an oversized body instead of buffering it', async () => {
    const body = endlessBody(new TextEncoder().encode('{"workspaces":['.padEnd(64 * 1024, ' ')));
    const fetchImpl = vi.fn(async () => new Response(body.stream));
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    await expect(client.listWorkspaces()).rejects.toThrow(/not JSON/);
    expect(body.pulled()).toBeLessThanOrEqual(REMOTE_LIMITS.workspacesBodyBytes + 2 * 64 * 1024);
  });

  // The stream opens with a well-formed attach frame pair, so a counter that
  // resets on any good frame would retry forever; an oversized frame ends it.
  it('an endless stream with no frame terminator is cut at the cap and never retried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bodies: ReturnType<typeof endlessBody>[] = [];
    const fetchImpl = vi.fn(async () => {
      const body = endlessBody(new Uint8Array(256 * 1024).fill(0x61));
      bodies.push(body);
      const head = new TextEncoder().encode('event: meta\ndata: {"cols":80,"rows":24}\n\nevent: snapshot\ndata: AA==\n\n');
      const reader = body.stream.getReader();
      let sentHead = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sentHead) { sentHead = true; controller.enqueue(head); return; }
          const { value } = await reader.read();
          if (value) controller.enqueue(value);
        },
        cancel() { void reader.cancel(); },
      });
      return { ok: true, status: 200, body: stream } as unknown as Response;
    });
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    const errors: string[] = [];
    client.onError((e) => errors.push(e.message));
    client.attach('s1');

    for (let i = 0; i < 8 && errors.length === 0; i += 1) {
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await flush();

    expect(errors).toEqual(['stream frame exceeds the size limit']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const body of bodies) {
      expect(body.cancelled()).toBe(true);
      expect(body.pulled()).toBeLessThanOrEqual(REMOTE_LIMITS.streamBufferBytes + 2 * 256 * 1024);
    }
    client.detachAll();
  });
});

describe('RemoteHostClient — geometry', () => {
  it('clamps absurd meta geometry and drops a frame with none', async () => {
    const frames =
      'event: meta\ndata: {"cols":1e9,"rows":-5,"truncated":"yes","omittedBytes":-1}\n\n' +
      'event: snapshot\ndata: AA==\n\n' +
      'event: meta\ndata: {"cols":"80","rows":null,"resize":true}\n\n' +
      'event: meta\ndata: {"cols":120.7,"rows":30,"resize":true}\n\n';
    const client = new RemoteHostClient(host, (async () => sse(frames)) as unknown as typeof fetch);
    const metas: unknown[] = [];
    const resizes: unknown[] = [];
    client.onMeta((e) => metas.push(e));
    client.onResize((e) => resizes.push(e));
    const attachId = client.attach('s1');
    await flush();
    client.detachAll();

    expect(metas).toEqual([{ attachId, cols: REMOTE_LIMITS.geometryMax, rows: 1, snapshotB64: 'AA==' }]);
    expect(resizes).toEqual([{ attachId, cols: 120, rows: 30 }]);
  });

  it('resizeSession clamps what it sends and refuses an out-of-range answer', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ cols: 99999, rows: Number.MAX_SAFE_INTEGER })),
    );
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    const result = await client.resizeSession('s1', 1e12, 0);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ cols: REMOTE_LIMITS.geometryMax, rows: 1 });
    expect(result).toEqual({ ok: false, reason: 'resizeSession: response geometry out of range' });

    // An in-range answer that differs from the request (the host floors) is a grant.
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ cols: 40, rows: 8 })));
    await expect(client.resizeSession('s1', 20, 4)).resolves.toEqual({ ok: true, cols: 40, rows: 8 });

    fetchImpl.mockClear();
    await expect(client.resizeSession('s1', Number.NaN, 24)).resolves.toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/** Control and bidi characters, built from code points so no editor or tool
 *  can normalise them away: ESC, CR, LF, BEL, NUL, C1 NEL, LINE SEPARATOR,
 *  RIGHT-TO-LEFT OVERRIDE, FIRST STRONG ISOLATE. */
const C = {
  esc: String.fromCharCode(0x1b),
  cr: String.fromCharCode(0x0d),
  lf: String.fromCharCode(0x0a),
  bel: String.fromCharCode(0x07),
  nul: String.fromCharCode(0x00),
  nel: String.fromCharCode(0x85),
  ls: String.fromCharCode(0x2028),
  rlo: String.fromCharCode(0x202e),
  fsi: String.fromCharCode(0x2068),
};

describe('RemoteHostClient — control characters in host text', () => {
  it('normalizeWorkspaces replaces control and bidi characters in display text', () => {
    const out = normalizeWorkspaces({
      workspaces: [{
        id: 'w1',
        name: `evil${C.esc}[31mRED${C.cr}${C.lf}line${C.rlo}gnp.exe${C.nul}${C.nel}x${C.ls}y${C.fsi}z`,
        panes: [{
          sessionId: 's1',
          shell: `pwsh${C.esc}[2J`,
          cwd: `C:\\x${C.bel}${C.esc}]8;;file:///C:/${C.bel}link`,
          agentName: `claude${C.esc}[5m`,
        }],
      }],
    });
    expect(out).toEqual([{
      id: 'w1',
      name: 'evil [31mRED line gnp.exe x y z',
      panes: [{ sessionId: 's1', shell: 'pwsh [2J', cwd: 'C:\\x ]8;;file:///C:/ link', agentName: 'claude [5m' }],
    }]);
  });

  it('normalizeWorkspaces drops a row whose id carries a control character', () => {
    const out = normalizeWorkspaces({
      workspaces: [
        { id: `w${C.esc}1`, name: 'a', panes: [] },
        { id: 'w2', name: 'b', panes: [{ sessionId: `s${C.lf}1` }, { sessionId: 's2' }] },
      ],
    });
    expect(out).toEqual([{ id: 'w2', name: 'b', panes: [{ sessionId: 's2' }] }]);
  });

  it("a host's error text reaches the caller without control characters", async () => {
    const detail = `boom${C.esc}[31m${C.cr}${C.lf}FAKE: credential accepted${C.rlo}`;
    const client = new RemoteHostClient(host, (async () => new Response(JSON.stringify({ error: 'x', detail }), { status: 500 })) as unknown as typeof fetch);
    await expect(client.createWorkspace('w1')).rejects.toThrow(/^boom \[31m FAKE: credential accepted $/);

    const resize = new RemoteHostClient(host, (async () => new Response(JSON.stringify({ error: detail }), { status: 500 })) as unknown as typeof fetch);
    await expect(resize.resizeSession('s1', 80, 24)).resolves.toEqual({ ok: false, reason: 'boom [31m FAKE: credential accepted ' });
  });
});

describe('normalizeWorkspaces — bounds', () => {
  it('keeps the first row of a duplicate workspace or session id', () => {
    const out = normalizeWorkspaces({
      workspaces: [
        { id: 'w1', name: 'first', panes: [{ sessionId: 's1' }, { sessionId: 's1' }] },
        { id: 'w1', name: 'second', panes: [{ sessionId: 's2' }] },
        { id: 'w2', name: 'other', panes: [{ sessionId: 's1' }, { sessionId: 's3' }] },
      ],
    });
    expect(out).toEqual([
      { id: 'w1', name: 'first', panes: [{ sessionId: 's1' }] },
      { id: 'w2', name: 'other', panes: [{ sessionId: 's3' }] },
    ]);
  });

  it('caps row counts and string lengths, and drops over-long ids', () => {
    const workspaces = Array.from({ length: REMOTE_LIMITS.workspaces + 50 }, (_, i) => ({
      id: `w${i}`,
      name: 'n'.repeat(10_000),
      panes: Array.from({ length: 10 }, (__, j) => ({ sessionId: `s${i}-${j}`, cwd: '/'.repeat(100_000), shell: 'z'.repeat(5_000) })),
    }));
    workspaces.unshift({ id: 'x'.repeat(REMOTE_LIMITS.id + 1), name: '', panes: [] });
    const out = normalizeWorkspaces({ workspaces });

    expect(out).toHaveLength(REMOTE_LIMITS.workspaces);
    expect(out[0].id).toBe('w0');
    expect(out[0].name).toHaveLength(REMOTE_LIMITS.workspaceName);
    expect(out[0].panes[0].cwd).toHaveLength(REMOTE_LIMITS.cwd);
    expect(out[0].panes[0].shell).toHaveLength(REMOTE_LIMITS.shell);
    expect(out.reduce((n, w) => n + w.panes.length, 0)).toBe(REMOTE_LIMITS.panes);
  });
});

/** A stream that yields `chunks` (bytes) and then stays open. */
function byteStream(chunks: Uint8Array[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

describe('RemoteHostClient — frames are counted in bytes', () => {
  const enc = new TextEncoder();

  it('refuses a COMPLETE data frame over the cap before dispatching it', async () => {
    const big = 'A'.repeat(REMOTE_LIMITS.streamBufferBytes + 10);
    const frame = enc.encode(`event: data\ndata: ${big}\n\n`);
    const client = new RemoteHostClient(host, (async () => byteStream([frame])) as unknown as typeof fetch);
    const data: unknown[] = [];
    const errors: string[] = [];
    client.onData((e) => data.push(e));
    client.onError((e) => errors.push(e.message));
    client.attach('s1');
    await flush();
    client.detachAll();
    expect(data).toEqual([]);
    expect(errors).toEqual(['stream frame exceeds the size limit']);
  });

  it('refuses a multi-byte frame whose UTF-16 length is under the cap but bytes are over it', async () => {
    // 3 bytes per character: ~2M characters, ~6 MiB on the wire.
    const chars = Math.ceil((REMOTE_LIMITS.streamBufferBytes * 1.5) / 3);
    const name = '한'.repeat(chars);
    expect(name.length).toBeLessThan(REMOTE_LIMITS.streamBufferBytes);
    const frame = enc.encode(`event: meta\ndata: {"cols":80,"rows":24,"x":"${name}"}\n\n`);
    const client = new RemoteHostClient(host, (async () => byteStream([frame])) as unknown as typeof fetch);
    const resizes: unknown[] = [];
    const errors: string[] = [];
    client.onResize((e) => resizes.push(e));
    client.onError((e) => errors.push(e.message));
    client.attach('s1');
    await flush();
    client.detachAll();
    expect(resizes).toEqual([]);
    expect(errors).toEqual(['stream frame exceeds the size limit']);
  });

  it('still delivers multi-byte frames split across chunks', async () => {
    const bytes = enc.encode('event: data\ndata: 한글\n\nevent: exit\ndata: {}\n\n');
    const chunks = [bytes.subarray(0, 20), bytes.subarray(20, 24), bytes.subarray(24, 25), bytes.subarray(25)];
    const client = new RemoteHostClient(host, (async () => byteStream(chunks)) as unknown as typeof fetch);
    const data: string[] = [];
    let exits = 0;
    client.onData((e) => data.push(e.dataB64));
    client.onExit(() => { exits += 1; });
    client.attach('s1');
    await flush();
    client.detachAll();
    expect(data).toEqual(['한글']);
    expect(exits).toBe(1);
  });
});

describe('RemoteHostClient — viewer window', () => {
  /** A host that sends complete, in-limit data frames for as long as it is read. */
  function steadyHost(frameBytes: number): { fetchImpl: typeof fetch; pulled: () => number } {
    const frame = new TextEncoder().encode(`event: data\ndata: ${'B'.repeat(frameBytes)}\n\n`);
    let pulled = 0;
    const fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += frame.byteLength;
          controller.enqueue(frame);
        },
      });
      return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, pulled: () => pulled };
  }

  it('stops reading at the window for a viewer that never acks, then ends the attach', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const host1 = steadyHost(64 * 1024);
    const windowBytes = 1024 * 1024;
    const client = new RemoteHostClient(host, host1.fetchImpl, { viewerWindowBytes: windowBytes, viewerStallMs: 5_000 });
    let delivered = 0;
    const errors: string[] = [];
    client.onData((e) => { delivered += e.dataB64.length; });
    client.onError((e) => errors.push(e.message));
    const attachId = client.attach('s1');
    await flush();
    await flush();

    // Paused: what was handed over is bounded by the window plus one chunk.
    expect(delivered).toBeGreaterThan(windowBytes);
    expect(delivered).toBeLessThanOrEqual(windowBytes + 64 * 1024);
    const pulledWhilePaused = host1.pulled();
    await flush();
    expect(host1.pulled()).toBeLessThanOrEqual(pulledWhilePaused + 2 * (64 * 1024 + 32));
    expect(client.unackedBytes(attachId)).toBe(delivered);

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(errors).toEqual(['stream paused: the viewer stopped consuming output']);
    client.detachAll();
  });

  it('resumes reading once the viewer acks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const host1 = steadyHost(64 * 1024);
    const windowBytes = 1024 * 1024;
    const client = new RemoteHostClient(host, host1.fetchImpl, { viewerWindowBytes: windowBytes, viewerStallMs: 5_000 });
    let delivered = 0;
    const errors: string[] = [];
    client.onData((e) => { delivered += e.dataB64.length; });
    client.onError((e) => errors.push(e.message));
    const attachId = client.attach('s1');
    await flush();
    const before = delivered;
    client.ack(attachId, before);
    await flush();
    expect(delivered).toBeGreaterThan(before);
    expect(errors).toEqual([]);
    client.detachAll();
  });
});
