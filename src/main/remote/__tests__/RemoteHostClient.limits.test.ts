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

  it('an endless stream with no frame terminator is cut at the cap and ends in onError', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bodies: ReturnType<typeof endlessBody>[] = [];
    const fetchImpl = vi.fn(async () => {
      const body = endlessBody(new Uint8Array(256 * 1024).fill(0x61));
      bodies.push(body);
      return { ok: true, status: 200, body: body.stream } as unknown as Response;
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
    // One first attempt plus the bounded retries — never an endless loop.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
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

  it('resizeSession clamps what it sends and what it reports', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ cols: 99999, rows: Number.MAX_SAFE_INTEGER })),
    );
    const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
    const result = await client.resizeSession('s1', 1e12, 0);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ cols: REMOTE_LIMITS.geometryMax, rows: 1 });
    expect(result).toEqual({ ok: true, cols: REMOTE_LIMITS.geometryMax, rows: REMOTE_LIMITS.geometryMax });

    fetchImpl.mockClear();
    await expect(client.resizeSession('s1', Number.NaN, 24)).resolves.toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
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
