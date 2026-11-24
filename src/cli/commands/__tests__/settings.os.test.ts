// `wmux settings`: its arguments, the claim it carries from a pane, what it
// says when the app is not running, and how it prints each answer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
  setWorkspaceToken: vi.fn(),
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendRequest, setWorkspaceToken } from '../../client';
import { resolveSelfContext } from '../../identity';
import { handleSettings, parseSettingsArgs } from '../settings';
import { APP_SETTING_KEYS, HUMAN_ONLY_SETTINGS } from '../../../shared/appSettings';

const rpc = sendRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;
let out: string[];
let errors: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  errors = [];
  delete process.env.WMUX_WORKSPACE_ID;
  delete process.env.WMUX_PTY_ID;
  selfContext.mockResolvedValue({});
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

const answer = (result: Record<string, unknown>) => rpc.mockResolvedValue({ id: '1', ok: true, result: { ok: true, ...result } });

describe('parseSettingsArgs', () => {
  it('reads list, get and set', () => {
    expect(parseSettingsArgs(['list'])).toEqual({ verb: 'list' });
    expect(parseSettingsArgs(['get'])).toEqual({ verb: 'get' });
    expect(parseSettingsArgs(['get', 'theme'])).toEqual({ verb: 'get', key: 'theme' });
    expect(parseSettingsArgs(['set', 'theme', 'paper'])).toEqual({ verb: 'set', key: 'theme', value: 'paper' });
  });

  it('refuses anything else', () => {
    for (const args of [[], ['delete'], ['list', 'x'], ['get', 'a', 'b'], ['set', 'theme'], ['set', 'a', 'b', 'c'], ['set', 'theme', 'x', '--force']]) {
      expect(() => parseSettingsArgs(args), args.join(' ')).toThrow(/exit 1/);
    }
  });
});

describe('handleSettings', () => {
  it('from a terminal outside wmux: sends without a claim', async () => {
    answer({ id: 'settings.set', key: 'theme', value: 'paper', changed: true });
    await handleSettings(['set', 'theme', 'paper'], false);
    expect(setWorkspaceToken).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenLastCalledWith('app.action', { id: 'settings.set', args: { key: 'theme', value: 'paper' } });
    expect(out).toEqual(['theme = paper']);
  });

  it('from a pane: carries the pane claim', async () => {
    selfContext.mockResolvedValue({ ptyId: 'pty-self', workspaceId: 'ws-self', workspaceToken: 'claim-self' });
    answer({ id: 'settings.get', settings: { 'titlebar.clock': true } });
    await handleSettings(['get', 'titlebar.clock'], false);
    expect(setWorkspaceToken).toHaveBeenCalledWith('claim-self');
    expect(out).toEqual(['titlebar.clock = on']);
  });

  describe('in a pane whose claim did not come back', () => {
    const platform = process.platform;
    const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
    beforeEach(() => { process.env.WMUX_WORKSPACE_ID = 'ws-self'; });
    afterEach(() => setPlatform(platform));

    it('on macOS and Linux: sends without one, and main decides from the connection', async () => {
      setPlatform('darwin');
      answer({ id: 'settings.get', settings: { theme: 'tint' } });
      await handleSettings(['get', 'theme'], false);
      expect(rpc).toHaveBeenLastCalledWith('app.action', { id: 'settings.get', args: { key: 'theme' } });
    });

    it('on Windows: stops instead of sending as the command line, as JSON too', async () => {
      setPlatform('win32');
      answer({ actions: [] });
      await expect(handleSettings(['set', 'theme', 'paper'], false)).rejects.toThrow(/exit 1/);
      expect(rpc).not.toHaveBeenCalledWith('app.action', expect.anything());
      expect(errors.join('\n')).toMatch(/could not confirm which one/);
      await expect(handleSettings(['get'], true)).rejects.toThrow(/exit 1/);
      expect(JSON.parse(out.at(-1) ?? '{}')).toMatchObject({ ok: false, code: 'no_identity' });
    });

    it('on Windows with the app closed: says the app is not running, not to run it again', async () => {
      setPlatform('win32');
      rpc.mockRejectedValue(new Error('wmux is not running. Start the app first.'));
      await expect(handleSettings(['list'], false)).rejects.toThrow(/exit 1/);
      expect(errors.at(-1)).toMatch(/settings change through the running app/);
    });
  });

  it('the app not running: says settings change through the running app', async () => {
    rpc.mockRejectedValue(new Error('wmux is not running. Start the app first.'));
    await expect(handleSettings(['get'], false)).rejects.toThrow(/exit 1/);
    expect(errors.at(-1)).toMatch(/settings change through the running app/);
  });

  it('no window: the same rule, with the reason, as JSON too', async () => {
    rpc.mockResolvedValue({ id: '1', ok: true, result: { ok: false, code: 'no_window', error: 'settings.get: the wmux window is not open' } });
    await expect(handleSettings(['get'], false)).rejects.toThrow(/exit 1/);
    expect(errors.at(-1)).toMatch(/window is not open: settings change through the running app/);
    await expect(handleSettings(['get'], true)).rejects.toThrow(/exit 1/);
    expect(JSON.parse(out.at(-1) ?? '{}')).toMatchObject({ ok: false, code: 'no_window' });
  });

  it('list prints one row per setting the app returned, and nothing else', async () => {
    answer({ id: 'settings.list', settings: APP_SETTING_KEYS.map((key) => ({ key, value: 'x', allowed: 'y' })) });
    await handleSettings(['list'], false);
    const keys = out.join('\n').split('\n').map((line) => line.split(/\s+/)[0]);
    expect(keys).toEqual(APP_SETTING_KEYS);
  });

  it.each(HUMAN_ONLY_SETTINGS.map((h) => [h.id.endsWith('.') ? `${h.id}x` : h.id, h.section]))(
    'set %s: prints the refusal that names Settings › %s',
    async (key, section) => {
      rpc.mockResolvedValue({ id: '1', ok: true, result: { ok: false, code: 'invalid_args', error: `settings.set: ${key} is changed by a person in Settings › ${section}, not by an agent or the command line` } });
      await expect(handleSettings(['set', key, 'on'], false)).rejects.toThrow(/exit 1/);
      expect(errors.at(-1)).toContain(`Settings › ${section}`);
    },
  );

  it('--json prints the raw answer', async () => {
    answer({ id: 'settings.set', key: 'theme', value: 'paper', changed: false });
    await handleSettings(['set', 'theme', 'paper'], true);
    expect(JSON.parse(out[0])).toEqual({ key: 'theme', value: 'paper', changed: false });
  });
});
