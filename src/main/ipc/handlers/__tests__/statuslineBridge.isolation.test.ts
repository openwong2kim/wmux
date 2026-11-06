/**
 * The status line goes into Claude Code's settings, which are shared with the
 * installed wmux: an isolated instance (WMUX_DATA_SUFFIX set) or a
 * development build never installs it from Settings into the account's real
 * home (a sandbox home is its own). It answers with a
 * refusal that names `wmux setup-statusline`, and every file is left as it
 * was. A packaged, unsuffixed instance installs as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../../shared/constants';
import type { SetupStatuslinePaths } from '../../../../cli/commands/setupStatusline';
import { registerStatuslineBridgeHandlers } from '../statuslineBridge.handler';

const state = vi.hoisted(() => ({ isPackaged: true, paths: null as SetupStatuslinePaths | null }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
  },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
}));
vi.mock('../../../../cli/commands/setupStatusline', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../cli/commands/setupStatusline')>();
  return { ...real, defaultPaths: () => state.paths as SetupStatuslinePaths };
});

let tmp: string;

/** What the OS says the account's home is (os.userInfo().homedir). */
function accountHome(home: string): void {
  const real = os.userInfo();
  vi.spyOn(os, 'userInfo').mockReturnValue({ ...real, homedir: home } as never);
}

function install(): Promise<{ ok: boolean; error: string | null }> {
  registerStatuslineBridgeHandlers();
  const call = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC.STATUSLINE_BRIDGE_INSTALL);
  if (!call) throw new Error('no install handler');
  const handler = call[1] as unknown as (event: unknown, payload?: unknown) => Promise<{ ok: boolean; error: string | null }>;
  return handler({});
}

/** Every file under the temp HOME: its bytes and its mtime. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      out[path.relative(tmp, file)] = `${sha} ${fs.statSync(file).mtimeMs}`;
    }
  };
  walk(tmp);
  return out;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-statusline-isolation-'));
  const scriptSource = path.join(tmp, 'src-statusline.mjs');
  fs.writeFileSync(scriptSource, 'STATUSLINE\n', 'utf8');
  const settingsPath = path.join(tmp, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{}\n', 'utf8');
  state.paths = {
    targets: [{ label: 'default (~/.claude)', settingsPath }],
    scriptDest: path.join(tmp, '.wmux', 'hooks', 'wmux-statusline.mjs'),
    scriptSource,
  };
  state.isPackaged = true;
  vi.stubEnv('WMUX_DATA_SUFFIX', '');
  vi.mocked(ipcMain.handle).mockClear();
  // The account's home is the one this process runs with: the real home.
  accountHome(os.homedir());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Settings status line install', () => {
  it('refuses from an isolated instance and writes nothing', async () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '-iso');
    const before = snapshot();
    const outcome = await install();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('isolated instance (WMUX_DATA_SUFFIX=-iso)');
    expect(outcome.error).toContain('wmux setup-statusline');
    expect(snapshot()).toEqual(before);
  });

  it('refuses from a development build and writes nothing', async () => {
    state.isPackaged = false;
    const before = snapshot();
    const outcome = await install();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('a development build');
    expect(outcome.error).toContain('wmux setup-statusline');
    expect(snapshot()).toEqual(before);
  });

  it('installs from an isolated instance whose home is a sandbox', async () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '-e2e');
    accountHome(path.join(tmp, 'the-account-home'));
    expect(await install()).toMatchObject({ ok: true, error: null });
  });

  it('installs from a packaged, unsuffixed instance', async () => {
    const before = snapshot();
    const outcome = await install();
    expect(outcome).toMatchObject({ ok: true, error: null });
    const settings = path.join('.claude', 'settings.json');
    expect(snapshot()[settings]).not.toBe(before[settings]);
  });
});
