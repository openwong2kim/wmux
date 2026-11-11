// `wmux action`: argument parsing, the pane claim it carries, and how it
// prints a result or a refusal (with its code) in both output modes.
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
import { handleAction, parseActionArgs } from '../action';

const rpc = sendRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;
let out: string[];
let errors: string[];

beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  errors = [];
  selfContext.mockResolvedValue({ ptyId: 'pty-self', workspaceId: 'ws-self', workspaceToken: 'claim-self' });
  rpc.mockResolvedValue({ id: '1', ok: true, result: { ok: true, id: 'workspace.rename', workspaceId: 'ws-self', name: 'api', changed: true } });
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseActionArgs', () => {
  it('reads the id, the target and repeated --arg pairs, in either flag spelling', () => {
    expect(parseActionArgs(['pane.move', '--target', '#w1-2', '--arg', 'beside=#w1-1', '--arg=edge=left'])).toEqual({
      list: false,
      id: 'pane.move',
      target: '#w1-2',
      args: { beside: '#w1-1', edge: 'left' },
    });
    expect(parseActionArgs(['--list'])).toMatchObject({ list: true, id: '' });
  });

  it('refuses an unknown flag, a malformed or repeated --arg, and two ids', () => {
    for (const argv of [['x', '--force'], ['x', '--arg', 'novalue'], ['x', '--arg', 'a=1', '--arg', 'a=2'], ['x', 'y']]) {
      expect(() => parseActionArgs(argv), argv.join(' ')).toThrow('exit 1');
    }
  });
});

describe('wmux action', () => {
  it('carries the pane claim main walked, then runs the action', async () => {
    await handleAction(['workspace.rename', '--arg', 'name=api'], false);
    expect(selfContext).toHaveBeenCalledWith(expect.objectContaining({ callerPid: process.pid }));
    expect(setWorkspaceToken).toHaveBeenCalledWith('claim-self');
    expect(rpc).toHaveBeenCalledWith('app.action', { id: 'workspace.rename', args: { name: 'api' } });
    expect(out).toEqual(['workspace.rename: done {"workspaceId":"ws-self","name":"api"}']);
  });

  it('outside a pane it sends no claim, and prints main\'s no_identity refusal', async () => {
    selfContext.mockResolvedValue({});
    rpc.mockResolvedValue({ id: '1', ok: true, result: { ok: false, code: 'no_identity', error: 'app.action: no workspace found for the calling pane' } });
    await expect(handleAction(['layout.balance'], false)).rejects.toThrow('exit 1');
    expect(setWorkspaceToken).not.toHaveBeenCalled();
    expect(errors.join('\n')).toBe('Error: no_identity: app.action: no workspace found for the calling pane');
  });

  it('--json prints the refusal with its code on stdout and exits 1', async () => {
    rpc.mockResolvedValue({ id: '1', ok: true, result: { ok: false, code: 'not_owned', error: 'ws-b is in another workspace' } });
    await expect(handleAction(['layout.balance', '--target', 'ws-b'], true)).rejects.toThrow('exit 1');
    expect(JSON.parse(out.join('\n'))).toEqual({ ok: false, code: 'not_owned', error: 'ws-b is in another workspace' });
  });

  it('names the fence refusal the router answers as fenced', async () => {
    rpc.mockResolvedValue({ id: '1', ok: false, error: 'app.action: not available inside the worker fence' });
    await expect(handleAction(['layout.balance'], true)).rejects.toThrow('exit 1');
    expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: false, code: 'fenced' });
  });

  it('--list prints each action from app.action.list', async () => {
    rpc.mockResolvedValue({
      id: '1',
      ok: true,
      result: {
        ok: true,
        actions: [
          { id: 'layout.balance', target: 'workspace', args: {}, description: 'Balance.' },
          { id: 'settings.get', target: 'none', args: { key: { type: 'enum', values: ['theme', 'locale'] } }, description: 'Read.' },
        ],
      },
    });
    await handleAction(['--list'], false);
    expect(rpc).toHaveBeenCalledWith('app.action.list', {});
    expect(selfContext).not.toHaveBeenCalled();
    const text = out.join('\n');
    expect(text).toContain('layout.balance [--target <workspace>]');
    expect(text).toContain('settings.get [key=<theme|locale>]');
  });

  it('needs an id', async () => {
    await expect(handleAction([], false)).rejects.toThrow('exit 1');
    expect(rpc).not.toHaveBeenCalled();
  });
});
