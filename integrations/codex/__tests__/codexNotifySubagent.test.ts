import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
// The notify bridge is plain .mjs (Codex spawns it with `node`); it exports
// its pure thread rules so they can be checked without a Codex process.
import {
  uuidV7Millis, findRolloutFile, parseSessionMeta, classifyCodexThread,
} from '../bin/wmux-codex-notify.mjs';

// #1696: a Codex sub-agent thread inherits the pane env, so its
// turn-complete notify arrives pane-exact. Sent as agent.stop it stole the
// pane's resume binding (resume opened "Viewing sub-agent — direct input is
// disabled"), raised a "Task finished" toast the Subagent mute never caught,
// and read as the lead turn ending.

const BRIDGE = path.join(__dirname, '..', 'bin', 'wmux-codex-notify.mjs');

// 2026-09-30 07:52:21.000Z, the shape of a real Codex UUIDv7 thread id.
const BASE_MS = Date.UTC(2026, 8, 30, 7, 52, 21);
function v7(ms: number, tail: string): string {
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18)}`;
}
const ROOT = v7(BASE_MS, 'aaa000000000000001');
const CHILD = v7(BASE_MS + 60_000, 'bbb000000000000002');
const GRANDCHILD = v7(BASE_MS + 120_000, 'ccc000000000000003');
const OTHER = v7(BASE_MS + 180_000, 'ddd000000000000004');

function dayDir(sessionsRoot: string, ms: number): string {
  const d = new Date(ms);
  return path.join(
    sessionsRoot,
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  );
}

function meta(id: string, source: unknown, sessionId?: string): string {
  return JSON.stringify({
    timestamp: new Date(BASE_MS).toISOString(),
    type: 'session_meta',
    payload: { id, ...(sessionId ? { session_id: sessionId } : {}), source, base_instructions: { text: 'x'.repeat(30_000) } },
  });
}

function writeRollout(sessionsRoot: string, id: string, firstLine: string, dirMs?: number): string {
  const dir = dayDir(sessionsRoot, dirMs ?? uuidV7Millis(id) ?? BASE_MS);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-30T09-52-21-${id}.jsonl`);
  fs.writeFileSync(file, `${firstLine}\n{"type":"turn_context"}\n`);
  return file;
}

const spawnSource = (parent: string, depth = 1) => ({
  subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_nickname: 'Peirce' } },
});

describe('uuidV7Millis', () => {
  it('reads the creation time of a v7 id and nothing else', () => {
    expect(uuidV7Millis(ROOT)).toBe(BASE_MS);
    expect(uuidV7Millis('11111111-2222-4333-8444-555555555555')).toBeUndefined();
    expect(uuidV7Millis('not-an-id')).toBeUndefined();
  });
});

describe('parseSessionMeta', () => {
  it('a top-level thread is not a sub-agent', () => {
    expect(parseSessionMeta(meta(ROOT, 'cli', ROOT))).toEqual({ subagent: false });
    expect(parseSessionMeta(meta(ROOT, 'exec'))).toEqual({ subagent: false });
  });

  it('a spawned sub-agent names its root (session_id) and its parent', () => {
    expect(parseSessionMeta(meta(CHILD, spawnSource(ROOT), ROOT))).toEqual({ subagent: true, rootId: ROOT, parentId: ROOT });
  });

  it('a sub-agent without session_id still names its parent', () => {
    expect(parseSessionMeta(meta(GRANDCHILD, spawnSource(CHILD, 2)))).toEqual({ subagent: true, rootId: undefined, parentId: CHILD });
  });

  it('a non-spawn sub-agent (review, compact) is a sub-agent with no parent', () => {
    expect(parseSessionMeta(meta(CHILD, { subagent: 'review' }))).toEqual({ subagent: true, rootId: undefined, parentId: undefined });
  });

  it('source.subagent: false, or any other empty value, is not a sub-agent (#1697 review)', () => {
    expect(parseSessionMeta(meta(ROOT, { subagent: false }))).toEqual({ subagent: false });
    expect(parseSessionMeta(meta(ROOT, { subagent: '' }))).toEqual({ subagent: false });
    expect(parseSessionMeta(meta(ROOT, { subagent: 0 }))).toEqual({ subagent: false });
  });

  it('anything that is not session_meta is undefined', () => {
    expect(parseSessionMeta('{"type":"turn_context"}')).toBeUndefined();
    expect(parseSessionMeta('not json')).toBeUndefined();
    expect(parseSessionMeta('[]')).toBeUndefined();
  });
});

describe('findRolloutFile / classifyCodexThread', () => {
  let sessionsRoot: string;
  beforeEach(() => {
    sessionsRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cn-subagent-')), 'sessions');
  });
  afterEach(() => fs.rmSync(path.dirname(sessionsRoot), { recursive: true, force: true }));

  it('finds a rollout in its creation day, or the day either side', () => {
    const file = writeRollout(sessionsRoot, ROOT, meta(ROOT, 'cli', ROOT));
    expect(findRolloutFile(ROOT, sessionsRoot)).toBe(file);
    const late = writeRollout(sessionsRoot, CHILD, meta(CHILD, 'cli', CHILD), BASE_MS + 24 * 60 * 60 * 1000);
    expect(findRolloutFile(CHILD, sessionsRoot)).toBe(late);
    expect(findRolloutFile(GRANDCHILD, sessionsRoot)).toBeUndefined();
  });

  it('a top-level thread keeps its own id', () => {
    writeRollout(sessionsRoot, ROOT, meta(ROOT, 'cli', ROOT));
    expect(classifyCodexThread(ROOT, sessionsRoot)).toEqual({ subagent: false, rootId: ROOT });
  });

  it('a sub-agent resolves to its root thread', () => {
    writeRollout(sessionsRoot, ROOT, meta(ROOT, 'cli', ROOT));
    writeRollout(sessionsRoot, CHILD, meta(CHILD, spawnSource(ROOT), ROOT));
    expect(classifyCodexThread(CHILD, sessionsRoot)).toEqual({ subagent: true, rootId: ROOT });
  });

  it('walks parent links when session_id is absent', () => {
    writeRollout(sessionsRoot, ROOT, meta(ROOT, 'cli'));
    writeRollout(sessionsRoot, CHILD, meta(CHILD, spawnSource(ROOT)));
    writeRollout(sessionsRoot, GRANDCHILD, meta(GRANDCHILD, spawnSource(CHILD, 2)));
    expect(classifyCodexThread(GRANDCHILD, sessionsRoot)).toEqual({ subagent: true, rootId: ROOT });
  });

  // #1697 review ("must fix" #1): an unresolved parent must never become the
  // reported root — it could itself be a sub-agent. This is the exact #1696
  // failure mode (resume opening a sub-agent), so the walk now reports
  // "sub-agent, unknown root" instead of guessing.
  it('an immediate parent whose rollout is gone is a sub-agent with no CONFIRMED root', () => {
    writeRollout(sessionsRoot, CHILD, meta(CHILD, spawnSource(ROOT)));
    expect(classifyCodexThread(CHILD, sessionsRoot)).toEqual({ subagent: true, rootId: undefined });
  });

  it('a missing INTERMEDIATE rollout (not the immediate parent) also withholds the root', () => {
    // GRANDCHILD -> CHILD (rollout exists, points further up) -> ROOT (missing).
    writeRollout(sessionsRoot, GRANDCHILD, meta(GRANDCHILD, spawnSource(CHILD, 2)));
    writeRollout(sessionsRoot, CHILD, meta(CHILD, spawnSource(ROOT)));
    expect(classifyCodexThread(GRANDCHILD, sessionsRoot)).toEqual({ subagent: true, rootId: undefined });
  });

  it('a cycle (A spawned-by B spawned-by A) terminates without a root', () => {
    writeRollout(sessionsRoot, ROOT, meta(ROOT, spawnSource(CHILD)));
    writeRollout(sessionsRoot, CHILD, meta(CHILD, spawnSource(ROOT)));
    expect(classifyCodexThread(ROOT, sessionsRoot)).toEqual({ subagent: true, rootId: undefined });
  });

  it('exhausting the hop budget withholds the root rather than returning an unconfirmed id', () => {
    // A chain of MAX_PARENT_HOPS (8) sub-agents, each naming only its direct
    // parent (no session_id shortcut), with no top-level thread reachable
    // inside the budget. T0 (never reached) would resolve it if the budget
    // were unbounded.
    const chain = Array.from({ length: 9 }, (_, i) => v7(BASE_MS + i * 60_000, `${i}`.padStart(3, '0') + '0'.repeat(15)));
    writeRollout(sessionsRoot, chain[0], meta(chain[0], 'cli'));
    for (let i = 1; i < chain.length; i++) {
      writeRollout(sessionsRoot, chain[i], meta(chain[i], spawnSource(chain[i - 1])));
    }
    expect(classifyCodexThread(chain[chain.length - 1], sessionsRoot)).toEqual({ subagent: true, rootId: undefined });
  });

  it('a sub-agent with no parent binds nothing', () => {
    writeRollout(sessionsRoot, CHILD, meta(CHILD, { subagent: 'review' }));
    expect(classifyCodexThread(CHILD, sessionsRoot)).toEqual({ subagent: true, rootId: undefined });
  });

  // #1697 review ("must fix" #2): the rollout found by filename must still
  // name the thread it was looked up for before it is trusted.
  it('ignores a rollout whose own session_meta names a different thread', () => {
    const dir = dayDir(sessionsRoot, uuidV7Millis(CHILD)!);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-09-30T09-52-21-${CHILD}.jsonl`), `${meta(OTHER, 'cli', OTHER)}\n`);
    expect(classifyCodexThread(CHILD, sessionsRoot)).toEqual({ subagent: false, rootId: CHILD });
  });

  it('fails open to the thread itself when there is no readable history', () => {
    expect(classifyCodexThread(ROOT, sessionsRoot)).toEqual({ subagent: false, rootId: ROOT });
    writeRollout(sessionsRoot, CHILD, 'garbage');
    expect(classifyCodexThread(CHILD, sessionsRoot)).toEqual({ subagent: false, rootId: CHILD });
    const legacy = '11111111-2222-4333-8444-555555555555';
    expect(classifyCodexThread(legacy, sessionsRoot)).toEqual({ subagent: false, rootId: legacy });
  });
});

// End to end: the bridge as Codex runs it, against a fake wmux main pipe.
describe('wmux-codex-notify with a sub-agent thread', () => {
  let dir: string;
  let home: string;
  let codexHome: string;
  let pipe: string;
  let server: net.Server;
  let received: Array<{ method?: string; params?: Record<string, unknown> }>;

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cn-subagent-e2e-')));
    home = path.join(dir, 'home');
    codexHome = path.join(dir, 'codex');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.wmux-auth-token'), 'test-token');
    received = [];
    pipe = process.platform === 'win32'
      ? `\\\\.\\pipe\\wmux-codex-notify-subagent-${randomUUID()}`
      : path.join(os.tmpdir(), `wmux-cs-${randomUUID().slice(0, 8)}.sock`);
    server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
          const request = JSON.parse(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          received.push(request);
          socket.write(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }) + '\n');
        }
      });
      socket.on('error', () => { /* the bridge closes first */ });
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') fs.rmSync(pipe, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(threadId: string): Promise<number | null> {
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': threadId, 'turn-id': 'turn-1', cwd: dir });
    const env: NodeJS.ProcessEnv = { ...process.env };
    // This suite may itself run inside a wmux pane.
    for (const key of Object.keys(env)) if (key.startsWith('WMUX_')) delete env[key];
    Object.assign(env, {
      USERPROFILE: home,
      HOME: home,
      CODEX_HOME: codexHome,
      WMUX_PIPE_NAME: pipe,
      WMUX_PTY_ID: 'pty-1',
      WMUX_WORKSPACE_ID: 'ws-1',
      WMUX_SURFACE_ID: 'surface-1',
    });
    const proc = spawn(process.execPath, [BRIDGE, payload], { cwd: dir, env, stdio: 'ignore' });
    return new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  }

  const logLines = () => fs.readFileSync(path.join(home, '.wmux', 'codex-notify.log'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const spoolFiles = () => {
    const spool = path.join(home, '.wmux', 'resume-spool');
    return fs.existsSync(spool) ? fs.readdirSync(spool).filter((f) => f.endsWith('.json')) : [];
  };

  it('reports a sub-agent turn as subagent_stop with no session id (so it cannot rebind the pane)', async () => {
    const sessions = path.join(codexHome, 'sessions');
    writeRollout(sessions, ROOT, meta(ROOT, 'cli', ROOT));
    writeRollout(sessions, CHILD, meta(CHILD, spawnSource(ROOT), ROOT));
    expect(await run(CHILD)).toBe(0);
    expect(received).toEqual([expect.objectContaining({
      method: 'hooks.signal',
      params: expect.objectContaining({ kind: 'agent.subagent_stop', agent: 'codex', ptyId: 'pty-1' }),
    })]);
    expect(received[0].params).not.toHaveProperty('agentSessionId');
    // The root is still the best CONFIRMED one (CHILD's session_id names it
    // directly) and rides along for the log only.
    expect(logLines()).toEqual([expect.objectContaining({ outcome: 'ok', sessionId: CHILD, subagent: true, rootSessionId: ROOT })]);
  }, 20_000);

  it('reports the root thread\'s own turn as agent.stop, as before', async () => {
    writeRollout(path.join(codexHome, 'sessions'), ROOT, meta(ROOT, 'cli', ROOT));
    expect(await run(ROOT)).toBe(0);
    expect(received).toEqual([expect.objectContaining({
      params: expect.objectContaining({ kind: 'agent.stop', agentSessionId: ROOT }),
    })]);
    expect(logLines()[0]).not.toHaveProperty('subagent');
  }, 20_000);

  it('sends a parentless sub-agent turn without a session id, so it binds nothing', async () => {
    writeRollout(path.join(codexHome, 'sessions'), CHILD, meta(CHILD, { subagent: 'review' }));
    expect(await run(CHILD)).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].params).toEqual(expect.objectContaining({ kind: 'agent.subagent_stop' }));
    expect(received[0].params).not.toHaveProperty('agentSessionId');
  }, 20_000);

  // #1697 review ("should fix" #5): a sub-agent completion must never replace
  // an older, valid agent.stop spool for the same pane — so it is not spooled
  // at all when no wmux endpoint can be reached.
  it('does not spool a sub-agent completion when no wmux endpoint exists', async () => {
    fs.rmSync(path.join(home, '.wmux-auth-token'), { force: true });
    writeRollout(path.join(codexHome, 'sessions'), CHILD, meta(CHILD, { subagent: 'review' }));
    expect(await run(CHILD)).toBe(0);
    expect(spoolFiles()).toEqual([]);
    expect(logLines()).toEqual([expect.objectContaining({ outcome: 'no-auth-token', subagent: true })]);
  }, 20_000);

  it('still spools the root thread\'s own turn when no wmux endpoint exists, as before', async () => {
    fs.rmSync(path.join(home, '.wmux-auth-token'), { force: true });
    writeRollout(path.join(codexHome, 'sessions'), ROOT, meta(ROOT, 'cli', ROOT));
    expect(await run(ROOT)).toBe(0);
    expect(spoolFiles()).toEqual(['pty-1.json']);
  }, 20_000);
});
