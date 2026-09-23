// fleet_triage: the MCP tool forwards to the fleet.triage RPC with exactly the
// params the caller gave, is registered in every profile, and never resolves an
// omitted workspaceId to the caller's own workspace (the question is fleet-wide).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFleetTriageToolCatalog, registerFleetTriageTools } from '../fleetTriage';
import type { WmuxToolProfile } from '../toolCatalog';
import {
  expectCommanderCatalogLockstep,
  expectCoreCatalogLockstep,
  expectFrozenCatalog,
} from './catalogAssertions';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
}>;

const mockCallRpc = vi.fn(async () => ({
  content: [{ type: 'text' as const, text: '{}' }],
}));

function collectTools(profile: WmuxToolProfile): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerFleetTriageTools(server as never, { callRpc: mockCallRpc }, {
    profile,
    context: { principal: { kind: 'unattributed' } },
  });
  return tools;
}

beforeEach(() => {
  mockCallRpc.mockClear();
});

describe('fleet_triage registration', () => {
  it.each<WmuxToolProfile>(['full', 'core', 'commander'])('is listed in the %s profile', (profile) => {
    expect([...collectTools(profile).keys()]).toEqual(['fleet_triage']);
  });

  it('keeps the core and commander manifests in lockstep with the catalog', () => {
    const specs = createFleetTriageToolCatalog({ callRpc: mockCallRpc });
    expectCommanderCatalogLockstep(specs);
    expectCoreCatalogLockstep(specs);
    expectFrozenCatalog(specs);
  });

  it('keeps the description inside the tools/list budget', () => {
    const [spec] = createFleetTriageToolCatalog({ callRpc: mockCallRpc });
    expect(spec.description.length).toBeLessThanOrEqual(220);
  });
});

describe('fleet_triage invocation', () => {
  const triage = collectTools('full').get('fleet_triage')!;

  it('asks for the whole fleet when no workspaceId is given', async () => {
    await triage({});
    expect(mockCallRpc).toHaveBeenCalledWith('fleet.triage', {});
  });

  it('forwards workspaceId and includeIdle verbatim', async () => {
    await triage({ workspaceId: 'ws-2', includeIdle: true });
    expect(mockCallRpc).toHaveBeenCalledWith('fleet.triage', { workspaceId: 'ws-2', includeIdle: true });
  });

  it('forwards an explicit includeIdle:false', async () => {
    await triage({ includeIdle: false });
    expect(mockCallRpc).toHaveBeenCalledWith('fleet.triage', { includeIdle: false });
  });

  it('forwards an empty workspaceId so the renderer can refuse it', async () => {
    await triage({ workspaceId: '' });
    expect(mockCallRpc).toHaveBeenCalledWith('fleet.triage', { workspaceId: '' });
  });
});
