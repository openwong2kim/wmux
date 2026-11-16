// R2 (a) — with no Rust terminal module nothing can start (there is no other
// engine). Restored sessions are held, not attempted: no recoveryError, so no
// retention clock, and the holdReason keeps every TTL off them (StateWriter,
// covered in StateWriter.test.ts). A create or promote that meets the missing
// module answers TERMINAL_CORE_MISSING. The boot wiring (recoverSessions,
// promoteSession in index.ts) is checked live: module renamed away, then back.
import { describe, expect, it } from 'vitest';
import { DaemonSessionManager } from '../DaemonSessionManager';
import { DaemonPipeServer } from '../DaemonPipeServer';
import type { DaemonSession } from '../types';
import { TerminalCoreMissingError, TERMINAL_CORE_MISSING } from '../../shared/terminalPty';

function session(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    id: 'daemon-held', state: 'detached', pid: 0, cmd: 'pwsh.exe', cwd: 'C:\\', cols: 80, rows: 24,
    createdAt: new Date(0).toISOString(), lastActivity: new Date(0).toISOString(), deadTtlHours: 24,
    ...overrides,
  } as DaemonSession;
}

describe('holdPendingRecovery', () => {
  it('holds the session suspended, starting no retention clock', () => {
    const manager = new DaemonSessionManager();
    manager.holdPendingRecovery(session());
    const held = manager.getPendingRecovery('daemon-held');
    expect(held).toMatchObject({ state: 'suspended', holdReason: 'terminal-core-missing' });
    expect(held?.recoveryError).toBeUndefined();
    expect(held?.recoveryPendingSince).toBeUndefined();
    // No clock to restart for a pane that asks for it either.
    expect(manager.touchPendingRecovery('daemon-held')).toBe(false);
    expect(manager.isStartPending('daemon-held')).toBe(false);
  });

  it('leaves a WSL entry\'s own error and clock as they were', () => {
    const manager = new DaemonSessionManager();
    const since = new Date(Date.now() - 3_600_000).toISOString();
    manager.holdPendingRecovery(session({ cmd: 'wsl.exe', recoveryError: 'distro unavailable', recoveryPendingSince: since }));
    expect(manager.getPendingRecovery('daemon-held')).toMatchObject({
      holdReason: 'terminal-core-missing', recoveryError: 'distro unavailable', recoveryPendingSince: since,
    });
  });
});

describe('TERMINAL_CORE_MISSING over the daemon pipe', () => {
  it('carries the code with the message, and only for a missing core', async () => {
    const server = new DaemonPipeServer('unused-pipe');
    server.onRpc('test.create', async () => { throw new TerminalCoreMissingError('Native terminal core lacks pty-v1'); });
    server.onRpc('test.other', async () => { throw new Error('spawn failed'); });
    const dispatch = (method: string) => (server as unknown as {
      dispatch(request: { id: string; method: string; params: object }, clientId: string): Promise<Record<string, unknown>>;
    }).dispatch({ id: '1', method, params: {} }, 'client');
    const missing = await dispatch('test.create');
    expect(missing).toMatchObject({ ok: false, code: TERMINAL_CORE_MISSING });
    expect(String(missing.error)).toContain('Native terminal core lacks pty-v1');
    expect(String(missing.error)).toContain('Reinstall wmux');
    const other = await dispatch('test.other');
    expect(other).toMatchObject({ ok: false, error: 'spawn failed' });
    expect(other).not.toHaveProperty('code');
  });
});
