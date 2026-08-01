import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

import worker, { resetRelayStateForTests, type RelayEnv } from '../src/index';

const TOKEN = 'a'.repeat(64);
/** The one deployment-wide secret every wmux daemon presents. */
const SHARED_SECRET = 'relay-shared-secret-for-tests';
/** Stands in for a sealed pushEnvelope blob. Must come back out untouched. */
const CIPHERTEXT = Buffer.from('SEALED-ENVELOPE-DO-NOT-LOG').toString('base64');

let env: RelayEnv;

function toPem(der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  env = {
    APNS_KEY_P8: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    APNS_KEY_ID: 'ABCD123456',
    APNS_TEAM_ID: 'TEAM123456',
    APNS_TOPIC: 'com.wmux.app',
    RELAY_SHARED_SECRET: SHARED_SECRET,
  };
});

/** Records every outbound call and replies with a scripted APNs response. */
function stubApns(replies: Array<{ status: number; body?: string; apnsId?: string } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body ?? '', {
      status: reply.status,
      headers: reply.apnsId ? { 'apns-id': reply.apnsId } : {},
    });
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

function push(body: unknown, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(
    new Request('https://relay.example/push', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
      // Authenticated by default so every existing case still exercises the
      // path it was written for; the auth cases below override it explicitly.
      headers: {
        authorization: `Bearer ${SHARED_SECRET}`,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    }),
    env,
  );
}

function validBody(extra: Record<string, unknown> = {}) {
  return { apnsDeviceToken: TOKEN, ciphertext: CIPHERTEXT, ...extra };
}

beforeEach(() => {
  resetRelayStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('routing and method guards', () => {
  it('serves /health without touching APNs', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await worker.fetch(new Request('https://relay.example/health'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('404s an unknown path', async () => {
    const res = await worker.fetch(new Request('https://relay.example/'), env);
    expect(res.status).toBe(404);
  });

  it('405s a non-POST /push', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await worker.fetch(new Request('https://relay.example/push', { method }), env);
      expect(res.status).toBe(405);
    }
  });

  it('marks relay-originated responses with x-wmux-relay-stage', async () => {
    const res = await worker.fetch(new Request('https://relay.example/nope'), env);
    expect(res.headers.get('x-wmux-relay-stage')).toBe('relay');
  });
});

describe('abuse control happens before any crypto', () => {
  it('rejects an oversized declared Content-Length', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await worker.fetch(
      new Request('https://relay.example/push', {
        method: 'POST',
        body: JSON.stringify(validBody()),
        headers: { 'content-length': '999999' },
      }),
      env,
    );
    expect(res.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an oversized actual body', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await push({ apnsDeviceToken: TOKEN, ciphertext: 'A'.repeat(9000) });
    expect(res.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await push('{ not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: 'bad-json' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a malformed device token without calling APNs', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await push({ apnsDeviceToken: 'nope', ciphertext: CIPHERTEXT });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, reason: 'bad-device-token' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('configuration', () => {
  it('fails closed when a secret is missing and does not name it to the caller', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await worker.fetch(
      new Request('https://relay.example/push', { method: 'POST', body: JSON.stringify(validBody()) }),
      { ...env, APNS_TOPIC: '' },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, reason: 'relay-misconfigured' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('forwarding to APNs', () => {
  it('posts to the production host with the documented headers', async () => {
    const calls = stubApns([{ status: 200, apnsId: 'apns-1' }]);
    const res = await push(validBody());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, apnsStatus: 200, apnsId: 'apns-1' });
    expect(res.headers.get('x-wmux-relay-stage')).toBe('apns');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(headers['apns-topic']).toBe('com.wmux.app');
    expect(headers['apns-push-type']).toBe('alert');
    expect(headers['apns-priority']).toBe('10');
    expect(Number(headers['apns-expiration'])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(headers['apns-collapse-id']).toBeUndefined();
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('switches to the sandbox host', async () => {
    const calls = stubApns([{ status: 200 }]);
    await worker.fetch(
      new Request('https://relay.example/push', {
        method: 'POST',
        body: JSON.stringify(validBody()),
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      }),
      { ...env, APNS_ENV: 'sandbox' },
    );
    expect(calls[0].url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
  });

  it('★ lets the request pick the host, so two builds on one relay stop colliding', async () => {
    // The relay-wide APNS_ENV says production; this device registered from a
    // development build. Without the per-request override its token goes to the
    // wrong Apple host and comes back BadDeviceToken with nothing to trace.
    const calls = stubApns([{ status: 200 }, { status: 200 }]);
    await push(validBody({ apnsEnvironment: 'development' }));
    expect(calls[0].url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);

    // And the other way: a production token through a sandbox-configured relay.
    await worker.fetch(
      new Request('https://relay.example/push', {
        method: 'POST',
        body: JSON.stringify(validBody({ apnsEnvironment: 'production' })),
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      }),
      { ...env, APNS_ENV: 'sandbox' },
    );
    expect(calls[1].url).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
  });

  it('falls back to APNS_ENV when the request names no stage', async () => {
    // What every daemon that predates the field sends, and what a build with no
    // provisioning profile (the simulator) sends. Guessing here would route a
    // token to the wrong host.
    const calls = stubApns([{ status: 200 }]);
    await worker.fetch(
      new Request('https://relay.example/push', {
        method: 'POST',
        body: JSON.stringify(validBody()),
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      }),
      { ...env, APNS_ENV: 'sandbox' },
    );
    expect(calls[0].url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
  });

  it('refuses a stage that is not one of Apple two words', async () => {
    const calls = stubApns([{ status: 200 }]);
    const res = await push(validBody({ apnsEnvironment: 'https://evil.example' }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('bad-apns-environment');
    // Refused before a JWT is signed or Apple is called at all.
    expect(calls).toHaveLength(0);
  });

  it('passes priority and collapseId through as headers', async () => {
    const calls = stubApns([{ status: 200 }]);
    await push(validBody({ priority: 5, collapseId: 'ap_42' }));
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['apns-priority']).toBe('5');
    expect(headers['apns-collapse-id']).toBe('ap_42');
  });

  it('carries the ciphertext verbatim and sets mutable-content', async () => {
    const calls = stubApns([{ status: 200 }]);
    await push(validBody());
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.wmux).toBe(CIPHERTEXT);
    expect(body.aps['mutable-content']).toBe(1);
    // The relay cannot know the real title, so it sends a fixed placeholder the
    // Notification Service Extension overwrites.
    expect(body.aps.alert).toEqual({ title: 'wmux', body: 'New activity' });
  });

  it('never decodes or reshapes the ciphertext', async () => {
    const calls = stubApns([{ status: 200 }]);
    await push(validBody());
    const outbound = calls[0].init.body as string;
    // The plaintext behind CIPHERTEXT must not appear anywhere on the wire.
    expect(outbound).not.toContain('SEALED-ENVELOPE-DO-NOT-LOG');
    expect(outbound).toContain(CIPHERTEXT);
  });

  it('reuses one provider token across requests', async () => {
    const calls = stubApns([{ status: 200 }]);
    await push(validBody());
    await push(validBody());
    const auth = calls.map((c) => (c.init.headers as Record<string, string>).authorization);
    expect(auth[0]).toBe(auth[1]);
  });
});

describe('APNs status passthrough', () => {
  it('passes 410 through so the daemon can prune the token', async () => {
    stubApns([{ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }]);
    const res = await push(validBody());
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ ok: false, apnsStatus: 410, reason: 'Unregistered' });
    expect(res.headers.get('x-wmux-relay-stage')).toBe('apns');
  });

  it('passes 400 BadDeviceToken through', async () => {
    stubApns([{ status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) }]);
    const res = await push(validBody());
    expect(await res.json()).toEqual({ ok: false, apnsStatus: 400, reason: 'BadDeviceToken' });
  });

  it('passes 429 through without inventing a reason', async () => {
    stubApns([{ status: 429, body: '' }]);
    const res = await push(validBody());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, apnsStatus: 429 });
  });

  it('re-signs and retries once on ExpiredProviderToken', async () => {
    const calls = stubApns([
      { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) },
      { status: 200, apnsId: 'apns-2' },
    ]);
    const res = await push(validBody());
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    const auth = calls.map((c) => (c.init.headers as Record<string, string>).authorization);
    expect(auth[1]).not.toBe(auth[0]);
  });

  it('does not retry a 403 for an unrelated reason', async () => {
    const calls = stubApns([{ status: 403, body: JSON.stringify({ reason: 'BadCollapseId' }) }]);
    const res = await push(validBody());
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it('reports 502 when APNs is unreachable', async () => {
    stubApns([new Error('connection refused')]);
    const res = await push(validBody());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: 'apns-unreachable' });
    expect(res.headers.get('x-wmux-relay-stage')).toBe('relay');
  });

  it('reports 502 apns-timeout on a timed-out request', async () => {
    stubApns([Object.assign(new Error('timed out'), { name: 'TimeoutError' })]);
    const res = await push(validBody());
    expect(await res.json()).toEqual({ ok: false, reason: 'apns-timeout' });
  });

  it('ignores a non-JSON error body from an intermediary', async () => {
    stubApns([{ status: 503, body: '<html>upstream down</html>' }]);
    const res = await push(validBody());
    expect(await res.json()).toEqual({ ok: false, apnsStatus: 503 });
  });
});

describe('the blindness claim', () => {
  /** Capture everything the relay writes to the console. */
  function captureConsole() {
    const lines: string[] = [];
    const sink = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(sink);
    vi.spyOn(console, 'warn').mockImplementation(sink);
    vi.spyOn(console, 'error').mockImplementation(sink);
    vi.spyOn(console, 'info').mockImplementation(sink);
    vi.spyOn(console, 'debug').mockImplementation(sink);
    return lines;
  }

  it('never logs the ciphertext or the device token on the success path', async () => {
    stubApns([{ status: 200 }]);
    const lines = captureConsole();
    await push(validBody());
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0); // proves the capture is wired up
    expect(all).not.toContain(CIPHERTEXT);
    expect(all).not.toContain(TOKEN);
  });

  it('never logs them on rejection, APNs-error, or transport-error paths', async () => {
    const scenarios: Array<() => Promise<unknown>> = [
      async () => {
        stubApns([{ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }]);
        return push(validBody());
      },
      async () => {
        stubApns([new Error('boom')]);
        return push(validBody());
      },
      async () => {
        stubApns([{ status: 200 }]);
        return push({ apnsDeviceToken: TOKEN, ciphertext: `${CIPHERTEXT}*bad` });
      },
      async () => {
        stubApns([{ status: 200 }]);
        return push(`{"apnsDeviceToken":"${TOKEN}","ciphertext":"${CIPHERTEXT}"`); // truncated JSON
      },
    ];

    for (const run of scenarios) {
      resetRelayStateForTests();
      const lines = captureConsole();
      await run();
      const all = lines.join('\n');
      expect(all).not.toContain(CIPHERTEXT);
      expect(all).not.toContain(TOKEN);
      vi.restoreAllMocks();
    }
  });

  it('never puts the ciphertext in a response body', async () => {
    stubApns([{ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }]);
    const res = await push(validBody());
    expect(await res.text()).not.toContain(CIPHERTEXT);
  });
});

describe('shared-secret gate', () => {
  it('refuses an unauthenticated push without touching APNs', async () => {
    const calls = stubApns([{ status: 200 }]);
    const res = await worker.fetch(
      new Request('https://relay.example/push', {
        method: 'POST',
        body: JSON.stringify(validBody()),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, reason: 'unauthorized' });
    // The whole point: a stranger never reaches the code that spends our
    // provider key.
    expect(calls).toHaveLength(0);
  });

  it('refuses a wrong secret, and a right-prefix guess is no closer', async () => {
    const calls = stubApns([{ status: 200 }]);
    for (const guess of ['', 'wrong', SHARED_SECRET.slice(0, -1), `${SHARED_SECRET}x`]) {
      const res = await push(validBody(), { headers: { authorization: `Bearer ${guess}` } });
      expect(res.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses to serve at all when the secret is not configured', async () => {
    const calls = stubApns([{ status: 200 }]);
    const { RELAY_SHARED_SECRET: _omitted, ...unconfigured } = env;
    const res = await worker.fetch(
      new Request('https://relay.example/push', {
        method: 'POST',
        body: JSON.stringify(validBody()),
        headers: { authorization: 'Bearer anything' },
      }),
      unconfigured as RelayEnv,
    );
    // An unconfigured relay must not fall open.
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, reason: 'relay-misconfigured' });
    expect(calls).toHaveLength(0);
  });
});

describe('body cap', () => {
  it('stops reading a chunked body once it passes the cap', async () => {
    const calls = stubApns([{ status: 200 }]);
    let produced = 0;
    let cancelled = false;
    // No Content-Length: this is the shape that walked past the declared-length
    // guard and made arrayBuffer() buffer everything before the cap was applied.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        if (produced > 10_000) return controller.close();
        controller.enqueue(new Uint8Array(4096));
      },
      cancel() {
        cancelled = true;
      },
    });

    const res = await worker.fetch(
      new Request('https://relay.example/push', {
        method: 'POST',
        body,
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
        // @ts-expect-error — undici needs this for a streaming request body.
        duplex: 'half',
      }),
      env,
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, reason: 'body-too-large' });
    expect(cancelled).toBe(true);
    // Aborted early rather than after draining the whole stream.
    expect(produced).toBeLessThan(20);
    expect(calls).toHaveLength(0);
  });
});
