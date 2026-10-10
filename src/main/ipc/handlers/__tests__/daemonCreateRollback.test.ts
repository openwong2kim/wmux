import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withDaemonCreateRollback, ROLLBACK_RATE_LIMIT_RETRY_MS } from '../daemonCreateRollback';

function deps(rpc = vi.fn(async () => ({}))) {
  return { rpc, undoLocal: vi.fn(), sleep: vi.fn(async () => undefined) };
}

describe('withDaemonCreateRollback', () => {
  it('destroys the session and rethrows the original error when attach fails', async () => {
    const d = deps();
    const original = new Error('rate limited (global)');
    await expect(withDaemonCreateRollback('daemon-abc', d, async () => { throw original; })).rejects.toBe(original);
    expect(d.rpc).toHaveBeenCalledTimes(1);
    expect(d.rpc).toHaveBeenCalledWith('daemon.destroySession', { id: 'daemon-abc' });
    expect(d.undoLocal).toHaveBeenCalledTimes(1);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('retries a rate-limited destroy once after the limiter window', async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new Error('rate limited (global)'))
      .mockResolvedValueOnce({});
    const d = deps(rpc);
    const original = new Error('Session pipe connection timeout: daemon-abc');
    await expect(withDaemonCreateRollback('daemon-abc', d, async () => { throw original; })).rejects.toBe(original);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(ROLLBACK_RATE_LIMIT_RETRY_MS);
  });

  it('never masks the original error when destroy and local undo both fail', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('rate limited'));
    const d = deps(rpc);
    d.undoLocal.mockImplementation(() => { throw new Error('undo boom'); });
    const original = new Error('attach failed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(withDaemonCreateRollback('daemon-abc', d, async () => { throw original; })).rejects.toBe(original);
    expect(rpc).toHaveBeenCalledTimes(2); // one retry, not a loop
    warn.mockRestore();
  });

  it('makes no destroy call on the happy path', async () => {
    const d = deps();
    await expect(withDaemonCreateRollback('daemon-abc', d, async () => 42)).resolves.toBe(42);
    expect(d.rpc).not.toHaveBeenCalled();
    expect(d.undoLocal).not.toHaveBeenCalled();
  });

  it('wraps createSession through connectSessionPipe in the daemon PTY_CREATE handler', () => {
    // Structural: pty.handler.ts imports electron and cannot load under vitest.
    const source = fs.readFileSync(path.join(__dirname, '..', 'pty.handler.ts'), 'utf-8');
    const wrapAt = source.indexOf('await withDaemonCreateRollback(sessionId,');
    expect(wrapAt).toBeGreaterThanOrEqual(0);
    const region = source.slice(wrapAt, source.indexOf('scheduleInitialCommand(', wrapAt));
    expect(region).toContain("daemonClient.rpc('daemon.createSession'");
    expect(region).toContain("daemonClient.rpc('daemon.attachSession'");
    expect(region).toContain('await daemonClient.connectSessionPipe(sessionId);\n      });');
  });
});
