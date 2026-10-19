// Scenario: a bot asks for a key → the owner submits it in the modal → a
// worker the bot starts has it in its process env → no wmux store, renderer
// payload, bot-facing read or log holds the value.
//
// Real: RoomWriter, FactLog, TaskLedger, FanOutService, the pty:create
// secret stage, DaemonSessionManager (node-pty mocked), RpcRouter with a bot
// token, the secret store (a reversible stand-in for safeStorage) and its
// main-window IPC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ipcHandlers, spawned } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (e: unknown, req: unknown) => Promise<unknown>>(),
  spawned: [] as Array<{ env?: Record<string, string> }>,
}));
vi.mock('electron', () => ({
  safeStorage: {},
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, req: unknown) => Promise<unknown>) => { ipcHandlers.set(ch, fn); },
    removeHandler: (ch: string) => { ipcHandlers.delete(ch); },
  },
}));

vi.mock('node-pty', async () => {
  const { EventEmitter } = await import('node:events');
  class P extends EventEmitter {
    pid = 777;
    constructor(readonly opts: { env?: Record<string, string> }) { super(); spawned.push(opts); }
    onData() { return { dispose: () => undefined }; }
    onExit() { return { dispose: () => undefined }; }
    write() { /* noop */ }
    resize() { /* noop */ }
    kill() { /* noop */ }
  }
  const spawn = (_c: string, _a: string[], opts: { env?: Record<string, string> }) => new P(opts);
  return { default: { spawn }, spawn };
});

import { RoomWriter, type RoomEventPayload } from '../roomWriter';
import { createFactLog } from '../factLog';
import { SecretStore, setSecretStore, getSecretStore, type SecretCrypto } from '../secretStore';
import { setSecretGrantSource, secretEnvForCreate } from '../secretGrants';
import { __resetRedactedSecretsForTesting } from '../secretRedaction';
import { handleSecretRequest, handleSecretList, registerSecretIpc } from '../../pipe/handlers/botSecret.rpc';
import { FanOutService, type FanOutDaemonPort } from '../../worktask/FanOutService';
import type { TaskWorktreeManager, TaskWorktreePlan } from '../../worktask/TaskWorktreeManager';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { setTaskLedgerForTests } from '../../deck/taskLedgerHost';
import { FanOutGuards, setFanOutGuardsForTests } from '../../worktask/fanoutGuards';
import { botWorkerForCreate } from '../../agents/botWorkerMergeGuard';
import { DaemonSessionManager } from '../../../daemon/DaemonSessionManager';
import { RpcRouter } from '../../pipe/RpcRouter';
import { mintBotToken, revokeCommanderToken } from '../../deck/commanderTrust';
import { BOT_SECRET_IPC } from '../../../shared/botSecret';
import type { RpcContext, RpcMethod } from '../../../shared/rpc';
import type { WakeEnqueueInput } from '../wakeQueue';

const VALUE = 'ghp_S3cr3tV4lu3ForTheScenario0123456789';
const BOT = { workspaceId: 'ws-bot', botId: 'bot-0a1b2c3d', role: 'lead' as const };

const crypto: SecretCrypto = {
  state: () => 'ok',
  encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').reverse().toString('hex')}`),
  decrypt: (cipher) => Buffer.from(cipher.toString().slice(4), 'hex').reverse().toString('utf8'),
};

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

const leaks = (text: string): string[] => [VALUE, Buffer.from(VALUE).toString('base64'), encodeURIComponent(VALUE)].filter((f) => text.includes(f));

let root = '';
let logs: string[] = [];
const restore: Array<() => void> = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-w4-scenario-'));
  logs = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    const spy = vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' '));
    });
    restore.push(() => spy.mockRestore());
  }
  __resetRedactedSecretsForTesting();
});

afterEach(() => {
  for (const r of restore.splice(0)) r();
  setSecretGrantSource(null);
  setSecretStore(null);
  setTaskLedgerForTests(null);
  setFanOutGuardsForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bot secret scenario', () => {
  it('request → modal submit → worker env has the key → every wmux store and bot-facing read is clean', async () => {
    const factoryDir = path.join(root, 'factory');
    // ── stores ──
    const rendererPayloads: unknown[] = [];
    const writer = new RoomWriter({ dir: path.join(factoryDir, 'rooms'), emit: (p: RoomEventPayload) => rendererPayloads.push(p) });
    const facts = createFactLog(factoryDir);
    facts.start();
    const ledger = new TaskLedger({ dir: path.join(root, 'ledger'), redact: (await import('../secretRedaction')).redactStoredSecretsDeep });
    setTaskLedgerForTests(ledger);
    setFanOutGuardsForTests(new FanOutGuards({ dir: root, countLiveTasks: () => 0, ledgerTaskOwner: () => null }));
    const store = new SecretStore({ file: path.join(factoryDir, 'secrets.json'), crypto, onChange: () => rendererPayloads.push({ type: 'secrets-changed' }) });
    store.load();
    setSecretStore(store);
    setSecretGrantSource(getSecretStore);
    const wakes: WakeEnqueueInput[] = [];
    const ports = { wakes: { enqueue: (w: WakeEnqueueInput) => { wakes.push(w); return null; } }, factLog: facts };
    const deps = { store: getSecretStore, writer: () => writer, ports: () => ports };
    const botCtx = { origin: 'local', bot: BOT } as unknown as RpcContext;

    // ── 1. the bot asks (a non-credential name is refused first) ──
    expect(handleSecretRequest({ name: 'MY_NAME', label: 'x', why: 'y' }, botCtx, deps)).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(handleSecretRequest({ name: 'GH_TOKEN', label: 'x', why: 'y' }, { origin: 'local' } as RpcContext, deps)).toMatchObject({ ok: false });
    const asked = handleSecretRequest({ name: 'GH_TOKEN', label: 'GitHub token', why: 'to open the release PR' }, botCtx, deps) as { ok: true; cardId: string; stored: boolean };
    expect(asked).toMatchObject({ ok: true, stored: false });
    const card = writer.get('ws-bot', asked.cardId);
    expect(card).toMatchObject({ kind: 'secret_request', state: 'open', refs: { secretName: 'GH_TOKEN' }, actor: { kind: 'bot', botId: BOT.botId } });

    // ── 2. the owner submits the modal (main-window IPC; another sender is refused) ──
    const mainFrame = {};
    const win = { isDestroyed: () => false, webContents: { mainFrame } } as unknown as Electron.BrowserWindow;
    registerSecretIpc(() => win, deps, { github: async () => false, claude: async () => false });
    const set = ipcHandlers.get(BOT_SECRET_IPC.set)!;
    const req = { name: 'GH_TOKEN', value: VALUE, workspaceId: 'ws-bot', cardId: asked.cardId };
    expect(await set({ sender: {}, senderFrame: mainFrame }, req)).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(store.has('GH_TOKEN')).toBe(false);
    const saved = await set({ sender: win.webContents, senderFrame: mainFrame }, req);
    rendererPayloads.push(saved);
    expect(saved).toMatchObject({ ok: true, entry: { name: 'GH_TOKEN' } });
    rendererPayloads.push(await ipcHandlers.get(BOT_SECRET_IPC.list)!({ sender: win.webContents, senderFrame: mainFrame }, {}));
    expect(writer.get('ws-bot', asked.cardId)?.state).toBe('resolved');
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ botId: BOT.botId, priority: 0, reason: { kind: 'human' } });
    const listed = handleSecretList({}, botCtx, deps);
    expect(listed).toMatchObject({ ok: true, secrets: [{ name: 'GH_TOKEN', usable: true }] });

    // ── 3. the bot starts a worker naming the key ──
    const daemonSessions = new DaemonSessionManager();
    let workerEnv: Record<string, string> | undefined;
    let grantSeen: unknown;
    const plan = (slug: string): TaskWorktreePlan => ({
      repoRoot: '/repo', repoHash: 'h', taskSlug: slug,
      worktreePath: path.join(root, 'wt', slug), branch: `wtask/${slug}`, metaDir: path.join(root, 'meta', slug),
    });
    let seq = 0;
    const daemon: FanOutDaemonPort = {
      rpc: async (method: string) => {
        if (method === 'task.mission.start') {
          seq++;
          return { ok: true, taskId: `wtask-t-${seq}0000000`, channelId: `ch-${seq}` };
        }
        return { ok: true };
      },
    };
    const svc = new FanOutService({
      daemon,
      // The renderer's spawn → pty.create → main's pty:create stage → daemon.
      renderer: {
        spawnWorkspace: async (p) => {
          grantSeen = p.secretGrant;
          const options = { workspaceId: 'ws-task-1', cwd: p.cwd, fanoutTaskOf: p.fanoutTaskOf, secretGrant: p.secretGrant, initialCommand: p.initialCommand };
          const secretEnv = secretEnvForCreate(options, botWorkerForCreate(options));
          daemonSessions.createSession({ id: 'daemon-task1', cmd: '/bin/bash', cwd: os.tmpdir(), env: { PATH: '/usr/bin' }, ...(secretEnv ? { secretEnv } : {}) });
          workerEnv = spawned.at(-1)?.env;
          return { workspaceId: 'ws-task-1', ptyId: 'daemon-task1' };
        },
      },
      worktrees: {
        preflight: async (_r: string, _t: string, taskId: string) => ({ ok: true as const, plan: plan(taskId.slice(-8)) }),
        createWorktree: async (p: TaskWorktreePlan) => ({ ok: true as const, worktreePath: p.worktreePath, branch: p.branch }),
        resolveBase: async () => ({ oid: 'c'.repeat(40), ref: 'refs/remotes/origin/main' }),
        removeWorktree: async () => ({ ok: true as const }),
      } as unknown as TaskWorktreeManager,
      wiringRetryDelaysMs: [0, 0],
    });
    const res = await svc.start({
      idempotencyKey: 'ws-bot::bot::bot-0a1b2c3d::wake:w-1:1',
      prompt: 'cut the release',
      titles: ['release'],
      repoPath: '/repo',
      agentCmd: 'claude',
      verifiedWorkspaceId: 'ws-bot',
      caller: { kind: 'bot', botId: BOT.botId },
      preset: 'default',
      secretNames: ['GH_TOKEN'],
    });
    expect(res.ok).toBe(true);
    expect(typeof grantSeen).toBe('string');
    expect(String(grantSeen)).not.toContain(VALUE);
    expect(workerEnv?.GH_TOKEN).toBe(VALUE);
    expect(store.list()[0].lastUsed?.botId).toBe(BOT.botId);

    // ── 4. the value turns up in what the worker and the owner write ──
    const row = ledger.list({ ownerWorkspaceId: 'ws-bot' })[0];
    const updated = await ledger.update({ id: row.id, status: 'review_requested', actor: { kind: 'worker', workspaceId: row.taskWorkspaceId }, expectedRev: row.rev, summary: `pushed with token ${VALUE}` });
    expect(updated).toMatchObject({ ok: true, entry: { summary: 'pushed with token [secret:GH_TOKEN]' } });
    await ledger.flush();
    expect(facts.append({ kind: 'task.done', at: Date.now(), workspaceId: 'ws-bot', ref: { taskId: row.id }, payload: { summary: `used ${VALUE}` } })?.payload).toEqual({ summary: 'used [secret:GH_TOKEN]' });
    facts.append({ kind: 'human.message', at: Date.now(), workspaceId: 'ws-bot', ref: { botId: BOT.botId, messageId: `m-${VALUE}` }, payload: { [VALUE]: true } });
    const pasted = writer.post({ workspaceId: 'ws-bot', kind: 'human', actor: { kind: 'human' }, title: `here it is ${VALUE}`, body: Buffer.from(VALUE).toString('base64'), refs: { label: VALUE } });
    expect(pasted).toMatchObject({ ok: true, card: { title: 'here it is [secret:GH_TOKEN]', body: '[secret:GH_TOKEN]' } });

    // ── 5. the bot reads the worker's screen through its token ──
    const router = new RpcRouter();
    router.register('input.readScreen' as RpcMethod, async () => ({ ptyId: 'daemon-task1', text: `$ echo $GH_TOKEN\r\n${VALUE.slice(0, 20)}\r\n${VALUE.slice(20)}\r\n$ ` }));
    router.setEnforcementMode('shadow');
    const token = mintBotToken(BOT);
    let screen: unknown;
    try {
      screen = await router.dispatch({ id: 'r1', method: 'input.readScreen' as RpcMethod, params: {}, commanderToken: token }, { externalWire: true });
    } finally {
      revokeCommanderToken(token);
    }
    expect(screen).toMatchObject({ ok: true });
    expect(JSON.stringify(screen)).toContain('[secret:GH_TOKEN]');
    // A tail read whose window starts on the value's second row.
    router.register('input.readScreen' as RpcMethod, async () => ({ ptyId: 'daemon-task1', text: `${VALUE.slice(20)}\r\n$ ` }));
    const tailToken = mintBotToken(BOT);
    let tail: unknown;
    try {
      tail = await router.dispatch({ id: 'r2', method: 'input.readScreen' as RpcMethod, params: {}, commanderToken: tailToken }, { externalWire: true });
    } finally {
      revokeCommanderToken(tailToken);
    }
    expect(tail).toMatchObject({ ok: true, result: { text: '[secret:GH_TOKEN]\r\n$ ' } });

    // ── 6. grep: nothing holds the value ──
    facts.dispose();
    expect(leaks(JSON.stringify(screen))).toEqual([]);
    expect(leaks(JSON.stringify(daemonSessions.listSessions()))).toEqual([]); // = sessions.json (buildState)
    expect(leaks(JSON.stringify(rendererPayloads))).toEqual([]);
    expect(leaks(JSON.stringify(wakes))).toEqual([]);
    expect(leaks(JSON.stringify(ledger.list({})))).toEqual([]);
    expect(leaks(JSON.stringify(writer.read('ws-bot', {}).cards))).toEqual([]);
    for (const f of allFiles(root)) expect({ file: path.relative(root, f), leaks: leaks(fs.readFileSync(f, 'utf8')) }).toEqual({ file: path.relative(root, f), leaks: [] });
    expect(leaks(logs.join('\n'))).toEqual([]);
    daemonSessions.disposeAll();
  });
});
