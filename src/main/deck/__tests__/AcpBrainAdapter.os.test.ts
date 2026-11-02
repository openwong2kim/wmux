import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpBrainAdapter, type AcpHermesPolicy } from '../AcpBrainAdapter';
import { HERMES_MCP_MISSING_LEAD, HERMES_TOOLS_CHANGED_LEAD } from '../../factory/engineError';
import { commanderTokenWorkspace, resolveCommanderToken } from '../commanderTrust';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrainEvent } from '../BrainAdapter';
import { deliberateSleep } from '../../../test-utils/waitFor';

// ── fake ACP agent over fake stdio ──────────────────────────────────────────
// Mirrors the ClaudeSdkAdapter test philosophy: drive the adapter's REAL wire
// plumbing (ndjson framing, request/response correlation, notification
// routing) against a scripted agent, no live subprocess.

interface Sent {
  msg: Record<string, unknown>;
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  sent: Sent[] = [];
  private responder: (msg: Record<string, unknown>) => void;
  stdin = {
    write: (line: string) => {
      const msg = JSON.parse(line) as Record<string, unknown>;
      this.sent.push({ msg });
      // Respond on a microtask so the adapter's await sequencing is realistic.
      queueMicrotask(() => this.responder(msg));
      return true;
    },
  };

  constructor(responder: (child: FakeChild, msg: Record<string, unknown>) => void) {
    super();
    this.responder = (msg) => responder(this, msg);
  }

  emitLine(obj: Record<string, unknown>): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0);
    return true;
  }
}

/** A standard scripted agent: answers initialize/session lifecycle, and for
 *  session/prompt emits the given updates before resolving the prompt. */
function scriptedAgent(opts?: {
  updates?: Array<Record<string, unknown>>;
  stopReason?: string;
  usage?: Record<string, unknown>;
  failLoad?: boolean;
}): { spawnFn: () => ChildProcessWithoutNullStreams; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawnFn = () => {
    const child = new FakeChild((c, msg) => {
      const id = msg.id as number;
      switch (msg.method) {
        case 'initialize':
          c.emitLine({ jsonrpc: '2.0', id, result: { protocolVersion: 1, authMethods: [] } });
          return;
        case 'session/load':
          if (opts?.failLoad) c.emitLine({ jsonrpc: '2.0', id, error: { code: -32000, message: 'unknown session' } });
          else c.emitLine({ jsonrpc: '2.0', id, result: {} });
          return;
        case 'session/new':
          c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 'acp-sess-1' } });
          return;
        case 'session/prompt': {
          const sessionId = (msg.params as Record<string, unknown>).sessionId;
          for (const u of opts?.updates ?? []) {
            c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
          }
          c.emitLine({
            jsonrpc: '2.0',
            id,
            result: { stopReason: opts?.stopReason ?? 'end_turn', ...(opts?.usage ? { usage: opts.usage } : {}) },
          });
          return;
        }
        default:
          c.emitLine({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown' } });
      }
    });
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnFn, children };
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const SPEC = { command: 'hermes', args: ['acp'] };

describe('AcpBrainAdapter', () => {
  it('runs a full turn: updates map to the 5-event vocabulary, prompt response ends the turn', async () => {
    const { spawnFn } = scriptedAgent({
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'hi ' }] },
        { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'wmux pane_list', kind: 'other' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' },
        { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'done' }] },
      ],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({ systemPrompt: 'SYS' });
    const events = await collect(adapter.send('go'));
    expect(events.map((e) => e.type)).toEqual([
      'text-delta',
      'tool-start',
      'tool-end',
      'text-delta',
      'turn-end',
    ]);
    const toolEnd = events[2] as Extract<BrainEvent, { type: 'tool-end' }>;
    expect(toolEnd.name).toBe('wmux pane_list');
    expect(toolEnd.ok).toBe(true);
    const end = events[4] as Extract<BrainEvent, { type: 'turn-end' }>;
    expect(end.sessionId).toBe('acp-sess-1');
    expect(end.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    adapter.dispose();
  });

  it('injects the wmux MCP server per session with --commander arg + token env (P4)', async () => {
    const { spawnFn, children } = scriptedAgent();
    const adapter = new AcpBrainAdapter({
      spawnSpec: SPEC, newSessionSettleMs: 0,
      workspaceId: 'ws-1',
      mcpBundlePath: '/fake/mcp.js',
      spawnFn,
    });
    adapter.start({});
    await collect(adapter.send('go'));
    const sessionNew = children[0].sent.find((s) => s.msg.method === 'session/new');
    const servers = (sessionNew?.msg.params as Record<string, unknown>).mcpServers as Array<
      Record<string, unknown>
    >;
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('wmux');
    expect(servers[0].args).toEqual(['/fake/mcp.js', '--commander']);
    const env = servers[0].env as Array<{ name: string; value: string }>;
    const token = env.find((e) => e.name === 'WMUX_COMMANDER_TOKEN')?.value ?? '';
    expect(token.length).toBeGreaterThanOrEqual(64);
    // The injected token is LIVE and bound to this adapter's workspace.
    expect(commanderTokenWorkspace(token)).toBe('ws-1');
    adapter.dispose();
    // Dispose revokes it — the child's straggling RPCs fail closed (P4).
    expect(commanderTokenWorkspace(token)).toBeNull();
  });

  it('system prompt + fleet context ride the FIRST prompt only', async () => {
    const { spawnFn, children } = scriptedAgent();
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({ systemPrompt: 'SYS', fleetContext: 'FLEET' });
    await collect(adapter.send('first'));
    await collect(adapter.send('second'));
    const prompts = children[0].sent
      .filter((s) => s.msg.method === 'session/prompt')
      .map((s) => ((s.msg.params as Record<string, unknown>).prompt as Array<{ text: string }>)[0].text);
    expect(prompts[0]).toContain('SYS');
    expect(prompts[0]).toContain('FLEET');
    expect(prompts[0]).toContain('first');
    expect(prompts[1]).toBe('second');
    adapter.dispose();
  });

  it('resumes via session/load, and falls back to a fresh session on a dead id', async () => {
    const ok = scriptedAgent();
    const a1 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: ok.spawnFn });
    a1.start({ resumeSessionId: 'persisted-1' });
    await collect(a1.send('go'));
    const loads = ok.children[0].sent.filter((s) => s.msg.method === 'session/load');
    expect(loads).toHaveLength(1);
    expect((loads[0].msg.params as Record<string, unknown>).sessionId).toBe('persisted-1');
    expect(a1.sessionId).toBe('persisted-1');
    a1.dispose();

    const dead = scriptedAgent({ failLoad: true });
    const a2 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: dead.spawnFn });
    a2.start({ resumeSessionId: 'gc-ed' });
    const events = await collect(a2.send('go'));
    expect(events.at(-1)?.type).toBe('turn-end');
    expect(a2.sessionId).toBe('acp-sess-1'); // fresh session, turn not bricked
    a2.dispose();
  });

  it('a refusal stop reason surfaces as an error event (no turn-end)', async () => {
    const { spawnFn } = scriptedAgent({ stopReason: 'refusal' });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    const events = await collect(adapter.send('go'));
    expect(events.at(-1)?.type).toBe('error');
    expect(events.some((e) => e.type === 'turn-end')).toBe(false);
    adapter.dispose();
  });

  it('loads a persisted session ONCE per child — later sends skip session/load (Codex P2)', async () => {
    const { spawnFn, children } = scriptedAgent();
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({ resumeSessionId: 'persisted-1' });
    await collect(adapter.send('one'));
    await collect(adapter.send('two'));
    await collect(adapter.send('three'));
    // Re-loading every turn replays the whole transcript on some agents —
    // latency would grow with history.
    expect(children[0].sent.filter((s) => s.msg.method === 'session/load')).toHaveLength(1);
    expect(children[0].sent.filter((s) => s.msg.method === 'session/prompt')).toHaveLength(3);
    adapter.dispose();
  });

  it('retries once on a fresh session when an UNVALIDATED resume dies at prompt time (Codex P2)', async () => {
    // Agent reports the unknown persisted id as a SUCCESSFUL empty load, then
    // errors the prompt — the adapter must drop the dead id and retry fresh.
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === 'initialize') c.emitLine({ jsonrpc: '2.0', id, result: {} });
        else if (msg.method === 'session/load') c.emitLine({ jsonrpc: '2.0', id, result: {} }); // "success"
        else if (msg.method === 'session/new') c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 'fresh-1' } });
        else if (msg.method === 'session/prompt') {
          const sid = (msg.params as Record<string, unknown>).sessionId;
          if (sid === 'gc-ed') c.emitLine({ jsonrpc: '2.0', id, error: { code: -32000, message: 'unknown session' } });
          else {
            c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'ok' }] } } });
            c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          }
        }
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({ resumeSessionId: 'gc-ed' });
    const events = await collect(adapter.send('go'));
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'turn-end']);
    expect(adapter.sessionId).toBe('fresh-1');
    adapter.dispose();
  });

  it('correlates a response even when the agent echoes `method` on it (GLM P2)', async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        // Echo the method on every response — still a response, not a
        // notification.
        if (msg.method === 'initialize') c.emitLine({ jsonrpc: '2.0', id, method: 'initialize', result: {} });
        else if (msg.method === 'session/new') c.emitLine({ jsonrpc: '2.0', id, method: 'session/new', result: { sessionId: 's' } });
        else if (msg.method === 'session/prompt') c.emitLine({ jsonrpc: '2.0', id, method: 'session/prompt', result: { stopReason: 'end_turn' } });
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    const events = await collect(adapter.send('go'));
    expect(events.at(-1)?.type).toBe('turn-end');
    adapter.dispose();
  });

  it('reassembles ndjson lines split across stdout chunks (framing edge)', async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === 'initialize') {
          // Split the response across two data events, plus two messages in
          // one chunk later.
          const line = JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n';
          c.stdout.emit('data', Buffer.from(line.slice(0, 10)));
          c.stdout.emit('data', Buffer.from(line.slice(10)));
        } else if (msg.method === 'session/new') {
          const l1 = JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 's' } });
          c.stdout.emit('data', Buffer.from(l1 + '\n'));
        } else if (msg.method === 'session/prompt') {
          const sid = (msg.params as Record<string, unknown>).sessionId;
          const upd = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'hi' }] } } });
          const res = JSON.stringify({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          c.stdout.emit('data', Buffer.from(upd + '\n' + res + '\n')); // two lines, one chunk
        }
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    const events = await collect(adapter.send('go'));
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'turn-end']);
    adapter.dispose();
  });

  it('DENIES session/request_permission — a headless commander has no consenting human (Codex P1)', async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === 'initialize') c.emitLine({ jsonrpc: '2.0', id, result: {} });
        else if (msg.method === 'session/new') c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 's' } });
        else if (msg.method === 'session/prompt') {
          // Agent asks permission mid-turn, then finishes.
          c.emitLine({
            jsonrpc: '2.0',
            id: 'agent-req-1',
            method: 'session/request_permission',
            params: { options: [{ optionId: 'opt-allow', kind: 'allow_once' }, { optionId: 'opt-deny', kind: 'reject_once' }] },
          });
          c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    await collect(adapter.send('go'));
    const reply = children[0].sent.find((s) => s.msg.id === 'agent-req-1');
    // The agent asks permission precisely when IT considers the action
    // dangerous; a blanket allow would hand pane-output prompt injection the
    // agent's native shell. Deny is the only fail-closed answer.
    expect((reply?.msg.result as Record<string, unknown>).outcome).toEqual({
      outcome: 'selected',
      optionId: 'opt-deny',
    });
    adapter.dispose();
  });

  it('agent process death mid-turn surfaces as an error event, not a hang', async () => {
    const children: FakeChild[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === 'initialize') c.emitLine({ jsonrpc: '2.0', id, result: {} });
        else if (msg.method === 'session/new') c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 's' } });
        else if (msg.method === 'session/prompt') c.kill(); // crash mid-turn
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    const events = await collect(adapter.send('go'));
    expect(events.at(-1)?.type).toBe('error');
    adapter.dispose();
  });

  it('interrupt sends the session/cancel notification', async () => {
    const { spawnFn, children } = scriptedAgent();
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    await collect(adapter.send('go'));
    adapter.interrupt();
    const cancel = children[0].sent.find((s) => s.msg.method === 'session/cancel');
    expect(cancel).toBeTruthy();
    expect((cancel?.msg.params as Record<string, unknown>).sessionId).toBe('acp-sess-1');
    expect(cancel?.msg.id).toBeUndefined(); // notification, not a request
    adapter.dispose();
  });

  it('send after dispose yields a terminal error', async () => {
    const { spawnFn } = scriptedAgent();
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn });
    adapter.start({});
    adapter.dispose();
    const events = await collect(adapter.send('go'));
    expect(events).toEqual([{ type: 'error', message: 'commander session disposed' }]);
  });
});

// ── the Hermes preset ───────────────────────────────────────────────────────

const HERMES_TOOLS_OK = 'Available tools (2):\n  web: web_search\n  mcp-wmux: mcp__editor_wmux_ab12__room_post\n';

/** A Hermes-like agent: `/tools` answers from `tools`; any other prompt runs
 *  `onPrompt`, and a prompt it holds ends `cancelled` on session/cancel.
 *  `onReply` sees the adapter's answers to the agent's own requests. */
function hermesAgent(script: {
  onPrompt?: (c: FakeChild, promptId: number, sessionId: unknown) => 'hold' | void;
  onReply?: (c: FakeChild, msg: Record<string, unknown>) => void;
  tools?: string;
}): { spawnFn: () => ChildProcessWithoutNullStreams; children: FakeChild[]; prompts: () => number } {
  const children: FakeChild[] = [];
  let held: number | null = null;
  let prompts = 0;
  const spawnFn = () => {
    const child = new FakeChild((c, msg) => {
      const id = msg.id as number;
      if (msg.method === undefined) {
        script.onReply?.(c, msg);
        return;
      }
      switch (msg.method) {
        case 'initialize':
          c.emitLine({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
          return;
        case 'session/new':
          c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 'h-1' } });
          return;
        case 'session/load':
          c.emitLine({ jsonrpc: '2.0', id, result: {} });
          return;
        case 'session/cancel':
          if (held !== null) c.emitLine({ jsonrpc: '2.0', id: held, result: { stopReason: 'cancelled' } });
          held = null;
          return;
        case 'session/prompt': {
          const params = msg.params as Record<string, unknown>;
          const text = ((params.prompt as Array<Record<string, unknown>>)[0]?.text ?? '') as string;
          if (text === '/tools') {
            const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: script.tools ?? HERMES_TOOLS_OK } };
            c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update } });
            c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
            return;
          }
          prompts++;
          if (script.onPrompt?.(c, id, params.sessionId) === 'hold') held = id;
          else if (!script.onPrompt) c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
          return;
        }
      }
    });
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnFn, children, prompts: () => prompts };
}

function hermesPolicy(over: Partial<AcpHermesPolicy> = {}) {
  const asks: Array<{ req: { title: string; command: string }; signal: AbortSignal; answer: (ok: boolean) => void }> = [];
  const policy: AcpHermesPolicy = {
    prepare: async () => ({ ok: true, env: { HERMES_HOME: '/r' } }),
    sessionStarted: () => null,
    askOwner: (req, signal) => new Promise<boolean>((answer) => {
      asks.push({ req, signal, answer });
    }),
    toolAllowed: (n) => n === 'web_search' || n.startsWith('mcp__editor_wmux_'),
    mcpReady: async () => true,
    unsettled: vi.fn(async () => undefined),
    ...over,
  };
  return { policy, asks };
}

const PERM_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once' },
  { optionId: 'allow_always', kind: 'allow_always' },
  { optionId: 'deny', kind: 'reject_once' },
];
const permRequest = (id: string, toolCallId: string, kind: string, command?: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'session/request_permission',
  params: { sessionId: 'h-1', options: PERM_OPTIONS, toolCall: { toolCallId, kind, title: command ?? toolCallId, rawInput: command ? { command } : {} } },
});
const answerOf = (child: FakeChild, id: string) =>
  (child.sent.find((s) => s.msg.id === id && s.msg.method === undefined)?.msg.result as Record<string, unknown> | undefined)?.outcome;

describe('AcpBrainAdapter (Hermes preset)', () => {
  it('cards only command approvals: clarify, model confirmation and a second request are rejected at once; approve answers allow_once', async () => {
    const { policy, asks } = hermesPolicy();
    let promptId = 0;
    const agent = hermesAgent({
      onPrompt: (c, id) => {
        promptId = id;
        c.emitLine(permRequest('r-clarify', 'clarify-1', 'other'));
        c.emitLine(permRequest('r-model', 'model-confirm-1', 'other'));
        c.emitLine(permRequest('r-cmd', 'perm-check-1', 'execute', 'rm -rf build'));
        c.emitLine(permRequest('r-second', 'perm-check-2', 'execute', 'ls'));
        return 'hold';
      },
      onReply: (c, msg) => {
        if (msg.id === 'r-cmd') c.emitLine({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      },
    });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: agent.spawnFn, hermes: policy });
    adapter.start({});
    const turn = collect(adapter.send('go'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    const child = agent.children[0];
    for (const id of ['r-clarify', 'r-model', 'r-second']) expect(answerOf(child, id)).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(answerOf(child, 'r-cmd')).toBeUndefined();
    expect(asks[0].req).toEqual({ title: 'rm -rf build', command: 'rm -rf build' });
    asks[0].answer(true);
    const events = await turn;
    expect(answerOf(child, 'r-cmd')).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    expect(events.at(-1)?.type).toBe('turn-end');
    adapter.dispose();
  });

  it('a turn\'s tool ids do not label the next turn\'s tools (the table clears after the tools check too)', async () => {
    const { policy } = hermesPolicy();
    let turn = 0;
    const agent = hermesAgent({
      onPrompt: (c, id, sessionId) => {
        turn += 1;
        const update = (u: Record<string, unknown>) => c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
        if (turn === 1) {
          update({ sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'web_search', kind: 'fetch' });
          update({ sessionUpdate: 'tool_call_update', toolCallId: 't-1', status: 'completed' });
        } else {
          // The agent reuses the id for an unnamed call.
          update({ sessionUpdate: 'tool_call_update', toolCallId: 't-1', status: 'completed' });
        }
        c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      },
    });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: agent.spawnFn, hermes: policy });
    adapter.start({});
    expect(await collect(adapter.send('one'))).toContainEqual(expect.objectContaining({ type: 'tool-end', name: 'web_search' }));
    const second = await collect(adapter.send('two'));
    expect(second).toContainEqual(expect.objectContaining({ type: 'tool-end', toolId: 't-1', name: 'tool' }));
    adapter.dispose();
  });

  it('a stop rejects the waiting request, cancels the turn and lets it settle; dispose rejects and adds no prompt', async () => {
    const { policy, asks } = hermesPolicy();
    const agent = hermesAgent({
      onPrompt: (c) => {
        c.emitLine(permRequest('r-cmd', 'perm-check-1', 'execute', 'make'));
        return 'hold';
      },
    });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: agent.spawnFn, hermes: policy });
    adapter.start({});
    const turn = collect(adapter.send('go'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    adapter.interrupt();
    const child = agent.children[0];
    expect(answerOf(child, 'r-cmd')).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(asks[0].signal.aborted).toBe(true);
    expect(child.sent.some((s) => s.msg.method === 'session/cancel')).toBe(true);
    await turn;
    // The cancelled turn ran no /tools check and no other prompt.
    expect(child.sent.filter((s) => s.msg.method === 'session/prompt')).toHaveLength(1);

    // Dispose while a request waits: rejected, the turn settles, the agent goes.
    const turn2 = collect(adapter.send('again'));
    await vi.waitFor(() => expect(asks).toHaveLength(2), { timeout: 5_000 });
    await adapter.shutdown();
    expect(answerOf(child, 'r-cmd')).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(child.sent.filter((s) => s.msg.id === 'r-cmd' && s.msg.method === undefined)).toHaveLength(2);
    expect(child.killed).toBe(true);
    expect(policy.unsettled).not.toHaveBeenCalled();
    await turn2;
    expect(agent.prompts()).toBe(2);
  });

  it('a tool outside the allowlist ends the turn, as does one /tools names after the first turn', async () => {
    const drift = hermesAgent({
      onPrompt: (c, id, sessionId) => {
        c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'terminal: ls -la' } } });
        return 'hold';
      },
    });
    const a1 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: drift.spawnFn, hermes: hermesPolicy().policy });
    a1.start({});
    const e1 = await collect(a1.send('go'));
    expect(e1.at(-1)).toEqual({ type: 'error', message: `${HERMES_TOOLS_CHANGED_LEAD} terminal` });
    expect(drift.children[0].sent.some((s) => s.msg.method === 'session/cancel')).toBe(true);
    expect(drift.children[0].killed).toBe(true);
    a1.dispose();

    const listed = hermesAgent({ tools: 'Available tools (3):\n  web: web_search\n  terminal: terminal, process\n' });
    const a2 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: listed.spawnFn, hermes: hermesPolicy().policy });
    a2.start({});
    const e2 = await collect(a2.send('go'));
    expect(e2.at(-1)).toEqual({ type: 'error', message: `${HERMES_TOOLS_CHANGED_LEAD} terminal, process` });
    a2.dispose();

    // A /tools answer whose names do not add up to its count reads as unknown: refused.
    const odd = hermesAgent({ tools: 'Available tools (4):\n  web: web_search\n' });
    const a4 = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn: odd.spawnFn, hermes: hermesPolicy().policy });
    a4.start({});
    const e4 = await collect(a4.send('go'));
    expect(e4.at(-1)).toEqual({ type: 'error', message: `${HERMES_TOOLS_CHANGED_LEAD} wmux could not read the tools of this Hermes session` });
    a4.dispose();
  });

  it('a session whose wmux tools never connect, or a Hermes that is not ready, gets no prompt', async () => {
    const agent = hermesAgent({});
    const a1 = new AcpBrainAdapter({
      spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: '/fake/mcp.js', spawnFn: agent.spawnFn,
      hermes: hermesPolicy({ mcpReady: async () => false }).policy,
    });
    a1.start({});
    const e1 = await collect(a1.send('go'));
    expect(e1.at(-1)?.type).toBe('error');
    expect((e1.at(-1) as { message: string }).message.startsWith(HERMES_MCP_MISSING_LEAD)).toBe(true);
    expect(agent.prompts()).toBe(0);
    a1.dispose();

    // A refused session is checked again on the next turn, not reused.
    const refusals = ['its gateway runs messaging platforms', null];
    const sessionStarted = vi.fn(() => refusals.shift() ?? null);
    const a3 = new AcpBrainAdapter({
      spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: '/fake/mcp.js', spawnFn: agent.spawnFn,
      hermes: hermesPolicy({ sessionStarted }).policy,
    });
    a3.start({});
    expect((await collect(a3.send('go'))).at(-1)).toEqual({ type: 'error', message: 'its gateway runs messaging platforms' });
    expect(agent.prompts()).toBe(0);
    expect((await collect(a3.send('go'))).at(-1)?.type).toBe('turn-end');
    expect(sessionStarted).toHaveBeenCalledTimes(2);
    a3.dispose();

    const spawnFn = vi.fn(agent.spawnFn);
    const a2 = new AcpBrainAdapter({
      spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: null, spawnFn,
      hermes: hermesPolicy({ prepare: async () => ({ ok: false, message: 'not ready' }) }).policy,
    });
    a2.start({});
    expect(await collect(a2.send('go'))).toEqual([{ type: 'error', message: 'not ready' }]);
    expect(spawnFn).not.toHaveBeenCalled();
    a2.dispose();
  });
});

describe('AcpBrainAdapter (My Hermes, own mode)', () => {
  // A test on fake timers that fails must not leave them to the next one.
  afterEach(() => {
    vi.useRealTimers();
  });
  /** A Hermes that holds every prompt and answers a held one only when told
   *  (a cancel alone does not end the turn). */
  function slowHermes() {
    const children: FakeChild[] = [];
    const held: number[] = [];
    const texts: string[] = [];
    const spawnFn = () => {
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === undefined) return;
        switch (msg.method) {
          case 'initialize': c.emitLine({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } }); return;
          case 'session/new': c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 'h-1' } }); return;
          case 'session/load': c.emitLine({ jsonrpc: '2.0', id, result: {} }); return;
          case 'session/cancel': return;
          case 'session/prompt': {
            const params = msg.params as Record<string, unknown>;
            const text = ((params.prompt as Array<Record<string, unknown>>)[0]?.text ?? '') as string;
            if (text === '/tools') {
              c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'h-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: HERMES_TOOLS_OK } } } });
              c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
              return;
            }
            texts.push(text);
            held.push(id);
            c.emitLine(permRequest('r-cmd', 'perm-check-1', 'execute', 'rm -rf build'));
            return;
          }
        }
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const answer = (stopReason = 'cancelled'): void => {
      const id = held.shift();
      if (id !== undefined) children[children.length - 1].emitLine({ jsonrpc: '2.0', id, result: { stopReason } });
    };
    return { spawnFn, children, answer, texts, held };
  }
  const ownAdapter = (
    spawnFn: () => ChildProcessWithoutNullStreams,
    over: Partial<AcpHermesPolicy> = {},
    mcpBundlePath: string | null = '/app/mcp/index.js',
    timing: { promptTimeoutMs?: number; ownCancelBoundMs?: number } = {},
  ) => {
    const { policy, asks } = hermesPolicy({ mode: 'own', ...over });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath, spawnFn, hermes: policy, promptTimeoutMs: 200, ...timing });
    return { adapter, policy, asks };
  };

  it('a stop Hermes never answers: past the bound wmux closes only its own agent, tells the owner, and the next message starts a new agent', async () => {
    const h = slowHermes();
    const { adapter, policy, asks } = ownAdapter(h.spawnFn, {}, undefined, { promptTimeoutMs: 60_000, ownCancelBoundMs: 300 });
    adapter.start({});
    const turn = collect(adapter.send('hello'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    // The owner stops the bot (BotRuntime's turn timeout stops it the same
    // way); Hermes never reports the cancelled turn's end.
    adapter.interrupt();
    const first = h.children[0];
    expect(first.sent.some((s) => s.msg.method === 'session/cancel')).toBe(true);
    await deliberateSleep(100, 'a negative check: within the bound the bot stays in the turn');
    expect(first.killed).toBe(false);
    expect(policy.unsettled).not.toHaveBeenCalled();
    expect((await turn).at(-1)).toMatchObject({ type: 'error' });
    expect(first.killed).toBe(true);
    expect(policy.unsettled).toHaveBeenCalledTimes(1);
    // The killed agent's held prompt is gone with it.
    h.held.length = 0;
    const next = collect(adapter.send('next'));
    await vi.waitFor(() => expect(h.texts).toEqual(['hello', 'next']), { timeout: 3_000 });
    // A new agent, which resumes the conversation (this Hermes accepts the load).
    expect(h.children).toHaveLength(2);
    expect(h.children[1].sent.some((s) => s.msg.method === 'session/load' && (s.msg.params as Record<string, unknown>).sessionId === 'h-1')).toBe(true);
    h.answer('end_turn');
    expect((await next).at(-1)).toMatchObject({ type: 'turn-end' });
    adapter.dispose();
  });

  it.skipIf(process.platform === 'win32')('at the bound wmux stops its agent with what it started, and the bot\'s turn ends only once they are gone', async () => {
    const h = slowHermes();
    const withPid = () => Object.assign(h.spawnFn(), { pid: 424242 }) as unknown as ChildProcessWithoutNullStreams;
    let stopped: () => void = () => undefined;
    const stops: number[] = [];
    const stopAgentTree = (pid: number) => new Promise<void>((r) => {
      stops.push(pid);
      stopped = r;
    });
    const { policy, asks } = hermesPolicy({ mode: 'own' });
    const adapter = new AcpBrainAdapter({ spawnSpec: SPEC, newSessionSettleMs: 0, workspaceId: 'ws-1', mcpBundlePath: '/app/mcp/index.js', spawnFn: withPid, hermes: policy, promptTimeoutMs: 60_000, ownCancelBoundMs: 200, stopAgentTree });
    adapter.start({});
    let done = false;
    const turn = collect(adapter.send('hello')).then((evs) => { done = true; return evs; });
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    adapter.interrupt();
    await vi.waitFor(() => expect(stops).toEqual([424242]), { timeout: 5_000 });
    // The tree is still being stopped: the turn (and the bot's gate) holds.
    await deliberateSleep(100, 'a negative check: the turn must not end before the tree is gone');
    expect(done).toBe(false);
    stopped();
    expect((await turn).at(-1)).toMatchObject({ type: 'error' });
    expect(policy.unsettled).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it('a cancel watch whose turn fails stops wmux\'s agent at once instead of leaving its timer armed', async () => {
    const h = slowHermes();
    const { adapter, policy, asks } = ownAdapter(h.spawnFn, {}, undefined, { promptTimeoutMs: 60_000, ownCancelBoundMs: 60_000 });
    adapter.start({});
    const turn = collect(adapter.send('hello'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    const failed = Promise.reject(new Error('boom'));
    failed.catch(() => undefined);
    (adapter as unknown as { ownTurn: Promise<void> }).ownTurn = failed;
    adapter.interrupt();
    await vi.waitFor(() => expect(h.children[0].killed).toBe(true), { timeout: 3_000 });
    expect(policy.unsettled).toHaveBeenCalledTimes(1);
    expect((await turn).at(-1)).toMatchObject({ type: 'error' });
    adapter.dispose();
  });

  it('a timed-out turn Hermes never ends is let go at the bound too, so the bot is not blocked until restart', async () => {
    const h = slowHermes();
    const { adapter, policy, asks } = ownAdapter(h.spawnFn, {}, undefined, { promptTimeoutMs: 200, ownCancelBoundMs: 300 });
    adapter.start({});
    const turn = collect(adapter.send('hello'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    expect((await turn).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('timed out') });
    expect(h.children[0].killed).toBe(true);
    expect(policy.unsettled).toHaveBeenCalledTimes(1);
    // The timed-out message is not sent again on the new agent.
    h.held.length = 0;
    const next = collect(adapter.send('next'));
    await vi.waitFor(() => expect(h.texts).toEqual(['hello', 'next']), { timeout: 3_000 });
    h.answer('end_turn');
    await next;
    adapter.dispose();
  });

  it('a dispose holds the profile\'s turn gate until Hermes ends the cancelled turn or the bound passes, not after the 10 s settle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const flush = async (): Promise<void> => {
        for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
      };
      const h = slowHermes();
      const turnGate = { ended: null as Promise<void> | null };
      const timing = { promptTimeoutMs: 600_000, ownCancelBoundMs: 30_000 };
      const a = ownAdapter(h.spawnFn, { turnGate }, undefined, timing);
      a.adapter.start({});
      const turn = collect(a.adapter.send('hello'));
      await flush();
      expect(a.asks).toHaveLength(1);
      // The bot is deleted or switched engines: its adapter goes while Hermes
      // still runs the cancelled turn, and a new session of the profile starts.
      a.adapter.dispose();
      const b = ownAdapter(h.spawnFn, { turnGate }, undefined, timing);
      b.adapter.start({});
      const next = collect(b.adapter.send('again'));
      await vi.advanceTimersByTimeAsync(11_000);
      await flush();
      expect(h.texts).toEqual(['hello']);
      expect(h.children[0].killed).toBe(false);
      // The bound passes: wmux lets its own agent go, and only then may the new session prompt.
      await vi.advanceTimersByTimeAsync(20_000);
      await flush();
      expect(h.children[0].killed).toBe(true);
      expect(a.policy.unsettled).toHaveBeenCalledTimes(1);
      await turn;
      // The killed agent's held prompt is gone with it; the new session's stays.
      h.held.shift();
      expect(h.texts).toEqual(['hello', 'again']);
      h.answer('end_turn');
      await flush();
      expect((await next).at(-1)).toMatchObject({ type: 'turn-end' });
      b.adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a dispose whose turn Hermes ends opens the gate at that end, with no notice', async () => {
    const h = slowHermes();
    const turnGate = { ended: null as Promise<void> | null };
    const a = ownAdapter(h.spawnFn, { turnGate }, undefined, { promptTimeoutMs: 60_000 });
    a.adapter.start({});
    const turn = collect(a.adapter.send('hello'));
    await vi.waitFor(() => expect(a.asks).toHaveLength(1), { timeout: 5_000 });
    const quitting = a.adapter.shutdown();
    const b = ownAdapter(h.spawnFn, { turnGate }, undefined, { promptTimeoutMs: 60_000 });
    b.adapter.start({});
    const next = collect(b.adapter.send('again'));
    await deliberateSleep(100, 'a negative check: the new session waits for the cancelled turn');
    expect(h.texts).toEqual(['hello']);
    h.answer();
    await quitting;
    await turn;
    await vi.waitFor(() => expect(h.texts).toEqual(['hello', 'again']), { timeout: 3_000 });
    expect(a.policy.unsettled).not.toHaveBeenCalled();
    h.answer('end_turn');
    await next;
    b.adapter.dispose();
  });

  it('a timed-out turn is cancelled, its request rejected, and the bot blocked until Hermes ends it; no gateway stop', async () => {
    const h = slowHermes();
    const { adapter, policy, asks } = ownAdapter(h.spawnFn);
    adapter.start({ systemPrompt: 'SYSTEM', fleetContext: 'FLEET' });
    let done = false;
    const turn = collect(adapter.send('hello')).then((evs) => { done = true; return evs; });
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    const child = h.children[0];
    await vi.waitFor(() => expect(child.sent.some((s) => s.msg.method === 'session/cancel')).toBe(true), { timeout: 5_000 });
    expect(answerOf(child, 'r-cmd')).toEqual({ outcome: 'selected', optionId: 'deny' });
    expect(asks[0].signal.aborted).toBe(true);
    // Hermes has not reported the turn's end: the bot is still in it.
    await deliberateSleep(300, 'a negative check: the turn must not end while Hermes has not answered');
    expect(done).toBe(false);
    // A new message waits for that end too.
    let second = false;
    const next = collect(adapter.send('again')).then((evs) => { second = true; return evs; });
    await deliberateSleep(50, 'a negative check: the second message must not reach Hermes yet');
    expect(h.texts).toEqual(['hello']);
    h.answer();
    expect((await turn).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('timed out') });
    // Own mode: the owner's raw message only, no system prompt or fleet context.
    await vi.waitFor(() => expect(h.texts).toEqual(['hello', 'again']), { timeout: 5_000 });
    h.answer('end_turn');
    await next;
    expect(second).toBe(true);
    expect(policy.unsettled).not.toHaveBeenCalled();
    expect(child.killed).toBe(false);
    adapter.dispose();
  });

  it('a message stopped while it waits for the last turn\'s end is never sent', async () => {
    const h = slowHermes();
    const { adapter, asks } = ownAdapter(h.spawnFn);
    adapter.start({});
    const turn = collect(adapter.send('hello'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    const waiting = collect(adapter.send('stopped'));
    await vi.waitFor(() => expect(h.children[0].sent.some((s) => s.msg.method === 'session/cancel')).toBe(true), { timeout: 5_000 });
    // The owner stops the bot while 'stopped' waits for the first turn's end.
    adapter.interrupt();
    expect(await waiting).toEqual([]);
    h.answer();
    await turn;
    const next = collect(adapter.send('next'));
    // 'stopped' never reached Hermes, even after the first turn ended.
    await vi.waitFor(() => expect(h.texts).toEqual(['hello', 'next']), { timeout: 3_000 });
    h.answer('end_turn');
    await next;
    adapter.dispose();
  });

  it('a turn whose agent wmux kills ends with it, so the bot is not blocked forever', async () => {
    const h = slowHermes();
    const { adapter, asks } = ownAdapter(h.spawnFn);
    adapter.start({});
    const turn = collect(adapter.send('hello'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(h.children[0].sent.some((s) => s.msg.method === 'session/cancel')).toBe(true), { timeout: 5_000 });
    // A protocol violation: wmux kills the agent; the turn it ran is over.
    h.children[0].stdout.emit('data', Buffer.from('x'.repeat(8 * 1024 * 1024 + 1)));
    expect(h.children[0].killed).toBe(true);
    expect((await turn).at(-1)).toMatchObject({ type: 'error' });
    // The killed agent's prompt is gone with it.
    h.held.length = 0;
    const next = collect(adapter.send('next'));
    await vi.waitFor(() => expect(h.texts).toEqual(['hello', 'next']), { timeout: 3_000 });
    h.answer('end_turn');
    await next;
    adapter.dispose();
  });

  it('a prompt the agent never got (it went just before) ends its turn, so the bot is not blocked', async () => {
    let n = 0;
    const children: FakeChild[] = [];
    const spawnFn = () => {
      n += 1;
      const first = n === 1;
      const child = new FakeChild((c, msg) => {
        const id = msg.id as number;
        if (msg.method === 'initialize') c.emitLine({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
        else if (msg.method === 'session/new' || msg.method === 'session/load') {
          c.emitLine({ jsonrpc: '2.0', id, result: { sessionId: 'h-1' } });
          // The first agent goes right after its session started.
          if (first) c.kill();
        } else if (msg.method === 'session/prompt') {
          const text = (((msg.params as Record<string, unknown>).prompt as Array<Record<string, unknown>>)[0]?.text ?? '') as string;
          if (text === '/tools') c.emitLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'h-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: HERMES_TOOLS_OK } } } });
          c.emitLine({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
        }
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const { adapter } = ownAdapter(spawnFn);
    adapter.start({});
    expect((await collect(adapter.send('hello'))).at(-1)).toMatchObject({ type: 'error' });
    // The next message is not held behind a turn no agent will ever answer.
    expect((await collect(adapter.send('again'))).at(-1)).toMatchObject({ type: 'turn-end' });
    adapter.dispose();
  });

  it('a new adapter of the bot (a new session) waits for the last adapter\'s turn too', async () => {
    const h = slowHermes();
    const turnGate = { ended: null as Promise<void> | null };
    const a = ownAdapter(h.spawnFn, { turnGate });
    a.adapter.start({});
    const turn = collect(a.adapter.send('hello'));
    await vi.waitFor(() => expect(a.asks).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(h.children[0].sent.some((s) => s.msg.method === 'session/cancel')).toBe(true), { timeout: 5_000 });
    const b = ownAdapter(h.spawnFn, { turnGate });
    b.adapter.start({});
    const next = collect(b.adapter.send('again'));
    await deliberateSleep(150, 'a negative check: the new session must not prompt while the old turn runs');
    expect(h.texts).toEqual(['hello']);
    h.answer();
    await turn;
    await vi.waitFor(() => expect(h.texts).toEqual(['hello', 'again']), { timeout: 3_000 });
    h.answer('end_turn');
    await next;
    a.adapter.dispose();
    b.adapter.dispose();
  });

  it('a timed-out prompt on a resumed session is not sent again on a fresh one', async () => {
    const h = slowHermes();
    const { adapter, asks } = ownAdapter(h.spawnFn);
    adapter.start({ resumeSessionId: 'h-1' });
    const turn = collect(adapter.send('hello'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    await deliberateSleep(300, 'a negative check: past the prompt timeout, no second prompt may go out');
    h.answer();
    expect((await turn).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('timed out') });
    expect(h.texts).toEqual(['hello']);
    adapter.dispose();
  });

  it('says a photo was sent, since My Hermes is not shown it', async () => {
    const h = slowHermes();
    const { adapter } = ownAdapter(h.spawnFn);
    adapter.start({ systemPrompt: 'SYSTEM' });
    const turn = collect(adapter.send('what is wrong here?', { images: [{ mediaType: 'image/png', data: 'AAAA' }] }));
    await vi.waitFor(() => expect(h.texts).toHaveLength(1), { timeout: 5_000 });
    expect(h.texts[0]).toMatch(/^what is wrong here\?\n\n\(The owner attached a photo/);
    expect(h.texts[0]).not.toContain('SYSTEM');
    h.answer('end_turn');
    await turn;
    adapter.dispose();
  });

  it('a stop and a shutdown cancel without a gateway stop', async () => {
    const h = slowHermes();
    const { adapter, policy, asks } = ownAdapter(h.spawnFn);
    adapter.start({});
    const turn = collect(adapter.send('hello'));
    await vi.waitFor(() => expect(asks).toHaveLength(1), { timeout: 5_000 });
    adapter.interrupt();
    const child = h.children[0];
    expect(child.sent.some((s) => s.msg.method === 'session/cancel')).toBe(true);
    expect(answerOf(child, 'r-cmd')).toEqual({ outcome: 'selected', optionId: 'deny' });
    h.answer();
    await turn;
    const turn2 = collect(adapter.send('again'));
    await vi.waitFor(() => expect(asks).toHaveLength(2), { timeout: 5_000 });
    const quitting = adapter.shutdown();
    h.answer();
    await quitting;
    await turn2;
    expect(child.sent.filter((s) => s.msg.method === 'session/cancel').length).toBeGreaterThanOrEqual(2);
    expect(policy.unsettled).not.toHaveBeenCalled();
  });

  it('hands the MCP child a room-post token and --bot-surface=room-post', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-own-'));
    const agent = hermesAgent({});
    const binding = { workspaceId: 'ws-1', botId: 'bot-0000000a', role: 'lead' as const };
    const adapter = new AcpBrainAdapter({
      spawnSpec: SPEC, newSessionSettleMs: 0, mcpBundlePath: '/app/mcp/index.js', spawnFn: agent.spawnFn,
      bot: { binding, cwd: dir, wmuxDir: dir }, hermes: hermesPolicy({ mode: 'own' }).policy,
    });
    try {
      adapter.start({});
      await collect(adapter.send('hi'));
      const sessionNew = agent.children[0].sent.find((s) => s.msg.method === 'session/new');
      const args = ((sessionNew?.msg.params as Record<string, unknown>).mcpServers as Array<Record<string, unknown>>)[0].args as string[];
      expect(args).toContain('--bot-surface=room-post');
      const tokenFile = args.find((a) => a.startsWith('--bot-token-file='))?.slice('--bot-token-file='.length) ?? '';
      expect(resolveCommanderToken(fs.readFileSync(tokenFile, 'utf8'))?.surface).toBe('room-post');
    } finally {
      adapter.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed without the wmux tools, before any spawn', async () => {
    const spawnFn = vi.fn(slowHermes().spawnFn);
    const { adapter } = ownAdapter(spawnFn, {}, null);
    adapter.start({});
    expect(await collect(adapter.send('hi'))).toEqual([{ type: 'error', message: expect.stringContaining(HERMES_MCP_MISSING_LEAD) }]);
    expect(spawnFn).not.toHaveBeenCalled();
    adapter.dispose();
  });
});
