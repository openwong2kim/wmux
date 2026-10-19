import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * #1888 — the client-side fallback walk must not trust process.ppid on Windows.
 * An orphan is never re-parented there, so when the MCP server's own parent
 * exits and Windows hands that pid to a newer pane shell, `callerPpid` names
 * that pane. The server-side walk already checks this caller → parent edge;
 * the client-side walk now asks getParentPid (which compares creation times)
 * for the first hop too. Mocked boundaries: the RPC pipe and child_process.
 */

const { mockSendRpc, psCalls, psStdout } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  psCalls: [] as string[],
  psStdout: { value: '' },
}));

vi.mock('../wmux-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wmux-client')>();
  return { ...actual, sendRpc: mockSendRpc };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = Object.assign(
    () => { throw new Error('callback execFile not expected'); },
    {
      [promisify.custom]: async (_file: string, args: string[]) => {
        psCalls.push(args.join(' '));
        return { stdout: psStdout.value, stderr: '' };
      },
    },
  );
  return { ...actual, default: { ...actual, execFile }, execFile };
});

import { createWmuxServer } from '../index';

const STALE_PPID = 4242; // our dead parent's pid, now a newer pane's shell
const CALLER = 777;

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  psCalls.length = 0;
  psStdout.value = '';
  mockSendRpc.mockReset();
  mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.resolve.identity') {
      // main's walk missed (it rejects the reused pid); the pid map still lists it.
      return {
        mappings: { [String(STALE_PPID)]: 'ws-stranger' },
        entries: [{ pid: String(STALE_PPID), ptyId: 'pty-stranger', workspaceId: 'ws-stranger' }],
        resolved: null,
      };
    }
    if (method === 'a2a.whoami') return { echo: params };
    return {};
  });
});

afterEach(() => {
  setPlatform(realPlatform);
});

async function whoami(): Promise<void> {
  const server = createWmuxServer({
    envWorkspaceHint: '',
    envPtyHint: '',
    commanderToken: undefined,
    commanderMode: false,
    coreMode: false,
    callerPid: CALLER,
    callerPpid: STALE_PPID,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'codex-mcp-client', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.callTool({ name: 'a2a_whoami', arguments: {} });
  await client.close();
}

const whoamiWorkspaces = () =>
  mockSendRpc.mock.calls.filter((c) => c[0] === 'a2a.whoami').map((c) => (c[1] as Record<string, unknown>).workspaceId);

describe('client-side pid walk, caller → parent edge (#1888)', () => {
  it('on Windows, checks the first edge with getParentPid instead of trusting callerPpid', async () => {
    setPlatform('win32');
    psStdout.value = ''; // the parent is newer than the caller: not our parent
    await whoami();
    expect(psCalls.some((a) => a.includes(`ProcessId=${CALLER}`))).toBe(true);
    expect(whoamiWorkspaces()).not.toContain('ws-stranger');
  });

  it('on Windows, an intact first edge still resolves', async () => {
    setPlatform('win32');
    psStdout.value = String(STALE_PPID); // the parent is older: a real parent
    await whoami();
    expect(whoamiWorkspaces()).toContain('ws-stranger');
  });

  it('elsewhere, keeps starting from callerPpid (orphans are re-parented there)', async () => {
    setPlatform('linux');
    await whoami();
    expect(psCalls.some((a) => a.endsWith(`-p ${CALLER}`))).toBe(false);
    expect(whoamiWorkspaces()).toContain('ws-stranger');
  });
});
