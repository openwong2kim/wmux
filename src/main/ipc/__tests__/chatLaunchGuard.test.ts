// The Resume pill and auto-resume ask the daemon before they type a line that
// starts an agent: refused while chat v2 owns the pane, a move holds it or an
// active chat holds the conversation the line names, and on any failure but a
// daemon that predates the question.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CHATV2_LAUNCH_ALLOWED_RPC } from '../../../shared/chatv2/ipc';
import { launchAllowedByChat } from '../handlers/chatLaunchGuard';

describe('launchAllowedByChat', () => {
  it('follows the daemon, and refuses whenever the answer is not a plain yes', async () => {
    const rpc = vi.fn(async () => ({ allowed: false }));
    expect(await launchAllowedByChat({ rpc }, 'pty-1', 'claude --resume abc')).toBe(false);
    expect(rpc).toHaveBeenCalledWith(CHATV2_LAUNCH_ALLOWED_RPC, { paneId: 'pty-1', line: 'claude --resume abc' }, { timeoutMs: 5_000 });
    expect(await launchAllowedByChat({ rpc: async () => ({ allowed: true }) }, 'pty-1', 'claude')).toBe(true);
    expect(await launchAllowedByChat({ rpc: async () => null }, 'pty-1', 'claude')).toBe(false);
    expect(await launchAllowedByChat({ rpc: async () => { throw new Error('timeout'); } }, 'pty-1', 'claude')).toBe(false);
    // A daemon without the method has no move into chat to protect.
    expect(await launchAllowedByChat({ rpc: async () => { throw new Error(`Unknown method: ${CHATV2_LAUNCH_ALLOWED_RPC}`); } }, 'pty-1', 'claude')).toBe(true);
    // Only that answer: another unknown method is some other failure.
    expect(await launchAllowedByChat({ rpc: async () => { throw new Error('Unknown method: daemon.other'); } }, 'pty-1', 'claude')).toBe(false);
  });
});

describe('pty:write-launch', () => {
  it('asks the daemon before it types a line that starts an agent', () => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'pty.handler.ts'), 'utf-8');
    const handler = body.slice(body.indexOf('ipcMain.handle(IPC.PTY_WRITE_LAUNCH'));
    const guard = handler.indexOf('launchAllowedByChat(dc, id, text)');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(handler.indexOf('daemonClient.writeToSession(id, line)'));
  });

  it('asks about a folder-trust prompt before the launch is recorded or typed, an unreadable screen stopping all but a line a person clicked for', () => {
    const body = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'pty.handler.ts'), 'utf-8');
    const handler = body.slice(body.indexOf('ipcMain.handle(IPC.PTY_WRITE_LAUNCH'));
    expect(handler).toMatch(/^[^\n]*submit: unknown, origin: unknown\) => \{/);
    expect(handler).toContain("const human = origin === 'human';");
    expect(handler).toContain('const trustOpts = human ? { refuseUnknown: false } : { refuseUnknown: true, budgetMs: FOLDER_TRUST_DELIVERY_BUDGET_MS };');
    const ask = handler.indexOf("folderTrustLaunchRefusal(dc, id, human ? 'launch line' : 'automated launch line', trustOpts)");
    expect(ask).toBeGreaterThan(0);
    expect(handler.slice(ask)).toMatch(/^[^\n]*\n\s*if \(trustRefusal\) throw new Error\(`PTY_WRITE_LAUNCH: \$\{trustRefusal\}`\);/);
    expect(ask).toBeLessThan(handler.indexOf('launchAllowedByChat(dc, id, text)'));
    expect(ask).toBeLessThan(handler.indexOf('beginPaneRelaunch(id)'));
    expect(ask).toBeLessThan(handler.indexOf('daemonClient.writeToSession(id, line)'));
  });
});
