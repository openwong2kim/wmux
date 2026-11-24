/**
 * `wmux remote approve <task-id> <prompt-id> allow|deny` — from the pane that
 * sent the task, through the app's pipe method (the same one remote_approve
 * calls). Bad arguments never reach it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
  sendDaemonRequest: vi.fn(),
  isDefinitelyNotRunning: () => false,
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendRequest, sendDaemonRequest } from '../../client';
import { resolveSelfContext } from '../../identity';
import { handleRemote, parseApproveArgs } from '../remote';

const mainRpc = sendRequest as unknown as ReturnType<typeof vi.fn>;
const daemonRpc = sendDaemonRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

class ExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`exit(${code})`);
  }
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const PROMPT = '0123456789abcdef';

function printed(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(' ')).join('\n');
}

async function run(args: string[], json = false): Promise<number | undefined> {
  try {
    await handleRemote('approve', args, json);
    return 0;
  } catch (err) {
    if (err instanceof ExitCalled) return err.code;
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  selfContext.mockResolvedValue({ ptyId: 'pty-a' });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseApproveArgs', () => {
  it('takes exactly a task id, a 16-hex prompt id and allow or deny', () => {
    expect(parseApproveArgs(['rt-1', PROMPT, 'allow'])).toEqual({ taskId: 'rt-1', promptId: PROMPT, decision: 'allow' });
    expect(parseApproveArgs(['rt-1', PROMPT, 'deny', '--json'])).toEqual({ taskId: 'rt-1', promptId: PROMPT, decision: 'deny' });
    for (const bad of [[], ['rt-1', PROMPT], ['rt-1', 'p-1', 'allow'], ['rt-1', PROMPT, 'yes'], ['rt-1', PROMPT, 'allow', 'extra']]) {
      expect(typeof parseApproveArgs(bad)).toBe('string');
    }
  });
});

describe('wmux remote approve', () => {
  it('sends through the app with the pane identity, and prints the outcome', async () => {
    mainRpc.mockResolvedValueOnce({ id: 'x', ok: true, result: { ok: true, taskId: 'rt-1', messageId: 'ap-1', promptId: PROMPT, decision: 'allow', tool: 'Bash', outcome: { messageId: 'ap-1', outcome: 'done' } } });
    expect(await run(['rt-1', PROMPT, 'allow'])).toBe(0);
    expect(mainRpc).toHaveBeenCalledWith('a2a.remote.approve', { taskId: 'rt-1', promptId: PROMPT, decision: 'allow', senderPtyId: 'pty-a' }, expect.any(Number));
    expect(daemonRpc).not.toHaveBeenCalled();
    expect(printed()).toContain('Allow for Bash (ap-1): done on the other PC.');
  });

  it('a bad argument, or no pane identity, sends nothing', async () => {
    expect(await run(['rt-1', PROMPT, 'yes'])).toBe(1);
    selfContext.mockResolvedValue({});
    expect(await run(['rt-1', PROMPT, 'deny'])).toBe(1);
    expect(mainRpc).not.toHaveBeenCalled();
  });

  it('a refusal here (allow on a deny-only prompt) exits 1 with its reason', async () => {
    mainRpc.mockResolvedValueOnce({ id: 'x', ok: true, result: { ok: false, error: 'deny-only', message: 'that PC takes only deny for this prompt; nothing was sent' } });
    expect(await run(['rt-1', PROMPT, 'allow'])).toBe(1);
    expect(printed()).toContain('deny-only: that PC takes only deny for this prompt');
  });

  it('rate-limited there: exits 1 and says when to try again', async () => {
    mainRpc.mockResolvedValueOnce({ id: 'x', ok: true, result: { ok: true, taskId: 'rt-1', messageId: 'ap-3', promptId: PROMPT, decision: 'deny', tool: 'Bash', outcome: { messageId: 'ap-3', outcome: 'not-done', reason: 'rate-limited', retryAfterMs: 41_200 } } });
    expect(await run(['rt-1', PROMPT, 'deny'])).toBe(1);
    expect(printed()).toContain('Try again in 42 s.');
  });

  it('with --json: the result printed, and the same exit status as the text (1 for not done or uncertain)', async () => {
    const result = (outcome?: Record<string, unknown>) => ({
      id: 'x', ok: true, result: { ok: true, taskId: 'rt-1', messageId: 'ap-4', promptId: PROMPT, decision: 'deny', tool: 'Bash', ...(outcome ? { outcome: { messageId: 'ap-4', ...outcome } } : { pending: true }) },
    });
    mainRpc.mockResolvedValueOnce(result({ outcome: 'not-done', reason: 'rate-limited', retryAfterMs: 60_000 }));
    expect(await run(['rt-1', PROMPT, 'deny'], true)).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({ outcome: { outcome: 'not-done', reason: 'rate-limited' } });
    mainRpc.mockResolvedValueOnce(result({ outcome: 'uncertain' }));
    expect(await run(['rt-1', PROMPT, 'deny'], true)).toBe(1);
    mainRpc.mockResolvedValueOnce(result({ outcome: 'done' }));
    expect(await run(['rt-1', PROMPT, 'deny'], true)).toBe(0);
    mainRpc.mockResolvedValueOnce(result());
    expect(await run(['rt-1', PROMPT, 'deny'], true)).toBe(0);
  });

  it('pending: says where the outcome shows', async () => {
    mainRpc.mockResolvedValueOnce({ id: 'x', ok: true, result: { ok: true, taskId: 'rt-1', messageId: 'ap-2', promptId: PROMPT, decision: 'deny', tool: 'Bash', pending: true } });
    expect(await run(['rt-1', PROMPT, 'deny'])).toBe(0);
    expect(printed()).toContain('detail.approvals');
  });
});
