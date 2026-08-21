/**
 * The install prompt's durable refusal, at the IPC boundary.
 *
 * The property under test: a refusal is created and destroyed ONLY by an
 * explicit boolean. A caller bug that sends something else must not be coerced
 * into muting the prompt — a silently muted prompt is invisible, and the user
 * would simply never be offered hooks again with no way to know why. The
 * mirror-image failure matters too: a rejected payload must report what is
 * actually STORED rather than a cheerful default the disk does not agree with.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { registerHooksBridgeHandlers } from '../hooksBridge.handler';
import { IPC } from '../../../../shared/constants';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
}));

const store = vi.hoisted(() => ({ suppressed: false }));
const setSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../hooks/hooksPromptPreference', () => ({
  loadHooksPromptPreference: () => ({ suppressed: store.suppressed }),
  setHooksPromptSuppressed: async (suppressed: boolean) => {
    setSpy(suppressed);
    store.suppressed = suppressed;
    return { suppressed };
  },
}));

// The hook install/status side is not under test here and must not touch a real
// ~/.claude during it.
vi.mock('../../../../cli/commands/setupHooks', () => ({
  defaultPaths: () => ({}),
  statusHooks: () => ({ installedEvents: [], bridgeExists: false, settingsCorrupted: false }),
  installHooks: () => ({ ok: true }),
}));

type IpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

function handlerFor(channel: string): IpcInvokeHandler {
  registerHooksBridgeHandlers();
  const call = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no ipcMain.handle registration for "${channel}"`);
  return call[1] as unknown as IpcInvokeHandler;
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear();
  setSpy.mockClear();
  store.suppressed = false;
});

describe('hooks:bridge:prompt-pref', () => {
  it('a literal true stores the refusal', async () => {
    const set = handlerFor(IPC.HOOKS_BRIDGE_PROMPT_PREF_SET);
    await expect(set({}, true)).resolves.toEqual({ suppressed: true });
    expect(setSpy).toHaveBeenCalledWith(true);
  });

  it('a literal false clears it — the Settings "Ask again" path', async () => {
    store.suppressed = true;
    const set = handlerFor(IPC.HOOKS_BRIDGE_PROMPT_PREF_SET);
    await expect(set({}, false)).resolves.toEqual({ suppressed: false });
    expect(setSpy).toHaveBeenCalledWith(false);
  });

  it('never coerces a non-boolean into a write', async () => {
    const set = handlerFor(IPC.HOOKS_BRIDGE_PROMPT_PREF_SET);
    for (const bad of ['true', 1, {}, [], null, undefined]) {
      await set({}, bad);
    }
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('reports the STORED value when it rejects a payload, not a default', async () => {
    store.suppressed = true;
    const set = handlerFor(IPC.HOOKS_BRIDGE_PROMPT_PREF_SET);
    // The refusal is real and still in force; answering `false` here would tell
    // the renderer the write failed when nothing had been asked of it.
    await expect(set({}, 'yes')).resolves.toEqual({ suppressed: true });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('GET reads through to the store', async () => {
    store.suppressed = true;
    const get = handlerFor(IPC.HOOKS_BRIDGE_PROMPT_PREF_GET);
    await expect(get({})).resolves.toEqual({ suppressed: true });
  });
});
