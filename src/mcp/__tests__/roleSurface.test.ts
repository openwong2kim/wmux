import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ROLE_TOOL_SURFACES } from '../../shared/roleSurfaces';

/**
 * `--role=<Role>` end to end: a real McpServer from createWmuxServer() over an
 * in-memory transport, so the assertion is on the tools/list a host would see.
 */
const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});

import { createWmuxServer } from '../index';

async function listNames(opts: { roleSurface?: string; coreMode?: boolean; commanderMode?: boolean }): Promise<string[]> {
  const server = createWmuxServer({
    envWorkspaceHint: 'ws-caller',
    envPtyHint: '',
    commanderToken: opts.commanderMode ? 'wmux-token-test' : undefined,
    commanderMode: opts.commanderMode ?? false,
    coreMode: opts.coreMode ?? false,
    roleSurface: opts.roleSurface,
    callerPid: process.pid,
    callerPpid: null,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    // A server with no tools at all does not advertise the tools capability.
    if (!client.getServerCapabilities()?.tools) return [];
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockRejectedValue(new Error('rpc-down'));
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => errSpy.mockRestore());

describe('--role surface', () => {
  it.each(['Planner', 'Reviewer', 'Builder', 'Tester'] as const)('%s lists exactly its surface', async (role) => {
    const names = await listNames({ roleSurface: role });
    expect([...names].sort()).toEqual([...ROLE_TOOL_SURFACES[role]].sort());
  });

  it('Reviewer lists exactly 5 tools', async () => {
    expect(await listNames({ roleSurface: 'Reviewer' })).toHaveLength(5);
  });

  it('a fan-out worker gets the tools its preamble names: Builder 8, Tester 8', async () => {
    expect(await listNames({ roleSurface: 'Builder' })).toHaveLength(8);
    expect(await listNames({ roleSurface: 'Builder' })).toContain('task_push');
    expect(await listNames({ roleSurface: 'Builder' })).toContain('task_fetch');
    expect(await listNames({ roleSurface: 'Tester' })).toHaveLength(8);
    expect(await listNames({ roleSurface: 'Builder' })).toContain('ledger_update');
  });

  it('an unknown role falls back to core and says so on stderr', async () => {
    const core = await listNames({ coreMode: true });
    const names = await listNames({ roleSurface: 'Wizard' });
    expect(names).toEqual(core);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('unknown --role=Wizard');
  });

  it('--commander wins over --role', async () => {
    const commander = await listNames({ commanderMode: true });
    const names = await listNames({ commanderMode: true, roleSurface: 'Reviewer' });
    expect(names).toEqual(commander);
    expect(errSpy.mock.calls.flat().join('\n')).toContain('--role ignored');
  });

  it('no role leaves the full surface untouched', async () => {
    const names = await listNames({});
    expect(names.length).toBeGreaterThan(ROLE_TOOL_SURFACES.Planner.length);
    expect(names.some((n) => n.startsWith('browser_'))).toBe(true);
  });
});
