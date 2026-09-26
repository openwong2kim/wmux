import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver, type WebTerminalStartOptions } from '../WebTerminalServer';
import { TranscriptProjector } from '../../transcript/TranscriptProjector';
import type { ResumeBinding } from '../../../shared/agentResume';
import type { ChatBridge, ChatResolution } from '../../chat/chatBridge';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import type { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';

/**
 * `GET /api/search` through the real HTTP surface: auth, the grants, which
 * panes each credential may read, the config flag, the concurrency bound, and
 * a `turnCursor` that `/turns` actually opens on the hit.
 */

const AGENT_SESSION = '920b9112-1111-4222-8333-444455556666';

type Pane = {
  meta: {
    id: string; incarnationId: string; env: Record<string, string>; cwd: string; spawnCwd: string; state: string;
    cols: number; rows: number; lastActivity: string; agent?: { role: string; teamId: string; displayName: string };
  };
  ringBuffer: { readAll: () => Buffer; totalBytesWritten: number };
  bridge: EventEmitter;
  ptyProcess: { write: ReturnType<typeof vi.fn> };
};

function mkPane(id: string, over: Partial<Pane['meta']> = {}): Pane {
  return {
    meta: {
      id, incarnationId: `${id}-inc`, env: {}, cwd: '/tmp', spawnCwd: '/tmp', state: 'detached', cols: 80, rows: 24,
      lastActivity: '2026-09-01T00:00:00.000Z', ...over,
    },
    ringBuffer: { readAll: () => Buffer.from(''), totalBytesWritten: 0 },
    bridge: new EventEmitter(),
    ptyProcess: { write: vi.fn() },
  };
}

describe('GET /api/search', () => {
  let dir: string;
  let transcript: string;
  let panes: Map<string, Pane>;
  let bindings: Map<string, ResumeBinding>;
  let roster: Map<string, string>;
  let textReads: string[];
  let chatWired: boolean;
  let chatGate: Promise<void> | null;
  let chatResolves: number;
  let desktopRequests: number;
  let desktopAvailable: boolean;
  let server: WebTerminalServer;
  let projector: TranscriptProjector;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-search-'));
    const projects = path.join(dir, 'projects', '-repo');
    fs.mkdirSync(projects, { recursive: true });
    transcript = path.join(projects, `${AGENT_SESSION}.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(JSON.stringify({
        type: 'user',
        uuid: `u-${i}`,
        timestamp: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        message: { role: 'user', content: i === 7 ? 'Where is the Needle hidden?' : `filler line ${i} ` + 'x'.repeat(200) },
      }));
    }
    fs.writeFileSync(transcript, lines.join('\n') + '\n');

    panes = new Map([
      ['s1', mkPane('s1', {
        env: { WMUX_WORKSPACE_ID: 'ws-1', WMUX_WORKSPACE_NAME: 'Alpha' }, cwd: '/src/app', lastActivity: '2026-09-02T00:00:00.000Z',
        agent: { role: 'worker', teamId: 't', displayName: 'Claude' },
      })],
      ['dead-1', mkPane('dead-1', { env: { WMUX_WORKSPACE_NAME: 'needle ws' }, state: 'dead', lastActivity: '2026-08-01T00:00:00.000Z' })],
      ['brain-1', mkPane('brain-1', { env: { WMUX_WORKSPACE_NAME: 'needle ws' } })],
      ['marked', mkPane('marked', { env: { WMUX_WORKSPACE_NAME: 'needle ws', WMUX_BRAIN_PTY: '1' } })],
    ]);
    bindings = new Map([['s1', { agent: 'claude', sessionId: AGENT_SESSION, cwd: '/repo', ts: 1, transcriptPath: transcript }]]);
    roster = new Map();
    textReads = [];
    chatWired = false;
    chatGate = null;
    chatResolves = 0;
    desktopRequests = 0;
    desktopAvailable = false;

    projector = new TranscriptProjector({
      getResumeBinding: (id) => bindings.get(id),
      getSessionEnv: () => ({ CLAUDE_CONFIG_DIR: dir }),
      emitAppend: () => { /* unused */ },
    });
    // Just enough of the bridge for `/turns` and the search to resolve a file binding.
    const chat = {
      resolve: async (id: string): Promise<ChatResolution> => {
        chatResolves += 1;
        if (chatGate) await chatGate;
        const status = projector.status(id);
        return status.available
          ? { source: 'file', status }
          : { source: 'none', status, launch: { ready: false, reason: 'not-integrated', agents: [], maxPromptUnits: 0 } };
      },
      blocked: async () => undefined,
      managedSnapshot: () => null,
      watch: () => { /* unused */ },
      unwatch: () => { /* unused */ },
    } as unknown as ChatBridge;
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        return roster.get(deviceId) === secret ? { ok: true, deviceId, allowInput: false } : { ok: false, reason: 'unknown' };
      },
    };
    const desktop = {
      get available() { return desktopAvailable; },
      request: async () => {
        desktopRequests += 1;
        return { sidebar: { activeWorkspaceId: null, workspaces: [], panes: [{ ptyId: 's1', workspaceId: 'ws-1', surfaceTitle: 'Tab title' }] } };
      },
    } as unknown as DesktopPhoneBridge;
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: (id: string) => panes.get(id),
      listManagedSessions: () => [...panes.values()],
      listLiveSessions: () => [...panes.values()].filter((p) => p.meta.state !== 'dead').map((p) => ({ ...p.meta })),
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      devices,
      desktop: () => desktop,
      projector: () => projector,
      chat: () => (chatWired ? chat : null),
      sessionText: async (id) => {
        textReads.push(id);
        return [{ text: `needle in the ring of ${id}`, wrapped: false }];
      },
      log: () => { /* silent */ },
      assetsDir: os.tmpdir(),
    });
  });

  afterEach(async () => {
    if (server.isRunning) await server.stop();
    projector.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const start = (over: Partial<WebTerminalStartOptions> = {}) =>
    server.start({ port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, allowTranscript: true, ...over });
  const base = () => `http://127.0.0.1:${server.status().port}`;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const device = () => {
    roster.set('phone', 'secret');
    return bearer('phone.secret');
  };
  const search = async (headers: Record<string, string>, query: string) => {
    const res = await fetch(`${base()}/api/search?${query}`, { headers });
    return { res, body: await res.json() as Record<string, any> };
  };
  const sessionsOf = (body: Record<string, any>) => [...new Set((body.results as Array<{ sessionId: string }>).map((r) => r.sessionId))].sort();

  it('401s without a credential and answers no-store', async () => {
    const info = await start();
    expect((await fetch(`${base()}/api/search?q=needle`)).status).toBe(401);
    const { res } = await search(bearer(info.token as string), 'q=needle');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const bad = await search(bearer(info.token as string), 'q=n');
    expect([bad.res.status, bad.body.error, bad.res.headers.get('cache-control')]).toEqual([400, 'invalid-query', 'no-store']);
  });

  it('403s only when every requested scope needs --allow-transcript', async () => {
    const info = await start({ allowTranscript: false });
    const token = bearer(info.token as string);
    const refused = await search(token, 'q=needle');
    expect([refused.res.status, refused.body]).toEqual([403, { error: 'transcript-disabled' }]);

    const mixed = await search(token, 'q=needle&scope=turns,scrollback');
    expect(mixed.res.status).toBe(200);
    expect(mixed.body.results.every((r: { kind: string }) => r.kind === 'scrollback')).toBe(true);
    const disabled = mixed.body.coverage.skippedSessions.filter((s: { reason: string }) => s.reason === 'transcript-disabled');
    expect(disabled.map((s: { sessionId: string; scope: string }) => `${s.sessionId}:${s.scope}`).sort()).toEqual(['dead-1:turns', 's1:turns']);
  });

  it('gives a paired device no brain pane in any scope; the operator keeps brain scrollback only', async () => {
    const info = await start();
    const all = 'q=needle&scope=turns,sessions,scrollback';
    const phone = await search(device(), all);
    expect(phone.res.status).toBe(200);
    expect(sessionsOf(phone.body)).toEqual(['dead-1', 's1']);
    const skipped = phone.body.coverage.skippedSessions.map((s: { sessionId: string }) => s.sessionId);
    expect(skipped).not.toContain('brain-1');
    expect(skipped).not.toContain('marked');

    const operator = await search(bearer(info.token as string), all);
    expect(sessionsOf(operator.body)).toEqual(['brain-1', 'dead-1', 'marked', 's1']);
    const brainKinds = operator.body.results.filter((r: { sessionId: string }) => r.sessionId === 'brain-1' || r.sessionId === 'marked')
      .map((r: { kind: string }) => r.kind);
    expect(new Set(brainKinds)).toEqual(new Set(['scrollback']));
  });

  it('marks tombstones not alive, composes titles, and reuses cached scrollback text', async () => {
    const info = await start();
    const token = bearer(info.token as string);
    const { body } = await search(token, 'q=needle&scope=sessions,scrollback');
    const dead = body.results.find((r: { sessionId: string; kind: string }) => r.sessionId === 'dead-1' && r.kind === 'session');
    expect(dead).toMatchObject({ alive: false, title: 'needle ws · tmp' });
    const live = body.results.find((r: { sessionId: string; kind: string }) => r.sessionId === 's1' && r.kind === 'scrollback');
    expect(live).toMatchObject({ alive: true, title: 'Alpha · Claude · app', workspaceId: 'ws-1', snippet: 'needle in the ring of s1', matchRanges: [[0, 6]] });
    expect(live).not.toHaveProperty('surfaceTitle');

    const before = textReads.length;
    await search(token, 'q=ring&scope=scrollback');
    expect(textReads.length).toBe(before);
    panes.get('s1')!.ringBuffer.totalBytesWritten = 10;
    await search(token, 'q=ring&scope=scrollback');
    expect(textReads.slice(before)).toEqual(['s1']);
  });

  it('carries the desktop tab title from the cached sidebar without asking the desktop', async () => {
    desktopAvailable = true;
    const info = await start();
    const token = bearer(info.token as string);
    await fetch(`${base()}/api/sessions`, { headers: token });
    const asked = desktopRequests;
    expect(asked).toBeGreaterThan(0);
    const { body } = await search(token, 'q=Tab%20title&scope=sessions');
    expect(desktopRequests).toBe(asked);
    expect(body.results).toEqual([expect.objectContaining({ sessionId: 's1', surfaceTitle: 'Tab title', snippet: 'Tab title', title: 'Alpha · Claude · app' })]);
  });

  it('advertises search in /api/config by what can answer this caller', async () => {
    const withTranscript = await start();
    const config = async (t: string) => (await fetch(`${base()}/api/config`, { headers: bearer(t) })).json();
    expect(await config(withTranscript.token as string)).toMatchObject({ search: true, searchScopes: ['turns', 'sessions', 'scrollback'] });
    await server.stop();
    const without = await start({ allowTranscript: false });
    expect(await config(without.token as string)).toMatchObject({ search: true, searchScopes: ['scrollback'] });
  });

  it('opens a turn hit through /turns with the cursor it carries, bridge or no bridge', async () => {
    const info = await start();
    const token = bearer(info.token as string);
    for (const wired of [false, true]) {
      chatWired = wired;
      const { body } = await search(token, 'q=needle&scope=turns');
      const hit = body.results.find((r: { kind: string }) => r.kind === 'turn');
      expect(hit).toMatchObject({ sessionId: 's1', turnEventId: 'u-7', at: Date.UTC(2026, 8, 1, 0, 7), alive: true });
      expect(hit.matchRanges).toEqual([[13, 6]]);
      expect(hit.snippet.slice(13, 19)).toBe('Needle');
      const turns = await fetch(`${base()}/api/sessions/s1/turns?dir=back&cursor=${encodeURIComponent(hit.turnCursor)}`, { headers: token });
      const page = await turns.json() as { events: Array<{ id: string }>; mode?: string };
      expect(page.events[page.events.length - 1].id).toBe('u-7');
      if (wired) expect(page.mode).toBe('older');
    }
  });

  it('runs two searches at once and answers a third 429 with Retry-After', async () => {
    const info = await start();
    const token = bearer(info.token as string);
    chatWired = true;
    let release!: () => void;
    chatGate = new Promise<void>((resolve) => { release = resolve; });
    const first = search(token, 'q=needle&scope=turns');
    const second = search(token, 'q=needle&scope=turns');
    const deadline = Date.now() + 2000;
    while (chatResolves < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const busy = await fetch(`${base()}/api/search?q=needle&scope=turns`, { headers: token });
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(await busy.json()).toEqual({ error: 'search-busy' });
    release();
    expect((await first).res.status).toBe(200);
    expect((await second).res.status).toBe(200);
    chatGate = null;
    expect((await search(token, 'q=needle&scope=turns')).res.status).toBe(200);
  });
});
