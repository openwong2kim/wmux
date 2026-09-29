// automation_propose / automation_list / automation_runs: full + core only,
// propose rejects any option outside its seven fields (so an agent cannot even
// phrase "enabled" or "permission"), and a refusal surfaces as isError.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { createAutomationToolCatalog, registerAutomationTools } from '../automation';
import { toolInputSchema, type WmuxToolProfile } from '../toolCatalog';
import { expectCommanderCatalogLockstep, expectCoreCatalogLockstep, expectFrozenCatalog } from './catalogAssertions';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const sendRpc = vi.fn(async (): Promise<unknown> => ({ ok: true }));

function collectTools(profile: WmuxToolProfile): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = { registerTool: (name: string, _c: unknown, h: ToolHandler) => tools.set(name, h) };
  registerAutomationTools(server as never, { sendRpc }, { profile, context: { principal: { kind: 'unattributed' } } });
  return tools;
}

const draft = { name: 'n', cwd: '/r', agent: 'claude', prompt: 'p', weekdays: [1], time: '09:00' };

beforeEach(() => sendRpc.mockClear());

describe('automation tools registration', () => {
  it.each<WmuxToolProfile>(['full', 'core'])('is listed in the %s profile', (profile) => {
    expect([...collectTools(profile).keys()]).toEqual(['automation_propose', 'automation_list', 'automation_runs']);
  });

  it('is not on the commander surface', () => {
    expect(collectTools('commander').size).toBe(0);
  });

  it('keeps the core and commander manifests in lockstep with the catalog', () => {
    const specs = createAutomationToolCatalog({ sendRpc });
    expectCommanderCatalogLockstep(specs);
    expectCoreCatalogLockstep(specs);
    expectFrozenCatalog(specs);
  });

  it('propose rejects options outside its fields', () => {
    const [propose] = createAutomationToolCatalog({ sendRpc });
    const schema = toolInputSchema(propose) as z.ZodObject<z.ZodRawShape>;
    expect(schema.safeParse(draft).success).toBe(true);
    for (const extra of [{ enabled: true }, { permission: 'bypass' }, { allowedTools: ['Bash'] }]) {
      expect(schema.safeParse({ ...draft, ...extra }).success).toBe(false);
    }
  });
});

describe('automation tools invocation', () => {
  it('propose forwards exactly the draft fields', async () => {
    await collectTools('full').get('automation_propose')!(draft);
    expect(sendRpc).toHaveBeenCalledWith('automation.propose', draft);
  });

  it('a refusal comes back as isError', async () => {
    sendRpc.mockResolvedValueOnce({ ok: false, error: { code: 'RATE_LIMITED', message: 'x' } });
    const res = await collectTools('full').get('automation_propose')!(draft);
    expect(res.isError).toBe(true);
  });

  it('list and runs map to their RPCs', async () => {
    const tools = collectTools('core');
    await tools.get('automation_list')!({});
    expect(sendRpc).toHaveBeenLastCalledWith('automation.list', {});
    await tools.get('automation_runs')!({});
    expect(sendRpc).toHaveBeenLastCalledWith('automation.runs', {});
    await tools.get('automation_runs')!({ automationId: 'a1' });
    expect(sendRpc).toHaveBeenLastCalledWith('automation.runs', { automationId: 'a1' });
  });
});
