// A scriptable stand-in for `claude -p` stream-json: a fake ChildProcess whose
// stdin lines are recorded and whose stdout the test writes. It answers the
// initialize handshake by itself and exits when its stdin closes.
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ChildBackend } from '../childBackend';

let nextPid = 3_900_000;

export class FakeClaude {
  readonly stdin: Array<Record<string, unknown>> = [];
  args: string[] = [];
  env: Record<string, string> = {};
  cwd = '';
  spawns = 0;
  /** Answer the initialize handshake (false: never answer). */
  handshake = true;
  private child: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; exitCode: number | null; pid: number }) | null = null;

  backend(): ChildBackend {
    return new ChildBackend(
      (_command, args, cwd, env) => this.spawn(args, cwd, env),
      () => this.exit(null, 'SIGKILL'),
    );
  }

  private spawn(args: string[], cwd: string, env: Record<string, string>): ChildProcessWithoutNullStreams {
    this.spawns += 1;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let buffer = '';
    const stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        buffer += chunk.toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
          buffer = buffer.slice(index + 1);
          this.stdin.push(line);
          const request = line.request as Record<string, unknown> | undefined;
          if (line.type === 'control_request' && request?.subtype === 'initialize' && this.handshake) {
            this.out({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: {} } });
          }
        }
        callback();
      },
    });
    stdin.on('finish', () => this.exit(0, null));
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: nextPid++, exitCode: null as number | null, signalCode: null });
    this.child = child;
    setImmediate(() => child.emit('spawn'));
    return child as unknown as ChildProcessWithoutNullStreams;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  out(record: Record<string, unknown>): void {
    this.child?.stdout.write(`${JSON.stringify(record)}\n`);
  }

  exit(code: number | null, signal: string | null): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.exitCode = code ?? -1;
    setImmediate(() => {
      child.emit('exit', code, signal);
      child.stdout.end();
      setImmediate(() => child.emit('close', code, signal));
    });
  }

  /** Every control_response written for this request id. */
  responses(requestId: string): Array<Record<string, unknown>> {
    return this.stdin.flatMap((line) => {
      const response = line.response as Record<string, unknown> | undefined;
      return line.type === 'control_response' && response?.request_id === requestId ? [response.response as Record<string, unknown>] : [];
    });
  }

  canUseTool(requestId: string, toolName: string, input: Record<string, unknown>, toolUseId?: string): void {
    this.out({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: toolName, input, ...(toolUseId ? { tool_use_id: toolUseId } : {}) },
    });
  }

  toolUse(id: string, name: string, input: Record<string, unknown>): void {
    this.out({ type: 'assistant', session_id: 's', message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  }

  result(subtype = 'success', extra: Record<string, unknown> = {}): void {
    this.out({ type: 'result', subtype, session_id: 's', usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
  }
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check` holds, polling briefly. */
export async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await tick(5);
  }
}
