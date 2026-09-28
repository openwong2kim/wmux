import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { request as httpReq } from 'node:http';
import { WebTerminalServer, type WebDeviceResolver, type WebTerminalStartOptions } from '../WebTerminalServer';
import { DeviceStore } from '../DeviceStore';
import { DeviceAuditLog } from '../deviceAudit';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

/**
 * Phone device management (`/api/devices`) against a REAL DeviceStore in a
 * temp dir, so visibility, audit actors and persist failures are the store's
 * own behaviour rather than a fake's idea of it.
 */

type Paired = { deviceId: string; token: string };

describe('device management routes', () => {
  let dir: string;
  let clock: number;
  let store: DeviceStore;
  let server: WebTerminalServer;
  let others: WebTerminalServer[];

  const makeServer = (devices: WebDeviceResolver): WebTerminalServer => {
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    return new WebTerminalServer({
      sessionManager,
      devices,
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-web-devices-'));
    clock = 1_700_000_000_000;
    store = new DeviceStore({ wmuxDir: dir, log: () => { /* silent */ }, now: () => clock });
    server = makeServer(store);
    others = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of [server, ...others]) if (s.isRunning) await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const start = (over: Partial<WebTerminalStartOptions> = {}, s: WebTerminalServer = server) =>
    s.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true, ...over });
  const base = (s: WebTerminalServer = server) => `http://127.0.0.1:${s.status().port}`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const operator = () => bearer(server.status().token as string);

  const pair = async (name: string, allowInput: boolean): Promise<Paired> => {
    const d = await store.mint({ name, allowInput });
    return { deviceId: d.deviceId, token: `${d.deviceId}.${d.deviceSecret}` };
  };

  const getDevices = async (h: Record<string, string>) => {
    const res = await fetch(`${base()}/api/devices`, { headers: h });
    const text = await res.text();
    return { res, text, body: JSON.parse(text) as Record<string, any> };
  };
  const revoke = (h: Record<string, string>, id: string) =>
    fetch(`${base()}/api/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: h });
  const patchGrants = (h: Record<string, string>, id: string, body: unknown) =>
    fetch(`${base()}/api/devices/${encodeURIComponent(id)}/grants`, {
      method: 'PATCH',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const config = async (h: Record<string, string>, s: WebTerminalServer = server) =>
    (await (await fetch(`${base(s)}/api/config`, { headers: h })).json()) as Record<string, any>;
  const audit = () => new DeviceAuditLog(dir).read();

  const openEvents = async (h: Record<string, string>, query = '') => {
    const ac = new AbortController();
    const res = await fetch(`${base()}/api/events${query}`, {
      signal: ac.signal,
      headers: { ...h, Accept: 'text/event-stream' },
    });
    const reader = res.body ? (res.body as ReadableStream<Uint8Array>).getReader() : null;
    return { ac, res, reader };
  };
  const readWithin = async (reader: ReadableStreamDefaultReader<Uint8Array>, deadline: number) => {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([reader.read(), budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  /** True once the SERVER ends the stream; false if it is still open at the deadline. */
  const closedWithin = async (reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const chunk = await readWithin(reader, deadline);
      if (!chunk) return false;
      if (chunk.done) return true;
    }
    return false;
  };

  describe('/api/config deviceManagement', () => {
    it('reports the scope for each principal kind', async () => {
      await start();
      const typer = await pair('Typer', true);
      const viewer = await pair('Viewer', false);

      expect((await config(operator())).deviceManagement).toEqual({ scope: 'all' });
      expect((await config(bearer(typer.token))).deviceManagement).toEqual({ scope: 'all' });
      expect((await config(bearer(viewer.token))).deviceManagement).toEqual({ scope: 'self' });
    });

    it('scopes a granted device to itself on a server started read-only', async () => {
      await start({ allowInput: false });
      const typer = await pair('Typer', true);

      // The server flag is the ceiling: without it this device has no shell here.
      expect((await config(bearer(typer.token))).deviceManagement).toEqual({ scope: 'self' });
      expect((await config(operator())).deviceManagement).toEqual({ scope: 'all' });
    });

    it('is absent when the resolver cannot list, revoke and set grants', async () => {
      const bare = makeServer({ resolve: store.resolve.bind(store), mint: store.mint.bind(store) });
      others.push(bare);
      await start({}, bare);
      const typer = await pair('Typer', true);
      const opToken = bearer(bare.status().token as string);

      expect('deviceManagement' in (await config(opToken, bare))).toBe(false);
      expect('deviceManagement' in (await config(bearer(typer.token), bare))).toBe(false);
      const listed = await fetch(`${base(bare)}/api/devices`, { headers: opToken });
      expect(listed.status).toBe(503);
      expect(await listed.json()).toEqual({ error: 'device-management-unavailable' });
    });
  });

  describe('GET /api/devices', () => {
    it('shows a read-only device only its own row', async () => {
      await start();
      clock = 1_700_000_111_111;
      await pair('Other phone', true);
      clock = 1_700_000_222_222;
      const viewer = await pair('Wall display', false);
      clock = 1_700_000_333_333;

      const { res, text, body } = await getDevices(bearer(viewer.token));

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(body.scope).toBe('self');
      expect(body.devices).toEqual([
        {
          deviceId: viewer.deviceId,
          name: 'Wall display',
          pairedAt: 1_700_000_222_222,
          lastSeenAt: 1_700_000_333_333,
          grants: { input: false },
          revoked: false,
          current: true,
        },
      ]);
      // Nothing about the other device reaches the wire — not its name, not
      // when it was last seen.
      expect(text).not.toContain('Other phone');
      expect(text).not.toContain('1700000111111');
    });

    it('shows a device that may type every ACTIVE device, and the operator the tombstones too', async () => {
      await start();
      const typer = await pair('Typer', true);
      const viewer = await pair('Viewer', false);
      const gone = await pair('Lost phone', true);
      clock += 1000;
      expect(store.revoke(gone.deviceId, 'desktop').ok).toBe(true);

      const asTyper = await getDevices(bearer(typer.token));
      expect(asTyper.body.scope).toBe('all');
      expect(asTyper.body.devices.map((d: { deviceId: string }) => d.deviceId).sort()).toEqual(
        [typer.deviceId, viewer.deviceId].sort(),
      );
      expect(asTyper.body.devices.find((d: { current: boolean }) => d.current).deviceId).toBe(typer.deviceId);

      const asOperator = await getDevices(operator());
      expect(asOperator.body.scope).toBe('all');
      expect(asOperator.body.devices).toHaveLength(3);
      expect(asOperator.body.devices.every((d: { current: boolean }) => d.current === false)).toBe(true);
      expect(asOperator.body.devices.find((d: { deviceId: string }) => d.deviceId === gone.deviceId)).toMatchObject({
        revoked: true,
        revokedAt: clock,
        grants: { input: true },
      });
      expect(asOperator.body.serverGrants).toEqual({ input: true, upload: false, transcript: true });
    });

    it('never carries secret material or push tokens', async () => {
      await start();
      const typer = await pair('Typer', true);
      const apnsToken = 'ab'.repeat(32);
      const publicKey = crypto.randomBytes(32).toString('base64');
      expect(store.registerPush(typer.deviceId, { apnsToken, publicKey }).ok).toBe(true);

      const { text } = await getDevices(operator());

      for (const leak of ['secretHash', 'salt', 'kdf', 'push', 'liveActivity', apnsToken, publicKey]) {
        expect(text).not.toContain(leak);
      }
    });
  });

  describe('a device acting on another id', () => {
    it('gets byte-identical 403s for an existing and a nonexistent target, before any lookup', async () => {
      await start();
      const typer = await pair('Typer', true);
      const other = await pair('Other', true);
      const listSpy = vi.spyOn(store, 'list');
      const revokeSpy = vi.spyOn(store, 'revoke');
      const setInputSpy = vi.spyOn(store, 'setInput');
      const h = bearer(typer.token);

      const revokeReal = await revoke(h, other.deviceId);
      const revokeGhost = await revoke(h, crypto.randomUUID());
      expect(revokeReal.status).toBe(403);
      expect(revokeGhost.status).toBe(403);
      const revokeBody = await revokeReal.text();
      expect(revokeBody).toBe('{"error":"not-permitted"}');
      expect(await revokeGhost.text()).toBe(revokeBody);

      const patchReal = await patchGrants(h, other.deviceId, { input: false });
      const patchGhost = await patchGrants(h, crypto.randomUUID(), { input: false });
      expect(patchReal.status).toBe(403);
      expect(patchGhost.status).toBe(403);
      const patchBody = await patchReal.text();
      expect(patchBody).toBe('{"error":"not-permitted"}');
      expect(await patchGhost.text()).toBe(patchBody);

      expect(listSpy).not.toHaveBeenCalled();
      expect(revokeSpy).not.toHaveBeenCalled();
      expect(setInputSpy).not.toHaveBeenCalled();
      expect((await getDevices(operator())).body.devices.every((d: { revoked: boolean }) => !d.revoked)).toBe(true);
    });
  });

  describe('POST /api/devices/:id/revoke', () => {
    it('self-revoke answers, closes its own streams and tickets, and leaves other devices streaming', async () => {
      await start({ allowInput: false });
      // Read-only on a read-only server: giving up your own access needs no grant.
      const victim = await pair('Old phone', false);
      const bystander = await pair('Keeps working', true);

      const ticketRes = await fetch(`${base()}/api/stream-ticket`, { method: 'POST', headers: bearer(victim.token) });
      expect(ticketRes.status).toBe(200);
      const { ticket } = (await ticketRes.json()) as { ticket: string };

      const victimEvents = await openEvents(bearer(victim.token));
      const bystanderEvents = await openEvents(bearer(bystander.token));
      expect(victimEvents.res.status).toBe(200);
      expect(bystanderEvents.res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));

      const res = await revoke(bearer(victim.token), victim.deviceId);

      // The response arrives even though this device's streams were just cut.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, closed: 1 });
      expect(await closedWithin(victimEvents.reader!, 1000)).toBe(true);
      expect(await closedWithin(bystanderEvents.reader!, 150)).toBe(false);

      // The ticket died with the device: it cannot reopen a stream.
      const viaTicket = await fetch(`${base()}/api/events?ticket=${encodeURIComponent(ticket)}`, {
        headers: { Accept: 'text/event-stream' },
      });
      expect(viaTicket.status).toBe(401);

      const next = await fetch(`${base()}/api/config`, { headers: bearer(victim.token) });
      expect(next.status).toBe(401);
      expect(await next.json()).toEqual({ error: 'unauthorized', reason: 'revoked' });

      expect(audit().filter((e) => e.event === 'revoke')).toEqual([
        expect.objectContaining({ deviceId: victim.deviceId, actor: 'device-self' }),
      ]);
      bystanderEvents.ac.abort();
    });

    it('reports a failed write honestly and still blocks the device', async () => {
      await start();
      const victim = await pair('Old phone', true);
      vi.spyOn(store as unknown as { persist: () => boolean }, 'persist').mockReturnValue(false);

      const res = await revoke(bearer(victim.token), victim.deviceId);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, reason: 'persist-failed', closed: 0 });
      expect((await fetch(`${base()}/api/config`, { headers: bearer(victim.token) })).status).toBe(401);
    });

    it('answers 500 instead of dropping the connection when the revoke throws', async () => {
      await start();
      const target = await pair('Target', true);
      vi.spyOn(store, 'revoke').mockImplementation(() => {
        throw new Error('roster exploded');
      });

      const res = await revoke(operator(), target.deviceId);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'device-revoke-failed' });
    });

    it('lets the operator revoke anyone, 404s an unknown id, and is idempotent', async () => {
      await start();
      const target = await pair('Target', true);

      const first = await revoke(operator(), target.deviceId);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ok: true, closed: 0 });

      const again = await revoke(operator(), target.deviceId);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, closed: 0 });

      const ghost = await revoke(operator(), crypto.randomUUID());
      expect(ghost.status).toBe(404);
      expect(await ghost.json()).toEqual({ error: 'device-not-found' });

      expect(audit().filter((e) => e.event === 'revoke')).toEqual([
        expect.objectContaining({ deviceId: target.deviceId, actor: 'operator-web' }),
      ]);
    });
  });

  describe('PATCH /api/devices/:id/grants', () => {
    it('refuses to RAISE a grant for everyone, the operator included, without writing', async () => {
      await start();
      const viewer = await pair('Viewer', false);
      const persistSpy = vi.spyOn(store as unknown as { persist: () => boolean }, 'persist');
      const setInputSpy = vi.spyOn(store, 'setInput');

      const asOperator = await patchGrants(operator(), viewer.deviceId, { input: true });
      expect(asOperator.status).toBe(403);
      expect(await asOperator.json()).toEqual({ error: 'grant-escalation-desktop-only' });

      const asSelf = await patchGrants(bearer(viewer.token), viewer.deviceId, { input: true });
      expect(asSelf.status).toBe(403);
      expect(await asSelf.json()).toEqual({ error: 'grant-escalation-desktop-only' });

      expect(persistSpy).toHaveBeenCalledTimes(0);
      expect(setInputSpy).not.toHaveBeenCalled();
    });

    it('lets a device lower its own grant, closes its streams, and audits it as the device', async () => {
      await start();
      const typer = await pair('Typer', true);
      const events = await openEvents(bearer(typer.token));
      expect(events.res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));

      const res = await patchGrants(bearer(typer.token), typer.deviceId, { input: false });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, grants: { input: false } });
      expect(await closedWithin(events.reader!, 1000)).toBe(true);
      const after = await config(bearer(typer.token));
      expect(after.allowInput).toBe(false);
      expect(after.deviceManagement).toEqual({ scope: 'self' });
      expect(audit().filter((e) => e.event === 'input-grant')).toEqual([
        expect.objectContaining({ deviceId: typer.deviceId, actor: 'device-self', allowInput: false }),
      ]);
    });

    it('does not cut the streams of a device whose grant is already off and on disk', async () => {
      await start();
      const viewer = await pair('Viewer', false);
      const events = await openEvents(bearer(viewer.token));
      expect(events.res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      const disconnect = vi.spyOn(server, 'disconnectDevice');

      for (let i = 0; i < 3; i++) {
        const res = await patchGrants(operator(), viewer.deviceId, { input: false });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, grants: { input: false } });
      }

      expect(disconnect).not.toHaveBeenCalled();
      expect(await closedWithin(events.reader!, 150)).toBe(false);
      expect(audit().filter((e) => e.event === 'input-grant')).toEqual([]);
      events.ac.abort();
    });

    it('retries an unpersisted change on the same PATCH until it lands', async () => {
      await start();
      const typer = await pair('Typer', true);
      const persist = vi.spyOn(store as unknown as { persist: () => boolean }, 'persist').mockReturnValue(false);
      const disconnect = vi.spyOn(server, 'disconnectDevice');

      const first = await patchGrants(operator(), typer.deviceId, { input: false });
      expect(await first.json()).toEqual({ ok: false, reason: 'persist-failed', grants: { input: false } });
      const retry = await patchGrants(operator(), typer.deviceId, { input: false });
      expect(await retry.json()).toEqual({ ok: false, reason: 'persist-failed', grants: { input: false } });
      expect(persist).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledTimes(2);

      persist.mockRestore();
      const landed = await patchGrants(operator(), typer.deviceId, { input: false });
      expect(await landed.json()).toEqual({ ok: true, grants: { input: false } });
      expect(new DeviceStore({ wmuxDir: dir }).list().find((d) => d.deviceId === typer.deviceId)?.allowInput).toBe(false);
    });

    it('lets a read-only device send input:false to itself', async () => {
      await start();
      const viewer = await pair('Viewer', false);

      const res = await patchGrants(bearer(viewer.token), viewer.deviceId, { input: false });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, grants: { input: false } });
    });

    it('rejects a malformed grants body', async () => {
      await start();
      const typer = await pair('Typer', true);
      for (const body of ['{}', { input: 'false' }, { input: false, upload: false }, [false], { input: null }, '']) {
        const res = await patchGrants(operator(), typer.deviceId, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'invalid-grants' });
      }
      expect((await getDevices(operator())).body.devices[0].grants).toEqual({ input: true });
    });

    it('answers 404 for an unknown id and 409 for a revoked one (operator)', async () => {
      await start();
      const gone = await pair('Gone', true);
      store.revoke(gone.deviceId, 'desktop');

      const ghost = await patchGrants(operator(), crypto.randomUUID(), { input: false });
      expect(ghost.status).toBe(404);
      expect(await ghost.json()).toEqual({ error: 'device-not-found' });

      const revoked = await patchGrants(operator(), gone.deviceId, { input: false });
      expect(revoked.status).toBe(409);
      expect(await revoked.json()).toEqual({ error: 'device-revoked' });
    });

    it('answers 409 when the desktop revokes the target while the body is still arriving', async () => {
      await start();
      const target = await pair('Target', true);

      const outcome = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpReq(
          {
            host: '127.0.0.1',
            port: server.status().port,
            path: `/api/devices/${target.deviceId}/grants`,
            method: 'PATCH',
            headers: { ...operator(), 'Content-Type': 'application/json' },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.write('{"input":');
        setTimeout(() => {
          // The desktop's revoke lands between the route's auth and its body.
          expect(store.revoke(target.deviceId, 'desktop').ok).toBe(true);
          req.end('false}');
        }, 80);
      });

      expect(outcome.status).toBe(409);
      expect(JSON.parse(outcome.body)).toEqual({ error: 'device-revoked' });
    });
  });
});
