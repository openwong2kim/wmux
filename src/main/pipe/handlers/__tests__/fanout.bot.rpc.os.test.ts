import { getWorkflowFanout } from '../../../factory/workflowFanout';
// task.fanout.start from a factory bot (§4, §13 rule 3, R8): the repository
// comes from the bot's profile (no anchor pane), only the role's presets and
// only worktrees are allowed, a detached checkout is the verify preset's, the
// key is the running wake's `wake:<id>:<n>` (so a retried turn polls instead
// of starting twice), and the bot's worker budget and the factory-wide worker
// cap refuse before anything is reserved.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));
vi.mock('../../../git/git', () => ({ git: vi.fn() }));
// Partial: the handoff router (imported by the handler) reads its limits.
vi.mock('../../../deck/deckDecisionStore', async (actual) => ({
  ...(await actual<typeof import('../../../deck/deckDecisionStore')>()),
  loadWorkspaceDecision: vi.fn(() => null),
}));

import { sendToRenderer } from '../_bridge';
import { git } from '../../../git/git';
import { BOT_FANOUT_STARTING_NOTE, botLaunchRefusal, countOpenBotWorkers, parseCheckout, registerFanOutRpc, verdictedTaskIds, workersHeldNote, type FanOutBotPort, type HeldFanoutRequest } from '../fanout.rpc';
import type { FanOutRequest, FanOutResult, FanOutService, FanOutStatus } from '../../../worktask/FanOutService';
import type { RpcRouter } from '../../RpcRouter';
import { FANOUT_LIVE_TASK_CAP, FanOutGuards } from '../../../worktask/fanoutGuards';
import type { FanoutPreset } from '../../../../shared/fanoutPreset';
import { DEFAULT_BOT_BUDGETS, type BotProfile, type BotRole } from '../../../../shared/bot';
import { emptyUsage } from '../../../factory/budget';
import type { ThreadId } from '../../../../shared/room';
import type { BotGroup } from '../../../../shared/botGroup';
import { setFactoryRoomPorts } from '../../../factory/roomWriter';
import { HeldFanouts, heldFanoutFingerprint, setHeldFanouts } from '../../../factory/heldFanouts';
import { WakeQueue, setWakeQueue, wakeQueuePath } from '../../../factory/wakeQueue';
import type { BotWorkerStartOutcome } from '../../../factory/botNotices';
import { SecretStore, setSecretStore } from '../../../factory/secretStore';
import { ConnectorStore } from '../../../factory/connectorStore';
import { setSecretGrantSource } from '../../../factory/secretGrants';
import type { GatewayOAuth } from '../../../connectors/workerGateway';
import type { Connector } from '../../../../shared/botConnector';
import type { ConnectorCheckResult } from '../../../../shared/connectorCheck';

const REPO = nodePath.resolve('/repo');
const WMUX_DIR = nodePath.resolve('/wmux-data');
const SHA = 'a'.repeat(40);
const BOT_ID = 'bot-0a1b2c3d';
type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const PRESETS: FanoutPreset[] = [
  // The operator's spelling; the ledger records the role's ('verify').
  { name: 'Verify', items: [{ agent: 'claude' }], worktree: true },
  { name: 'repro', items: [{ agent: 'claude' }], worktree: true },
  { name: 'default', items: [{ agent: 'claude' }], worktree: false },
];

function profile(role: BotRole, over: Partial<BotProfile> = {}): BotProfile {
  return {
    version: 1, id: BOT_ID, workspaceId: 'ws-bot', role, name: role, engine: { kind: 'claude-sdk' },
    triggers: [], budget: { ...DEFAULT_BOT_BUDGETS[role] }, repo: { repoKey: 'o/r', repoPath: REPO },
    enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}

function botCtx(role: BotRole): RpcContext {
  return { origin: 'local', commanderWorkspace: 'ws-bot', bot: { workspaceId: 'ws-bot', botId: BOT_ID, role } };
}

interface Rig {
  call: (params: Record<string, unknown>, ctx: RpcContext) => Promise<Record<string, unknown>>;
  start: ReturnType<typeof vi.fn>;
  port: FanOutBotPort & { started: string[][]; exhausted: string[]; full: Array<{ scope: string; running: number; limit: number; request?: HeldFanoutRequest }>; seen: Set<string>; refusal: string | null; outcomes: BotWorkerStartOutcome[] };
  approve: () => void;
  setWake: (id: string | null) => void;
  setThread: (t: string | null) => void;
  setOpen: (o: { bot: number; factory: number }) => void;
  setLiveTasks: (n: number) => void;
  setTainted: (t: boolean) => void;
  setGuestSourced: (g: boolean) => void;
  flush: () => Promise<void>;
  /** Repositories whose default branch was read, with how many fan-outs had started then. */
  defaultBranchReads: Array<{ root: string; startedBefore: number }>;
  setDefaultBranchNote: (n: { name: string | null; recorded: boolean }) => void;
}

function rig(role: BotRole, over: Partial<BotProfile> = {}, opts: {
  builtinPresets?: boolean; connectors?: () => ConnectorStore | null; platform?: NodeJS.Platform; presets?: FanoutPreset[];
  /** Signed-in connections: the OAuth service, the sandbox probe, the conversation's mark and the service's tool list. */
  gateway?: {
    oauth: () => GatewayOAuth | null; sandbox: () => Promise<{ ok: true } | { ok: false; reason: string }>; conversationTainted: (botId: string) => boolean;
    listTools?: (c: Connector, headers: Record<string, string>) => Promise<ConnectorCheckResult>;
  };
} = {}): Rig {
  const handlers = new Map<string, Handler>();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) } as unknown as RpcRouter;
  const state = new Map<string, FanOutStatus>();
  const start = vi.fn((req: FanOutRequest): Promise<FanOutResult> => {
    state.set(req.idempotencyKey, { state: 'running' });
    const result: FanOutResult = {
      ok: true,
      tasks: req.titles.map((title, index) => ({ index, title, ok: true, taskId: `task-${index}`, workspaceId: `ws-task-${index}` })),
    };
    state.set(req.idempotencyKey, { state: 'done', result });
    return Promise.resolve(result);
  });
  const service = {
    start,
    statusOf: (key: string) => state.get(key) ?? { state: 'unknown' },
    cancelDependents: () => null,
  } as unknown as FanOutService;
  let holdApproval = false;
  let releaseApproval: (() => void) | null = null;
  vi.mocked(sendToRenderer).mockImplementation(async (_w, method: string) => {
    if (method === 'fanout.requestApproval') {
      if (holdApproval) await new Promise<void>((r) => { releaseApproval = r; });
      return { approved: true, outcome: 'auto' };
    }
    throw new Error(`unexpected renderer call: ${method}`);
  });
  vi.mocked(git).mockImplementation(async (_a: string[], dir: string) =>
    dir.startsWith(REPO) ? { stdout: `${REPO}\n`, stderr: '', code: 0 } : { stdout: '', stderr: 'not a git repository', code: 128 });
  let wake: string | null = 'w-1';
  let thread: string | null = null;
  let open = { bot: 0, factory: 0 };
  /** Live fan-out tasks across wmux that are not bot fan-outs booked here
   *  (the owner's, mostly): the guards' live cap counts them. */
  let liveTasks = 0;
  let tainted = false;
  let guestSourced = false;
  const defaultBranchReads: Rig['defaultBranchReads'] = [];
  let defaultBranchNote: { name: string | null; recorded: boolean } = { name: 'develop', recorded: true };
  const p = profile(role, over);
  const guards = new FanOutGuards({ dir: fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp2-fanout-bot-')), countLiveTasks: () => liveTasks, ledgerTaskOwner: () => null });
  /** Bot fan-outs booked and not through their start: the holder set counts
   *  them (factory/workerHolders.ts). */
  const booked = (botId?: string): number => guards.reservedTasks().filter((u) => u.botId && (botId === undefined || u.botId === botId)).length;
  const port: Rig['port'] = {
    started: [],
    exhausted: [],
    full: [],
    seen: new Set<string>(),
    refusal: null,
    outcomes: [],
    workerStartOutcome: (_b, o) => {
      port.outcomes.push(o);
    },
    fanoutKeySeen: (key) => port.seen.has(key),
    recordFanoutKey: (key) => {
      port.seen.add(key);
    },
    launchRefusal: () => port.refusal,
    profile: () => p,
    currentWakeId: () => wake,
    currentWakeThread: () => thread as ThreadId | null,
    currentWakeTainted: () => tainted,
    wakeGuestSourced: () => guestSourced,
    currentWakeHandoff: () => (wake ? 'h-dispatch' : null),
    openWorkers: (botId) => ({ bot: open.bot + booked(botId), factory: open.factory + booked(), botStarting: booked(botId), live: liveTasks + guards.reservedTasks().length }),
    usage: () => emptyUsage(),
    workersStarted: (_b, ids) => {
      port.started.push([...ids]);
    },
    budgetExhausted: (_b, reason) => {
      port.exhausted.push(reason);
    },
    workersFull: (_b, full, request) => {
      port.full.push({ ...full, request });
      return request !== undefined;
    },
  };
  registerFanOutRpc(router, service, () => null, {
    guards,
    workerPermissionMode: () => 'auto',
    requireApproval: () => false,
    presets: () => PRESETS,
    ...(opts.builtinPresets ? {} : { botPresets: () => opts.presets ?? PRESETS }),
    ...(opts.connectors ? { connectors: opts.connectors } : {}),
    ...(opts.platform ? { workerPlatform: opts.platform } : {}),
    ...(opts.gateway ? { gatewayOAuth: opts.gateway.oauth, gatewaySandbox: opts.gateway.sandbox, conversationTainted: opts.gateway.conversationTainted } : {}),
    ...(opts.gateway?.listTools ? { gatewayListTools: opts.gateway.listTools } : {}),
    bot: () => port,
    wmuxDir: () => WMUX_DIR,
    botDefaultBranch: async (root) => {
      defaultBranchReads.push({ root, startedBefore: start.mock.calls.length });
      return defaultBranchNote;
    },
  });
  const handler = handlers.get('task.fanout.start') as Handler;
  return {
    call: async (params, ctx) => (await handler(params, ctx)) as Record<string, unknown>,
    start,
    port,
    defaultBranchReads,
    setDefaultBranchNote: (n) => {
      defaultBranchNote = n;
    },
    approve: () => {
      if (releaseApproval) releaseApproval();
      else holdApproval = true;
    },
    setWake: (id) => {
      wake = id;
    },
    setThread: (t) => {
      thread = t;
    },
    setOpen: (o) => {
      open = o;
    },
    setLiveTasks: (n) => {
      liveTasks = n;
    },
    setTainted: (t) => {
      tainted = t;
    },
    setGuestSourced: (g) => {
      guestSourced = g;
    },
    flush: async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

const errorOf = (res: Record<string, unknown>): { code: string; message: string } => {
  expect(res.ok).toBe(false);
  return res.error as { code: string; message: string };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('task.fanout.start — bot origin', () => {
  it('a wake that carried outside text marks its tasks tainted; a clean one does not', async () => {
    const r = rig('lead');
    r.setTainted(true);
    expect(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
    await r.flush();
    expect((r.start.mock.calls[0][0] as FanOutRequest).caller).toEqual({ kind: 'bot', botId: BOT_ID, tainted: true, guest: false });
    r.setTainted(false);
    r.setWake('w-2');
    expect(await r.call({ idempotencyKey: 'wake:w-2:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
    await r.flush();
    expect((r.start.mock.calls[1][0] as FanOutRequest).caller).toEqual({ kind: 'bot', botId: BOT_ID, tainted: false, guest: false });
  });

  it('a guest-sourced wake (or one of unknown provenance) starts no workers', async () => {
    const r = rig('lead');
    r.setGuestSourced(true);
    const refused = errorOf(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead')));
    expect(refused).toMatchObject({ code: 'FAILED_PRECONDITION' });
    expect(refused.message).toContain('external guest');
    await r.flush();
    expect(r.start).not.toHaveBeenCalled();
    expect(r.port.full).toHaveLength(0);
    r.setGuestSourced(false);
    r.setWake('w-2');
    expect(await r.call({ idempotencyKey: 'wake:w-2:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
  });

  it('a connection\'s key is refused as a plain secretNames entry, before anything starts', async () => {
    const secrets = new SecretStore({
      file: nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp2-fanout-conn-')), 'secrets.json'),
      crypto: { state: () => 'ok', encrypt: (p) => Buffer.from(p), decrypt: (c) => c.toString() },
    });
    secrets.load();
    expect(secrets.set('GH_MCP_TOKEN', 'ghp_connection_value_123', { connectorId: 'con-00000001' }).ok).toBe(true);
    expect(secrets.set('NPM_TOKEN', 'npm_plain_value_123456').ok).toBe(true);
    setSecretStore(secrets);
    setSecretGrantSource(() => secrets);
    try {
      const r = rig('lead');
      const refused = errorOf(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], prompt: 'x', preset: 'repro', secretNames: ['NPM_TOKEN', 'GH_MCP_TOKEN'] }, botCtx('lead')));
      expect(refused.code).toBe('INVALID_ARGUMENT');
      expect(refused.message).toContain('GH_MCP_TOKEN');
      expect(r.start).not.toHaveBeenCalled();
      expect(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], prompt: 'x', preset: 'repro', secretNames: ['NPM_TOKEN'] }, botCtx('lead'))).toMatchObject({ ok: true });
    } finally {
      setSecretGrantSource(null);
      setSecretStore(null);
    }
  });

  describe('connections', () => {
    function library(dir: string): ConnectorStore {
      const lib = new ConnectorStore(nodePath.join(dir, 'connectors.json'), { botIds: () => new Set([BOT_ID]) });
      lib.load();
      const base = { transport: 'http' as const, remote: { url: 'https://x.dev/mcp', headers: {} }, secrets: [], tools: { mode: 'all' as const, blocked: [] }, enabled: true };
      lib.save({ ...base, name: 'shared', scope: { kind: 'all' } });
      lib.save({ ...base, name: 'mine', scope: { kind: 'bots', botIds: [BOT_ID] } });
      lib.save({ ...base, name: 'keyed', scope: { kind: 'all' }, secrets: [{ secret: 'KEYED_MCP_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }] });
      const off = lib.save({ ...base, name: 'turned-off', scope: { kind: 'all' } });
      if (off.ok) lib.setOffForBot(off.connector.id, BOT_ID, true);
      return lib;
    }
    const call = (r: Rig, connectors: unknown, ctx = botCtx('lead')) =>
      r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], prompt: 'x', preset: 'repro', connectors }, ctx);

    it('a bot names connections from its own set: the request carries the records and the task is tainted, even from a clean wake', async () => {
      const lib = library(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp2-conn-')));
      const r = rig('lead', {}, { connectors: () => lib, platform: 'darwin' });
      r.setTainted(false);
      expect(await call(r, ['shared', 'mine'])).toMatchObject({ ok: true });
      await r.flush();
      const req = r.start.mock.calls[0][0] as FanOutRequest;
      expect(req.connectors?.map((c) => c.name)).toEqual(['shared', 'mine']);
      expect(req.caller).toEqual({ kind: 'bot', botId: BOT_ID, tainted: true, guest: false });
      await lib.flush();
    });

    it('refuses a name outside its set, one switched off for it, a missing key, a pane caller, Windows and a worker other than claude or codex', async () => {
      const lib = library(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp2-conn-')));
      const r = rig('lead', {}, { connectors: () => lib, platform: 'darwin' });
      expect(errorOf(await call(r, ['nope'])).message).toMatch(/not one of your connections: nope/);
      expect(errorOf(await call(r, ['turned-off'])).message).toMatch(/not one of your connections: turned-off/);
      expect(errorOf(await call(r, ['Bad_Name'])).code).toBe('INVALID_ARGUMENT');
      expect(errorOf(await call(r, ['keyed'])).code).toBe('FAILED_PRECONDITION');
      const brain = await r.call({ idempotencyKey: 'k', titles: ['x'], connectors: ['shared'] }, { origin: 'local', commanderWorkspace: 'ws-hq' } as RpcContext);
      expect(errorOf(brain).message).toMatch(/connectors only from a factory bot/);
      const win = rig('lead', {}, { connectors: () => lib, platform: 'win32' });
      expect(errorOf(await call(win, ['shared'])).message).toMatch(/Windows/);
      const gemini = rig('lead', {}, { connectors: () => lib, platform: 'darwin', presets: [{ name: 'repro', items: [{ agent: 'gemini' }], worktree: true }] });
      expect(errorOf(await call(gemini, ['shared'])).message).toMatch(/claude and codex workers only/);
      expect(r.start).not.toHaveBeenCalled();
      expect(gemini.start).not.toHaveBeenCalled();
      await lib.flush();
    });

    it('a signed-in connection: research only, alone, from a clean wake and conversation, with tools the service marks read-only', async () => {
      const lib = library(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp2-conn-')));
      const saved = lib.save({ transport: 'http', remote: { url: 'https://mcp.notion.example/mcp', headers: {} }, secrets: [], tools: { mode: 'listed', allowed: ['read_page'] }, enabled: true, name: 'notion', scope: { kind: 'all' } });
      if (!saved.ok) throw new Error('not saved');
      let token: string | undefined = 'vendor-token';
      const oauth: GatewayOAuth = {
        hasRecord: (id) => id === saved.connector.id,
        accessToken: async () => token,
        revision: () => 0,
        awaitingConsent: () => false,
        onRevision: () => () => undefined,
      };
      let sandbox: { ok: true } | { ok: false; reason: string } = { ok: true };
      let conversationTainted = false;
      let listed: ConnectorCheckResult = { status: 'ready', toolCount: 2, toolNames: ['read_page', 'delete_page'], readOnlyToolNames: ['read_page'], checkedAt: 1 };
      const listHeaders: Array<Record<string, string>> = [];
      const r = rig('lead', {}, {
        builtinPresets: true, connectors: () => lib, platform: 'darwin',
        gateway: {
          oauth: () => oauth, sandbox: async () => sandbox, conversationTainted: () => conversationTainted,
          listTools: async (_c, headers) => {
            listHeaders.push(headers);
            return listed;
          },
        },
      });
      r.setTainted(false);
      let n = 0;
      const ask = (preset: string, connectors: string[] = ['notion']) =>
        r.call({ idempotencyKey: `wake:w-1:${++n}`, titles: ['read the page'], prompt: 'read it', preset, connectors }, botCtx('lead'));
      // Code presets never carry one.
      expect(errorOf(await ask('repro')).message).toMatch(/preset "research"/);
      // From a clean wake and conversation: accepted.
      expect(await ask('research')).toMatchObject({ ok: true });
      await r.flush();
      expect(r.start.mock.calls[0][0] as FanOutRequest).toMatchObject({ gatewayConnectors: ['notion'] });
      // The service's tool list was read with the owner's token, in main.
      expect(listHeaders[0]).toEqual({ Authorization: 'Bearer vendor-token' });
      // Never beside another connection.
      expect(errorOf(await ask('research', ['notion', 'shared'])).message).toMatch(/only signed-in connections; start shared/);
      // Outside text in the conversation, or a wake that started from it: none.
      conversationTainted = true;
      expect(errorOf(await ask('research')).message).toMatch(/conversation has taken in outside text/);
      conversationTainted = false;
      r.setTainted(true);
      expect(errorOf(await ask('research')).message).toMatch(/outside text/);
      r.setTainted(false);
      // A picked tool the service does not mark read-only, or no list now.
      listed = { status: 'ready', toolCount: 1, toolNames: ['read_page'], readOnlyToolNames: [], checkedAt: 1 };
      expect(errorOf(await ask('research')).message).toMatch(/does not mark these read-only: read_page/);
      listed = { status: 'timeout' };
      expect(errorOf(await ask('research')).message).toMatch(/could not be listed now \(timeout\)/);
      listed = { status: 'ready', toolCount: 1, toolNames: ['read_page'], readOnlyToolNames: ['read_page'], checkedAt: 1 };
      // Not signed in now, or no command sandbox: nothing starts.
      token = undefined;
      expect(errorOf(await ask('research')).message).toMatch(/sign in again/);
      token = 'vendor-token';
      sandbox = { ok: false, reason: 'macOS sandbox-exec is missing' };
      expect(errorOf(await ask('research')).message).toMatch(/command sandbox/);
      sandbox = { ok: true };
      // A connection with no sign-in keeps today's direct path.
      expect(await ask('research', ['shared'])).toMatchObject({ ok: true });
      await r.flush();
      expect(r.start.mock.calls[1][0] as FanOutRequest).not.toHaveProperty('gatewayConnectors');
      expect(r.start).toHaveBeenCalledTimes(2);
      // On Windows, nothing.
      const win = rig('lead', {}, { builtinPresets: true, connectors: () => lib, platform: 'win32', gateway: { oauth: () => oauth, sandbox: async () => sandbox, conversationTainted: () => false } });
      expect(errorOf(await win.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], prompt: 'x', preset: 'research', connectors: ['notion'] }, botCtx('lead'))).message).toMatch(/Windows/);
      await lib.flush();
    });

    it('a codex worker takes connections, but not an SSE one (codexConnectorRefusal)', async () => {
      const lib = library(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp2-conn-')));
      const remote = { remote: { url: 'https://x.dev/mcp', headers: {} }, tools: { mode: 'all' as const, blocked: [] }, enabled: true, scope: { kind: 'all' as const } };
      lib.save({ ...remote, name: 'streamed', transport: 'sse', secrets: [] });
      const codex = rig('lead', {}, { connectors: () => lib, platform: 'darwin', presets: [{ name: 'repro', items: [{ agent: 'codex' }], worktree: true }] });
      expect(errorOf(await call(codex, ['streamed'])).message).toMatch(/do not connect to SSE servers/);
      expect(codex.start).not.toHaveBeenCalled();
      expect(await call(codex, ['shared'])).toMatchObject({ ok: true });
      await codex.flush();
      expect((codex.start.mock.calls[0][0] as FanOutRequest).connectors?.map((c) => c.name)).toEqual(['shared']);
      await lib.flush();
    });
  });

  it('records the handoff the asking wake delivers on its tasks', async () => {
    const r = rig('lead');
    expect(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
    await r.flush();
    expect((r.start.mock.calls[0][0] as FanOutRequest).handoffId).toBe('h-dispatch');
  });

  it('records the repository its code tasks run in, as the factory spells it', async () => {
    const r = rig('lead');
    expect(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
    await r.flush();
    expect((r.start.mock.calls[0][0] as FanOutRequest).repoKey).toBe('github.com/o/r');
  });

  it('a researcher\'s tasks are tainted even from a clean wake; a developer\'s are not', async () => {
    const researcher = rig('lead', { template: 'researcher' });
    expect(await researcher.call({ idempotencyKey: 'wake:w-1:1', titles: ['look it up'], prompt: 'research', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
    await researcher.flush();
    expect((researcher.start.mock.calls[0][0] as FanOutRequest).caller).toEqual({ kind: 'bot', botId: BOT_ID, tainted: true, guest: false });
    const developer = rig('lead', { template: 'developer' });
    expect(await developer.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
    await developer.flush();
    expect((developer.start.mock.calls[0][0] as FanOutRequest).caller).toEqual({ kind: 'bot', botId: BOT_ID, tainted: false, guest: false });
  });

  it('reads the bot repository\'s default branch for the workers\' push rules before anything starts', async () => {
    const r = rig('lead');
    expect(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
    await r.flush();
    expect(r.defaultBranchReads).toEqual([{ root: REPO, startedBefore: 0 }]);
    expect(r.start).toHaveBeenCalledTimes(1);
  });

  it('a default branch read but not kept from the workers launches nothing; an unread one falls back to main/master', async () => {
    const r = rig('lead');
    r.setDefaultBranchNote({ name: 'odd name', recorded: false });
    const refused = await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'));
    expect(JSON.stringify(refused)).toContain('cannot be kept from its workers');
    expect(r.start).not.toHaveBeenCalled();
    r.setDefaultBranchNote({ name: null, recorded: false });
    r.setWake('w-2');
    expect(await r.call({ idempotencyKey: 'wake:w-2:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
    await r.flush();
    expect(r.start).toHaveBeenCalledTimes(1);
  });

  it('a held request and its queued wake retire only once a retry launched a worker: a refusal or a failed launch keeps them', async () => {
    const held = new HeldFanouts({ budget: () => ({ maxConcurrentWorkers: 2 }), openWorkers: () => ({ bot: 2, factory: 2 }), wakes: () => null });
    setHeldFanouts(held);
    const queue = new WakeQueue(wakeQueuePath(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp2-held-wake-'))));
    queue.load();
    setWakeQueue(queue);
    try {
      const params = { titles: ['fix it'], prompt: 'fix', preset: 'repro' };
      held.hold({ botId: BOT_ID, workspaceId: 'ws-bot', args: params, threadId: 'general', handoffId: 'h-dispatch', tainted: false });
      const wake = queue.enqueue({
        botId: BOT_ID, workspaceId: 'ws-bot', priority: 1, threadId: 'general',
        reason: { kind: 'held_fanout', heldId: 'held-q', heldAt: 1, titles: ['fix it'], args: params, fingerprint: heldFanoutFingerprint(params), tainted: false, handoffId: 'h-dispatch' },
      });
      const kept = (): void => {
        expect(held.list(BOT_ID)).toHaveLength(1);
        expect(queue.get(wake?.id ?? '')?.state).toBe('queued');
      };
      const r = rig('lead');
      // Refused at the default-branch check: nothing launched.
      r.setDefaultBranchNote({ name: 'odd name', recorded: false });
      expect(JSON.stringify(await r.call({ idempotencyKey: 'wake:w-1:1', ...params }, botCtx('lead')))).toContain('cannot be kept from its workers');
      await r.flush();
      kept();
      // Started, but its agent never came up: no worker launched.
      r.setDefaultBranchNote({ name: null, recorded: false });
      r.start.mockImplementationOnce(async (req: FanOutRequest) => ({
        ok: true,
        tasks: req.titles.map((title, index) => ({ index, title, ok: false, taskId: `task-${index}`, workspaceId: `ws-task-${index}`, launchFailed: true })),
      }));
      r.setWake('w-2');
      expect(await r.call({ idempotencyKey: 'wake:w-2:1', ...params }, botCtx('lead'))).toMatchObject({ ok: true });
      await r.flush();
      kept();
      // A worker launched: the hold and its queued wake retire.
      r.setWake('w-3');
      expect(await r.call({ idempotencyKey: 'wake:w-3:1', ...params }, botCtx('lead'))).toMatchObject({ ok: true });
      await r.flush();
      expect(held.list(BOT_ID)).toEqual([]);
      expect(queue.get(wake?.id ?? '')?.state).toBe('dropped');
    } finally {
      setHeldFanouts(null);
      setWakeQueue(null);
      await queue.flush();
    }
  });

  it('a held fan-out\'s wake that reserves its workers hands its slot to the booking; another wake\'s reserve does not', async () => {
    const held = new HeldFanouts({ budget: () => ({ maxConcurrentWorkers: 2 }), openWorkers: () => ({ bot: 0, factory: 0 }), wakes: () => null });
    const reserved = vi.spyOn(held, 'reserved');
    setHeldFanouts(held);
    const queue = new WakeQueue(wakeQueuePath(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp2-held-reserve-'))));
    queue.load();
    setWakeQueue(queue);
    try {
      const params = { titles: ['fix it'], prompt: 'fix', preset: 'repro' };
      const r = rig('lead');
      r.setDefaultBranchNote({ name: null, recorded: false });
      // An owner's message: its reserve is no held wake's.
      const human = queue.enqueue({ botId: BOT_ID, workspaceId: 'ws-bot', priority: 0, reason: { kind: 'human', text: 'go', source: 'desktop' } });
      queue.start(human?.id ?? '');
      r.setWake(human?.id ?? null);
      expect(await r.call({ idempotencyKey: `wake:${human?.id}:1`, ...params }, botCtx('lead'))).toMatchObject({ ok: true });
      await r.flush();
      queue.finish(human?.id ?? '');
      expect(reserved).not.toHaveBeenCalled();
      // The held wake's turn reserves: its slot is the booking's now.
      const wake = queue.enqueue({
        botId: BOT_ID, workspaceId: 'ws-bot', priority: 1, threadId: 'general',
        reason: { kind: 'held_fanout', heldId: 'held-r', heldAt: 1, titles: ['fix it'], args: params, fingerprint: heldFanoutFingerprint(params), tainted: false, handoffId: 'h-dispatch' },
      });
      queue.start(wake?.id ?? '');
      r.setWake(wake?.id ?? null);
      expect(await r.call({ idempotencyKey: `wake:${wake?.id}:1`, ...params }, botCtx('lead'))).toMatchObject({ ok: true });
      await r.flush();
      expect(reserved.mock.calls).toEqual([[wake?.id]]);
    } finally {
      setHeldFanouts(null);
      setWakeQueue(null);
      await queue.flush();
    }
  });

  it('only the internal workflow port stamps binding/base and retains the existing wake gates', async () => {
    const r = rig('maintainer', {}, { builtinPresets: true });
    const workflow = { id: 'wf-' + 'a'.repeat(24), step: 1 };
    const params = { idempotencyKey: 'wake:w-1:1', titles: ['step'], prompt: 'implement', preset: 'default', workflow, workflowBaseSha: SHA };
    expect((await r.call(params, botCtx('maintainer'))).ok).toBe(true);
    await r.flush();
    expect(r.start.mock.calls[0][0]).not.toHaveProperty('workflow');
    expect(r.start.mock.calls[0][0]).not.toHaveProperty('workflowBaseSha');
    const binding = { ...workflow, baseSha: SHA, repoKey: 'o/r', tainted: true, onStartFailed: vi.fn() };
    expect(await getWorkflowFanout()!({ ...params, idempotencyKey: 'wake:w-1:2' }, botCtx('maintainer'), { ...binding, repoKey: 'other/repo' })).toMatchObject({ ok: false });
    expect(await getWorkflowFanout()!({ ...params, idempotencyKey: 'wake:old:1' }, botCtx('maintainer'), binding)).toMatchObject({ ok: false });
    expect(await getWorkflowFanout()!({ ...params, idempotencyKey: 'wake:w-1:2' }, botCtx('maintainer'), binding)).toMatchObject({ ok: true });
    await r.flush();
    expect(r.start.mock.calls[1][0]).toMatchObject({ workflow, workflowBaseSha: SHA, caller: { tainted: true } });
  });

  it.each(['awaiting approval', 'completed'])('an ordinary fan-out key cannot poll as an accepted workflow while %s', async (phase) => {
    const r = rig('maintainer', {}, { builtinPresets: true });
    if (phase === 'awaiting approval') r.approve();
    const params = { idempotencyKey: 'wake:w-1:1', titles: ['ordinary'], preset: 'default' };
    expect(await r.call(params, botCtx('maintainer'))).toMatchObject({ ok: true, status: 'accepted' });
    if (phase === 'completed') await r.flush();
    const binding = { id: 'wf-' + 'a'.repeat(24), step: 0, repoKey: 'o/r', tainted: false, onStartFailed: vi.fn() };
    expect(await getWorkflowFanout()!(params, botCtx('maintainer'), binding)).toMatchObject({ ok: false });
    if (phase === 'awaiting approval') { r.approve(); await r.flush(); }
    expect(r.start).toHaveBeenCalledTimes(1);
    expect(r.start.mock.calls[0][0]).not.toHaveProperty('workflow');
  });

  it('blocks an accepted workflow when its owner stops during approval without launching a worker', async () => {
    const r = rig('maintainer', {}, { builtinPresets: true });
    r.approve();
    const failed = vi.fn();
    const binding = { id: 'wf-' + 'a'.repeat(24), step: 0, repoKey: 'o/r', tainted: false, onStartFailed: failed };
    expect(await getWorkflowFanout()!({ idempotencyKey: 'wake:w-1:1', titles: ['step'], preset: 'default' }, botCtx('maintainer'), binding)).toMatchObject({ ok: true });
    r.port.refusal = 'the owner stopped this bot'; r.approve(); await r.flush();
    expect(r.start).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledWith('the owner stopped this bot');
  });

  it('refuses a workflow at capacity without holding an unbound retry', async () => {
    const r = rig('maintainer', { budget: { ...DEFAULT_BOT_BUDGETS.maintainer, maxConcurrentWorkers: 1 } }, { builtinPresets: true });
    r.setOpen({ bot: 1, factory: 1 });
    const binding = { id: 'wf-' + 'a'.repeat(24), step: 1, repoKey: 'o/r', baseSha: SHA, tainted: true, onStartFailed: vi.fn() };
    const result = await getWorkflowFanout()!({ idempotencyKey: 'wake:w-1:1', titles: ['step'], preset: 'default' }, botCtx('maintainer'), binding);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('holds this fan-out');
    expect(r.port.full).toHaveLength(1);
    expect(r.port.full[0].request).toBeUndefined();
    expect(r.start).not.toHaveBeenCalled();
    expect(r.port.seen.size).toBe(0);
  });

  it('a workflow launch does not retire an ordinary held fan-out with the same wire arguments', async () => {
    const held = new HeldFanouts({ budget: () => ({ maxConcurrentWorkers: 1 }), openWorkers: () => ({ bot: 1, factory: 1 }), wakes: () => null });
    setHeldFanouts(held);
    try {
      const params = { titles: ['step'], prompt: 'implement', preset: 'default' };
      held.hold({ botId: BOT_ID, workspaceId: 'ws-bot', args: params, threadId: 'general', handoffId: 'h-dispatch', tainted: false });
      const r = rig('maintainer', {}, { builtinPresets: true });
      const binding = { id: 'wf-' + 'a'.repeat(24), step: 0, repoKey: 'o/r', tainted: false, onStartFailed: vi.fn() };
      expect(await getWorkflowFanout()!({ ...params, idempotencyKey: 'wake:w-1:1' }, botCtx('maintainer'), binding)).toMatchObject({ ok: true });
      await r.flush();
      expect(r.start).toHaveBeenCalledTimes(1);
      expect(held.list(BOT_ID)).toHaveLength(1);
    } finally {
      setHeldFanouts(null);
    }
  });

  it('verify preset at a detached SHA: repo from the profile, bot origin, preset and checkout on the request', async () => {
    const r = rig('verifier');
    const res = await r.call(
      { idempotencyKey: 'wake:w-1:1', titles: ['verify #12'], prompt: 'gate it', preset: 'verify', checkout: { sha: SHA, fetchRef: 'pull/12/head' } },
      botCtx('verifier'),
    );
    expect(res).toMatchObject({ ok: true, status: 'accepted', repoPath: REPO, ownerWorkspaceId: 'ws-bot' });
    await r.flush();
    const req = r.start.mock.calls[0][0] as FanOutRequest;
    expect(req).toMatchObject({
      repoPath: REPO,
      verifiedWorkspaceId: 'ws-bot',
      caller: { kind: 'bot', botId: BOT_ID },
      preset: 'verify',
      checkout: { sha: SHA, detached: true, fetchRef: 'pull/12/head' },
    });
    expect(req.idempotencyKey).toBe(`ws-bot::bot::${BOT_ID}::wake:w-1:1`);
    // No pane anchor: the only renderer call is the approval gate.
    expect(vi.mocked(sendToRenderer).mock.calls.map((c) => c[1])).toEqual(['fanout.requestApproval']);
    expect(r.port.started).toEqual([['task-0']]);
  });

  it('records the running wake\'s thread on the request, read from main\'s wake state', async () => {
    const r = rig('verifier');
    r.setThread('pr:Acme/App#12');
    expect((await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['verify'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'))).status)
      .toBe('accepted');
    await r.flush();
    // The canonical spelling: one PR is one thread however it was written.
    expect((r.start.mock.calls[0][0] as FanOutRequest).threadId).toBe('pr:github.com/acme/app#12');
  });

  it('records no thread for a wake in general or with none, nor for General named', async () => {
    const cases: Array<[string | null, string | undefined]> = [['general', undefined], [null, undefined], ['not a thread', undefined], ['pr:o/r#12', 'general']];
    for (const [t, named] of cases) {
      const r = rig('verifier');
      r.setThread(t);
      const res = await r.call(
        { idempotencyKey: 'wake:w-1:1', titles: ['verify'], preset: 'verify', checkout: { sha: SHA }, ...(named ? { threadId: named } : {}) },
        botCtx('verifier'),
      );
      expect(res.status).toBe('accepted');
      await r.flush();
      expect(r.start.mock.calls[0][0] as FanOutRequest).not.toHaveProperty('threadId');
    }
  });

  it('records the thread the bot names over its wake\'s: a wake about one PR starting the next', async () => {
    for (const [named, recorded] of [['pr:o/r#31', 'pr:github.com/o/r#31'], [`dm:${BOT_ID}`, `dm:${BOT_ID}`]] as const) {
      const r = rig('verifier');
      r.setThread('pr:o/r#12');
      const res = await r.call(
        { idempotencyKey: 'wake:w-1:1', titles: ['verify #31'], preset: 'verify', checkout: { sha: SHA }, threadId: named },
        botCtx('verifier'),
      );
      expect(res.status).toBe('accepted');
      await r.flush();
      expect((r.start.mock.calls[0][0] as FanOutRequest).threadId).toBe(recorded);
    }
  });

  it('refuses a thread the bot may not post in, or one that is no thread, before anything starts', async () => {
    for (const named of ['dm:bot-99999999', 'group:grp-0a1b2c3d', 'not a thread']) {
      const r = rig('verifier');
      r.setThread('pr:o/r#12');
      const res = await r.call(
        { idempotencyKey: 'wake:w-1:1', titles: ['verify'], preset: 'verify', checkout: { sha: SHA }, threadId: named },
        botCtx('verifier'),
      );
      expect(errorOf(res)).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('thread') });
      await r.flush();
      expect(r.start).not.toHaveBeenCalled();
    }
  });

  it('takes a group chat the bot is in, and another bot\'s 1:1 only from the wake running in it', async () => {
    const OTHER_DM = 'dm:bot-99999999';
    let wakeThread: string | null = null;
    setFactoryRoomPorts(() => ({
      currentWakeThread: () => wakeThread as ThreadId | null,
      groups: { byThread: (_ws, t) => (t === 'group:grp-0a1b2c3d' ? { memberIds: [BOT_ID] } : t === 'group:grp-0b0b0b0b' ? { memberIds: ['bot-99999999'] } : null) as BotGroup | null },
    }));
    try {
      const attempt = async (named: string): Promise<Record<string, unknown>> =>
        rig('verifier').call({ idempotencyKey: 'wake:w-1:1', titles: ['verify'], preset: 'verify', checkout: { sha: SHA }, threadId: named }, botCtx('verifier'));
      expect((await attempt('group:grp-0a1b2c3d')).status).toBe('accepted');
      expect(errorOf(await attempt('group:grp-0b0b0b0b')).code).toBe('INVALID_ARGUMENT');
      expect(errorOf(await attempt(OTHER_DM)).code).toBe('INVALID_ARGUMENT');
      wakeThread = OTHER_DM;
      expect((await attempt(OTHER_DM)).status).toBe('accepted');
    } finally {
      setFactoryRoomPorts(() => null);
    }
  });

  it('with no thread named, records the PR its tasks check out (pull/<n>/head) over a subject wake\'s, not over a conversation\'s', async () => {
    const cases: Array<[string | null, string]> = [
      ['pr:o/r#12', 'pr:github.com/o/r#31'],
      [null, 'pr:github.com/o/r#31'],
      ['handoff:h-x', 'handoff:h-x'],
      [`dm:${BOT_ID}`, `dm:${BOT_ID}`],
    ];
    for (const [wakeThread, recorded] of cases) {
      const r = rig('verifier');
      r.setThread(wakeThread);
      const res = await r.call(
        { idempotencyKey: 'wake:w-1:1', titles: ['verify #31'], preset: 'verify', checkout: { sha: SHA, fetchRef: 'pull/31/head' } },
        botCtx('verifier'),
      );
      expect(res.status).toBe('accepted');
      await r.flush();
      expect((r.start.mock.calls[0][0] as FanOutRequest).threadId).toBe(recorded);
    }
  });

  it('records the handoff the task\'s subject belongs to (HandoffRouter.taskHandoff), not always the wake\'s', async () => {
    const PR31 = 'pr:github.com/o/r#31';
    const cases: Array<[string | null, Record<string, unknown>, Record<string, unknown>]> = [
      // A wake about PR #12 starting the worker for #31: its subject is #31's thread and PR.
      ['pr:o/r#12', { checkout: { sha: SHA, fetchRef: 'pull/31/head' } }, { threadId: PR31, pr: { number: 31, threadId: PR31 } }],
      // A handoff's own thread stays the task's, but the PR it checks out is still its subject.
      ['handoff:h-x', { checkout: { sha: SHA, fetchRef: 'pull/31/head' } }, { pr: { number: 31, threadId: PR31 } }],
      // A named PR thread names the PR too.
      ['pr:o/r#12', { checkout: { sha: SHA }, threadId: 'pr:o/r#31' }, { threadId: PR31, pr: { number: 31, threadId: PR31 } }],
      ['handoff:h-x', { checkout: { sha: SHA }, threadId: 'handoff:h-y' }, { threadId: 'handoff:h-y' }],
      ['pr:o/r#12', { checkout: { sha: SHA } }, {}],
      // General names no subject; the PR checked out still is one.
      ['pr:o/r#12', { checkout: { sha: SHA, fetchRef: 'pull/31/head' }, threadId: 'general' }, { pr: { number: 31, threadId: PR31 } }],
    ];
    for (const [wakeThread, extra, subject] of cases) {
      for (const answer of ['h-31', null]) {
        const r = rig('verifier');
        r.setThread(wakeThread);
        const taskHandoff = vi.fn(() => answer);
        r.port.taskHandoff = taskHandoff;
        expect((await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['verify'], preset: 'verify', ...extra }, botCtx('verifier'))).status).toBe('accepted');
        await r.flush();
        expect(taskHandoff).toHaveBeenCalledWith({ workspaceId: 'ws-bot', botId: BOT_ID }, subject, 'h-dispatch');
        const req = r.start.mock.calls[0][0] as FanOutRequest;
        if (answer) expect(req.handoffId).toBe(answer);
        else expect(req).not.toHaveProperty('handoffId');
      }
    }
  });

  it('the same wake key twice polls the first fan-out; a retried turn cannot start a second', async () => {
    const r = rig('verifier');
    const params = { idempotencyKey: 'wake:w-1:1', titles: ['verify'], preset: 'verify', checkout: { sha: SHA } };
    expect((await r.call(params, botCtx('verifier'))).status).toBe('accepted');
    await r.flush();
    expect((await r.call(params, botCtx('verifier'))).status).toBe('completed');
    expect(r.start).toHaveBeenCalledTimes(1);
  });

  it('refuses a key that is not the running wake\'s, and any fan-out between wakes', async () => {
    const r = rig('verifier');
    const base = { titles: ['verify'], preset: 'verify', checkout: { sha: SHA } };
    expect(errorOf(await r.call({ ...base, idempotencyKey: 'fanout-1' }, botCtx('verifier'))).code).toBe('INVALID_ARGUMENT');
    expect(errorOf(await r.call({ ...base, idempotencyKey: 'wake:w-other:1' }, botCtx('verifier'))).code).toBe('INVALID_ARGUMENT');
    expect(errorOf(await r.call({ ...base, idempotencyKey: 'wake:w-1:99' }, botCtx('verifier'))).code).toBe('INVALID_ARGUMENT');
    r.setWake(null);
    expect(errorOf(await r.call({ ...base, idempotencyKey: 'wake:w-1:1' }, botCtx('verifier'))).code).toBe('FAILED_PRECONDITION');
    expect(r.start).not.toHaveBeenCalled();
  });

  it('refuses a preset that is no bot preset, a missing preset, and worktree:false; any bot may use every bot preset', async () => {
    const v = rig('verifier');
    expect(errorOf(await v.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'wizard' }, botCtx('verifier'))).code).toMatch(/NOT_AUTHORIZED|INVALID_ARGUMENT/);
    expect(errorOf(await v.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'] }, botCtx('verifier'))).code).toBe('NOT_AUTHORIZED');
    const lead = rig('lead');
    const res = errorOf(await lead.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'default' }, botCtx('lead')));
    expect(res).toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(res.message).toMatch(/worktree/);
    expect(v.start).not.toHaveBeenCalled();
    const moa = rig('moa');
    expect((await moa.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('moa'))).status).toBe('accepted');
  });

  it('checkout: bot + verify only, and a well-formed sha / fetchRef', async () => {
    const triage = rig('triage');
    expect(errorOf(await triage.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'repro', checkout: { sha: SHA } }, botCtx('triage'))).code)
      .toBe('INVALID_ARGUMENT');
    const v = rig('verifier');
    expect(errorOf(await v.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: 'abc' } }, botCtx('verifier'))).code)
      .toBe('INVALID_ARGUMENT');
    expect(errorOf(await v.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA, fetchRef: '+refs/heads/main:refs/heads/x' } }, botCtx('verifier'))).code)
      .toBe('INVALID_ARGUMENT');
    // A pane caller may not name a checkout at all.
    const pane = await v.call({ idempotencyKey: 'k', senderPtyId: 'pty-1', titles: ['x'], checkout: { sha: SHA } }, { origin: 'local' });
    expect(pane.ok).toBe(false);
  });

  it('checkout.fetchRef is the review head ref of the bot\'s host: pull/<n>/head on GitHub, merge-requests/<n>/head on GitLab', () => {
    const GL = 'gitlab.example.com/group/proj';
    expect(parseCheckout({ sha: SHA, fetchRef: 'merge-requests/12/head' }, GL)).toEqual({ sha: SHA, detached: true, fetchRef: 'merge-requests/12/head' });
    expect(parseCheckout({ sha: SHA, fetchRef: 'pull/12/head' }, 'github.com/o/r')).toEqual({ sha: SHA, detached: true, fetchRef: 'pull/12/head' });
    // The other host's ref style, and an unknown host, are refused.
    expect(parseCheckout({ sha: SHA, fetchRef: 'pull/12/head' }, GL)).toEqual({ error: expect.stringMatching(/merge-requests\/<number>\/head/) });
    expect(parseCheckout({ sha: SHA, fetchRef: 'merge-requests/12/head' }, 'github.com/o/r')).toEqual({ error: expect.stringMatching(/pull\/<number>\/head/) });
    expect(parseCheckout({ sha: SHA, fetchRef: 'merge-requests/12/head' })).toHaveProperty('error');
    for (const bad of ['merge-requests/0/head', 'merge-requests/12/merge', 'merge-requests/12/head:x', 'refs/merge-requests/12/head', 'merge-requests/1234567890/head', '+merge-requests/12/head']) {
      expect(parseCheckout({ sha: SHA, fetchRef: bad }, GL)).toHaveProperty('error');
    }
    expect(parseCheckout({ sha: SHA }, GL)).toEqual({ sha: SHA, detached: true });
  });

  it('a full worker slot (the bot\'s or the factory\'s) is reported as workers_full and held, not as an exhausted budget', async () => {
    const r = rig('verifier'); // maxConcurrentWorkers 1
    r.setOpen({ bot: 1, factory: 1 });
    const own = errorOf(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier')));
    expect(own.code).toBe('RESOURCE_EXHAUSTED');
    expect(own.message).toMatch(/not a budget limit/);
    expect(own.message).toMatch(/wakes you/);
    r.setOpen({ bot: 0, factory: 3 });
    expect(errorOf(await r.call({ idempotencyKey: 'wake:w-1:2', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'))).code).toBe('RESOURCE_EXHAUSTED');
    expect(r.port.exhausted).toEqual([]);
    expect(r.port.full.map(({ scope, running, limit }) => ({ scope, running, limit }))).toEqual([
      { scope: 'bot', running: 1, limit: 1 },
      { scope: 'factory', running: 3, limit: 3 },
    ]);
    // The request is held as the bot's tool arguments, with the wake's handoff.
    expect(r.port.full[0].request).toMatchObject({
      args: { titles: ['x'], preset: 'verify', checkout: { sha: SHA } },
      tainted: false,
      handoffId: 'h-dispatch',
    });
    expect(r.start).not.toHaveBeenCalled();
  });

  it('the wmux-wide live cap full of the owner\'s fan-outs holds the bot\'s request too, instead of a refusal that loses it', async () => {
    const r = rig('verifier');
    r.setLiveTasks(FANOUT_LIVE_TASK_CAP);
    const e = errorOf(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier')));
    expect(e.code).toBe('RESOURCE_EXHAUSTED');
    expect(e.message).toMatch(/all 8 tasks that can run at once across wmux are in use \(8 of 8/);
    expect(e.message).toMatch(/wakes you/);
    expect(r.port.full.map(({ scope, running, limit }) => ({ scope, running, limit }))).toEqual([{ scope: 'wmux', running: 8, limit: 8 }]);
    expect(r.port.full[0].request).toMatchObject({ args: { titles: ['x'], preset: 'verify' } });
    expect(r.start).not.toHaveBeenCalled();
    // One live slot frees: the same request starts.
    r.setLiveTasks(FANOUT_LIVE_TASK_CAP - 1);
    expect((await r.call({ idempotencyKey: 'wake:w-1:2', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'))).ok).toBe(true);
  });

  it('more tasks than the bot\'s slots hold: a batch-size refusal, reported as workers_full only while its slots are all in use', async () => {
    const r = rig('lead', { budget: { ...DEFAULT_BOT_BUDGETS.lead, maxConcurrentWorkers: 1 } }, { builtinPresets: true });
    const two = { titles: ['x', 'y'], prompt: 'build it', preset: 'default' };
    expect(errorOf(await r.call({ idempotencyKey: 'wake:w-1:1', ...two }, botCtx('lead'))).message).toMatch(/start at most 1 task per fan-out/);
    expect(r.port.full).toEqual([]);
    r.setOpen({ bot: 1, factory: 1 });
    expect(errorOf(await r.call({ idempotencyKey: 'wake:w-1:2', ...two }, botCtx('lead'))).message).toMatch(/start at most 1 task per fan-out/);
    expect(r.port.full).toEqual([{ scope: 'bot', running: 1, limit: 1 }]);
    expect(r.port.exhausted).toEqual([]);
  });

  it('worker hours used up stay a budget refusal, and nothing is held', async () => {
    const r = rig('verifier', { budget: { ...DEFAULT_BOT_BUDGETS.verifier, maxWorkerHoursPerDay: 0 } });
    expect(errorOf(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'))).code).toBe('RESOURCE_EXHAUSTED');
    expect(r.port.exhausted).toEqual(['worker_hours_day']);
    expect(r.port.full).toEqual([]);
  });

  it('reads the workers\' panes fresh before the factory-wide cap check (#2255)', async () => {
    const r = rig('verifier');
    // The last check saw three live workers; two have paused since.
    r.setOpen({ bot: 0, factory: 3 });
    r.port.refreshLiveness = async () => {
      r.setOpen({ bot: 0, factory: 1 });
    };
    const res = await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'));
    expect(res.status).toBe('accepted');
    expect(r.port.exhausted).toEqual([]);
  });

  it('a poll of a known key answers without waiting on the panes read (#2255)', async () => {
    const r = rig('verifier');
    const params = { idempotencyKey: 'wake:w-1:1', titles: ['verify'], preset: 'verify', checkout: { sha: SHA } };
    expect((await r.call(params, botCtx('verifier'))).status).toBe('accepted');
    await r.flush();
    const refresh = vi.fn(() => new Promise<void>(() => undefined));
    r.port.refreshLiveness = refresh;
    expect((await r.call(params, botCtx('verifier'))).status).toBe('completed');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a panes read that hangs delays a new fan-out by the bounded wait only (#2255)', async () => {
    const r = rig('verifier');
    r.port.refreshLiveness = () => new Promise<void>(() => undefined);
    const at = Date.now();
    const res = await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'));
    expect(res.status).toBe('accepted');
    expect(Date.now() - at).toBeLessThan(5_000);
  });

  it('a second concurrent start counts the first one still being started', async () => {
    const r = rig('verifier');
    const first = r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'));
    const second = r.call({ idempotencyKey: 'wake:w-1:2', titles: ['y'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'));
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe('accepted');
    expect(errorOf(b).code).toBe('RESOURCE_EXHAUSTED');
  });

  it('a bot without a repository cannot fan out', async () => {
    const r = rig('verifier', { repo: undefined });
    expect(errorOf(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'))).code).toBe('FAILED_PRECONDITION');
  });

  it('refuses roles/agents instead of a preset, and dependsOn', async () => {
    const lead = rig('lead');
    expect(errorOf(await lead.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], agents: [{ agent: 'codex' }] }, botCtx('lead'))).code).toBe('NOT_AUTHORIZED');
    expect(errorOf(await lead.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], roles: ['Builder'] }, botCtx('lead'))).code).toBe('NOT_AUTHORIZED');
    const v = rig('verifier');
    expect(errorOf(await v.call({ idempotencyKey: 'wake:w-1:1', titles: ['a', 'b'], preset: 'verify', dependsOn: [[], [0]] }, botCtx('verifier'))).code)
      .toBe('INVALID_ARGUMENT');
    expect(lead.start).not.toHaveBeenCalled();
  });

  it('a key accepted before a restart answers "already ran" and starts nothing; accepted keys are recorded', async () => {
    const r = rig('verifier');
    r.port.seen.add(`ws-bot::bot::${BOT_ID}::wake:w-1:1`);
    const res = await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'));
    expect(res).toMatchObject({ ok: false, status: 'expired' });
    expect(r.start).not.toHaveBeenCalled();
    await r.call({ idempotencyKey: 'wake:w-1:2', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'));
    expect(r.port.seen.has(`ws-bot::bot::${BOT_ID}::wake:w-1:2`)).toBe(true);
  });

  it('a bot disabled or its wake interrupted while the approval was up launches nothing', async () => {
    const r = rig('verifier');
    r.approve(); // hold the approval
    const res = await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'));
    expect(res.status).toBe('accepted');
    r.port.refusal = 'the bot was removed or disabled';
    await r.flush();
    r.approve(); // answer it
    await r.flush();
    expect(r.start).not.toHaveBeenCalled();
    expect(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'))).toMatchObject({ status: 'denied' });
  });

  it('the factory switched off refuses a new fan-out at the call, and a pending one at its launch', async () => {
    const r = rig('verifier');
    r.port.refusal = 'the agent factory is off';
    const res = await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'));
    expect(res).toMatchObject({ ok: false, error: { code: 'FAILED_PRECONDITION', message: expect.stringContaining('the agent factory is off') } });
    expect(r.start).not.toHaveBeenCalled();
    // Accepted while on, switched off while its approval was up.
    r.port.refusal = null;
    r.approve();
    expect((await r.call({ idempotencyKey: 'wake:w-1:2', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'))).status).toBe('accepted');
    r.port.refusal = 'the agent factory is off';
    await r.flush();
    r.approve();
    await r.flush();
    expect(r.start).not.toHaveBeenCalled();
  });

  it('the service asks the bot port again right before each worker spawns', async () => {
    const r = rig('verifier');
    await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier'));
    await r.flush();
    const req = r.start.mock.calls[0][0] as FanOutRequest;
    expect(req.mayLaunch?.()).toBeNull();
    r.port.refusal = 'the agent factory is off';
    expect(req.mayLaunch?.()).toBe('the agent factory is off');
  });

  it('botLaunchRefusal: off refuses whatever the bot and wake say; on, the bot and the wake decide', () => {
    const on: Pick<BotProfile, 'enabled' | 'parked'> = { enabled: true };
    expect(botLaunchRefusal(false, on, 'running')).toBe('the agent factory is off');
    expect(botLaunchRefusal(true, on, 'running')).toBeNull();
    expect(botLaunchRefusal(true, on, 'done')).toBeNull();
    expect(botLaunchRefusal(true, null, 'running')).toMatch(/removed or disabled/);
    expect(botLaunchRefusal(true, { enabled: true, parked: { reason: 'human', at: 1 } }, 'running')).toMatch(/parked/);
    expect(botLaunchRefusal(true, on, 'interrupted')).toMatch(/interrupted/);
    expect(botLaunchRefusal(true, on, null)).toMatch(/gone/);
  });

  describe('built-in role presets (worktask/botFanoutPresets.ts)', () => {
    it('a bot resolves its role preset from the built-ins, never the operator presets', async () => {
      const r = rig('verifier', {}, { builtinPresets: true });
      const res = await r.call(
        { idempotencyKey: 'wake:w-1:1', titles: ['verify #12'], prompt: 'PR #12 at this head', preset: 'verify', checkout: { sha: SHA } },
        botCtx('verifier'),
      );
      expect(res.status).toBe('accepted');
      await r.flush();
      const req = r.start.mock.calls[0][0] as FanOutRequest;
      // The preset's worker prompt goes first, the bot's own after it.
      expect(req.prompt.startsWith('# Verify worker')).toBe(true);
      expect(req.prompt).toContain(SHA);
      expect(req.prompt.endsWith('PR #12 at this head')).toBe(true);
      // Unattended whatever the operator's fan-out setting ('auto' in the rig).
      expect(req.workerPermissionMode).toBe('bypassPermissions');
      expect(req.agents).toEqual([{ agent: 'claude' }]);
      expect(req.preset).toBe('verify');
    });

    it('the lead\'s default preset is a worktree preset (an operator "default" never applies to a bot)', async () => {
      const lead = rig('lead', {}, { builtinPresets: true });
      const res = await lead.call({ idempotencyKey: 'wake:w-1:1', titles: ['a', 'b'], prompt: 'build it', preset: 'default' }, botCtx('lead'));
      expect(res.status).toBe('accepted');
      await lead.flush();
      const req = lead.start.mock.calls[0][0] as FanOutRequest;
      expect(req.worktree).toBeUndefined();
      expect(req.prompt.startsWith('# Task worker')).toBe(true);
      expect(req.checkout).toBeUndefined();
    });

    it('a bot without a repository runs a research task in a scratch folder under its own data folder', async () => {
      const r = rig('lead', { repo: undefined, template: 'researcher' }, { builtinPresets: true });
      const res = await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['who else does this'], prompt: 'compare the competitors', preset: 'research' }, botCtx('lead'));
      expect(res.status).toBe('accepted');
      await r.flush();
      const req = r.start.mock.calls[0][0] as FanOutRequest;
      const root = nodePath.join(WMUX_DIR, 'factory', 'bots', BOT_ID, 'research');
      expect(req).toMatchObject({ worktree: false, outputRoot: root, repoPath: root, preset: 'research' });
      expect(req.prompt.startsWith('# Research worker')).toBe(true);
      expect(req.prompt.endsWith('compare the competitors')).toBe(true);
      // No repository: no default branch to read, no git at all.
      expect(r.defaultBranchReads).toEqual([]);
      expect(git).not.toHaveBeenCalled();
    });

    it('every preset that changes code still needs the repository, and says research does not', async () => {
      const r = rig('lead', { repo: undefined }, { builtinPresets: true });
      for (const preset of ['default', 'repro', 'maintain']) {
        const err = errorOf(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], prompt: 'p', preset }, botCtx('lead')));
        expect(err.code).toBe('FAILED_PRECONDITION');
        expect(err.message).toMatch(/no repository[\s\S]*preset "research"/);
      }
      expect(r.start).not.toHaveBeenCalled();
    });

    it('a research task is tainted even from a clean wake (its worker reads the web)', async () => {
      const r = rig('lead', {}, { builtinPresets: true });
      r.setTainted(false);
      expect((await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['q'], prompt: 'q', preset: 'research' }, botCtx('lead'))).status).toBe('accepted');
      await r.flush();
      expect((r.start.mock.calls[0][0] as FanOutRequest).caller).toEqual({ kind: 'bot', botId: BOT_ID, tainted: true, guest: false });
    });

    it('a bot whose workers run on codex is told research needs claude workers', async () => {
      const r = rig('lead', { repo: undefined, workerAgent: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' } }, { builtinPresets: true });
      const err = errorOf(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['q'], prompt: 'q', preset: 'research' }, botCtx('lead')));
      expect(err.code).toBe('FAILED_PRECONDITION');
      expect(err.message).toMatch(/claude workers only[\s\S]*codex/);
      expect(r.start).not.toHaveBeenCalled();
    });

    it('a bot with a repository runs research outside it too', async () => {
      const r = rig('lead', {}, { builtinPresets: true });
      expect((await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['q'], prompt: 'q', preset: 'research' }, botCtx('lead'))).status).toBe('accepted');
      await r.flush();
      const req = r.start.mock.calls[0][0] as FanOutRequest;
      expect(req.worktree).toBe(false);
      expect(req.repoPath).not.toBe(REPO);
      expect(req.repoKey).toBeUndefined();
      expect(r.defaultBranchReads).toEqual([]);
    });

    it('every task runs on the engine the owner picked for the bot; the preset\'s own engine otherwise', async () => {
      const codex = rig('lead', { workerAgent: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' } }, { builtinPresets: true });
      expect((await codex.call({ idempotencyKey: 'wake:w-1:1', titles: ['a', 'b'], prompt: 'build it', preset: 'default' }, botCtx('lead'))).status).toBe('accepted');
      await codex.flush();
      expect((codex.start.mock.calls[0][0] as FanOutRequest).agents).toEqual([
        { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' },
        { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' },
      ]);
      const plain = rig('lead', {}, { builtinPresets: true });
      expect((await plain.call({ idempotencyKey: 'wake:w-1:1', titles: ['a'], prompt: 'build it', preset: 'default' }, botCtx('lead'))).status).toBe('accepted');
      await plain.flush();
      expect((plain.start.mock.calls[0][0] as FanOutRequest).agents).toEqual([{ agent: 'claude' }]);
      // The bot still cannot name an engine itself.
      expect((await codex.call({ idempotencyKey: 'wake:w-1:2', titles: ['x'], agents: [{ agent: 'claude' }] }, botCtx('lead'))).status).not.toBe('accepted');
    });

    it('a model-only worker pick (the developer template\'s) puts every task on that model; research keeps working on it', async () => {
      const r = rig('lead', { workerAgent: { agent: 'claude', model: 'opus' } }, { builtinPresets: true });
      expect((await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['a', 'b'], prompt: 'build it', preset: 'default' }, botCtx('lead'))).status).toBe('accepted');
      expect((await r.call({ idempotencyKey: 'wake:w-1:2', titles: ['q'], prompt: 'q', preset: 'research' }, botCtx('lead'))).status).toBe('accepted');
      await r.flush();
      expect((r.start.mock.calls[0][0] as FanOutRequest).agents).toEqual([{ agent: 'claude', model: 'opus' }, { agent: 'claude', model: 'opus' }]);
      expect((r.start.mock.calls[1][0] as FanOutRequest).agents).toEqual([{ agent: 'claude', model: 'opus' }]);
    });

    it('verify refuses a fan-out without a checkout; the other presets refuse one', async () => {
      const v = rig('verifier', {}, { builtinPresets: true });
      const err = errorOf(await v.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'verify' }, botCtx('verifier')));
      expect(err.code).toBe('INVALID_ARGUMENT');
      expect(err.message).toMatch(/checkout/);
      const t = rig('triage', {}, { builtinPresets: true });
      expect(errorOf(await t.call({ idempotencyKey: 'wake:w-1:1', titles: ['x'], preset: 'repro', checkout: { sha: SHA } }, botCtx('triage'))).code)
        .toBe('INVALID_ARGUMENT');
      expect(v.start).not.toHaveBeenCalled();
      expect(t.start).not.toHaveBeenCalled();
    });

    it('verify starts one worker per fan-out', async () => {
      const v = rig('verifier', {}, { builtinPresets: true });
      const err = errorOf(await v.call({ idempotencyKey: 'wake:w-1:1', titles: ['a', 'b'], preset: 'verify', checkout: { sha: SHA } }, botCtx('verifier')));
      expect(err.code).toBe('INVALID_ARGUMENT');
    });

    it('a task prompt that no longer fits with the worker prompt is refused', async () => {
      const lead = rig('lead', {}, { builtinPresets: true });
      const big = 'x'.repeat(8 * 1024 - 200);
      const err = errorOf(await lead.call({ idempotencyKey: 'wake:w-1:1', titles: ['a'], prompt: big, preset: 'default' }, botCtx('lead')));
      expect(err.code).toBe('INVALID_ARGUMENT');
      expect(lead.start).not.toHaveBeenCalled();
    });
  });
});

describe('bot worker count (gap 3)', () => {
  const row = (id: string, status: string, over: Record<string, unknown> = {}) =>
    ({ id, status, dispatch: { origin: { kind: 'bot', botId: BOT_ID }, preset: 'verify' }, ...over }) as Parameters<typeof countOpenBotWorkers>[0][number];

  it('a verify task done with its verdict recorded holds no worker slot; every other open bot task does', () => {
    const rows = [
      row('t-verdicted', 'review_requested'),
      row('t-waiting', 'review_requested'),
      row('t-working', 'working'),
      row('t-lead', 'review_requested', { dispatch: { origin: { kind: 'bot', botId: 'bot-other00' }, preset: 'default' } }),
      row('t-human', 'working', { dispatch: { origin: { kind: 'pane' } } }),
    ];
    const asked: string[][] = [];
    const counts = countOpenBotWorkers(rows, BOT_ID, (ids) => {
      asked.push([...ids]);
      return new Set(ids.filter((id) => id === 't-verdicted'));
    });
    // Only review_requested verify rows are looked up.
    expect(asked).toEqual([['t-verdicted', 't-waiting']]);
    expect(counts).toEqual({ bot: 2, factory: 3 });
  });

  it('reads verdicts from verdict.recorded facts, and counts as open when the log cannot be read', () => {
    const facts = [
      { kind: 'verdict.recorded', ref: { taskId: 't-1' } },
      { kind: 'task.done', ref: { taskId: 't-2' } },
    ];
    const log = {
      readWhere: (_after: number, match: (f: unknown) => boolean, limit: number) => ({ facts: facts.filter(match).slice(0, limit), lastSeq: 2 }),
    };
    expect([...verdictedTaskIds(['t-1', 't-2'], log)]).toEqual(['t-1']);
    expect(verdictedTaskIds(['t-1'], null).size).toBe(0);
    expect(verdictedTaskIds(['t-1'], { readWhere: () => { throw new Error('gone'); } }).size).toBe(0);
  });
});

describe('task.fanout.start — a bot hears whether its workers started (A2)', () => {
  it('accepted says "starting"; once the start settles the bot is told per task, in the thread it asked from', async () => {
    const r = rig('lead');
    r.setThread('general');
    const res = await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'));
    expect(res).toMatchObject({ ok: true, status: 'accepted', starting: true, note: BOT_FANOUT_STARTING_NOTE });
    await r.flush();
    expect(r.port.outcomes).toEqual([{
      workspaceId: 'ws-bot', threadId: 'general', key: 'ws-bot::bot::bot-0a1b2c3d::wake:w-1:1', tainted: false,
      tasks: [{ index: 0, title: 'fix it', taskId: 'task-0', started: true }],
    }]);
  });

  it('a task that got no workspace, or a fan-out that failed before its tasks, is told as could not start, in plain words', async () => {
    const r = rig('verifier');
    r.start.mockImplementationOnce(async (req: FanOutRequest) => ({
      ok: false, tasks: [{ index: 0, title: req.titles[0], ok: false, taskId: 'task-0', error: 'worktree add failed: branch already exists' }],
    }));
    await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['verify #1'], prompt: 'v', preset: 'repro' }, botCtx('verifier'));
    await r.flush();
    expect(r.port.outcomes[0].tasks).toEqual([{ index: 0, title: 'verify #1', taskId: 'task-0', started: false, reason: 'its worktree could not be created', detail: 'worktree add failed: branch already exists' }]);
    r.setWake('w-2');
    r.start.mockImplementationOnce(async () => ({ ok: false, error: 'fanout preflight failed: could not fetch pull/1/head', tasks: [] }));
    await r.call({ idempotencyKey: 'wake:w-2:1', titles: ['verify #1'], prompt: 'v', preset: 'repro' }, botCtx('verifier'));
    await r.flush();
    expect(r.port.outcomes[1].tasks).toEqual([{ index: 0, title: 'verify #1', started: false, reason: 'the code it was to check could not be fetched from the repository', detail: 'fanout preflight failed: could not fetch pull/1/head' }]);
  });

  it('a pane whose agent never came up is no started worker', async () => {
    const r = rig('lead');
    r.start.mockImplementationOnce(async (req: FanOutRequest) => ({
      ok: false, tasks: [{ index: 0, title: req.titles[0], ok: false, taskId: 'task-0', workspaceId: 'ws-task-0', launchFailed: true, error: 'the agent did not start in pane p-1' }],
    }));
    await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'));
    await r.flush();
    expect(r.port.outcomes[0].tasks).toEqual([{ index: 0, title: 'fix it', taskId: 'task-0', started: false, reason: 'its pane could not be opened', detail: 'the agent did not start in pane p-1' }]);
  });

  it('a fan-out the approval step stopped is told as could not start', async () => {
    const r = rig('lead');
    vi.mocked(sendToRenderer).mockImplementation(async () => ({ approved: false, outcome: 'declined' }));
    await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'));
    await r.flush();
    expect(r.start).not.toHaveBeenCalled();
    expect(r.port.outcomes[0].tasks).toEqual([{ index: 0, title: 'fix it', started: false, reason: 'the owner declined it' }]);
  });

  it('a bot that may not act now (stopped, parked, off) is not told', async () => {
    const r = rig('lead');
    expect(await r.call({ idempotencyKey: 'wake:w-1:1', titles: ['fix it'], prompt: 'fix', preset: 'repro' }, botCtx('lead'))).toMatchObject({ ok: true });
    r.port.refusal = 'the owner stopped this bot';
    await r.flush();
    expect(r.port.outcomes).toEqual([]);
  });
});

describe('workersHeldNote', () => {
  it('says a worker waiting for a slot has not started', () => {
    expect(workersHeldNote(0, 1, 1)).toBe(': 1 is waiting for an agent slot, not started');
    expect(workersHeldNote(1, 2, 1)).toBe(': 1 of your workers is open, 1 is starting, 1 is waiting for an agent slot, not started');
    expect(workersHeldNote(0, 0, 0)).toBe('');
  });
});
