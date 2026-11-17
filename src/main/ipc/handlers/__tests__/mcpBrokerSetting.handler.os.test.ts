// Settings › Claude Code › Shared MCP process: main reads and writes the
// choice, refuses anything but default/on/off, and says what the next start
// decides next to what this run decided.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn); }),
      removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
    },
    __handlers: handlers,
  };
});
const store = vi.hoisted(() => ({ setting: 'default' as string, problem: undefined as string | undefined, writes: [] as string[] }));
vi.mock('../../../../shared/brokerSetting', () => ({
  readBrokerSetting: () => ({ setting: store.setting, ...(store.problem ? { problem: store.problem } : {}) }),
  writeBrokerSetting: (s: string) => { store.writes.push(s); store.setting = s; },
}));
vi.mock('../../../mcp/BrokerSupervisor', () => ({ mcpBrokerDecision: () => ({ on: false, source: 'default' }) }));

import { IPC } from '../../../../shared/constants';
import { registerMcpHandlers } from '../mcp.handler';
import type { McpRegistrar } from '../../../mcp/McpRegistrar';
import type { BrokerSettingPayload } from '../../../../shared/mcpBroker';

async function handler(channel: string) {
  const electron = (await import('electron')) as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> };
  return electron.__handlers.get(channel)!;
}

const savedEnv = process.env.WMUX_MCP_BROKER;
beforeEach(() => {
  store.setting = 'default';
  store.problem = undefined;
  store.writes = [];
  delete process.env.WMUX_MCP_BROKER;
  registerMcpHandlers({ getStatus: vi.fn() } as unknown as McpRegistrar, () => null);
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.WMUX_MCP_BROKER;
  else process.env.WMUX_MCP_BROKER = savedEnv;
});

describe('mcp:broker-setting', () => {
  it('get: the saved choice, what runs now, and what the next start decides', async () => {
    store.setting = 'on';
    const res = (await (await handler(IPC.MCP_BROKER_SETTING_GET))({})) as BrokerSettingPayload;
    expect(res).toMatchObject({ saved: 'on', env: 'unset', running: { on: false }, next: { on: true, source: 'setting' } });
  });

  it('set: writes the choice and answers with the new state', async () => {
    const res = (await (await handler(IPC.MCP_BROKER_SETTING_SET))({}, 'off')) as BrokerSettingPayload;
    expect(store.writes).toEqual(['off']);
    expect(res).toMatchObject({ saved: 'off', next: { on: false, source: 'setting' } });
  });

  it('set: refuses anything but default, on and off, and writes nothing', async () => {
    const set = await handler(IPC.MCP_BROKER_SETTING_SET);
    for (const bad of ['yes', '', 1, null, { broker: 'on' }]) {
      await expect(Promise.resolve().then(() => set({}, bad))).rejects.toThrow();
    }
    expect(store.writes).toEqual([]);
  });

  it('the environment decides the next start too, and the payload says so', async () => {
    process.env.WMUX_MCP_BROKER = '1';
    const res = (await (await handler(IPC.MCP_BROKER_SETTING_SET))({}, 'off')) as BrokerSettingPayload;
    expect(res).toMatchObject({ saved: 'off', env: 'on', next: { on: true, source: 'env' } });
  });

  it('says whether this platform hosts sessions (not on win32)', async () => {
    const res = (await (await handler(IPC.MCP_BROKER_SETTING_GET))({})) as BrokerSettingPayload;
    expect(res.hostsSessions).toBe(process.platform !== 'win32');
  });

  it('a file that was not used reports why', async () => {
    store.problem = 'mcp-broker.json: not valid JSON';
    const res = (await (await handler(IPC.MCP_BROKER_SETTING_GET))({})) as BrokerSettingPayload;
    expect(res.problem).toBe('mcp-broker.json: not valid JSON');
  });
});
