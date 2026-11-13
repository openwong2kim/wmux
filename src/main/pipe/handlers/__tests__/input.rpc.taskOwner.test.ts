// Fan-out T5 — a fan-out owner reads (and, guarded, types at) the panes of its
// OPEN task workspaces. Dispatched through the real RpcRouter so the identity
// under test is the one main derives (a validated commander token, or the
// workspace main resolves `callerPtyId` to), never `params.workspaceId`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc, taskPaneTextRefusal, taskStateOfRows } from '../input.rpc';
import { PENDING_TEXT_MAX, type PendingTaskState } from '../pendingDeliveries';
import { beginDeliverySend } from '../deliverySenders';
import { deliberateSleep } from '../../../../test-utils/waitFor';
import { mintCommanderToken, __resetCommanderTrustForTesting } from '../../../deck/commanderTrust';
import type { PTYManager } from '../../../pty/PTYManager';
import type { TaskLedger } from '../../../../daemon/ledger/TaskLedger';
import type { RpcContext } from '../../../../shared/rpc';
import type { FanoutOwnerAnswers } from '../../../../shared/workerLaunch';
import type { FolderTrustState } from '../../../../daemon/folderTrustState';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;

/** pty-owner lives in ws-owner (the caller); pty-task in ws-task (its worker). */
const PANE_OWNERS: Record<string, string> = {
  'pty-owner': 'ws-owner',
  'pty-task': 'ws-task',
  'pty-stranger': 'ws-stranger',
};

interface Entry {
  ownerWorkspaceId: string;
  taskWorkspaceId: string;
  status: string;
}

const OPEN = new Set(['working', 'input_required', 'review_requested']);

function ledgerOf(entries: Entry[]): TaskLedger {
  return {
    list: (f: { ownerWorkspaceId?: string; taskWorkspaceId?: string; openOnly?: boolean } = {}) =>
      entries.filter(
        (e) =>
          (f.ownerWorkspaceId === undefined || e.ownerWorkspaceId === f.ownerWorkspaceId) &&
          (f.taskWorkspaceId === undefined || e.taskWorkspaceId === f.taskWorkspaceId) &&
          (!f.openOnly || OPEN.has(e.status)),
      ),
  } as unknown as TaskLedger;
}

interface Wiring {
  router: RpcRouter;
  writes: Array<{ ptyId: string; data: string }>;
  logs: string[];
  notices: string[];
  deliveryGate: (ptyId: string) => Promise<unknown>;
  gatedSubmit: ReturnType<typeof registerInputRpc>['gatedSubmit'];
  retryPendingDeliveries: ReturnType<typeof registerInputRpc>['retryPendingDeliveries'];
  agentEnded: ReturnType<typeof registerInputRpc>['agentEnded'];
  /** Change what the harness answers between a refusal and a retry. */
  live: WireOpts;
  /** Move the virtual clock (with `virtualClock`). */
  advance: (ms: number) => void;
  /** The virtual clock now. */
  now: () => number;
}

interface WireOpts {
  entries?: Entry[];
  pending?: unknown[];
  ledgerThrows?: boolean;
  /** The owner setting in force (default all, as with no policy file). */
  ownerAnswers?: FanoutOwnerAnswers;
  /** What the task pane shows (default: plain worker output); `parked`: a
   *  hidden pane, read from its ring. */
  screen?: string | null | { parked: string };
  /** What the task pane shows on each read in turn, the last one after. */
  screens?: Array<string | null>;
  /** Whether the task pane is held at its usage limit. */
  usageLimited?: boolean;
  /** The daemon's folder-trust verdict, asked when no screen was read. */
  daemonTrust?: FolderTrustState | { state: FolderTrustState; reason?: string; dialog?: true } | null;
  /** The daemon's agent name for the task pane (default Claude Code). */
  agent?: string | null;
  /** The daemon's A2A task rows, read by a delivery's owner lane. */
  tasks?: unknown[];
  /** Whether wmux's own launch record proves the pane trust-clear. */
  trustProvenClear?: boolean;
  /** The daemon's channel messages: the author workspace of each "channel:seq". */
  mentionAuthors?: Record<string, string>;
  /** The daemon's agent state for the task pane (default: Claude Code, session inc-1, quiet). */
  agentSession?: string;
  /** The daemon reads no agent in the task pane: it is back at a shell. */
  atShell?: boolean;
  /** The time and `source` of the pane agent's last session-start hook (none by default). */
  sessionStartAt?: number;
  sessionStartSource?: string;
  /** A stored delivery's task state on each read in turn, before `tasks`
   *  decides; `hang` never answers. */
  taskStates?: Array<PendingTaskState | 'hang'>;
  /** Awaited inside every delivery sleep (the paste-to-Enter gap among them). */
  sleepGate?: () => Promise<void>;
  /** The pane holds a typed draft. */
  draft?: boolean;
  /** Time and sleeps on a virtual clock. */
  virtualClock?: boolean;
}

function wire(initial: WireOpts = {}): Wiring {
  // Read on each call, so a test may change it between a refusal and a retry.
  const opts: WireOpts = { ...initial };
  let clock = 1_000_000;
  const logs: string[] = [];
  const notices: string[] = [];
  const writes: Array<{ ptyId: string; data: string }> = [];
  const dc = {
    isConnected: true,
    rpc: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'daemon.approvals.list') return { pending: opts.pending ?? [] };
      if (method === 'a2a.channel.getMessages') {
        const author = opts.mentionAuthors?.[`${String(params['channelId'])}:${String(params['sinceSeq'])}`];
        return { ok: true, messages: author ? [{ seq: params['sinceSeq'], workspaceId: author }] : [] };
      }
      return {};
    },
    writeToSession: (ptyId: string, data: string) => {
      writes.push({ ptyId, data });
      return true;
    },
    readPromptEvents: async () => ({ events: [{ kind: 'command_end' }], lastCompletedRange: null }),
    getAgentState: async () => ({
      agentName: opts.atShell ? '' : 'Claude Code',
      agentVerified: true,
      agentStatus: 'running',
      inputQuiet: true,
      inputRevision: 0,
      incarnationId: opts.agentSession ?? 'inc-1',
      keyInputRevision: 0,
      keyInputIdleMs: 60_000,
      hasDraft: opts.draft === true,
    }),
  };
  const ledger = ledgerOf(
    opts.entries ?? [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'working' }],
  );
  const router = new RpcRouter();
  const { deliveryGate, gatedSubmit, retryPendingDeliveries, agentEnded } = registerInputRpc(
    router,
    { get: () => undefined } as unknown as PTYManager,
    () => fakeWindow,
    () => dc as never,
    undefined,
    undefined,
    {
      getLedger: () => {
        if (opts.ledgerThrows) throw new Error('ledger unreadable');
        return ledger;
      },
      ownerAnswers: () => opts.ownerAnswers ?? 'all',
      paneAgent: async () => (opts.agent === undefined ? 'claude' : opts.agent),
      ownerLaneNotice: (ws) => notices.push(ws),
      log: (line) => logs.push(line),
      answerPolicy: async () => ({ allowed: false, reason: 'autonomy-off' }),
      daemonFolderTrust: async () => opts.daemonTrust ?? null,
      queryDaemonTasks: async () => opts.tasks ?? [],
      readTaskState: async (_ws: string, taskId: string): Promise<PendingTaskState> => {
        const next = opts.taskStates?.length ? opts.taskStates.shift() : undefined;
        if (next === 'hang') return new Promise<PendingTaskState>(() => undefined);
        return next !== undefined ? next : taskStateOfRows(opts.tasks ?? [], [], taskId);
      },
      readSessionStart: () => (opts.sessionStartAt === undefined
        ? undefined
        : { at: opts.sessionStartAt, agent: 'claude', ...(opts.sessionStartSource ? { source: opts.sessionStartSource } : {}) }),
      trustProvenClear: async () => opts.trustProvenClear ?? false,
      // The gap between a delivery's paste and its Enter.
      sleep: async (ms: number) => {
        if (opts.virtualClock) clock += ms;
        await opts.sleepGate?.();
      },
      ...(opts.virtualClock ? { now: () => clock } : {}),
      // No stop events in these tests: retries are called directly.
      subscribeAgentStops: () => () => undefined,
      usageLimited: () => opts.usageLimited ?? false,
      ...(opts.screen !== undefined || opts.screens
        ? {
          readScreenText: async (ptyId: string) => {
            if (ptyId !== 'pty-task') return 'OWNER SCREEN';
            if (!opts.screens) return opts.screen as string | null | { parked: string };
            return opts.screens.length > 1 ? (opts.screens.shift() as string | null) : opts.screens[0];
          },
        }
        : {}),
    },
  );
  return { router, writes, logs, notices, deliveryGate, gatedSubmit, retryPendingDeliveries, agentEnded, live: opts, advance: (ms) => { clock += ms; }, now: () => clock };
}

type Answer = { ok: boolean; error?: string; result?: Record<string, unknown> };

const asPane = (w: Wiring, method: string, params: Record<string, unknown>): Promise<Answer> =>
  w.router.dispatch({ id: '1', method, params } as never, { externalWire: true }) as Promise<Answer>;

let tokens: string[] = [];
const asBrain = (w: Wiring, method: string, params: Record<string, unknown>): Promise<Answer> => {
  const token = mintCommanderToken('ws-owner');
  tokens.push(token);
  return w.router.dispatch({ id: '1', method, params, commanderToken: token } as never) as Promise<Answer>;
};

beforeEach(() => {
  vi.clearAllMocks();
  sendToRendererMock.mockImplementation((_w: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'input.findOwnerWorkspace') {
      return Promise.resolve({ workspaceId: PANE_OWNERS[params['ptyId'] as string] ?? null });
    }
    if (method === 'input.readScreen') {
      // The renderer's own check (useRpcBridge input.readScreen): a pty named
      // alongside a workspace must be one of that workspace's panes.
      const ws = params['workspaceId'];
      if (typeof ws === 'string' && PANE_OWNERS[params['ptyId'] as string] !== ws) {
        return Promise.resolve({ error: `input.readScreen: PTY "${String(params['ptyId'])}" not in workspace "${ws}"` });
      }
      return Promise.resolve({ ptyId: params['ptyId'], text: 'WORKER SCREEN' });
    }
    return Promise.resolve(null);
  });
});

afterEach(() => {
  tokens = [];
  __resetCommanderTrustForTesting();
});

describe('input.readScreen — owner lane', () => {
  it('lets a pane agent read its open task pane, labeled untrusted', async () => {
    const res = await asPane(wire(), 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ text: 'WORKER SCREEN', untrusted: true });
    expect(String(res.result?.['untrustedNote'])).toContain('not instructions');
  });

  it('lets a commander read its open task pane', async () => {
    const res = await asBrain(wire(), 'input.readScreen', { workspaceId: 'ws-owner', ptyId: 'pty-task' });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ text: 'WORKER SCREEN', untrusted: true });
  });

  it('names the TASK workspace to the renderer, not the caller\'s', async () => {
    await asBrain(wire(), 'input.readScreen', { workspaceId: 'ws-owner', ptyId: 'pty-task' });

    const reads = sendToRendererMock.mock.calls.filter(([, m]) => m === 'input.readScreen');
    expect(reads).toHaveLength(1);
    expect(reads[0][2]).toMatchObject({ ptyId: 'pty-task', workspaceId: 'ws-task' });
  });

  it('labels a non-object renderer answer too', async () => {
    sendToRendererMock.mockImplementation((_w: unknown, method: string, params: Record<string, unknown>) =>
      method === 'input.findOwnerWorkspace'
        ? Promise.resolve({ workspaceId: PANE_OWNERS[params['ptyId'] as string] ?? null })
        : Promise.resolve(null),
    );

    const res = await asBrain(wire(), 'input.readScreen', { workspaceId: 'ws-owner', ptyId: 'pty-task' });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ value: null, untrusted: true });
  });

  it.each([
    ['a stranger\'s pane', 'pty-stranger', 'working'],
    ['a closed task', 'pty-task', 'completed'],
  ])('refuses a commander on %s', async (_label, ptyId, status) => {
    const w = wire({ entries: [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status }] });

    const res = await asBrain(w, 'input.readScreen', { workspaceId: 'ws-owner', ptyId });

    expect(res.ok).toBe(false);
  });

  it('does not label a read of the caller\'s own pane', async () => {
    const res = await asPane(wire(), 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-owner',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(true);
    expect(res.result?.['untrusted']).toBeUndefined();
  });

  it.each(['completed', 'failed', 'cancelled'])('refuses once the task is %s', async (status) => {
    const w = wire({ entries: [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status }] });

    const res = await asPane(w, 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('Cross-workspace terminal access is not allowed');
  });

  it('refuses a task owned by a different workspace', async () => {
    const w = wire({ entries: [{ ownerWorkspaceId: 'ws-stranger', taskWorkspaceId: 'ws-task', status: 'working' }] });

    const res = await asPane(w, 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(false);
  });

  it('never takes identity from params.workspaceId', async () => {
    // No commander token and no callerPtyId: naming the owner workspace is not
    // an identity, so the task pane stays out of reach.
    const res = await asPane(wire(), 'input.readScreen', { workspaceId: 'ws-owner', ptyId: 'pty-task' });

    expect(res.ok).toBe(false);
  });

  it('refuses a plugin-hosted caller even with a callerPtyId', async () => {
    const w = wire();
    const res = (await w.router.dispatch(
      {
        id: '1',
        method: 'input.readScreen',
        params: { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner' },
      } as never,
      { firstParty: true, hostedWorkspace: 'ws-owner' },
    )) as Answer;

    expect(res.ok).toBe(false);
  });

  it('fails closed when the ledger cannot be read', async () => {
    const res = await asPane(wire({ ledgerThrows: true }), 'input.readScreen', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(false);
  });
});

describe('terminal.readEvents — owner lane', () => {
  it('reads a task pane\'s events, labeled untrusted', async () => {
    const res = await asPane(wire(), 'terminal.readEvents', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ ptyId: 'pty-task', untrusted: true });
  });

  it('refuses a stranger\'s pane', async () => {
    const res = await asPane(wire(), 'terminal.readEvents', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-stranger',
      callerPtyId: 'pty-owner',
    });

    expect(res.ok).toBe(false);
  });
});

describe('input.send — owner lane', () => {
  it('writes text to an open task pane', async () => {
    const w = wire();

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
      text: 'status?',
    });

    expect(res.ok).toBe(true);
    expect(w.writes).toEqual([{ ptyId: 'pty-task', data: 'status?' }]);
  });

  it('refuses a pane agent typing at a task pane that holds an approval, under ownerAnswers off', async () => {
    const w = wire({ ownerAnswers: 'off', pending: [{ id: 'ap-1', sessionId: 'pty-task', workspaceId: 'ws-task', toolName: 'Bash' }] });

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
      text: '1',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('refusing to type at an approval prompt');
    expect(w.writes).toHaveLength(0);
  });

  it('refuses a stranger\'s pane', async () => {
    const w = wire();

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-stranger',
      callerPtyId: 'pty-owner',
      text: 'hi',
    });

    expect(res.ok).toBe(false);
    expect(w.writes).toHaveLength(0);
  });
});

describe('input.send — owner lane refuses control bytes and raw writes', () => {
  it.each([
    ['EOT', 'bye\x04'],
    ['ctrl+c byte', '\x03'],
    ['ctrl+z byte', '\x1a'],
    ['an escape sequence', '\x1b[B'],
    ['a carriage return', 'yes\r'],
    ['DEL', 'x\x7f'],
  ])('refuses %s', async (_label, text) => {
    const w = wire();

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-task',
      callerPtyId: 'pty-owner',
      text,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('control characters are not allowed');
    expect(w.writes).toHaveLength(0);
  });

  it('refuses raw:true even for plain text', async () => {
    const w = wire();

    const res = await asBrain(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', text: 'ok', raw: true });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('raw writes are not allowed');
    expect(w.writes).toHaveLength(0);
  });

  it('allows tab and newline', () => {
    expect(taskPaneTextRefusal('a\tb\nc', false)).toBeNull();
  });

  it('leaves the caller\'s own pane alone', async () => {
    const w = wire();

    const res = await asPane(w, 'input.send', {
      workspaceId: 'ws-owner',
      ptyId: 'pty-owner',
      callerPtyId: 'pty-owner',
      text: 'x\x1b[B',
    });

    expect(res.ok).toBe(true);
  });
});

describe('commander lane on send / sendKey', () => {
  it('sends text to its open task pane', async () => {
    const w = wire();

    const res = await asBrain(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', text: 'go on' });

    expect(res.ok).toBe(true);
    expect(w.writes).toEqual([{ ptyId: 'pty-task', data: 'go on' }]);
  });

  it('is refused at an approval prompt under ownerAnswers off, and pointed at approval_press', async () => {
    const w = wire({ ownerAnswers: 'off', pending: [{ id: 'ap-1', sessionId: 'pty-task', workspaceId: 'ws-task', toolName: 'Bash' }] });

    const res = await asBrain(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', text: '1' });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('approval_press({ ptyId: "pty-task"');
    expect(w.writes).toHaveLength(0);
  });

  it('under ownerAnswers off, interrupts with ctrl+c at an approval but may not press enter there', async () => {
    const w = wire({ ownerAnswers: 'off', pending: [{ id: 'ap-1', sessionId: 'pty-task', workspaceId: 'ws-task', toolName: 'Bash' }] });

    expect((await asBrain(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-task', key: 'ctrl+c' })).ok).toBe(true);
    expect((await asBrain(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-task', key: 'enter' })).ok).toBe(false);
    expect(w.writes).toEqual([{ ptyId: 'pty-task', data: '\x03' }]);
  });

  it('refuses a closed task on send', async () => {
    const w = wire({ entries: [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'failed' }] });

    const res = await asBrain(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', text: 'hi' });

    expect(res.ok).toBe(false);
    expect(w.writes).toHaveLength(0);
  });
});

describe('non-local origin', () => {
  // RpcRouter only ever builds 'local' contexts today (the LAN listener is a
  // future transport), so drive the registered handler with a remote context.
  it('gets no owner lane', async () => {
    const handlers = new Map<string, (p: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>>();
    const fakeRouter = { register: (name: string, fn: never) => handlers.set(name, fn) } as unknown as RpcRouter;
    registerInputRpc(fakeRouter, { get: () => undefined } as unknown as PTYManager, () => fakeWindow, () => null, undefined, undefined, {
      getLedger: () => ledgerOf([{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'working' }]),
    });

    const readScreen = handlers.get('input.readScreen');
    expect(readScreen).toBeDefined();
    await expect(
      (readScreen as NonNullable<typeof readScreen>)(
        { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner' },
        { origin: 'remote', commanderWorkspace: 'ws-owner' },
      ),
    ).rejects.toThrow(/Cross-workspace terminal access is not allowed/);
  });
});

describe('input.sendKey — every key on the owner lane', () => {
  it.each([
    ['ctrl+c', '\x03'], ['escape', '\x1b'], ['enter', '\r'], ['down', '\x1b[B'], ['ctrl+d', '\x04'], ['tab', '\t'],
    ['space', ' '], ['backspace', '\x7f'], ['y', 'y'], ['n', 'n'], ['0', '0'], ['3', '3'], ['9', '9'],
  ])('writes %s to a task pane', async (key, bytes) => {
    for (const ownerAnswers of ['all', 'menus', 'off'] as const) {
      const w = wire({ ownerAnswers });

      const res = await asPane(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner', key });

      expect(res.ok, ownerAnswers).toBe(true);
      expect(w.writes).toEqual([{ ptyId: 'pty-task', data: bytes }]);
    }
  });

  it('names the new keys when a key is unknown', async () => {
    const res = await asPane(wire(), 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner', key: 'f13' });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('space, backspace, y, n');
    expect(res.error).toContain('0, 1, 2');
  });
});

// ── The owner setting (ownerAnswers) ────────────────────────────────────────

const fixture = (dir: string, name: string): string =>
  (JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../daemon/approvals/__tests__/fixtures', dir, `${name}.json`), 'utf8')) as { screen: string[] }).screen.join('\n');

/** The selection menu Claude Code shows when a turn stops on its usage limit. */
const LIMIT_MENU = [
  '  ⎿  You\'ve hit your weekly limit · resets 3am',
  '',
  '✻ Worked for 0s',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   What do you want to do?',
  '',
  '   ❯ 1. Stop and wait for limit to reset',
  '     2. Wait here, then continue automatically shortly',
  '     3. Ask your admin for more usage',
  '',
  '   Enter to confirm · Esc to cancel',
].join('\n');

/** Each screen kind, as the pane shows it (or the daemon reads it). */
const QUESTION_RECORD = [{ id: 'ap-q', sessionId: 'pty-task', workspaceId: 'ws-task', kind: 'awaiting_input', question: 'Which?' }];
const ASK_MENU = fixture('terminal-prompts', 'claude-ask-single-01-initial');

const SCREENS: Record<string, Pick<WireOpts, 'screen' | 'daemonTrust' | 'pending' | 'usageLimited'>> = {
  none: { screen: 'WORKER SCREEN' },
  'limit menu': { screen: LIMIT_MENU, usageLimited: true },
  'question menu': { screen: ASK_MENU, pending: QUESTION_RECORD },
  'question record': { screen: 'WORKER SCREEN', pending: QUESTION_RECORD },
  'question menu with no record': { screen: ASK_MENU },
  'limit menu on a pane not held': { screen: LIMIT_MENU },
  'permission under a question record': { screen: fixture('terminal-prompts', 'claude-bash-boxed-01'), pending: QUESTION_RECORD },
  permission: { screen: fixture('terminal-prompts', 'claude-bash-boxed-01') },
  'permission record': { screen: 'WORKER SCREEN', pending: [{ id: 'ap-p', sessionId: 'pty-task', workspaceId: 'ws-task', kind: 'terminal_prompt', toolName: 'Bash' }] },
  plan: { screen: fixture('terminal-prompts', 'claude-plan-01-initial') },
  trust: { screen: fixture('folder-trust', 'claude-folder-trust-60x30') },
  unknown: { screen: null, daemonTrust: 'unknown' },
};

const MENUS = new Set(['none', 'limit menu', 'question menu', 'question record']);

const sendKey = (w: Wiring, key: string): Promise<Answer> =>
  asPane(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner', key });

describe('owner lane — what each setting lets the owner answer', () => {
  const kinds = Object.keys(SCREENS);

  it.each(kinds)('all: every key reaches a pane showing %s', async (kind) => {
    for (const key of ['enter', '2', 'down', 'y', 'escape']) {
      const w = wire({ ownerAnswers: 'all', ...SCREENS[kind] });
      const res = await sendKey(w, key);
      expect(res.ok, `${kind} ${key}: ${res.error}`).toBe(true);
      expect(w.writes).toHaveLength(1);
    }
  });

  it.each(kinds)('menus: a Claude pane showing %s', async (kind) => {
    for (const key of ['enter', '2', 'down']) {
      const w = wire({ ownerAnswers: 'menus', ...SCREENS[kind] });
      const res = await sendKey(w, key);
      expect(res.ok, `${kind} ${key}: ${res.error}`).toBe(MENUS.has(kind));
      expect(w.writes).toHaveLength(MENUS.has(kind) ? 1 : 0);
    }
  });

  it.each(kinds)('off: a pane showing %s gets the gate every other caller gets', async (kind) => {
    const w = wire({ ownerAnswers: 'off', ...SCREENS[kind] });
    const res = await sendKey(w, 'enter');
    expect(res.ok, `${kind}: ${res.error}`).toBe(kind === 'none');
    expect(w.writes).toHaveLength(kind === 'none' ? 1 : 0);
  });

  it('menus: says why, and writes nothing', async () => {
    const w = wire({ ownerAnswers: 'menus', ...SCREENS['permission'] });
    const res = await sendKey(w, '1');
    expect(res.error).toContain('pane "pty-task" is showing a permission prompt');
    expect(res.error).toContain('"ownerAnswers" is "menus"');
    expect(res.error).toContain('Nothing was sent.');
  });

  it('menus: another agent\'s menu is refused, since its dialogs read as menus too', async () => {
    for (const agent of ['codex', null]) {
      const held = wire({ ownerAnswers: 'menus', screen: LIMIT_MENU, usageLimited: true, agent });
      const res = await sendKey(held, 'enter');
      expect(res.ok).toBe(false);
      expect(res.error).toContain("cannot confirm is Claude Code's");
      expect(held.writes).toHaveLength(0);
    }
    const codex = wire({ ownerAnswers: 'menus', screen: fixture('terminal-prompts', 'codex-approval-exec-01'), agent: 'codex' });
    const res = await sendKey(codex, 'enter');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not a question or usage-limit menu');
  });

  it('menus: a pane drawing Claude Code\'s dialogs counts (OpenClaude)', async () => {
    const w = wire({ ownerAnswers: 'menus', ...SCREENS['limit menu'], agent: 'openclaude' });
    expect((await sendKey(w, '1')).ok).toBe(true);
  });

  it('a refusal at a later check of the same write is logged too', async () => {
    // Clear when the gate reads it; a folder-trust prompt by the time the text is written.
    const trust = fixture('folder-trust', 'claude-folder-trust-60x30');
    const w = wire({ ownerAnswers: 'menus', screens: ['WORKER SCREEN', trust] });
    const res = await asPane(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner', text: 'go' });
    expect(res.ok).toBe(false);
    expect(w.writes).toHaveLength(0);
    expect(w.logs.map((l) => l.slice(l.lastIndexOf(';') + 2))).toEqual(['allowed', 'refused']);
  });

  it('menus: ctrl+c still stops a worker at any prompt; escape is refused on a trust prompt', async () => {
    for (const kind of kinds) {
      const w = wire({ ownerAnswers: 'menus', ...SCREENS[kind] });
      expect((await sendKey(w, 'ctrl+c')).ok, kind).toBe(true);
    }
    expect((await sendKey(wire({ ownerAnswers: 'menus', ...SCREENS['trust'] }), 'escape')).ok).toBe(false);
    expect((await sendKey(wire({ ownerAnswers: 'menus', ...SCREENS['permission'] }), 'escape')).ok).toBe(true);
  });

  it('text: written at a prompt under all, refused under menus and off', async () => {
    const send = (ownerAnswers: FanoutOwnerAnswers) => {
      const w = wire({ ownerAnswers, ...SCREENS['permission'] });
      return asPane(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner', text: 'use the other file' })
        .then((res) => ({ res, writes: w.writes }));
    };
    const all = await send('all');
    expect(all.res.ok).toBe(true);
    expect(all.writes).toEqual([{ ptyId: 'pty-task', data: 'use the other file' }]);
    for (const setting of ['menus', 'off'] as const) {
      const r = await send(setting);
      expect(r.res.ok, setting).toBe(false);
      expect(r.writes).toHaveLength(0);
    }
  });

  it('text: a submit under all reaches a folder-trust prompt too', async () => {
    const w = wire({ ownerAnswers: 'all', ...SCREENS['trust'] });
    const res = await asPane(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner', text: '1', submit: true });
    expect(res.ok, res.error).toBe(true);
    expect(w.writes.map((x) => x.data)).toEqual(['1', '\r']);
  });
});

describe('owner lane — who gets it', () => {
  it.each(['all', 'menus', 'off'] as const)('a pane that is not an open task of the caller is refused under %s', async (ownerAnswers) => {
    for (const [ptyId, entries] of [
      ['pty-stranger', undefined],
      ['pty-task', [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'completed' }]],
    ] as const) {
      const w = wire({ ownerAnswers, ...(entries ? { entries: [...entries] } : {}) });
      const res = await asPane(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId, callerPtyId: 'pty-owner', key: 'enter' });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('Cross-workspace terminal access is not allowed');
      expect(w.writes).toHaveLength(0);
      // Only the note saying why there was no lane; no lane write is logged.
      expect(w.logs).toHaveLength(1);
      expect(w.logs[0]).toContain(`input.sendKey from pane "pty-owner": no owner lane for pane "${ptyId}"`);
    }
  });

  it('a task\'s own sub-task is not reachable by the task\'s owner (direct ownership only)', async () => {
    PANE_OWNERS['pty-sub'] = 'ws-sub';
    try {
      const w = wire({ entries: [
        { ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'working' },
        { ownerWorkspaceId: 'ws-task', taskWorkspaceId: 'ws-sub', status: 'working' },
      ] });
      const fromGrandparent = await asPane(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-sub', callerPtyId: 'pty-owner', key: 'enter' });
      expect(fromGrandparent.ok).toBe(false);
      // The worker that started the sub-task drives it.
      const fromParent = await asPane(w, 'input.sendKey', { workspaceId: 'ws-task', ptyId: 'pty-sub', callerPtyId: 'pty-task', key: 'enter' });
      expect(fromParent.ok, fromParent.error).toBe(true);
      expect(w.writes).toEqual([{ ptyId: 'pty-sub', data: '\r' }]);
    } finally {
      delete PANE_OWNERS['pty-sub'];
    }
  });

  it.each([
    ['a remote-origin caller', { origin: 'remote', commanderWorkspace: 'ws-owner' }],
    ['a plugin-hosted caller', { origin: 'local', hostedWorkspace: 'ws-owner' }],
    ['a fenced worker', { origin: 'local', fencedWorker: true }],
  ] as const)('%s gets no owner lane', async (_label, ctx) => {
    const handlers = new Map<string, (p: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>>();
    const fakeRouter = { register: (name: string, fn: never) => handlers.set(name, fn) } as unknown as RpcRouter;
    const writes: string[] = [];
    registerInputRpc(fakeRouter, { get: () => undefined } as unknown as PTYManager, () => fakeWindow,
      () => ({ isConnected: true, rpc: async () => ({ pending: [] }), writeToSession: (_p: string, d: string) => writes.push(d) }) as never,
      undefined, undefined, {
        getLedger: () => ledgerOf([{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'working' }]),
        ownerAnswers: () => 'all',
      });
    const sendKeyHandler = handlers.get('input.sendKey') as NonNullable<ReturnType<typeof handlers.get>>;
    await expect(
      sendKeyHandler({ workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner', key: 'enter' }, ctx as RpcContext),
    ).rejects.toThrow(/Cross-workspace terminal access is not allowed/);
    expect(writes).toEqual([]);
  });
});

describe('owner lane — log line and notice', () => {
  it('logs every lane write, allowed or refused, with the screen and the setting', async () => {
    const w = wire({ ownerAnswers: 'menus', ...SCREENS['limit menu'] });
    await sendKey(w, '2');
    await asPane(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner', text: 'héllo', submit: true });
    const refused = wire({ ownerAnswers: 'menus', ...SCREENS['plan'] });
    await sendKey(refused, 'enter');

    expect(w.logs).toEqual([
      '[owner-lane] pane "pty-owner" (ws "ws-owner") → pane "pty-task" (task ws "ws-task"): key 2; screen menu; setting menus; allowed',
      '[owner-lane] pane "pty-owner" (ws "ws-owner") → pane "pty-task" (task ws "ws-task"): text 6 bytes + enter; screen menu; setting menus; allowed',
    ]);
    expect(refused.logs).toEqual([
      '[owner-lane] pane "pty-owner" (ws "ws-owner") → pane "pty-task" (task ws "ws-task"): key enter; screen plan; setting menus; refused',
    ]);
  });

  it('a stop key is not held up by a screen read', async () => {
    const w = wire({ ownerAnswers: 'menus', ...SCREENS['permission'] });
    await sendKey(w, 'ctrl+c');
    expect(w.logs).toEqual([
      '[owner-lane] pane "pty-owner" (ws "ws-owner") → pane "pty-task" (task ws "ws-task"): key ctrl+c; screen not read; setting menus; allowed',
    ]);
  });

  it('names a commander by its workspace', async () => {
    const w = wire();
    await asBrain(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-task', key: 'enter' });
    expect(w.logs).toEqual([
      '[owner-lane] ws "ws-owner" → pane "pty-task" (task ws "ws-task"): key enter; screen none; setting all; allowed',
    ]);
  });

  it('raises one notice in the task workspace for a run of writes, none for a refusal', async () => {
    const w = wire();
    for (const key of ['down', 'down', 'enter']) await sendKey(w, key);
    expect(w.notices).toEqual(['ws-task']);

    const refused = wire({ ownerAnswers: 'off', ...SCREENS['permission'] });
    await sendKey(refused, 'enter');
    expect(refused.notices).toEqual([]);
  });

  it('writes nothing to the log for a caller on its own pane', async () => {
    const w = wire();
    await asPane(w, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-owner', callerPtyId: 'pty-owner', key: 'enter' });
    expect(w.logs).toEqual([]);
  });
});

describe('owner setting and the automated writers', () => {
  it.each(['all', 'menus', 'off'] as const)('a delivery into a task pane still waits on its prompt under %s', async (ownerAnswers) => {
    for (const kind of ['permission', 'limit menu', 'trust']) {
      const w = wire({ ownerAnswers, ...SCREENS[kind] });
      expect(await w.deliveryGate('pty-task'), `${kind}`).toMatchObject({ ok: false });
    }
  });
});

describe('owner lane — an MCP terminal_send', () => {
  // The params the MCP server's terminal_send builds (src/mcp/index.ts): the
  // route's workspace, the target, its own pane as sender and caller.
  const mcpSend = (callerPtyId?: string): Record<string, unknown> => ({
    text: 'status?',
    workspaceId: 'ws-owner',
    ptyId: 'pty-task',
    ...(callerPtyId ? { senderPtyId: callerPtyId, callerPtyId } : {}),
    submit: true,
    clientTimeoutMs: 25_000,
  });

  it("from the task's owner pane resolves the lane", async () => {
    const w = wire();
    const res = await asPane(w, 'input.send', mcpSend('pty-owner'));
    expect(res.ok, res.error).toBe(true);
    expect(w.writes.map((x) => x.data)).toEqual(['status?', '\r']);
    expect(w.logs).toEqual([
      '[owner-lane] pane "pty-owner" (ws "ws-owner") → pane "pty-task" (task ws "ws-task"): text 7 bytes + enter; screen none; setting all; allowed',
    ]);
  });

  it.each(['working', 'input_required', 'review_requested'])('resolves while the ledger row is %s', async (status) => {
    const w = wire({ entries: [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status }] });
    expect((await asPane(w, 'input.send', mcpSend('pty-owner'))).ok).toBe(true);
  });

  it('logs why a cross-workspace write found no lane', async () => {
    const closed = wire({ entries: [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'completed' }] });
    expect((await asPane(closed, 'input.send', mcpSend('pty-owner'))).ok).toBe(false);
    expect(closed.logs).toEqual([
      '[owner-lane] input.send from pane "pty-owner": no owner lane for pane "pty-task": workspace "ws-owner" owns no open ledger task',
    ]);

    const anonymous = wire();
    expect((await asPane(anonymous, 'input.send', mcpSend())).ok).toBe(false);
    expect(anonymous.logs).toEqual([
      '[owner-lane] input.send from a caller with no pane: no owner lane for pane "pty-task": the call named no caller pane and no commander token',
    ]);

    const stranger = wire();
    const key = await asPane(stranger, 'input.sendKey', { workspaceId: 'ws-owner', ptyId: 'pty-stranger', callerPtyId: 'pty-owner', key: 'enter' });
    expect(key.ok).toBe(false);
    expect(stranger.logs).toEqual([
      '[owner-lane] input.sendKey from pane "pty-owner": no owner lane for pane "pty-stranger": the pane\'s workspace "ws-stranger" is not an open task of workspace "ws-owner"',
    ]);
  });
});

describe('owner lane — the miss line', () => {
  it('is written once a minute for the same refused write', async () => {
    const w = wire();
    const send = () => asPane(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', text: 'x' });
    await send();
    await send();
    expect(w.logs).toHaveLength(1);
  });
});

describe('owner lane — a delivery from the task\'s orchestrator', () => {
  const task = (id: string, from: string, to: string) => ({
    id,
    metadata: { from: { workspaceId: from }, to: { workspaceId: to } },
  });
  // A hidden pane: read from its ring, where the daemon cannot see the cells
  // a dialog would sit on.
  const UNREAD = { screen: { parked: 'WORKER SCREEN' }, daemonTrust: { state: 'unknown' as const, reason: 'unseen-cells' } };

  it('under all, an unreadable folder-trust check is passed over and logged', async () => {
    const w = wire({ ...UNREAD, tasks: [task('t1', 'ws-owner', 'ws-task')] });
    const res = await w.gatedSubmit('pty-task', 'hello', 'claude', { senderTaskIds: ['t1'] });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    expect(w.writes.map((x) => x.data)).toEqual(['\x1b[200~hello\x1b[201~', '\r']);
    expect(w.logs).toEqual([
      '[owner-lane] delivery from ws "ws-owner" → pane "pty-task" (task ws "ws-task"): folder-trust unknown (unseen-cells) passed; setting all',
    ]);
  });

  it('is refused without the task ids, under menus or off, from a stranger, or for tasks of two senders', async () => {
    const cases: Array<[string, WireOpts, string[] | undefined]> = [
      ['no task ids', { ...UNREAD, tasks: [task('t1', 'ws-owner', 'ws-task')] }, undefined],
      ['menus', { ...UNREAD, ownerAnswers: 'menus', tasks: [task('t1', 'ws-owner', 'ws-task')] }, ['t1']],
      ['off', { ...UNREAD, ownerAnswers: 'off', tasks: [task('t1', 'ws-owner', 'ws-task')] }, ['t1']],
      ['stranger', { ...UNREAD, tasks: [task('t1', 'ws-stranger', 'ws-task')] }, ['t1']],
      ['two senders', { ...UNREAD, tasks: [task('t1', 'ws-owner', 'ws-task'), task('t2', 'ws-stranger', 'ws-task')] }, ['t1', 't2']],
      ['unknown task', { ...UNREAD, tasks: [] }, ['t1']],
      ['closed row', { ...UNREAD, entries: [{ ownerWorkspaceId: 'ws-owner', taskWorkspaceId: 'ws-task', status: 'completed' }], tasks: [task('t1', 'ws-owner', 'ws-task')] }, ['t1']],
    ];
    for (const [name, opts, ids] of cases) {
      const w = wire(opts);
      const res = await w.gatedSubmit('pty-task', 'hello', 'claude', ids ? { senderTaskIds: ids } : undefined);
      expect(res, name).toMatchObject({ ok: false, reason: 'gate_unavailable' });
      expect(w.writes, name).toEqual([]);
    }
  });

  it('a folder-trust prompt on screen is still refused, and the refusal says why and who may answer it', async () => {
    const w = wire({ ...SCREENS['trust'], tasks: [task('t1', 'ws-owner', 'ws-task')] });
    const res = await w.gatedSubmit('pty-task', 'hello', 'claude', { senderTaskIds: ['t1'] });
    expect(res).toMatchObject({ ok: false });
    expect(JSON.stringify(res)).toContain('is on a folder-trust prompt, which would take the text and its Enter as its answer');
    expect(JSON.stringify(res)).toContain("when the owner setting is 'all', its task's orchestrator can send the keys there");
    expect(w.writes).toEqual([]);
  });

  it('a trust question read with its choices cut short is not passed, from text or from the daemon', async () => {
    const tasks = [task('t1', 'ws-owner', 'ws-task')];
    for (const opts of [
      { screen: { parked: 'WORKER SCREEN' }, daemonTrust: { state: 'unknown' as const, reason: 'cut-choices' }, tasks },
      { screen: { parked: 'WORKER SCREEN' }, daemonTrust: { state: 'unknown' as const, reason: 'cut-choices' }, tasks, trustProvenClear: true },
    ]) {
      const w = wire(opts);
      expect(await w.gatedSubmit('pty-task', 'hello', 'claude', { senderTaskIds: ['t1'] })).toMatchObject({ ok: false, reason: 'gate_unavailable' });
      expect(w.writes).toEqual([]);
      expect(w.logs.filter((l) => l.startsWith('[owner-lane]'))).toEqual([]);
    }
  });

  it('the launch record never overrides a trust prompt the ring text shows', async () => {
    const w = wire({ screen: { parked: SCREENS['trust'].screen as string }, daemonTrust: null, trustProvenClear: true });
    expect(await w.gatedSubmit('pty-task', 'hello', 'claude')).toMatchObject({ ok: false });
    expect(w.writes).toEqual([]);
  });

  it('passes only an unseen-cells verdict over clear ring text with no other dialog', async () => {
    const tasks = [task('t1', 'ws-owner', 'ws-task')];
    const refused: Array<[string, WireOpts]> = [
      ...(['timeout', 'unreadable', 'muted'] as const).map((reason): [string, WireOpts] => [reason, { screen: { parked: 'WORKER SCREEN' }, daemonTrust: { state: 'unknown', reason } }]),
      ['no reason', { screen: { parked: 'WORKER SCREEN' }, daemonTrust: 'unknown' }],
      ['another dialog', { screen: { parked: 'WORKER SCREEN' }, daemonTrust: { state: 'unknown', reason: 'unseen-cells', dialog: true } }],
      ['no ring text', { screen: '', daemonTrust: { state: 'unknown', reason: 'unseen-cells' } }],
      ['a blank ring text', { screen: { parked: '' }, daemonTrust: { state: 'unknown', reason: 'unseen-cells' } }],
      ['a whitespace ring text', { screen: { parked: '  \n ' }, daemonTrust: { state: 'unknown', reason: 'unseen-cells' } }],
      ['a trust question in the ring text', { screen: { parked: SCREENS['trust'].screen as string }, daemonTrust: { state: 'unknown', reason: 'unseen-cells' } }],
    ];
    for (const [name, opts] of refused) {
      for (const proof of [false, true]) {
        const w = wire({ ...opts, tasks, trustProvenClear: proof });
        expect(await w.gatedSubmit('pty-task', 'hello', 'claude', { senderTaskIds: ['t1'] }), `${name}, record ${proof}`).toMatchObject({ ok: false });
        expect(w.writes, name).toEqual([]);
      }
    }
  });

  it('a new task: the sender comes from main\'s record of the send, while it runs', async () => {
    const send = beginDeliverySend('ws-owner');
    // No daemon row yet: the daemon writes it after the delivery.
    const w = wire({ ...UNREAD, tasks: [] });
    expect(await w.gatedSubmit('pty-task', 'hello', 'claude', { senderSendKey: send.key })).toMatchObject({ ok: true });
    expect(w.logs).toHaveLength(1);
    send.end();
    const after = wire({ ...UNREAD, tasks: [] });
    expect(await after.gatedSubmit('pty-task', 'hello', 'claude', { senderSendKey: send.key })).toMatchObject({ ok: false });

    const stranger = beginDeliverySend('ws-stranger');
    const w2 = wire({ ...UNREAD, tasks: [] });
    expect(await w2.gatedSubmit('pty-task', 'hello', 'claude', { senderSendKey: stranger.key })).toMatchObject({ ok: false });
    stranger.end();
  });

  it('a mention nudge: the sender is each message\'s author as the daemon stamped it', async () => {
    const mentions = [{ channelId: 'ch-1', seq: 4 }, { channelId: 'ch-1', seq: 5 }];
    const owner = wire({ ...UNREAD, mentionAuthors: { 'ch-1:4': 'ws-owner', 'ch-1:5': 'ws-owner' } });
    expect(await owner.gatedSubmit('pty-task', 'nudge', 'claude', { senderMentions: mentions })).toMatchObject({ ok: true });
    const others: Array<Record<string, string>> = [{ 'ch-1:4': 'ws-owner', 'ch-1:5': 'ws-stranger' }, { 'ch-1:4': 'ws-owner' }, { 'ch-1:4': 'ws-stranger', 'ch-1:5': 'ws-stranger' }];
    for (const authors of others) {
      const w = wire({ ...UNREAD, mentionAuthors: authors });
      expect(await w.gatedSubmit('pty-task', 'nudge', 'claude', { senderMentions: mentions }), JSON.stringify(authors)).toMatchObject({ ok: false });
    }
  });

  it('the launch record changes deliveries only, not a terminal_send', async () => {
    const w = wire({ ...UNREAD, trustProvenClear: true, ownerAnswers: 'off' });
    const res = await asPane(w, 'input.send', { workspaceId: 'ws-owner', ptyId: 'pty-task', callerPtyId: 'pty-owner', text: 'go', submit: true });
    expect(res.ok).toBe(false);
    expect(w.writes).toEqual([]);
  });

  it('a pane wmux launched sandboxed is trust-clear without a read, for any sender', async () => {
    const w = wire({ ...UNREAD, trustProvenClear: true });
    const res = await w.gatedSubmit('pty-task', 'hello', 'claude');
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    expect(w.logs).toEqual([]);
  });
});

describe('a refused local delivery, stored and typed later', () => {
  const row = (id: string, from: string, to: string) => ({ id, metadata: { from: { workspaceId: from }, to: { workspaceId: to } } });
  // A hidden pane whose verdict the gate may not pass: refused at send.
  const UNPASSABLE = { screen: { parked: 'WORKER SCREEN' }, daemonTrust: { state: 'unknown' as const, reason: 'timeout' }, virtualClock: true };
  const PASSABLE = { state: 'unknown' as const, reason: 'unseen-cells' };
  const pasted = (w: Wiring) => w.writes.map((x) => x.data).filter((d) => d.includes('hello'));

  /** A new task refused at send, on main's record of the send, before its daemon row exists. */
  async function refusedNewTask(sender: string) {
    const w = wire({ ...UNPASSABLE, tasks: [] });
    const send = beginDeliverySend(sender);
    const res = await w.gatedSubmit('pty-task', 'hello', 'claude', { newTask: true, taskId: 't-new', senderSendKey: send.key });
    send.end();
    return { w, res };
  }

  it("the owner's new task is stored, then typed at retry under the lane read from the daemon row", async () => {
    const { w, res } = await refusedNewTask('ws-owner');
    expect(res).toMatchObject({ ok: false, reason: 'gate_unavailable', stored: true });
    expect(pasted(w)).toEqual([]);
    // By the retry the send key is dead and the daemon has the task's row.
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toHaveLength(1);
    expect(w.logs.some((l) => l.startsWith('[owner-lane] delivery from ws "ws-owner"'))).toBe(true);
    expect(w.logs.at(-1)).toBe('[delivery] typed stored task "t-new" into pane "pty-task"');
    // Typed once: a later pass finds nothing.
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toHaveLength(1);
  });

  it("a non-owner's stored message is still refused at retry", async () => {
    const { w, res } = await refusedNewTask('ws-stranger');
    expect(res).toMatchObject({ stored: true });
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-stranger', 'ws-task')];
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
    expect(w.logs.some((l) => l.includes('typed stored task'))).toBe(false);
  });

  it('is dropped, not typed, once its task has ended', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [];
    w.advance(61_000);
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
    expect(w.logs.at(-1)).toContain('dropped stored task "t-new" for pane "pty-task": task ended');
  });

  it('is dropped, not typed, when its task row shows an ended state', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    // A daemon that predates the anchors view lists ended tasks too.
    w.live.tasks = [{ ...row('t-new', 'ws-owner', 'ws-task'), status: { state: 'completed' } }];
    w.advance(61_000);
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
    expect(w.logs.at(-1)).toContain(': task ended;');
  });

  it('a later message on the task waits behind the stored one, and is typed after it', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    const res = await w.gatedSubmit('pty-task', 'hello again', 'claude', { senderTaskIds: ['t-new'] });
    expect(res).toMatchObject({ ok: false, reason: 'gate_unavailable', stored: true });
    expect((res as { detail: string }).detail).toContain('stored behind it');
    await vi.waitFor(() => expect(pasted(w)).toHaveLength(1), { timeout: 5_000 });
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w).map((d) => (d.includes('hello again') ? 'follow-up' : 'body'))).toEqual(['body', 'follow-up']);
  });

  it("is dropped, not typed, when the pane's agent session changed", async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    w.live.agentSession = 'inc-2';
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
    expect(w.logs.at(-1)).toContain(': agent changed;');
  });

  it('keeps refusing while a person types in the pane, and types once it is quiet', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    w.live.draft = true;
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
    w.live.draft = false;
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toHaveLength(1);
  });

  it('keeps refusing at an approval', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    w.live.pending = [{ id: 'ap-1', sessionId: 'pty-task', workspaceId: 'ws-task', toolName: 'Bash' }];
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
  });

  it('after an approval clears, the retry still checks the screen before the paste and before the Enter', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    w.live.pending = [{ id: 'ap-1', sessionId: 'pty-task', workspaceId: 'ws-task', toolName: 'Bash' }];
    await w.retryPendingDeliveries('pty-task');
    w.live.pending = [];
    // A follow-up dialog on the screen: nothing is pasted.
    w.live.screen = SCREENS.trust.screen;
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
    // A dialog that comes up after the paste: no Enter.
    w.live.screen = undefined;
    // Two reads before the paste (the gate's checks) see it clear; the read before the Enter sees the dialog.
    w.live.screens = ['WORKER SCREEN', 'WORKER SCREEN', SCREENS.trust.screen as string];
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toHaveLength(1);
    expect(w.writes.map((x) => x.data)).not.toContain('\r');
    // The text stays in the composer (#2993): it is not pasted again.
    expect(w.logs.at(-1)).toContain('was pasted into pane "pty-task" but not submitted');
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toHaveLength(1);
  });

  it('is never typed into a shell: a pane with no agent gets no write at all', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    w.live.atShell = true;
    const before = w.writes.length;
    await w.retryPendingDeliveries('pty-task');
    expect(w.writes.length).toBe(before);
    expect(w.logs.at(-1)).toContain(': agent changed;');
  });

  it('is dropped, not typed, when the agent restarted in the pane with the same name and pane session', async () => {
    const w = wire({ ...UNPASSABLE, tasks: [], sessionStartAt: 100 });
    const send = beginDeliverySend('ws-owner');
    await w.gatedSubmit('pty-task', 'hello', 'claude', { newTask: true, taskId: 't-new', senderSendKey: send.key });
    send.end();
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    // claude exited and was started again: a new session-start hook, same name and incarnation.
    w.live.sessionStartAt = 200;
    w.live.sessionStartSource = 'startup';
    const before = w.writes.length;
    await w.retryPendingDeliveries('pty-task');
    expect(w.writes.length).toBe(before);
    expect(w.logs.at(-1)).toContain(': agent changed;');
  });

  it("an agent's first start hook arriving just after the store is the same agent; a later one is a restart", async () => {
    for (const [lateMs, typed] of [[5_000, 1], [61_000, 0]] as const) {
      const w = wire({ ...UNPASSABLE, tasks: [] });
      const send = beginDeliverySend('ws-owner');
      await w.gatedSubmit('pty-task', 'hello', 'claude', { newTask: true, taskId: 't-new', senderSendKey: send.key });
      send.end();
      w.live.daemonTrust = PASSABLE;
      w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
      w.live.sessionStartAt = w.now() + lateMs;
      w.live.sessionStartSource = 'startup';
      w.advance(lateMs);
      await w.retryPendingDeliveries('pty-task');
      expect(pasted(w)).toHaveLength(typed);
    }
  });

  it('a task that cannot be read right before the paste is not typed, and stays stored', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    w.live.taskStates = ['open', null];
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
    expect(w.logs.some((l) => l.includes('dropped stored task'))).toBe(false);
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toHaveLength(1);
  });

  it('a retry that hangs lets the pane go after its time, and a live send there is typed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // A stored reply (a new task's retry would also hold the new-task lock).
      const w = wire({ ...UNPASSABLE, tasks: [row('t-reply', 'ws-owner', 'ws-task')] });
      expect(await w.gatedSubmit('pty-task', 'hello', 'claude', { senderTaskIds: ['t-reply'] })).toMatchObject({ stored: true });
      w.live.daemonTrust = PASSABLE;
      w.live.tasks = [row('t-reply', 'ws-owner', 'ws-task'), row('t-live', 'ws-owner', 'ws-task')];
      // Open for the pass; the read right before the paste never answers.
      w.live.taskStates = ['open', 'hang'];
      const retry = w.retryPendingDeliveries('pty-task');
      await vi.advanceTimersByTimeAsync(22_000);
      await retry;
      expect(pasted(w)).toEqual([]);
      expect(w.logs.some((l) => l.includes('dropped stored task'))).toBe(false);
      const live = w.gatedSubmit('pty-task', 'hello live', 'claude', { senderTaskIds: ['t-live'] });
      await vi.advanceTimersByTimeAsync(0);
      expect(await live).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a clear or a compaction in the same agent is no restart: the text is still typed', async () => {
    for (const source of ['clear', 'compact']) {
      const w = wire({ ...UNPASSABLE, tasks: [], sessionStartAt: 100, sessionStartSource: 'startup' });
      const send = beginDeliverySend('ws-owner');
      await w.gatedSubmit('pty-task', 'hello', 'claude', { newTask: true, taskId: 't-new', senderSendKey: send.key });
      send.end();
      w.live.daemonTrust = PASSABLE;
      w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
      w.live.sessionStartAt = 200;
      w.live.sessionStartSource = source;
      await w.retryPendingDeliveries('pty-task');
      expect(pasted(w)).toHaveLength(1);
    }
  });

  it("is dropped when the pane's agent process ends", async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.agentEnded('pty-task');
    expect(w.logs.at(-1)).toContain('dropped stored task "t-new" for pane "pty-task": agent changed');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
  });

  it('a new task sent without a sender record gets no owner lane at retry either', async () => {
    const w = wire({ ...UNPASSABLE, tasks: [] });
    expect(await w.gatedSubmit('pty-task', 'hello', 'claude', { newTask: true, taskId: 't-new' })).toMatchObject({ stored: true });
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
    expect(w.logs.some((l) => l.startsWith('[owner-lane]'))).toBe(false);
  });

  it('a retry and a live send on the same pane take turns: each paste gets its own Enter', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task'), row('t-live', 'ws-owner', 'ws-task')];
    // Hold the retry in its paste-to-Enter gap while the live send comes in.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let parked: () => void = () => undefined;
    const atGap = new Promise<void>((resolve) => { parked = resolve; });
    w.live.sleepGate = async () => {
      if (!pasted(w).length) return;
      w.live.sleepGate = undefined;
      parked();
      await held;
    };
    const retry = w.retryPendingDeliveries('pty-task');
    await atGap;
    const live = w.gatedSubmit('pty-task', 'hello live', 'claude', { senderTaskIds: ['t-live'] });
    await deliberateSleep(50, 'the live send runs up to the pane lock; nothing to observe until the retry lets go');
    release();
    await retry;
    expect(await live).toMatchObject({ ok: true });
    const order = w.writes.map((x) => x.data).filter((d) => d.includes('hello') || d === '\r' || d === '\x15');
    expect(order).toHaveLength(4);
    expect(order[1]).toBe('\r');
    expect(order[3]).toBe('\r');
    expect(w.logs.some((l) => l.includes('typed stored task "t-new"'))).toBe(true);
  });

  it('is not typed when its task ends while the retry runs', async () => {
    const { w } = await refusedNewTask('ws-owner');
    w.live.daemonTrust = PASSABLE;
    w.live.tasks = [row('t-new', 'ws-owner', 'ws-task')];
    // Open when the pass reads it; cancelled by the check right before the paste.
    w.live.taskStates = ['open', 'ended'];
    await w.retryPendingDeliveries('pty-task');
    expect(pasted(w)).toEqual([]);
    expect(w.logs.at(-1)).toContain(': refused (guard_refused);');
  });

  it('is not stored for a person or a dialog, nor without a single local task', async () => {
    const approval = wire({ ...UNPASSABLE, pending: [{ id: 'ap-1', sessionId: 'pty-task', workspaceId: 'ws-task', toolName: 'Bash' }] });
    expect(await approval.gatedSubmit('pty-task', 'hello', 'claude', { senderTaskIds: ['t1'] })).not.toHaveProperty('stored');
    const noTask = wire(UNPASSABLE);
    expect(await noTask.gatedSubmit('pty-task', 'hello', 'claude')).not.toHaveProperty('stored');
    const twoTasks = wire(UNPASSABLE);
    expect(await twoTasks.gatedSubmit('pty-task', 'hello', 'claude', { senderTaskIds: ['t1', 't2'] })).not.toHaveProperty('stored');
    const tooLong = wire(UNPASSABLE);
    expect(await tooLong.gatedSubmit('pty-task', 'x'.repeat(PENDING_TEXT_MAX + 1), 'claude', { senderTaskIds: ['t1'] })).not.toHaveProperty('stored');
    // A hand-off's caller settles its task on the outcome itself.
    const handoff = wire(UNPASSABLE);
    expect(await handoff.gatedSubmit('pty-task', 'hello', 'claude', { newTask: true, taskId: 't-h', waitQuiet: true })).not.toHaveProperty('stored');
    const reply = wire(UNPASSABLE);
    expect(await reply.gatedSubmit('pty-task', 'hello', 'claude', { senderTaskIds: ['t1'] })).toMatchObject({ stored: true });
  });
});
