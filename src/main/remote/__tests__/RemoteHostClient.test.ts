import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RemoteHostClient } from '../RemoteHostClient';
import type { RemoteHost } from '../../../shared/remoteHosts';

function makeHost(overrides: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: 'host-1',
    label: 'office-mac',
    origin: 'https://office-mac.example.ts.net:9600',
    token: 'secret-token',
    addedAt: 0,
    ...overrides,
  };
}

const META_SNAPSHOT = 'event: meta\ndata: {"cols":80,"rows":24}\n\n' + 'event: snapshot\ndata: c25hcHNob3Q=\n\n';

/** Builds a fake streaming Response whose body yields the given raw SSE text,
 *  optionally split into multiple chunks to exercise partial-frame handling.
 *  The stream stays open (never closes on its own) until aborted, matching
 *  real SSE semantics. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  let aborted = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (aborted) {
        controller.close();
        return;
      }
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
      }
    },
    cancel() {
      aborted = true;
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

/** A stream that immediately errors on read — simulates a dropped connection. */
function erroringStreamResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('stream reset'));
    },
  });
  return { ok: true, status: 200, body: stream } as unknown as Response;
}

describe('RemoteHostClient', () => {
  let host: RemoteHost;

  beforeEach(() => {
    host = makeHost();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createWorkspace (#1001)', () => {
    it('POSTs to /api/sessions with the operator Bearer token and the caller-supplied workspaceId', async () => {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: true,
        status: 201,
        json: async () => ({ id: 'web-1' }),
      }) as unknown as Response);
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const result = await client.createWorkspace('ws-brand-new');

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`${host.origin}/api/sessions`);
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${host.token}`);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(init?.body as string)).toEqual({ workspaceId: 'ws-brand-new' });
      expect(result).toEqual({ sessionId: 'web-1' });
    });

    it('includes cwd in the body only when given', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 'web-1' }) }) as unknown as Response);
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      await client.createWorkspace('ws-1', '/repo');

      const [, init] = fetchImpl.mock.calls[0];
      expect(JSON.parse(init?.body as string)).toEqual({ workspaceId: 'ws-1', cwd: '/repo' });
    });

    it('rejects with the daemon-supplied detail on a non-OK response', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid-workspace-id', detail: 'workspaceId must match ^[A-Za-z0-9_-]{1,64}$' }),
      }) as unknown as Response);
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      await expect(client.createWorkspace('bad id')).rejects.toThrow(
        'workspaceId must match ^[A-Za-z0-9_-]{1,64}$',
      );
    });

    it('rejects with a generic message when the error body is not JSON', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => { throw new Error('not json'); },
      }) as unknown as Response);
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      await expect(client.createWorkspace('ws-1')).rejects.toThrow('createWorkspace failed: HTTP 500');
    });

    it('rejects when the response carries no session id', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}) }) as unknown as Response);
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      await expect(client.createWorkspace('ws-1')).rejects.toThrow(
        'createWorkspace failed: response carried no session id',
      );
    });
  });

  describe('listWorkspaces', () => {
    it('sends Authorization: Bearer <token> and parses the body', async () => {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workspaces: [{ id: 'w1', name: 'proj', panes: [] }] }),
        } as unknown as Response;
      });
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const result = await client.listWorkspaces();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`${host.origin}/api/workspaces`);
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${host.token}`);
      expect(result).toEqual({ workspaces: [{ id: 'w1', name: 'proj', panes: [] }] });
    });

    // M2 — a credentialed listWorkspaces fetch must never follow a redirect
    // and must not hang forever.
    it('sets redirect: error and an abort timeout', async () => {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ workspaces: [] }) }) as unknown as Response);
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      await client.listWorkspaces();

      const [, init] = fetchImpl.mock.calls[0];
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    // Finding 3 — the body comes off ANOTHER machine. It used to be handed on
    // with nothing but a cast, so a shape the remote had no business sending
    // threw far downstream and took a whole refresh round with it.
    describe('normalises an untrustworthy body', () => {
      function clientFor(body: unknown): RemoteHostClient {
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);
        return new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
      }

      it('turns a non-array `workspaces` into an empty list', async () => {
        await expect(clientFor({ workspaces: null }).listWorkspaces()).resolves.toEqual({ workspaces: [] });
        await expect(clientFor({ workspaces: 'nope' }).listWorkspaces()).resolves.toEqual({ workspaces: [] });
        await expect(clientFor({}).listWorkspaces()).resolves.toEqual({ workspaces: [] });
        await expect(clientFor(null).listWorkspaces()).resolves.toEqual({ workspaces: [] });
      });

      it('turns a null pane list into an empty one', async () => {
        await expect(clientFor({ workspaces: [{ id: 'w1', name: 'proj', panes: null }] }).listWorkspaces())
          .resolves.toEqual({ workspaces: [{ id: 'w1', name: 'proj', panes: [] }] });
      });

      it('drops entries that cannot be addressed and keeps the rest', async () => {
        const body = {
          workspaces: [
            null,
            { name: 'no id', panes: [] },
            { id: '', panes: [] },
            { id: 'w1', panes: [{ sessionId: 's1', shell: 'zsh' }, { shell: 'no session id' }, 42] },
          ],
        };
        await expect(clientFor(body).listWorkspaces()).resolves.toEqual({
          workspaces: [{ id: 'w1', name: '', panes: [{ sessionId: 's1', shell: 'zsh' }] }],
        });
      });

      it('rejects a body that is not JSON at all', async () => {
        const fetchImpl = vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => { throw new SyntaxError('Unexpected token <'); },
        }) as unknown as Response);
        const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);
        await expect(client.listWorkspaces()).rejects.toThrow(/not JSON/);
      });
    });
  });

  describe('attach', () => {
    it('emits meta (combined with snapshot) then data in order', async () => {
      const body = META_SNAPSHOT + 'event: data\ndata: aGVsbG8=\n\n';
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([body]));
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const received: string[] = [];
      client.onMeta((e) => received.push(`meta:${e.cols}x${e.rows}:${e.snapshotB64}`));
      client.onData((e) => received.push(`data:${e.dataB64}`));

      const attachId = client.attach('sess-1');
      expect(typeof attachId).toBe('string');

      await vi.waitFor(() => {
        expect(received).toEqual(['meta:80x24:c25hcHNob3Q=', 'data:aGVsbG8=']);
      });

      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`${host.origin}/api/stream?session=sess-1`);
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${host.token}`);
      // M2 — credentialed request, never follow a redirect. No timeout here
      // (long-lived by design) — the abort signal is the attach controller.
      expect(init?.redirect).toBe('error');
    });

    // ── geometry-only frames ─────────────────────────────────────────────
    //
    // The daemon answers a resize with `meta` and nothing else: re-sending the
    // window would cost a full ring copy per viewer and every client resets its
    // terminal before replaying one, wiping the viewer's scrollback. A meta
    // held for a snapshot that is never coming is how those resizes used to
    // reach the mirror as nothing at all.
    it('★ dispatches a resize-marked meta as geometry, not as a repaint', async () => {
      const body =
        META_SNAPSHOT +
        'event: meta\ndata: {"cols":100,"rows":40,"resize":true}\n\n' +
        'event: data\ndata: aGVsbG8=\n\n';
      const fetchImpl = vi.fn(async () => sseResponse([body]));
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const received: string[] = [];
      client.onMeta((e) => received.push(`meta:${e.cols}x${e.rows}`));
      client.onResize((e) => received.push(`resize:${e.cols}x${e.rows}`));
      client.onData((e) => received.push(`data:${e.dataB64}`));

      client.attach('sess-1');
      await vi.waitFor(() => {
        expect(received).toEqual(['meta:80x24', 'resize:100x40', 'data:aGVsbG8=']);
      });
    });

    it('★ releases a bare meta that no snapshot follows, as geometry', async () => {
      // Belt and braces for a peer that omits the marker: a held meta must not
      // sit in the buffer for the rest of the stream.
      const body =
        META_SNAPSHOT +
        'event: meta\ndata: {"cols":120,"rows":30}\n\n' +
        'event: data\ndata: aGVsbG8=\n\n';
      const fetchImpl = vi.fn(async () => sseResponse([body]));
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const received: string[] = [];
      client.onMeta((e) => received.push(`meta:${e.cols}x${e.rows}`));
      client.onResize((e) => received.push(`resize:${e.cols}x${e.rows}`));
      client.onData((e) => received.push(`data:${e.dataB64}`));

      client.attach('sess-1');
      await vi.waitFor(() => {
        expect(received).toEqual(['meta:80x24', 'resize:120x30', 'data:aGVsbG8=']);
      });
    });

    it('forwards truncated and omittedBytes from meta', async () => {
      const body =
        'event: meta\ndata: {"cols":80,"rows":24,"truncated":true,"omittedBytes":42}\n\n' +
        'event: snapshot\ndata: c25hcHNob3Q=\n\n';
      const fetchImpl = vi.fn(async () => sseResponse([body]));
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      let metaEvent: { truncated?: boolean; omittedBytes?: number } | undefined;
      client.onMeta((e) => {
        metaEvent = e;
      });
      client.attach('sess-1');

      await vi.waitFor(() => {
        expect(metaEvent).toBeDefined();
      });
      expect(metaEvent?.truncated).toBe(true);
      expect(metaEvent?.omittedBytes).toBe(42);
    });

    it('skips comment frames (heartbeat ": ping")', async () => {
      const body = META_SNAPSHOT + ': ping\n\n' + 'event: data\ndata: aGVsbG8=\n\n';
      const fetchImpl = vi.fn(async () => sseResponse([body]));
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const received: string[] = [];
      client.onMeta(() => received.push('meta'));
      client.onData((e) => received.push(`data:${e.dataB64}`));
      client.attach('sess-1');

      await vi.waitFor(() => {
        expect(received).toEqual(['meta', 'data:aGVsbG8=']);
      });
    });

    it('ignores unknown event names (e.g. attention) instead of treating them as pane bytes', async () => {
      const body = META_SNAPSHOT + 'event: attention\ndata: {"kind":"notify"}\n\n' + 'event: data\ndata: aGVsbG8=\n\n';
      const fetchImpl = vi.fn(async () => sseResponse([body]));
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const received: string[] = [];
      client.onMeta(() => received.push('meta'));
      client.onData((e) => received.push(`data:${e.dataB64}`));
      client.attach('sess-1');

      await vi.waitFor(() => {
        expect(received).toEqual(['meta', 'data:aGVsbG8=']);
      });
      // No extra events snuck through as data.
      expect(received).toHaveLength(2);
    });

    it('emits exit', async () => {
      const body = META_SNAPSHOT + 'event: exit\ndata: 1\n\n';
      const fetchImpl = vi.fn(async () => sseResponse([body]));
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      let exited = false;
      client.onExit(() => {
        exited = true;
      });
      client.attach('sess-1');

      await vi.waitFor(() => {
        expect(exited).toBe(true);
      });
    });

    it('handles a frame split across multiple stream chunks', async () => {
      const fetchImpl = vi.fn(async () =>
        sseResponse(['event: meta\ndata: {"cols":80', ',"rows":24}\n\nevent: snapshot\ndata: c25hcHNob3Q=\n\n']),
      );
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const received: string[] = [];
      client.onMeta((e) => received.push(`meta:${e.cols}x${e.rows}`));
      client.attach('sess-1');

      await vi.waitFor(() => {
        expect(received).toEqual(['meta:80x24']);
      });
    });
  });

  describe('detach / detachAll', () => {
    it('detach aborts the stream fetch and stops further events', async () => {
      let abortSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        abortSignal = init?.signal ?? undefined;
        return sseResponse([META_SNAPSHOT]);
      });
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const received: string[] = [];
      client.onMeta(() => received.push('meta'));
      const attachId = client.attach('sess-1');

      await vi.waitFor(() => {
        expect(received).toEqual(['meta']);
      });

      client.detach(attachId);
      expect(abortSignal?.aborted).toBe(true);
    });

    it('detachAll aborts every in-flight attach', () => {
      const signals: (AbortSignal | undefined)[] = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return sseResponse([META_SNAPSHOT]);
      });
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      client.attach('sess-1');
      client.attach('sess-2');
      client.detachAll();

      for (const s of signals) {
        expect(s?.aborted).toBe(true);
      }
    });
  });

  describe('write', () => {
    it('POSTs the utf8 body to /api/input?session=<id>', async () => {
      const fetchImpl = vi.fn(
        async (_url: string, _init?: RequestInit) => ({ ok: true, status: 204 }) as unknown as Response,
      );
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      await client.write('sess-1', 'hello');

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`${host.origin}/api/input?session=sess-1`);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('hello');
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${host.token}`);
      // M2 — same redirect/timeout policy as listWorkspaces.
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('serializes rapid writes into sequential POSTs with coalesced bodies', async () => {
      vi.useFakeTimers();
      const bodies: string[] = [];
      let resolveFirst: (() => void) | undefined;
      let callCount = 0;
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        callCount += 1;
        bodies.push(String(init?.body ?? ''));
        if (callCount === 1) {
          // First POST hangs until we let it go, simulating in-flight latency
          // while more writes accumulate behind it.
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { ok: true, status: 204 } as unknown as Response;
      });
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const p1 = client.write('sess-1', 'a');
      // Let the coalescing window elapse so the queue kicks off the first POST.
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // More writes land while the first POST is in flight — they should
      // coalesce into a single second POST, not fire concurrently.
      const p2 = client.write('sess-1', 'b');
      const p3 = client.write('sess-1', 'c');
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // still just the first, in flight

      resolveFirst?.();
      await vi.advanceTimersByTimeAsync(10); // coalescing window
      await Promise.resolve();
      await Promise.resolve();

      await vi.waitFor(() => {
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      });

      await Promise.all([p1, p2, p3]);
      expect(bodies).toEqual(['a', 'bc']);
    });

    it('rejects with the server message verbatim on a 403', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: 'read-only: server started without --allow-input' }),
      }) as unknown as Response);
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      await expect(client.write('sess-1', 'x')).rejects.toThrow(
        'read-only: server started without --allow-input',
      );
    });
  });

  describe('reconnect', () => {
    it('schedules a jittered backoff reconnect on stream error and re-emits meta+snapshot', async () => {
      vi.useFakeTimers();
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return erroringStreamResponse();
        }
        return sseResponse([META_SNAPSHOT]);
      });
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const received: string[] = [];
      client.onMeta((e) => received.push(`meta:${e.cols}x${e.rows}`));
      client.attach('sess-1');

      // First fetch errors asynchronously; allow microtasks to run.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Backoff base is 1s +/- 30% jitter — advancing well past the max
      // possible delay (1.3s) guarantees the retry fires.
      await vi.advanceTimersByTimeAsync(1500);

      await vi.waitFor(() => {
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => {
        expect(received).toEqual(['meta:80x24']);
      });
    });

    it('gives up after 5 consecutive failed reconnects, emits onError, and schedules no further retries', async () => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn(async () => {
        throw new Error('connect failed');
      });
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const errors: Array<{ attachId: string; message: string }> = [];
      client.onError((e) => errors.push(e));
      const attachId = client.attach('sess-1');

      // Drain the initial attach failure plus 5 reconnect attempts. Max
      // backoff step is 5s +/- 30% jitter, so 7s per round is always enough.
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(7000);
      }

      expect(errors).toEqual([{ attachId, message: 'connect failed' }]);
      // Initial attempt (1) + 5 retries = 6 total fetch calls, never a 7th.
      const callsAtGiveUp = fetchImpl.mock.calls.length;
      expect(callsAtGiveUp).toBe(6);

      await vi.advanceTimersByTimeAsync(20000);
      expect(fetchImpl.mock.calls.length).toBe(callsAtGiveUp);
    });

    // M3 — the reconnect counter used to reset at pumpStream ENTRY (right
    // after headers, before any frame). A server that accepts the request
    // (200 + body) but then drops the stream before sending a single frame
    // hit that reset every time, so reconnectAttempt could never climb past
    // MAX_RECONNECT_ATTEMPTS and the retry loop ran forever. It must count
    // toward the cap exactly like a fetch-level failure does.
    it('a connect that succeeds at header level but dies before any frame still counts toward the reconnect cap', async () => {
      vi.useFakeTimers();
      // Every attempt: headers come back 200 OK, but the body stream errors
      // immediately — no meta/data frame is ever read.
      const fetchImpl = vi.fn(async () => erroringStreamResponse());
      const client = new RemoteHostClient(host, fetchImpl as unknown as typeof fetch);

      const errors: Array<{ attachId: string; message: string }> = [];
      client.onError((e) => errors.push(e));
      client.attach('sess-1');

      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(7000);
      }

      expect(errors).toHaveLength(1);
      const callsAtGiveUp = fetchImpl.mock.calls.length;
      expect(callsAtGiveUp).toBe(6); // initial + 5 retries, never unbounded

      await vi.advanceTimersByTimeAsync(20000);
      expect(fetchImpl.mock.calls.length).toBe(callsAtGiveUp); // no further retries after giving up
    });
  });
});
