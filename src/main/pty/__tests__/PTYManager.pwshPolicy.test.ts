import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn(() => ({ pid: 0, kill: vi.fn() })) }));
vi.mock('node-pty', () => ({ spawn, default: { spawn } }));

import { PTYManager } from '../PTYManager';
import { FACTORY_DEFAULT_SCOPES, __setPolicyProbeForTests } from '../../../shared/pwshExecutionPolicy';

// #1620, local mode (daemon off): the hook dot-source hits the same Restricted
// default as the daemon path, so it needs the same process-scoped policy.
describe('local-mode PowerShell hook — execution policy (#1620)', () => {
  const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const PS7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  let hooksDir: string;
  let manager: PTYManager;

  beforeEach(() => {
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hooks-'));
    fs.writeFileSync(path.join(hooksDir, 'pwsh.ps1'), '# test hook\n');
    manager = new PTYManager();
    vi.spyOn(manager, 'getShellHooksDir').mockReturnValue(hooksDir);
  });

  afterEach(() => {
    manager.disposeAll();
    __setPolicyProbeForTests(null);
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it('5.1 on a factory-default machine: RemoteSigned before -Command', () => {
    __setPolicyProbeForTests({ scopes: FACTORY_DEFAULT_SCOPES, platform: 'win32' });
    const { args } = manager.buildHookInjection('powershell', {}, PS51);
    expect(args).toEqual([
      '-NoExit', '-ExecutionPolicy', 'RemoteSigned', '-Command', `. '${path.join(hooksDir, 'pwsh.ps1')}'`,
    ]);
  });

  it('5.1 with an explicit policy: unchanged argv', () => {
    __setPolicyProbeForTests({ scopes: { ...FACTORY_DEFAULT_SCOPES, localMachine: 'set' }, platform: 'win32' });
    const { args } = manager.buildHookInjection('powershell', {}, PS51);
    expect(args).toEqual(['-NoExit', '-Command', `. '${path.join(hooksDir, 'pwsh.ps1')}'`]);
  });

  it('pwsh 7: unchanged argv', () => {
    __setPolicyProbeForTests({ scopes: FACTORY_DEFAULT_SCOPES, platform: 'win32' });
    const { args } = manager.buildHookInjection('powershell', {}, PS7);
    expect(args).not.toContain('-ExecutionPolicy');
  });

  // Local mode spawns a real Windows shell path; only meaningful on Windows.
  it.runIf(process.platform === 'win32')('create() hands the real shell path to the hook builder, not just the family', () => {
    const spy = vi.spyOn(manager, 'buildHookInjection').mockReturnValue({ args: [], env: {} });
    manager.create({ shell: PS51 });
    expect(spy).toHaveBeenCalledWith('powershell', expect.any(Object), PS51);
  });
});
