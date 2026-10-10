import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import { fleetTicketDetailResponse, fleetTicketsFields, type FleetTicketDesktop } from '../fleetTickets';
import { DesktopPhoneError } from '../../phone/DesktopPhoneBridge';
import type { PhoneFleetTicket, PhoneFleetTicketDetail } from '../../../shared/phoneFleetTickets';

/**
 * The phone's Fleet tickets on the daemon: `/api/config` `fleetTickets`, the
 * `/api/workspaces` keys behind `--allow-transcript`, and the detail route.
 * The server is real; main is a fake desktop answering over the real bridge.
 */

const ticket = (over: Partial<PhoneFleetTicket> = {}): PhoneFleetTicket => ({
  id: 'wl-1', taskId: 'task-1', origin: 'manual', workspaceId: 'ws-closed', workspaceName: 'wtask: build',
  agentName: 'Codex CLI', title: 'Build it', state: 'done', updatedAt: 1_700_000_000_900,
  requestLine: 'Please build the thing', resultSummary: 'Built and tested', verification: '3/4', ...over,
});
const detail: PhoneFleetTicketDetail = {
  id: 'wl-1', updatedAt: 1_700_000_000_900, request: 'Please build the thing\nwith tests', result: 'Built and tested\nall green',
  verification: '3/4', verificationItems: [{ kind: 'command', status: 'passed', summary: 'unit tests', command: 'npm test' }],
};
const sidebar = (extra: Record<string, unknown> = {}) => ({ activeWorkspaceId: 'ws-1', workspaces: [{ id: 'ws-1', order: 0, pinned: false }], panes: [], ...extra });

describe('fleet ticket routes', () => {
  let server: WebTerminalServer | undefined;
  afterEach(async () => { if (server?.isRunning) await server.stop(); server = undefined; });

  /** A server whose desktop answers `workspaces.list` with `sidebarReply` and the detail command from `details`. */
  async function start(opts: { allowTranscript: boolean; desktop?: boolean; announce?: boolean; sidebarReply?: Record<string, unknown> }) {
    const commands: string[] = [];
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      commands.push(data.command);
      queueMicrotask(() => {
        if (data.command === 'workspaces.list') {
          bridge.complete(clientId, { requestId: data.requestId, ok: true, result: { workspaces: [], sidebar: opts.sidebarReply ?? sidebar() } });
        } else if (data.command === 'workspaces.fleetTicket') {
          bridge.complete(clientId, { requestId: data.requestId, ok: true, result: data.payload.id === detail.id ? { ticket: detail } : { notFound: true } });
        }
      });
      return true;
    }, 500);
    if (opts.desktop !== false) bridge.register('main', opts.announce === false ? [] : ['workspaces.fleetTicket']);
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        return deviceId === 'd1' && secret === 's1' ? { ok: true, deviceId, allowInput: false } : { ok: false, reason: 'unknown' };
      },
      list: () => [{ deviceId: 'd1', name: 'd1', createdAt: 0, lastSeenAt: 0, allowInput: false }],
    };
    const live = [{
      id: 's1', cwd: '/x', cols: 80, rows: 24, state: 'detached', agent: undefined, lastDetectedAgent: undefined,
      lastActivity: '2020-01-01T00:00:00.000Z', env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_WORKSPACE_NAME: 'Workspace 1' }, cmd: '/bin/zsh',
    }];
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: () => undefined,
      listLiveSessions: () => live,
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager, devices, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir(),
    });
    await server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, allowTranscript: opts.allowTranscript });
    const get = async (route: string) => {
      const res = await fetch(`http://127.0.0.1:${server!.status().port}${route}`, { headers: { Authorization: 'Bearer d1.s1' } });
      return { status: res.status, body: await res.json() as Record<string, unknown>, cache: res.headers.get('cache-control') };
    };
    return { get, commands };
  }

  it('advertises fleetTickets in /api/config while a desktop bridge is wired', async () => {
    const { get } = await start({ allowTranscript: false });
    expect((await get('/api/config')).body.fleetTickets).toBe(true);
  });

  it('lists every ticket with its text lines under --allow-transcript, and without them otherwise', async () => {
    const reply = sidebar({ fleetTickets: [ticket()], nextScheduleAt: 1_700_000_100_000 });
    const on = await start({ allowTranscript: true, sidebarReply: reply });
    const withText = (await on.get('/api/workspaces')).body;
    expect(withText.fleetTickets).toEqual([ticket()]);
    expect(withText.nextScheduleAt).toBe(1_700_000_100_000);
    await server!.stop();
    const off = await start({ allowTranscript: false, sidebarReply: reply });
    const body = (await off.get('/api/workspaces')).body;
    const { requestLine: _r, resultSummary: _s, verification: _v, ...bare } = ticket();
    expect(body.fleetTickets).toEqual([bare]);
    expect(JSON.stringify(body)).not.toContain('Please build');
    expect(body.nextScheduleAt).toBe(1_700_000_100_000);
  });

  it('omits both keys when the desktop sent neither', async () => {
    const { get } = await start({ allowTranscript: true });
    const body = (await get('/api/workspaces')).body;
    expect(body).not.toHaveProperty('fleetTickets');
    expect(body).not.toHaveProperty('nextScheduleAt');
  });

  it('answers a detail 200 / 404, and 403 without --allow-transcript before asking the desktop', async () => {
    const on = await start({ allowTranscript: true });
    const ok = await on.get('/api/fleet/tickets/wl-1');
    expect(ok).toMatchObject({ status: 200, body: { ticket: detail }, cache: 'no-store' });
    expect((await on.get('/api/fleet/tickets/wl-unknown')).status).toBe(404);
    expect((await on.get(`/api/fleet/tickets/${encodeURIComponent('handoff:dec-9')}`)).status).toBe(404);
    expect((await on.get('/api/fleet/tickets/%E0%A4%A')).status).toBe(404);
    await server!.stop();
    const off = await start({ allowTranscript: false });
    expect(await off.get('/api/fleet/tickets/wl-1')).toMatchObject({ status: 403, body: { error: 'transcript-disabled' } });
    expect(off.commands).not.toContain('workspaces.fleetTicket');
  });

  it('answers 503 when the desktop never announced the detail command', async () => {
    const { get, commands } = await start({ allowTranscript: true, announce: false });
    expect(await get('/api/fleet/tickets/wl-1')).toMatchObject({ status: 503, body: { error: 'desktop-unavailable' } });
    expect(commands).not.toContain('workspaces.fleetTicket');
  });
});

describe('fleetTicketDetailResponse', () => {
  const desktop = (request: FleetTicketDesktop['request']): FleetTicketDesktop => ({ supports: () => true, request });

  it('maps a timeout to 504, a lost desktop to 503 and a malformed or mismatched reply to 502', async () => {
    const opts = (d: FleetTicketDesktop | null) => ({ allowTranscript: true, desktop: d });
    expect((await fleetTicketDetailResponse('wl-1', opts(desktop(() => Promise.reject(new DesktopPhoneError('desktop-timeout')))))).status).toBe(504);
    expect((await fleetTicketDetailResponse('wl-1', opts(desktop(() => Promise.reject(new DesktopPhoneError('desktop-disconnected')))))).status).toBe(503);
    expect((await fleetTicketDetailResponse('wl-1', opts(null))).status).toBe(503);
    expect((await fleetTicketDetailResponse('wl-1', opts(desktop(async () => ({ ticket: { id: 'wl-1' } }))))).status).toBe(502);
    expect((await fleetTicketDetailResponse('wl-1', opts(desktop(async () => ({ ticket: { ...detail, id: 'wl-2' } }))))).status).toBe(502);
  });

  it('drops unlisted keys and refuses control characters in the desktop reply', async () => {
    const res = await fleetTicketDetailResponse('wl-1', {
      allowTranscript: true,
      desktop: desktop(async () => ({ ticket: { ...detail, transcript: 'whole session', result: 'bad\u0007bell' } })),
    });
    expect(res.status).toBe(200);
    const body = res.body as { ticket: Record<string, unknown> };
    expect(body.ticket).not.toHaveProperty('transcript');
    expect(body.ticket).not.toHaveProperty('result');
    expect(body.ticket.request).toBe(detail.request);
  });
});

describe('fleetTicketsFields', () => {
  it('passes the list whole with the gate on and strips only agent text with it off', () => {
    const snap = { activeWorkspaceId: null, workspaces: [], panes: [], fleetTickets: [ticket()], nextScheduleAt: 5 };
    expect(fleetTicketsFields(snap, true)).toEqual({ fleetTickets: [ticket()], nextScheduleAt: 5 });
    const off = fleetTicketsFields(snap, false).fleetTickets![0];
    expect(Object.keys(off).sort()).toEqual(['agentName', 'id', 'origin', 'state', 'taskId', 'title', 'updatedAt', 'workspaceId', 'workspaceName']);
    expect(fleetTicketsFields({ activeWorkspaceId: null, workspaces: [], panes: [] }, true)).toEqual({});
  });
});
