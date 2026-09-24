import { randomUUID } from 'node:crypto';
import { BASE_CAPABILITIES, array, body, printable, record, string, type ChatAdapter, type ChatAdapterContext } from './adapter';
import { JsonRpcProcess } from './JsonRpcProcess';

/** Independently implemented against OpenAI's documented app-server protocol. */
export class CodexChatAdapter implements ChatAdapter {
  readonly capabilities = { ...BASE_CAPABILITIES, resume: true, questions: true, fileDiff: true };
  private rpc?: JsonRpcProcess;
  private context!: ChatAdapterContext;
  private session = '';
  private turn = '';
  private texts = new Map<string, string>();
  private completion?: { resolve: () => void; reject: (e: Error) => void };
  constructor(private executable = 'codex') {}

  async connect(context: ChatAdapterContext): Promise<string> {
    this.context = context;
    this.rpc = new JsonRpcProcess(this.executable, ['app-server', '--listen', 'stdio://'], context.cwd, context.env,
      (method, params, id) => {
        if (id !== undefined) void this.request(method, record(params), id).catch(() => this.close());
        else this.notification(method, record(params));
      }, (reason) => { this.completion?.reject(new Error(reason)); this.completion = undefined; context.disconnected(reason); });
    await this.rpc.request('initialize', { clientInfo: { name: 'wmux_chat', title: 'wmux', version: '1.0.0' } });
    this.rpc.notify('initialized', {});
    // Explicit approval and sandbox settings: never inherit an unattended mode.
    const params = { cwd: context.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    const response = record(await this.rpc.request(context.sessionId ? 'thread/resume' : 'thread/start',
      context.sessionId ? { ...params, threadId: context.sessionId } : params));
    const thread = record(response.thread);
    this.session = string(thread.id);
    if (!this.session || (context.sessionId && this.session !== context.sessionId)) throw new Error('Codex session identity mismatch');
    for (const turn of array(thread.turns)) {
      const t = record(turn);
      for (const item of array(t.items)) this.item(record(item), true);
      if (t.status === 'inProgress') throw new Error('Codex session is still running in another client');
    }
    return this.session;
  }

  async prompt(text: string, _requestId: string): Promise<void> {
    if (!this.rpc || this.completion) throw new Error('Codex is unavailable or busy');
    let resolve!: () => void; let reject!: (e: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Attach immediately: transport death before turn/start returns must not be unhandled.
    void done.catch(() => undefined);
    this.completion = { resolve, reject };
    this.texts.clear(); this.turn = '';
    try {
      const response = record(await this.rpc.request('turn/start', { threadId: this.session, input: [{ type: 'text', text }] }));
      this.turn = string(record(response.turn).id);
      if (!this.turn) throw new Error('Codex returned no turn identity');
      await done;
    } finally { this.completion = undefined; this.turn = ''; }
  }
  async cancel(): Promise<void> {
    if (!this.rpc || !this.turn) throw new Error('Codex turn has not been confirmed yet');
    await this.rpc.request('turn/interrupt', { threadId: this.session, turnId: this.turn });
  }
  close(): void { this.rpc?.close(); this.rpc = undefined; }

  private notification(method: string, params: Record<string, unknown>): void {
    if (string(params.threadId) !== this.session) return;
    const turnId = string(params.turnId) || string(record(params.turn).id);
    if (this.turn && turnId && this.turn !== turnId) return;
    if (method === 'turn/started' && this.completion) this.turn = string(record(params.turn).id);
    if (method === 'item/started' || method === 'item/completed') this.item(record(params.item), method === 'item/completed');
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta') {
      const id = string(params.itemId); if (!id) return;
      const text = ((this.texts.get(id) ?? '') + string(params.delta)).slice(0, 128_000);
      this.texts.set(id, text);
      this.context.emit({ id, kind: 'assistant_text', text, thinking: method.includes('reasoning'), turnId });
    }
    if (method === 'turn/completed') {
      const turn = record(params.turn);
      for (const item of array(turn.items)) this.item(record(item), true);
      if (turn.status === 'failed') this.completion?.reject(new Error(string(record(turn.error).message) || 'Codex turn failed'));
      else this.completion?.resolve();
    }
  }

  private item(item: Record<string, unknown>, complete: boolean): void {
    const id = string(item.id); if (!id) return;
    const type = string(item.type);
    if (type === 'userMessage') {
      const text = array(item.content).map((part) => string(record(part).text)).filter(Boolean).join('\n');
      this.context.emit({ id, kind: 'user_text', text, turnId: this.turn });
    } else if (type === 'agentMessage' || type === 'reasoning' || type === 'plan') {
      const text = type === 'reasoning' ? array(item.summary).map(string).join('\n') : string(item.text);
      this.texts.set(id, text);
      this.context.emit({ id, kind: 'assistant_text', text, thinking: type !== 'agentMessage', turnId: this.turn });
    } else {
      const input = type === 'commandExecution' ? string(item.command) : printable(item.arguments ?? item.changes ?? item);
      this.context.emit({ id, kind: 'tool_use', toolUseId: id, name: string(item.tool) || type,
        argSummary: input.replace(/\s+/g, ' ').slice(0, 120), input: body(input), turnId: this.turn });
      if (complete) {
        const output = printable(item.aggregatedOutput ?? item.result ?? item.changes ?? item.error ?? '');
        this.context.emit({ id: `${id}:result`, kind: 'tool_result', toolUseId: id,
          ok: !['failed', 'declined'].includes(string(item.status)) && !item.error,
          bytes: Buffer.byteLength(output), output: type === 'fileChange' ? undefined : body(output), diffLike: type === 'fileChange', turnId: this.turn,
          ...(type === 'fileChange' ? { files: array(item.changes).slice(0, 16).map((value) => {
            const change = record(value); const patch = string(change.diff); const lines = patch.split('\n');
            return { path: string(change.path), patch: patch.slice(0, 2000), truncated: patch.length > 2000,
              additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
              deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length };
          }) } : {}),
        });
      }
    }
  }

  private async request(method: string, params: Record<string, unknown>, id: string | number): Promise<void> {
    if (!this.rpc) return;
    if (params.threadId !== this.session || !this.completion || (this.turn && params.turnId !== this.turn)) { this.rpc.reject(id); return; }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const answer = await this.context.request({ kind: 'permission', title: method.includes('commandExecution') ? 'Run command' : 'Apply file changes',
        detail: printable(params.command ?? params.reason ?? params), options: [{ id: 'accept', label: 'Allow once' }, { id: 'decline', label: 'Deny' }] });
      this.rpc?.respond(id, { decision: answer.optionId === 'accept' ? 'accept' : 'decline' });
    } else if (method === 'item/permissions/requestApproval') {
      const answer = await this.context.request({ kind: 'permission', title: 'Grant requested permissions', detail: printable(params.permissions),
        options: [{ id: 'accept', label: 'Allow this turn' }, { id: 'decline', label: 'Deny' }] });
      this.rpc?.respond(id, { permissions: answer.optionId === 'accept' ? record(params.permissions) : {}, scope: 'turn' });
    } else if (method === 'item/tool/requestUserInput') {
      const questions = array(params.questions).map((entry) => {
        const q = record(entry); return { id: string(q.id) || randomUUID(), text: string(q.question), secret: q.isSecret === true,
          options: array(q.options).map((option) => string(record(option).label)).filter(Boolean) };
      });
      const answer = await this.context.request({ kind: 'question', title: 'Agent needs your input', questions, options: [] });
      this.rpc?.respond(id, { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: answer.answers?.[q.id] ?? [] }])) });
    } else { this.rpc.reject(id); }
  }
}
