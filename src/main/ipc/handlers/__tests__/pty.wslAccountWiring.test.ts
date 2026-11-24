/**
 * #3418 — how both create paths mark a WSL pane's account variables and refuse
 * a re-sign-in tab they cannot honour, pinned structurally (house pattern:
 * daemon/__tests__/heldUserShellWiring.test.ts). The handler registers inside
 * registerPtyHandlers with the whole main process behind it; the decisions it
 * calls are behaviour-tested in account/__tests__/wslAccountSpawn.test.ts and
 * shared/__tests__/wslAccountMark.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { readSourceText } from '../../../../test-utils/sourceText';

const handler = readSourceText(path.join(__dirname, '..', 'pty.handler.ts'));
const manager = readSourceText(path.join(__dirname, '..', '..', '..', 'pty', 'PTYManager.ts'));
const after = (source: string, from: string, start = 0): number => {
  const at = source.indexOf(from, start);
  expect(at, `${from} not found`).toBeGreaterThanOrEqual(0);
  return at;
};

describe('daemon-mode create', () => {
  const overrideAt = after(handler, 'const accountOverride = closingLeases(() => createAccountOverride(');
  const refuseAt = after(handler, 'const accountRefusal = wslAccountTabRefusal(shell, options);', overrideAt);
  const recordAt = after(handler, 'recordFanoutTaskPane(options, sessionId);', overrideAt);
  const markAt = after(handler, 'setWslAccountKeys(resolvedEnv, [...accountSourcedKeys(resolvedEnv, accountEnv), ...paneKeys]);', overrideAt);
  const mark = handler.slice(after(handler, 'if (isWslShell(shell)) {', recordAt), markAt);

  it('refuses an unhonoured re-sign-in tab before anything about the session is recorded', () => {
    expect(refuseAt).toBeLessThan(recordAt);
    expect(handler.slice(refuseAt, refuseAt + 200)).toContain('if (accountRefusal) throw failCreate(accountRefusal);');
  });

  it('marks, for a WSL shell only, the binding\'s keys plus the named or rotated account and the tab\'s', () => {
    expect(markAt).toBeGreaterThan(recordAt);
    expect(mark).toMatch(/paneAccountKeys\(resolvedEnv, \{\s+override: accountOverride, requested: options\?\.wslAccountHomeKey, supplied: options\?\.env,/);
    expect(mark).toContain('accounts: () => getAccountStore().listAccounts(),');
    // The backstop: the env the pane actually gets must still name the tab's account.
    expect(mark).toMatch(/requestedAccountRefusal\(options\?\.wslAccountHomeKey, paneKeys\);\s+\/\/[^\n]*\n?\s*if \(refusal\) throw failCreate\(refusal\);|if \(refusal\) throw failCreate\(refusal\);/);
  });
});

describe('local-mode create', () => {
  const localAt = after(handler, 'const { initialCommand, cols, rows, workspaceId, surfaceId, env, spawnKind, wslAccountLoginEnvKey, wslAccountHomeKey, ignoreAccountBinding, accountId } = options ?? {};');

  it('refuses the same tabs, and hands a quota switch\'s account to PTYManager', () => {
    expect(after(handler, 'const accountRefusal = wslAccountTabRefusal(shell, options);', after(handler, 'ipcMain.handle(IPC.PTY_CREATE'))).toBeLessThan(localAt);
    expect(handler.slice(localAt)).toMatch(/ptyManager\.createAsync\(\{[^\n]*\.\.\.\(typeof accountId === 'string' \? \{ accountId \} : \{\}\)/);
  });

  it('PTYManager marks that account and refuses an unhonoured tab', () => {
    expect(manager).toContain("const override = options?.accountId ? getAccountStore().getAccount(options.accountId) : undefined;");
    expect(manager).toMatch(/paneAccountKeys\(env, \{\s+override, requested: options\?\.wslAccountHomeKey, supplied: options\?\.env,/);
    expect(manager).toContain('if (refusal) throw new Error(refusal);');
    expect(manager).toContain('setWslAccountKeys(env, [...accountSourcedKeys(env, accountEnv), ...paneKeys]);');
  });
});
