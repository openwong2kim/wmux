import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAgent, stopAgent } from './agentProcess';
import { Readable, Writable, Transform } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { BASE_CAPABILITIES, array, body, deadline, printable, record, string, type ChatAdapter, type ChatAdapterContext } from './adapter';

/** Uses the protocol SDK only; no editor/competitor implementation is included. */
export class AcpChatAdapter implements ChatAdapter {
  readonly capabilities = { ...BASE_CAPABILITIES, fileDiff: true };
  private child?: ChildProcessWithoutNullStreams;
  private connection?: acp.ClientConnection;
  private context!: ChatAdapterContext;
  private session = '';
  private counter = 0;
  private message?: { id: string; text: string; kind: string };
  private loading = false;
  private turnId = '';
  private active = false;
  constructor(private executable: string, private args: string[]) {}

  async connect(context: ChatAdapterContext): Promise<string> {
    this.context = context;
    const child = this.child = spawnAgent(this.executable, this.args, context.cwd, context.env);
    child.stderr.resume();
    child.on('error', () => context.disconnected('Unable to launch ACP agent'));
    child.on('exit', () => context.disconnected('ACP agent exited'));
    // Bound each NDJSON frame before it reaches the SDK decoder.
    let bytes = 0;
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        bytes = byte === 10 ? 0 : bytes + 1;
        if (bytes > 4 * 1024 * 1024) { callback(new Error('ACP frame exceeds 4 MiB')); return; }
      }
      callback(null, chunk);
    } });
    bounded.on('error', () => { this.close(); context.disconnected('ACP protocol frame too large'); });
    child.stdout.pipe(bounded);
    this.connection = acp.client({ name: 'wmux' })
      .onNotification(acp.methods.client.session.update, ({ params }) => this.update(params))
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        if (params.sessionId !== this.session || !this.active) return { outcome: { outcome: 'cancelled' as const } };
        const answer = await context.request({ kind: 'permission', title: params.toolCall.title ?? 'Agent permission',
          detail: printable(params.toolCall.rawInput ?? params.toolCall.content),
          options: params.options.map((o) => ({ id: o.optionId, label: o.name })) });
        const option = params.options.find((o) => o.optionId === answer.optionId);
        return { outcome: option ? { outcome: 'selected' as const, optionId: option.optionId } : { outcome: 'cancelled' as const } };
      }).connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(bounded) as unknown as ReadableStream<Uint8Array>));
    this.connection.closed.then(() => context.disconnected('ACP connection closed'), () => context.disconnected('ACP connection failed'));
    const init = await deadline(this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'wmux', version: '1.0.0' },
    }));
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error('Unsupported ACP protocol version');
    this.capabilities.resume = init.agentCapabilities?.loadSession === true;
    if (context.sessionId) {
      if (!this.capabilities.resume) throw new Error('This ACP agent cannot restore sessions');
      this.session = context.sessionId; this.loading = true;
      try { await deadline(this.connection.agent.request(acp.methods.agent.session.load, { sessionId: this.session, cwd: context.cwd, mcpServers: [] })); }
      finally { this.loading = false; this.message = undefined; }
    } else {
      const result = await deadline(this.connection.agent.request(acp.methods.agent.session.new, { cwd: context.cwd, mcpServers: [] }));
      this.session = result.sessionId;
    }
    if (!this.session) throw new Error('ACP returned no session identity');
    return this.session;
  }
  async prompt(text: string, requestId: string): Promise<void> {
    if (!this.connection || this.active) throw new Error('ACP agent unavailable or busy');
    this.active = true; this.turnId = requestId; this.message = undefined;
    this.context.emit({ id: requestId, kind: 'user_text', text, turnId: requestId });
    try {
      await this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId: this.session, prompt: [{ type: 'text', text }] });
    } finally { this.active = false; this.message = undefined; }
  }
  async cancel(): Promise<void> {
    if (!this.connection) throw new Error('ACP agent disconnected');
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.session });
  }
  close(): void { this.connection?.close(); if (this.child) stopAgent(this.child); this.connection = undefined; this.child = undefined; }

  private update(params: acp.SessionNotification): void {
    if (params.sessionId !== this.session) return;
    const update = record(params.update); const kind = string(update.sessionUpdate);
    if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(kind)) {
      if (kind === 'user_message_chunk' && !this.loading) return;
      const content = record(update.content); if (content.type !== 'text') return;
      if (!this.message || this.message.kind !== kind) this.message = { id: `acp:${++this.counter}`, text: '', kind };
      this.message.text = (this.message.text + string(content.text)).slice(0, 128_000);
      this.context.emit(kind === 'user_message_chunk'
        ? { id: this.message.id, kind: 'user_text', text: this.message.text, turnId: this.turnId }
        : { id: this.message.id, kind: 'assistant_text', text: this.message.text, thinking: kind === 'agent_thought_chunk', turnId: this.turnId });
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.message = undefined;
      const id = string(update.toolCallId); if (!id) return;
      if (kind === 'tool_call') {
        const input = printable(update.rawInput ?? update.content ?? '');
        this.context.emit({ id, kind: 'tool_use', toolUseId: id, name: string(update.title) || 'Tool',
          argSummary: input.replace(/\s+/g, ' ').slice(0, 120), input: body(input), turnId: this.turnId });
      }
      if (update.status === 'completed' || update.status === 'failed') {
        const content = array(update.content);
        const output = printable(update.rawOutput ?? content);
        this.context.emit({ id: `${id}:result`, kind: 'tool_result', toolUseId: id, ok: update.status === 'completed',
          bytes: Buffer.byteLength(output), output: body(output), diffLike: content.some((v) => record(v).type === 'diff'), turnId: this.turnId,
          files: content.filter((v) => record(v).type === 'diff').slice(0, 16).map((value) => {
            const diff = record(value); const patch = `Before:\n${string(diff.oldText)}\nAfter:\n${string(diff.newText)}`;
            return { path: string(diff.path), patch: patch.slice(0, 2000), truncated: patch.length > 2000 };
          }) });
      }
    } else if (kind === 'plan') {
      this.message = undefined;
      this.context.emit({ id: `plan:${this.turnId || ++this.counter}`, kind: 'assistant_text', thinking: true,
        text: array(update.entries).map((v) => { const e = record(v); return `- [${e.status === 'completed' ? 'x' : ' '}] ${string(e.content)}`; }).join('\n'), turnId: this.turnId });
    }
  }
}
