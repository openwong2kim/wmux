import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import {
  PushSender,
  PUSH_QUEUE_CAP,
  type PushTarget,
} from '../PushSender';
import {
  decodePushEnvelopeFromRelay,
  openPushEnvelope,
  rawFromPublicKey,
} from '../../../shared/push/pushEnvelope';

const RELAY = 'https://relay.example';
const SECRET = 'relay-shared-secret';

function device(deviceId: string): { target: PushTarget; privateKey: Buffer } {
  const pair = generateKeyPairSync('x25519');
  const jwk = pair.privateKey.export({ format: 'jwk' }) as { d: string };
  return {
    target: {
      deviceId,
      name: deviceId,
      push: {
        apnsToken: 'a'.repeat(64),
        publicKey: rawFromPublicKey(pair.publicKey).toString('base64'),
      },
    },
    privateKey: Buffer.from(jwk.d, 'base64url'),
  };
}

interface Harness {
  sender: PushSender;
  calls: Array<{ url: string; init: RequestInit }>;
  forgotten: string[];
  logs: string[];
  setTargets: (t: PushTarget[]) => void;
}

function makeSender(
  replies: Array<number | 'throw'>,
  targets: PushTarget[],
  over: { relayUrl?: string; relaySecret?: string } = {},
): Harness {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const forgotten: string[] = [];
  const logs: string[] = [];
  let current = targets;
  let i = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply === 'throw') throw new Error('network down');
    return new Response('', { status: reply });
  }) as unknown as typeof fetch;

  const sender = new PushSender({
    relayUrl: 'relayUrl' in over ? over.relayUrl : RELAY,
    relaySecret: 'relaySecret' in over ? over.relaySecret : SECRET,
    targets: () => current,
    forgetPush: (id) => forgotten.push(id),
    log: (_l, m) => logs.push(m),
    now: () => 1753420800000,
    fetchImpl,
    sleep: async () => undefined,
  });

  return { sender, calls, forgotten, logs, setTargets: (t) => { current = t; } };
}

beforeEach(() => {
  delete process.env.WMUX_PUSH;
});
afterEach(() => {
  delete process.env.WMUX_PUSH;
  vi.restoreAllMocks();
});

describe('PushSender — enablement', () => {
  it('is inert without a relay configured, rather than erroring per notification', () => {
    const h = makeSender([200], [device('d1').target], { relayUrl: undefined });
    expect(h.sender.enabled).toBe(false);
    h.sender.notify({ title: 't', body: 'b' });
    expect(h.calls).toHaveLength(0);
  });

  it('is inert without the relay secret', () => {
    const h = makeSender([200], [device('d1').target], { relaySecret: undefined });
    expect(h.sender.enabled).toBe(false);
  });

  it('WMUX_PUSH=0 is a kill switch', async () => {
    const h = makeSender([200], [device('d1').target]);
    process.env.WMUX_PUSH = '0';
    expect(h.sender.enabled).toBe(false);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    expect(h.calls).toHaveLength(0);
  });
});

describe('PushSender — sealing', () => {
  it('★ forwards the device APNs stage, and omits it when the device named none', async () => {
    // The relay picks the Apple host from this. Two builds of the app on one
    // tailnet used to take turns breaking each other's push because the relay
    // had one answer for the whole deployment.
    const d = device('d1');
    const staged = {
      ...d.target,
      push: { ...d.target.push, apnsEnvironment: 'development' as const },
    };
    const h = makeSender([200, 200], [staged, device('d2').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();

    const bodies = h.calls.map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);
    expect(bodies[0].apnsEnvironment).toBe('development');
    // Absent stays absent — the relay must not have a stage guessed for it here.
    expect(bodies[1]).not.toHaveProperty('apnsEnvironment');
  });

  it('★ what leaves is opaque: the relay sees no title or body', async () => {
    const d = device('d1');
    const h = makeSender([200], [d.target]);
    h.sender.notify({ title: 'Approval needed', body: 'rm -rf ./build', approvalId: 'ap_1' });
    await h.sender.flush();

    expect(h.calls).toHaveLength(1);
    const sent = JSON.parse(String(h.calls[0].init.body)) as Record<string, string>;
    const raw = JSON.stringify(sent);
    expect(raw).not.toContain('Approval needed');
    expect(raw).not.toContain('rm -rf');
    expect(raw).not.toContain('ap_1');

    // …and only the intended phone can read it back.
    const env = decodePushEnvelopeFromRelay(sent.ciphertext);
    expect(env).not.toBeNull();
    expect(
      openPushEnvelope({
        devicePrivateKey: d.privateKey,
        deviceId: 'd1',
        envelope: env,
        now: 1753420800000,
      }),
    ).toEqual({ title: 'Approval needed', body: 'rm -rf ./build', approvalId: 'ap_1' });
  });

  it('seals separately per device, and one bad key does not stop the others', async () => {
    const good = device('good');
    const bad: PushTarget = {
      deviceId: 'bad',
      name: 'bad',
      push: { apnsToken: 'b'.repeat(64), publicKey: Buffer.alloc(32).toString('base64') },
    };
    const h = makeSender([200], [bad, good.target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();

    // The all-zero key cannot be sealed to; the healthy device still got one.
    expect(h.calls).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('could not seal for bad'))).toBe(true);
    // The failure names the device and never the payload.
    expect(h.logs.join('\n')).not.toContain('title');
  });

  it('sends the pinned host, a bearer secret, and refuses to follow redirects', async () => {
    const h = makeSender([200], [device('d1').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();

    expect(h.calls[0].url).toBe(`${RELAY}/push`);
    const headers = h.calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    // A redirect off the pinned host would carry the bearer secret with it.
    expect(h.calls[0].init.redirect).toBe('manual');
  });
});

describe('PushSender — failure handling', () => {
  it('retries once on a transport failure', async () => {
    const h = makeSender(['throw', 200], [device('d1').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    expect(h.calls).toHaveLength(2);
  });

  it('retries once on a 5xx, and only once', async () => {
    const h = makeSender([500, 500], [device('d1').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    expect(h.calls).toHaveLength(2);
  });

  it('★ does not retry a 4xx', async () => {
    // A refused secret or a rejected token does not get better by being sent
    // again, and hammering the relay with it is what its rate limit exists for.
    const h = makeSender([401], [device('d1').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    expect(h.calls).toHaveLength(1);
  });

  it('★ prunes a token Apple reported dead', async () => {
    const h = makeSender([410], [device('d1').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    expect(h.forgotten).toEqual(['d1']);
    // 410 is a verdict, not a transport failure — no retry.
    expect(h.calls).toHaveLength(1);
  });

  it('a throwing send does not wedge the queue', async () => {
    const h = makeSender(['throw', 'throw', 200], [device('d1').target]);
    h.sender.notify({ title: 'first', body: 'b' });
    h.sender.notify({ title: 'second', body: 'b' });
    await h.sender.flush();
    // Both notifications were attempted despite the first failing outright.
    expect(h.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('PushSender — a broken pipeline is visible', () => {
  it('★ reports a terminal failure instead of swallowing it', async () => {
    // Handling only 200 and 410 left a misconfigured relay secret completely
    // silent — the only symptom would be a user noticing notifications that
    // never arrive, which is the least debuggable signal there is.
    const h = makeSender([401], [device('d1').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();

    expect(h.logs.some((l) => l.includes('relay answered 401'))).toBe(true);
    expect(h.logs.some((l) => l.includes('1/1 notification(s) were not delivered'))).toBe(true);
    // Never the payload.
    expect(h.logs.join(String.fromCharCode(10))).not.toContain('title');
  });

  it('reports a relay that never answers', async () => {
    const h = makeSender(['throw'], [device('d1').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    expect(h.logs.some((l) => l.includes('no response from the relay'))).toBe(true);
  });

  it('logs a steady outage once, not once per notification', async () => {
    const h = makeSender([500], [device('d1').target]);
    for (let i = 0; i < 4; i++) h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    // The per-status line appears once; the per-send summary still counts each.
    expect(h.logs.filter((l) => l.includes('relay answered 500'))).toHaveLength(1);
    expect(h.logs.filter((l) => l.includes('were not delivered')).length).toBeGreaterThan(1);
  });

  it('says so when the relay recovers', async () => {
    const h = makeSender([500, 500, 200], [device('d1').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    expect(h.logs.some((l) => l.includes('relay is answering again'))).toBe(true);
  });
});

describe('PushSender — queue', () => {
  it('★ drops OLDEST past the cap, because the newest is the one still worth answering', async () => {
    const h = makeSender([200], [device('d1').target]);
    // Nothing drains while we enqueue synchronously.
    for (let i = 0; i < PUSH_QUEUE_CAP + 5; i++) {
      h.sender.notify({ title: `n${i}`, body: 'b' });
    }
    await h.sender.flush();
    expect(h.calls.length).toBeLessThanOrEqual(PUSH_QUEUE_CAP + 1);
    expect(h.logs.some((l) => l.includes('queue full'))).toBe(true);
  });

  it('re-reads the target list per send, so a revoke lands immediately', async () => {
    const h = makeSender([200], [device('d1').target]);
    h.sender.notify({ title: 't', body: 'b' });
    await h.sender.flush();
    expect(h.calls).toHaveLength(1);

    h.setTargets([]);
    h.sender.notify({ title: 't2', body: 'b' });
    await h.sender.flush();
    // No target, no request — the roster is the authority, not a cached copy.
    expect(h.calls).toHaveLength(1);
  });
});
