import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAgent, stopAgent } from './agentProcess';
import { randomBytes } from 'node:crypto';
// eslint's legacy node resolver does not understand package export maps.
// eslint-disable-next-line import/no-unresolved
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { BASE_CAPABILITIES, array, body, deadline, printable, record, string, type ChatAdapter, type ChatAdapterContext } from './adapter';

export class OpenCodeChatAdapter implements ChatAdapter {
  readonly capabilities = { ...BASE_CAPABILITIES, resume: true, questions: true, fileDiff: true };
  private child?: ChildProcessWithoutNullStreams;
  private client?: OpencodeClient;
  private context!: ChatAdapterContext;
  private abort = new AbortController();
  private session = '';
  private active = false;
  private cancelRequested = false;
  private roles = new Map<string, string>();
  private parts = new Map<string, Record<string, unknown>>();
  constructor(private executable = 'opencode') {}

  async connect(context: ChatAdapterContext): Promise<string> {
    this.context = context;
    // Private loopback server, unpredictable credentials, no command-line secrets.
    const password = randomBytes(32).toString('hex');
    const child = this.child = spawnAgent(this.executable, ['serve', '--hostname=127.0.0.1', '--port=0'], context.cwd,
      { ...context.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'wmux' });
    child.stderr.resume();
    const url = await deadline(new Promise<string>((resolve, reject) => {
      let output = '';
      const data = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 16_384) { reject(new Error('Unexpected OpenCode startup output')); return; }
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) { child.stdout.off('data', data); child.stdout.resume(); resolve(match[1]); }
      };
      child.stdout.on('data', data);
      child.on('error', () => { reject(new Error('Unable to launch OpenCode')); context.disconnected('Unable to launch OpenCode'); });
      child.on('exit', () => { reject(new Error('OpenCode exited')); context.disconnected('OpenCode exited'); });
    }));
    const client = this.client = createOpencodeClient({ baseUrl: url, directory: context.cwd, throwOnError: true,
      headers: { Authorization: `Basic ${Buffer.from(`wmux:${password}`).toString('base64')}` },
      fetch: (request) => fetch(request, { signal: this.abort.signal }),
    });
    const response = context.sessionId
      ? await deadline(client.session.get({ sessionID: context.sessionId }))
      : await deadline(client.session.create({ title: 'wmux chat', permission: [{ permission: '*', pattern: '*', action: 'ask' }] }));
    this.session = string(record(response.data).id);
    if (!this.session || (context.sessionId && this.session !== context.sessionId)) throw new Error('OpenCode session identity mismatch');
    // This private server is the only execution owner. Restore its idle history
    // before consuming deltas, so an older snapshot cannot overwrite live text.
    const statuses = await deadline(client.session.status());
    const nativeStatus = record(record(statuses.data)[this.session]);
    if (nativeStatus.type && nativeStatus.type !== 'idle') throw new Error('OpenCode session is already running');
    const history = await deadline(client.session.messages({ sessionID: this.session, limit: 1000 }));
    for (const value of array(history.data)) {
      const message = record(value); const info = record(message.info);
      this.roles.set(string(info.id), string(info.role));
      for (const part of array(message.parts)) this.part(record(part));
    }
    const events = await deadline(client.event.subscribe({}, { sseMaxRetryAttempts: 0, onSseError: () => { if (!this.abort.signal.aborted) context.disconnected('OpenCode event stream disconnected'); } }));
    void (async () => {
      try {
        for await (const event of events.stream) await this.event(record(event));
        if (!this.abort.signal.aborted) context.disconnected('OpenCode event stream ended');
      } catch { if (!this.abort.signal.aborted) context.disconnected('OpenCode event stream disconnected'); }
    })();
    return this.session;
  }
  async prompt(text: string, _requestId: string): Promise<void> {
    if (!this.client || this.active) throw new Error('OpenCode unavailable or busy');
    this.active = true; this.cancelRequested = false;
    try {
      const result = await this.client.session.prompt({ sessionID: this.session, parts: [{ type: 'text', text }] });
      const message = record(result.data); const info = record(message.info);
      const error = record(info.error);
      // OpenCode returns this terminal message before abort() acknowledges.
      // It confirms a requested cancellation, not uncertain delivery.
      if (info.error && !(this.cancelRequested && error.name === 'MessageAbortedError')) {
        throw new Error(string(record(error.data).message) || string(error.message) || 'OpenCode turn failed');
      }
      this.roles.set(string(info.id), string(info.role));
      for (const part of array(message.parts)) this.part(record(part));
    } finally { this.active = false; }
  }
  async cancel(): Promise<void> {
    if (!this.client) throw new Error('OpenCode disconnected');
    this.cancelRequested = true;
    const result = await deadline(this.client.session.abort({ sessionID: this.session }));
    if (result.data !== true) throw new Error('OpenCode did not acknowledge cancellation');
  }
  close(): void { this.abort.abort(); if (this.child) stopAgent(this.child); this.child = undefined; this.client = undefined; }

  private part(part: Record<string, unknown>): void {
    if (part.sessionID !== this.session) return;
    const id = string(part.id); if (!id) return;
    this.parts.set(id, part);
    if (this.parts.size > 10_000) this.parts.delete(this.parts.keys().next().value!);
    const role = this.roles.get(string(part.messageID));
    if (part.type === 'text' || part.type === 'reasoning') {
      if (!role) return; // wait for authoritative message metadata, never guess user/agent.
      this.context.emit(role === 'user'
        ? { id, kind: 'user_text', text: string(part.text) }
        : { id, kind: 'assistant_text', text: string(part.text), thinking: part.type === 'reasoning' });
    } else if (part.type === 'tool') {
      const state = record(part.state); const input = printable(state.input);
      this.context.emit({ id, kind: 'tool_use', toolUseId: id, name: string(part.tool), argSummary: input.replace(/\s+/g, ' ').slice(0, 120), input: body(input) });
      if (state.status === 'completed' || state.status === 'error') {
        const output = printable(state.output ?? state.error);
        this.context.emit({ id: `${id}:result`, kind: 'tool_result', toolUseId: id, ok: state.status === 'completed',
          bytes: Buffer.byteLength(output), output: body(output),
          ...this.fileChanges(record(state.metadata), string(part.tool), record(state.input)) });
      }
    }
  }
  private fileChanges(metadata: Record<string, unknown>, tool: string, input: Record<string, unknown>) {
    // Native write results provide the path and existence flag, not filediff.
    // The successful tool input is the exact after-content; do not invent a
    // before-image or deletion count for an overwritten file.
    if (tool === 'write' && typeof metadata.filepath === 'string' && typeof input.content === 'string') {
      const patch = `After:\n${input.content}`;
      return { files: [{ path: metadata.filepath, patch: patch.slice(0, 2000), truncated: patch.length > 2000,
        ...(metadata.exists === false ? { additions: input.content.split('\n').length, deletions: 0 } : {}),
      }] };
    }
    const diff = record(metadata.filediff);
    if (typeof diff.file !== 'string' || typeof diff.before !== 'string' || typeof diff.after !== 'string') return {};
    const patch = `Before:\n${diff.before}\nAfter:\n${diff.after}`;
    return { files: [{ path: diff.file, patch: patch.slice(0, 2000), truncated: patch.length > 2000,
      ...(typeof diff.additions === 'number' ? { additions: diff.additions } : {}),
      ...(typeof diff.deletions === 'number' ? { deletions: diff.deletions } : {}),
    }] };
  }
  private async event(event: Record<string, unknown>): Promise<void> {
    const p = record(event.properties);
    const info = record(p.info); const part = record(p.part);
    if ((p.sessionID ?? info.sessionID ?? part.sessionID) !== this.session) return;
    if (event.type === 'message.updated') {
      this.roles.set(string(info.id), string(info.role));
      for (const value of this.parts.values()) if (value.messageID === info.id) this.part(value);
    } else if (event.type === 'message.part.updated') this.part(part);
    else if (event.type === 'message.part.delta' && p.field === 'text') {
      const old = this.parts.get(string(p.partID));
      if (old) this.part({ ...old, text: (string(old.text) + string(p.delta)).slice(0, 128_000) });
    } else if (event.type === 'permission.asked' && this.active) {
      // Do not block the SSE consumer while the user considers a request.
      void this.permission(p).catch(() => this.context.disconnected('Permission response was not confirmed'));
    } else if (event.type === 'question.asked' && this.active) {
      void this.question(p).catch(() => this.context.disconnected('Question response was not confirmed'));
    }
  }
  private async permission(p: Record<string, unknown>): Promise<void> {
    const answer = await this.context.request({ kind: 'permission', title: string(p.permission), detail: printable(p.patterns),
      options: [{ id: 'once', label: 'Allow once' }, { id: 'reject', label: 'Deny' }] });
    await this.client?.permission.reply({ requestID: string(p.id), reply: answer.optionId === 'once' ? 'once' : 'reject' });
  }
  private async question(p: Record<string, unknown>): Promise<void> {
    const questions = array(p.questions).map((entry, i) => {
      const q = record(entry); return { id: String(i), text: string(q.question), multiple: q.multiple === true,
        options: array(q.options).map((v) => string(record(v).label)) };
    });
    const answer = await this.context.request({ kind: 'question', title: 'Agent needs your input', questions, options: [] });
    if (answer.answers) await this.client?.question.reply({ requestID: string(p.id), answers: questions.map((q) => answer.answers?.[q.id] ?? []) });
    else await this.client?.question.reject({ requestID: string(p.id) });
  }
}
