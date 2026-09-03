/**
 * Broker-awareness of the `wmux mcp register` script resolver
 * (plans/mcp-broker-enable-plan-2026-07-24.md W4 / RISK 4).
 *
 * `resolveWmuxScript()` must prefer the thin shim ONLY when a broker is actually
 * listening (a live pipe probe, not the env flag), otherwise fall back to the
 * full single-child bundle — so running the command never silently overwrites a
 * shim path with the ~32 MB bundle (or vice-versa) and breaks the topology.
 *
 * `fs`/`net` are mocked (hoisted) so the test is hermetic: no real filesystem
 * walk, no real named-pipe connect.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock BEFORE importing the module under test (Vitest hoists these). The net
// mock's `connect` is a shared spy so a test can both script its socket and
// assert whether the probe ran at all.
const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));
vi.mock('net', () => ({ connect: connectMock, default: { connect: connectMock } }));
vi.mock('fs');

import * as fs from 'fs';
import {
  canConnectBrokerPipe,
  isolatedInstanceNotice,
  resolveWmuxScript,
  selectedProfile,
} from '../mcp';

const existsSyncMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;

// A fake net.Socket whose connect outcome is scripted. It emits its terminal
// event on the next tick — the real net.connect resolves asynchronously too, so
// the code under test attaches its listeners first.
type Outcome = 'connect' | 'timeout' | 'error';

function fakeSocket(outcome: Outcome) {
  const socket = new EventEmitter() as unknown as import('net').Socket & EventEmitter;
  const setTimeoutSpy = vi.fn();
  const destroySpy = vi.fn();
  (socket as unknown as { setTimeout: unknown }).setTimeout = setTimeoutSpy;
  (socket as unknown as { destroy: unknown }).destroy = destroySpy;
  setImmediate(() => {
    if (outcome === 'connect') socket.emit('connect');
    else if (outcome === 'timeout') socket.emit('timeout');
    else socket.emit('error', new Error('ECONNREFUSED'));
  });
  return { socket, setTimeout: setTimeoutSpy, destroy: destroySpy };
}

// Script the next net.connect call to return a socket with the given outcome.
function scriptConnect(outcome: Outcome) {
  const fake = fakeSocket(outcome);
  connectMock.mockReturnValue(fake.socket);
  return fake;
}

// The walk-up resolver joins __dirname with candidate rel-paths, so absolute
// paths are environment-dependent. Match on the trailing filename instead: the
// shim layout ends in shim.js, the full bundle in index.js / entry.js.
function existsFor(kinds: Array<'shim' | 'bundle'>) {
  existsSyncMock.mockImplementation((p: unknown) => {
    const s = String(p);
    if (s.endsWith('shim.js')) return kinds.includes('shim');
    if (s.endsWith('index.js') || s.endsWith('entry.js')) return kinds.includes('bundle');
    return false;
  });
}

const savedFlag = process.env.WMUX_MCP_BROKER;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WMUX_MCP_BROKER;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.WMUX_MCP_BROKER;
  else process.env.WMUX_MCP_BROKER = savedFlag;
});

describe('resolveWmuxScript', () => {
  it('escape hatch: WMUX_MCP_BROKER=0 skips the probe and returns the full bundle', async () => {
    process.env.WMUX_MCP_BROKER = '0';
    scriptConnect('connect'); // would succeed if it were probed
    existsFor(['shim', 'bundle']); // both present — the bundle must still win

    const resolved = await resolveWmuxScript();

    expect(connectMock).not.toHaveBeenCalled();
    expect(resolved).toMatch(/index\.js$|entry\.js$/);
    expect(resolved).not.toMatch(/shim\.js$/);
  });

  it('probe succeeds and shim exists: returns the shim path', async () => {
    scriptConnect('connect');
    existsFor(['shim', 'bundle']);

    const resolved = await resolveWmuxScript();

    expect(connectMock).toHaveBeenCalled();
    expect(resolved).toMatch(/shim\.js$/);
  });

  it('probe succeeds but shim is missing: falls back to the full bundle', async () => {
    scriptConnect('connect');
    existsFor(['bundle']); // no shim on disk

    const resolved = await resolveWmuxScript();

    expect(resolved).toMatch(/index\.js$|entry\.js$/);
    expect(resolved).not.toMatch(/shim\.js$/);
  });

  it('probe fails (connection refused): returns the full bundle', async () => {
    scriptConnect('error');
    existsFor(['shim', 'bundle']);

    const resolved = await resolveWmuxScript();

    expect(connectMock).toHaveBeenCalled();
    expect(resolved).toMatch(/index\.js$|entry\.js$/);
    expect(resolved).not.toMatch(/shim\.js$/);
  });

  it('probe times out: socket is guarded/destroyed and the full bundle is used', async () => {
    const { setTimeout: setTimeoutSpy, destroy } = scriptConnect('timeout');
    existsFor(['shim', 'bundle']);

    const resolved = await resolveWmuxScript();

    expect(setTimeoutSpy).toHaveBeenCalledWith(300);
    expect(destroy).toHaveBeenCalled();
    expect(resolved).toMatch(/index\.js$|entry\.js$/);
    expect(resolved).not.toMatch(/shim\.js$/);
  });

  it('returns null when neither shim nor bundle is on disk', async () => {
    scriptConnect('connect');
    existsFor([]); // nothing exists

    expect(await resolveWmuxScript()).toBeNull();
  });
});

describe('canConnectBrokerPipe', () => {
  it('resolves true when the socket connects', async () => {
    scriptConnect('connect');
    await expect(canConnectBrokerPipe(300)).resolves.toBe(true);
  });

  it('resolves false and destroys the socket on timeout (hang guard)', async () => {
    const { setTimeout: setTimeoutSpy, destroy } = scriptConnect('timeout');
    await expect(canConnectBrokerPipe(150)).resolves.toBe(false);
    expect(setTimeoutSpy).toHaveBeenCalledWith(150);
    expect(destroy).toHaveBeenCalled();
  });

  it('resolves false on connection error and never rejects', async () => {
    scriptConnect('error');
    await expect(canConnectBrokerPipe(300)).resolves.toBe(false);
  });
});

describe('selectedProfile — `wmux mcp register --profile`', () => {
  it('is undefined when the flag is absent (= preserve what is on disk)', () => {
    // Not 'full': "no flag" must NOT mean "write the default", or every
    // re-register would undo an opted-in --core.
    expect(selectedProfile(['register'])).toBeUndefined();
    expect(selectedProfile(['register', '--target', 'claude', '--json'])).toBeUndefined();
  });

  it('parses both valid values, anywhere in the argv', () => {
    expect(selectedProfile(['register', '--profile', 'core'])).toBe('core');
    expect(selectedProfile(['register', '--profile', 'full'])).toBe('full');
    expect(selectedProfile(['register', '--profile', 'core', '--json'])).toBe('core');
    expect(selectedProfile(['register', '--json', '--profile', 'full'])).toBe('full');
  });

  it('parses the attached --profile=<value> form', () => {
    // The form most people reach for first. Parsing only the separated one let
    // `--profile=core` fall through as "no flag" and print a success message
    // for a registration that ignored the request.
    expect(selectedProfile(['register', '--profile=core'])).toBe('core');
    expect(selectedProfile(['register', '--profile=full'])).toBe('full');
    expect(selectedProfile(['register', '--profile=core', '--json'])).toBe('core');
    expect(selectedProfile(['register', '--profile=cores'])).toBeNull();
    expect(selectedProfile(['register', '--profile='])).toBeNull();
  });

  it('returns null for an unknown or missing value so the caller can error out', () => {
    // A typo must not silently register the default over someone's --core.
    expect(selectedProfile(['register', '--profile', 'cores'])).toBeNull();
    expect(selectedProfile(['register', '--profile', 'commander'])).toBeNull();
    expect(selectedProfile(['register', '--profile'])).toBeNull();
  });
});

describe('isolatedInstanceNotice — #1151 isolated instance (WMUX_DATA_SUFFIX)', () => {
  const saved = process.env.WMUX_DATA_SUFFIX;
  afterEach(() => {
    if (saved === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = saved;
  });

  it('stays silent on the daily (unsuffixed) instance — behavior unchanged', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    expect(isolatedInstanceNotice('check')).toBeNull();
    expect(isolatedInstanceNotice('register')).toBeNull();
    expect(isolatedInstanceNotice('unregister')).toBeNull();
  });

  it('treats an empty suffix as unsuffixed (dataSuffix() semantics)', () => {
    process.env.WMUX_DATA_SUFFIX = '';
    expect(isolatedInstanceNotice('check')).toBeNull();
  });

  it('`check` says the instance is isolated and names the suffix', () => {
    process.env.WMUX_DATA_SUFFIX = '-demo';
    const notice = isolatedInstanceNotice('check');
    // The whole point: the rows that follow are the PRODUCTION configs, and an
    // isolated instance is never the thing registered in them.
    expect(notice).toContain('isolated instance');
    expect(notice).toContain('WMUX_DATA_SUFFIX=-demo');
    expect(notice).toContain('never registers itself');
  });

  it('`register` / `unregister` warn that the PRODUCTION configs are the target', () => {
    process.env.WMUX_DATA_SUFFIX = '-demo';
    // The CLI is an explicit user action, so it proceeds — but it must never do
    // so silently, because the config paths are suffix-blind.
    expect(isolatedInstanceNotice('register')).toContain('~/.claude.json');
    expect(isolatedInstanceNotice('register')).toContain('production agent configs');
    expect(isolatedInstanceNotice('unregister')).toContain('removes the production');
  });
});
