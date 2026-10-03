import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  return { ipcMain, __handlers: handlers };
});

import { IPC } from '../../../../shared/constants';
import { registerMcpHandlers, type McpRegisterTargetResult, type McpStatusPayload } from '../mcp.handler';
import type { McpRegistrar, McpRegistrarStatus, McpTargetResult } from '../../../mcp/McpRegistrar';

describe('mcp.handler', () => {
  let mockRegistrar: Partial<McpRegistrar>;
  let mockGetAuthToken: () => string | null;
  let mockStatus: McpRegistrarStatus;
  let origSuffix: string | undefined;

  beforeEach(() => {
    origSuffix = process.env.WMUX_DATA_SUFFIX;
    delete process.env.WMUX_DATA_SUFFIX;
    mockStatus = {
      targets: [
        {
          id: 'agy',
          displayName: 'Antigravity CLI',
          format: 'json',
          configPath: '/mock/path/mcp_config.json',
          configExists: true,
          configModified: new Date('2026-09-30T12:00:00Z'),
          verified: false,
          wmux: { registered: true, path: '/mock/entry.js', profile: 'full' },
        },
      ],
      codexNotify: { configPath: '/mock/config.toml', configExists: false, state: 'none', path: null },
    };

    mockRegistrar = {
      getStatus: vi.fn(() => mockStatus),
      register: vi.fn(async () => []),
      registerTarget: vi.fn(async (authToken: string, targetId: string): Promise<McpTargetResult> => {
        return { id: targetId, success: true };
      }),
      forceUnregister: vi.fn(),
    };

    mockGetAuthToken = vi.fn(() => 'test-auth-token');
  });

  afterEach(() => {
    if (origSuffix === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = origSuffix;
  });

  async function getHandler(channel: string): Promise<(...args: unknown[]) => unknown> {
    const electron = (await import('electron')) as unknown as {
      __handlers: Map<string, (...args: unknown[]) => unknown>;
    };
    const handler = electron.__handlers.get(channel);
    expect(handler).toBeDefined();
    return handler!;
  }

  it('registers handlers and MCP_CHECK returns serialized status', async () => {
    registerMcpHandlers(mockRegistrar as McpRegistrar, mockGetAuthToken);
    const handler = await getHandler(IPC.MCP_CHECK);
    const result = (await handler({})) as McpStatusPayload;

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].id).toBe('agy');
    expect(result.targets[0].configModified).toBe('2026-09-30T12:00:00.000Z');
  });

  it('MCP_REREGISTER calls register without explicit options', async () => {
    registerMcpHandlers(mockRegistrar as McpRegistrar, mockGetAuthToken);
    const handler = await getHandler(IPC.MCP_REREGISTER);
    const result = (await handler({})) as McpStatusPayload;

    expect(mockRegistrar.register).toHaveBeenCalledWith('test-auth-token');
    expect(result.targets).toHaveLength(1);
  });

  it('MCP_REGISTER_TARGET explicitly registers target and returns per-target result', async () => {
    registerMcpHandlers(mockRegistrar as McpRegistrar, mockGetAuthToken);
    const handler = await getHandler(IPC.MCP_REGISTER_TARGET);
    const result = (await handler({}, 'agy')) as McpRegisterTargetResult;

    expect(mockRegistrar.registerTarget).toHaveBeenCalledWith('test-auth-token', 'agy');
    expect(result.id).toBe('agy');
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.status.targets).toHaveLength(1);
  });

  it('MCP_REGISTER_TARGET surfaces target registration errors', async () => {
    (mockRegistrar.registerTarget as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'agy',
      success: false,
      error: 'The CLI config file was not found',
    });

    registerMcpHandlers(mockRegistrar as McpRegistrar, mockGetAuthToken);
    const handler = await getHandler(IPC.MCP_REGISTER_TARGET);
    const result = (await handler({}, 'agy')) as McpRegisterTargetResult;

    expect(result.id).toBe('agy');
    expect(result.success).toBe(false);
    expect(result.error).toBe('The CLI config file was not found');
  });

  it('MCP_REGISTER_TARGET rejects invalid target id', async () => {
    registerMcpHandlers(mockRegistrar as McpRegistrar, mockGetAuthToken);
    const handler = await getHandler(IPC.MCP_REGISTER_TARGET);

    await expect(handler({}, '')).rejects.toThrow('Invalid target id');
    await expect(handler({}, 123)).rejects.toThrow('Invalid target id');
  });

  it('MCP_REGISTER_TARGET rejects when auth token not ready', async () => {
    mockGetAuthToken = vi.fn(() => null);
    registerMcpHandlers(mockRegistrar as McpRegistrar, mockGetAuthToken);
    const handler = await getHandler(IPC.MCP_REGISTER_TARGET);

    await expect(handler({}, 'agy')).rejects.toThrow('auth token not ready');
  });

  it('MCP_REGISTER_TARGET for agy registers MCP only and never installs the quota sensor', async () => {
    const quota = await import('../tokenUsageQuota.handler');
    const getService = vi.spyOn(quota, 'getDefaultQuotaService');
    try {
      registerMcpHandlers(mockRegistrar as McpRegistrar, mockGetAuthToken);
      const handler = await getHandler(IPC.MCP_REGISTER_TARGET);
      const result = (await handler({}, 'agy')) as McpRegisterTargetResult & { sensor?: unknown };

      expect(mockRegistrar.registerTarget).toHaveBeenCalledWith('test-auth-token', 'agy');
      expect(getService).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'agy', success: true });
      expect(result.sensor).toBeUndefined();
    } finally {
      getService.mockRestore();
    }
  });

  it('MCP_REGISTER_TARGET reports a failed agy registration', async () => {
    (mockRegistrar.registerTarget as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'agy',
      success: false,
      error: 'Registration failed',
    });
    registerMcpHandlers(mockRegistrar as McpRegistrar, mockGetAuthToken);
    const handler = await getHandler(IPC.MCP_REGISTER_TARGET);
    const result = (await handler({}, 'agy')) as McpRegisterTargetResult;

    expect(result).toMatchObject({ id: 'agy', success: false, error: 'Registration failed' });
  });

  it('cleanup unregisters all handlers including MCP_REGISTER_TARGET', async () => {
    const electron = (await import('electron')) as unknown as {
      __handlers: Map<string, (...args: unknown[]) => unknown>;
    };
    const cleanup = registerMcpHandlers(mockRegistrar as McpRegistrar, mockGetAuthToken);

    expect(electron.__handlers.has(IPC.MCP_CHECK)).toBe(true);
    expect(electron.__handlers.has(IPC.MCP_REREGISTER)).toBe(true);
    expect(electron.__handlers.has(IPC.MCP_UNREGISTER)).toBe(true);
    expect(electron.__handlers.has(IPC.MCP_REGISTER_TARGET)).toBe(true);

    cleanup();

    expect(electron.__handlers.has(IPC.MCP_CHECK)).toBe(false);
    expect(electron.__handlers.has(IPC.MCP_REREGISTER)).toBe(false);
    expect(electron.__handlers.has(IPC.MCP_UNREGISTER)).toBe(false);
    expect(electron.__handlers.has(IPC.MCP_REGISTER_TARGET)).toBe(false);
  });
});
