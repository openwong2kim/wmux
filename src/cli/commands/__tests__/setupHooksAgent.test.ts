// `wmux setup-hooks --agent <flavour>`: what the command hands the installer.
// The installer itself is covered in compatHookInstall.os.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installCompatHooks = vi.fn();
vi.mock('../../../shared/hooks/compatHookInstall', () => ({
  resolveCompatHookPaths: () => ({ marker: 'paths' }),
  installCompatHooks,
  removeCompatHooks: vi.fn(),
  statusCompatHooks: vi.fn(),
}));

import { handleSetupHooks } from '../setupHooks';

class Exit extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

beforeEach(() => {
  installCompatHooks.mockReset();
  installCompatHooks.mockResolvedValue({ ok: true, action: 'none', before: 'current', configPath: '/x', error: null });
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Exit(code); }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('setup-hooks --agent --reprobe', () => {
  it('asks the installer to run the check again only when given', async () => {
    await handleSetupHooks(['--agent', 'copilot', '--reprobe'], true);
    expect(installCompatHooks).toHaveBeenLastCalledWith('copilot', { marker: 'paths' }, { reprobe: true });
    await handleSetupHooks(['--agent', 'copilot'], true);
    expect(installCompatHooks).toHaveBeenLastCalledWith('copilot', { marker: 'paths' }, { reprobe: false });
  });

  it('is refused with --status or --remove, before anything runs', async () => {
    for (const other of ['--status', '--remove']) {
      await expect(handleSetupHooks(['--agent', 'copilot', '--reprobe', other], true)).rejects.toEqual(new Exit(1));
    }
    expect(installCompatHooks).not.toHaveBeenCalled();
  });
});
