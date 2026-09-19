import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

import worker, { resetRelayStateForTests, type RelayEnv } from '../src/index';

const TOKEN = 'a'.repeat(64);
const SHARED_SECRET = 'relay-shared-secret-for-tests';

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
function stubApns(replies: Array<{ status: number; body?: string } | Error> = [{ status: 200 }]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body ?? '', { status: reply.status });
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

function live(body: unknown, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(
    new Request('https://relay.example/live', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
      headers: {
        authorization: `Bearer ${SHARED_SECRET}`,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    }),
    env,
  );
}

const CONTENT_STATE = { pendingApprovals: 2, runningAgents: 3 };

function validBody(extra: Record<string, unknown> = {}) {
  return {
    apnsToken: TOKEN,
    event: 'update',
    contentState: CONTENT_STATE,
    timestamp: 1_700_000_000,
    ...extra,
  };
}

function apsOf(calls: Array<{ init: RequestInit }>, at = 0): Record<string, any> {
  return JSON.parse(String(calls[at].init.body)).aps;
}
function headersOf(calls: Array<{ init: RequestInit }>, at = 0): Record<string, string> {
  return calls[at].init.headers as Record<string, string>;
}

beforeEach(() => {
  resetRelayStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/live — the request that reaches Apple', () => {
  it('accepts an ActivityKit token longer than a device token', async () => {
    // A push-to-start token was observed at 160 hex characters, and Apple
    // documents no fixed length — the device-token cap of 200 is too tight.
    stubApns();
    expect((await live(validBody({ apnsToken: 'c'.repeat(300) }))).status).toBe(200);
  });

  it('★ is a liveactivity push on the activity topic, at priority 10', async () => {
    const calls = stubApns();
    expect((await live(validBody())).status).toBe(200);

    const headers = headersOf(calls);
    expect(headers['apns-push-type']).toBe('liveactivity');
    // The suffix is added HERE, so APNS_TOPIC stays the plain bundle id that
    // /push needs and this route changed no deployment secret.
    expect(headers['apns-topic']).toBe('com.wmux.app.push-type.liveactivity');
    // Priority 5 lets the system hold an update until it feels like it, which
    // for "someone is blocked on you" is the same as not sending it.
    expect(headers['apns-priority']).toBe('10');
  });

  it('★ expires in two minutes: a redelivered counter is wrong, not just old', async () => {
    const calls = stubApns();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_500_000);
    await live(validBody());
    expect(headersOf(calls)['apns-expiration']).toBe(String(1_700_000_500 + 120));
  });

  it('★ an update body: counters, timestamp, stale date — and no alert', async () => {
    const calls = stubApns();
    await live(validBody({ staleDate: 1_700_001_200 }));

    expect(apsOf(calls)).toEqual({
      timestamp: 1_700_000_000,
      event: 'update',
      'content-state': { pendingApprovals: 2, runningAgents: 3 },
      'relevance-score': 100,
      'stale-date': 1_700_001_200,
    });
    // ★ NO `alert`. The same approval already sends a sealed notification
    // through /push; adding one here puts two banners up for one event.
    expect(apsOf(calls).alert).toBeUndefined();
  });

  it('★ a start declares the attributes type, and attributes may be empty', async () => {
    const calls = stubApns();
    await live(validBody({ event: 'start', attributes: { daemonName: 'studio' } }));
    expect(apsOf(calls)['attributes-type']).toBe('FleetActivityAttributes');
    expect(apsOf(calls)['attributes']).toEqual({ daemonName: 'studio' });
    expect(apsOf(calls).alert).toBeUndefined();

    // A daemon that cannot name itself still starts an activity.
    await live(validBody({ event: 'start' }));
    expect(apsOf(calls, 1)['attributes']).toEqual({});
  });

  it('★ an end carries a dismissal date, so the activity does not linger', async () => {
    const calls = stubApns();
    await live(validBody({ event: 'end', dismissalDate: 1_700_000_005 }));
    const aps = apsOf(calls);
    expect(aps.event).toBe('end');
    expect(aps['dismissal-date']).toBe(1_700_000_005);
    expect(aps['attributes-type']).toBeUndefined();
  });

  it('optional counters are forwarded verbatim, and null survives as null', async () => {
    const calls = stubApns();
    await live(
      validBody({
        contentState: {
          pendingApprovals: 0,
          runningAgents: 4,
          workingAgents: 1,
          idleAgents: 2,
          blockedPanes: 1,
          // Not zero: nothing is blocked, so there is no age to show at all.
          oldestBlockedMinutes: null,
        },
      }),
    );
    expect(apsOf(calls)['content-state']).toEqual({
      pendingApprovals: 0,
      runningAgents: 4,
      workingAgents: 1,
      idleAgents: 2,
      blockedPanes: 1,
      oldestBlockedMinutes: null,
    });
  });
});

describe('/live — validation', () => {
  const rejects = async (body: unknown, reason: string) => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await live(body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect((await res.json()).reason).toBe(reason);
    // Nothing reached Apple, and no provider JWT was spent on it.
    expect(spy).not.toHaveBeenCalled();
  };

  it('★ refuses a content-state missing either field the app decodes strictly', async () => {
    // A payload missing one of these fails to decode on-device, and an activity
    // that cannot decode freezes on the numbers it already had — silently.
    await rejects(validBody({ contentState: { runningAgents: 1 } }), 'bad-content-state');
    await rejects(validBody({ contentState: { pendingApprovals: 1 } }), 'bad-content-state');
  });

  it('★ refuses any key it does not know, which is what keeps this route narrow', async () => {
    // The moment an unknown key passes through, a daemon bug can put a pane
    // name or a question on the wire in the clear.
    await rejects(
      validBody({ contentState: { ...CONTENT_STATE, workspaceName: 'api' } }),
      'bad-content-state',
    );
    await rejects(
      validBody({ contentState: { ...CONTENT_STATE, agents: [] } }),
      'bad-content-state',
    );
  });

  it('refuses non-integer counters, including the nullable one', async () => {
    await rejects(
      validBody({ contentState: { pendingApprovals: 1.5, runningAgents: 1 } }),
      'bad-content-state',
    );
    await rejects(
      validBody({ contentState: { ...CONTENT_STATE, blockedPanes: '1' } }),
      'bad-content-state',
    );
    await rejects(
      validBody({ contentState: { ...CONTENT_STATE, oldestBlockedMinutes: 'soon' } }),
      'bad-content-state',
    );
  });

  it('refuses an event that is not one of the three', async () => {
    for (const event of ['restart', '', 42, null, undefined]) {
      await rejects(validBody({ event }), 'bad-event');
    }
  });

  it('refuses a malformed device token, timestamp, stale date or dismissal date', async () => {
    await rejects(validBody({ apnsToken: 'nope' }), 'bad-device-token');
    await rejects(validBody({ timestamp: undefined }), 'bad-timestamp');
    await rejects(validBody({ timestamp: 1.5 }), 'bad-timestamp');
    await rejects(validBody({ staleDate: 'later' }), 'bad-stale-date');
    await rejects(validBody({ dismissalDate: -1 }), 'bad-dismissal-date');
  });

  it('refuses attributes it does not recognise', async () => {
    await rejects(validBody({ event: 'start', attributes: { workspace: 'api' } }), 'bad-attributes');
    await rejects(validBody({ event: 'start', attributes: { daemonName: 5 } }), 'bad-attributes');
    await rejects(validBody({ event: 'start', attributes: [] }), 'bad-attributes');
  });

  it('refuses a stage that is neither of Apple two words', async () => {
    await rejects(validBody({ apnsEnvironment: 'staging' }), 'bad-apns-environment');
  });

  it('★ refuses an unknown TOP-LEVEL key, not just an unknown counter', async () => {
    // The content-state allowlist only guards one nested object. What travels
    // on this route is unsealed, so a daemon bug that invented a new top-level
    // field — `paneName`, a `question` — would hand Apple plaintext the relay
    // never agreed to carry. Same complaint as a non-object body, same reason.
    await rejects(validBody({ paneName: 'api' }), 'body-not-object');
    await rejects(validBody({ priority: 10 }), 'body-not-object');
  });

  it('★ refuses a negative counter — a tally of things cannot be below zero', async () => {
    // The app subtracts these from one another to lay out its rows, so a
    // negative one does not read as "odd", it draws a broken widget with
    // nothing on the wire to say why.
    await rejects(
      validBody({ contentState: { pendingApprovals: -1, runningAgents: 1 } }),
      'bad-content-state',
    );
    await rejects(
      validBody({ contentState: { ...CONTENT_STATE, idleAgents: -2 } }),
      'bad-content-state',
    );
    await rejects(
      validBody({ contentState: { ...CONTENT_STATE, oldestBlockedMinutes: -5 } }),
      'bad-content-state',
    );
  });

  it('refuses a body that is not an object at all', async () => {
    await rejects('123', 'body-not-object');
    await rejects('[]', 'body-not-object');
  });
});

describe('/live — routing and passthrough', () => {
  it('★ routes per request to the stage the device named', async () => {
    const calls = stubApns();
    await live(validBody({ apnsEnvironment: 'development' }));
    expect(calls[0].url).toContain('api.sandbox.push.apple.com');

    await live(validBody({ apnsEnvironment: 'production' }));
    expect(calls[1].url).toContain('api.push.apple.com');

    // Absent means "whatever this relay was configured with".
    await worker.fetch(
      new Request('https://relay.example/live', {
        method: 'POST',
        body: JSON.stringify(validBody()),
        headers: { authorization: `Bearer ${SHARED_SECRET}` },
      }),
      { ...env, APNS_ENV: 'sandbox' },
    );
    expect(calls[2].url).toContain('api.sandbox.push.apple.com');
  });

  it('★ passes a 410 straight through — the daemon prunes on it', async () => {
    stubApns([{ status: 410, body: JSON.stringify({ reason: 'BadDeviceToken' }) }]);
    const res = await live(validBody());
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ ok: false, apnsStatus: 410, reason: 'BadDeviceToken' });
    expect(res.headers.get('x-wmux-relay-stage')).toBe('apns');
  });

  it('refuses an unauthenticated caller before reading a byte of body', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = await worker.fetch(
      new Request('https://relay.example/live', {
        method: 'POST',
        body: JSON.stringify(validBody()),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('405s a non-POST /live', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await worker.fetch(new Request('https://relay.example/live', { method }), env);
      expect(res.status).toBe(405);
    }
  });
});
