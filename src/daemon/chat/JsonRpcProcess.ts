import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAgent, stopAgent } from './agentProcess';
import { StringDecoder } from 'node:string_decoder';

/** Bounded JSONL transport for the official Codex stdio protocol. */
export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
    private onMessage: (method: string, params: unknown, id?: string | number) => void,
    private onClose: (reason: string) => void) {
    this.child = spawnAgent(command, args, cwd, env);
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { this.fail('Agent frame exceeds 4 MiB'); return; }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (!value || typeof value !== 'object') throw new Error('invalid frame');
          if (typeof value.method === 'string') {
            this.onMessage(value.method, value.params, typeof value.id === 'number' || typeof value.id === 'string' ? value.id : undefined);
          } else if (typeof value.id === 'number') {
            const request = this.pending.get(value.id);
            if (!request) continue;
            this.pending.delete(value.id); clearTimeout(request.timer);
            if (value.error) request.reject(new Error(String(value.error.message ?? 'Agent request failed')));
            else request.resolve(value.result);
          }
        } catch { this.fail('Invalid agent protocol frame'); return; }
      }
    });
    // Drain stderr, but never put credentials or conversation content in logs.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail('Agent input closed'));
    this.child.on('error', () => this.fail('Unable to launch agent executable'));
    this.child.on('exit', () => this.fail('Agent process exited'));
  }
  private write(value: unknown): void {
    if (this.closed) throw new Error('Agent disconnected');
    const line = JSON.stringify(value) + '\n';
    if (this.child.stdin.writableLength + Buffer.byteLength(line) > 1024 * 1024) throw new Error('Agent input backpressure');
    this.child.stdin.write(line);
  }
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('Agent request outcome is unconfirmed'));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  notify(method: string, params: unknown): void { this.write({ method, params }); }
  respond(id: string | number, result: unknown): void { this.write({ id, result }); }
  reject(id: string | number): void { this.write({ id, error: { code: -32601, message: 'Unsupported client request' } }); }
  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
    this.pending.clear(); stopAgent(this.child); this.onClose(reason);
  }
  close(): void { this.fail('Agent connection closed'); }
}
