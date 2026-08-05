/**
 * `wmux set-status` / `wmux set-progress` — issue #800.
 *
 * `meta.*` writes are workspace-scoped SERVER-SIDE from `senderPtyId` (U8,
 * meta.rpc.ts). The CLI never attached one, so both commands failed 100% of the
 * time with "cannot resolve the calling pane's workspace — send a verified
 * senderPtyId", even from a shell inside a pane where `wmux send` self-resolved
 * fine, and even with an explicit `--pane`.
 *
 * What these tests pin:
 *  1. senderPtyId rides along on both commands (verified walk),
 *  2. `--pane <ptyId>` overrides the walk and is NOT swallowed into the payload,
 *  3. env WMUX_PTY_ID is the fallback when the walk misses (descendant shells),
 *  4. no resolvable identity → exit 1 BEFORE any RPC, with an actionable message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
  sendDaemonRequest: vi.fn(),
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendRequest } from '../../client';
import { resolveSelfContext } from '../../identity';
import { handleSystem } from '../system';

const rpc = sendRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

class ExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`exit(${code})`);
  }
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WMUX_PTY_ID;
  selfContext.mockResolvedValue({ ptyId: 'pty-self', workspaceId: 'ws-self' });
  rpc.mockResolvedValue({ ok: true, result: { ok: true } });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.WMUX_PTY_ID;
});

describe('set-status / set-progress carry a senderPtyId (#800)', () => {
  it('attaches the verified-walk ptyId to meta.setStatus', async () => {
    await handleSystem('set-status', ['building'], false);
    expect(rpc).toHaveBeenCalledWith('meta.setStatus', {
      text: 'building',
      senderPtyId: 'pty-self',
    });
  });

  it('attaches the verified-walk ptyId to meta.setProgress', async () => {
    await handleSystem('set-progress', ['42'], false);
    expect(rpc).toHaveBeenCalledWith('meta.setProgress', {
      value: 42,
      senderPtyId: 'pty-self',
    });
  });

  it('lets --pane override the walk without leaking into the payload', async () => {
    await handleSystem('set-status', ['hello', '--pane', 'pty-other'], false);
    expect(rpc).toHaveBeenCalledWith('meta.setStatus', {
      text: 'hello',
      senderPtyId: 'pty-other',
    });
    // The walk must not even be attempted when the caller named a pane.
    expect(selfContext).not.toHaveBeenCalled();
  });

  it('reads the payload past a leading --pane instead of taking the flag as text', async () => {
    await handleSystem('set-status', ['--pane', 'pty-other', 'hello'], false);
    expect(rpc).toHaveBeenCalledWith('meta.setStatus', {
      text: 'hello',
      senderPtyId: 'pty-other',
    });
  });

  it('falls back to WMUX_PTY_ID when the walk misses', async () => {
    selfContext.mockResolvedValue({});
    process.env.WMUX_PTY_ID = 'pty-env';
    await handleSystem('set-progress', ['7'], false);
    expect(rpc).toHaveBeenCalledWith('meta.setProgress', {
      value: 7,
      senderPtyId: 'pty-env',
    });
  });

  it('survives a walk that throws (main pipe down) via the env hint', async () => {
    selfContext.mockRejectedValue(new Error('pipe closed'));
    process.env.WMUX_PTY_ID = 'pty-env';
    await handleSystem('set-status', ['headless'], false);
    expect(rpc).toHaveBeenCalledWith('meta.setStatus', {
      text: 'headless',
      senderPtyId: 'pty-env',
    });
  });

  it('accepts the --pane=<v> form instead of publishing it as the status', async () => {
    // The two-parser version posted the literal "--pane=pty-other" to the
    // caller's own workspace and exited 0.
    await handleSystem('set-status', ['--pane=pty-other', 'hello'], false);
    expect(rpc).toHaveBeenCalledWith('meta.setStatus', {
      text: 'hello',
      senderPtyId: 'pty-other',
    });
  });

  it('joins the whole payload instead of dropping every word after the first', async () => {
    await handleSystem('set-status', ['Build', 'failed'], false);
    expect(rpc).toHaveBeenCalledWith('meta.setStatus', {
      text: 'Build failed',
      senderPtyId: 'pty-self',
    });
  });

  it('rejects --pane with no value rather than eating the payload', async () => {
    await expect(handleSystem('set-status', ['--pane'], false)).rejects.toThrow(ExitCalled);
    await expect(handleSystem('set-status', ['--pane', '-x', 'hi'], false)).rejects.toThrow(
      ExitCalled,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects an unknown flag rather than publishing it as text', async () => {
    await expect(handleSystem('set-status', ['--panne', 'pty-x'], false)).rejects.toThrow(
      ExitCalled,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('passes a dash-leading payload through after --', async () => {
    await handleSystem('set-status', ['--', '--not-a-flag'], false);
    expect(rpc).toHaveBeenCalledWith('meta.setStatus', {
      text: '--not-a-flag',
      senderPtyId: 'pty-self',
    });
  });

  it('still treats a negative progress value as out-of-range, not an unknown flag', async () => {
    await expect(handleSystem('set-progress', ['-5'], false)).rejects.toThrow(ExitCalled);
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/between 0 and 100/);
  });

  it('fails closed BEFORE any RPC when no identity resolves', async () => {
    selfContext.mockResolvedValue({});
    await expect(handleSystem('set-status', ['nope'], false)).rejects.toThrow(ExitCalled);
    expect(rpc).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/--pane <ptyId>/);
  });
});
