import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpBrainAdapter } from '../AcpBrainAdapter';
import { commanderTokenWorkspace } from '../commanderTrust';
import type { BrainEvent } from '../BrainAdapter';

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
