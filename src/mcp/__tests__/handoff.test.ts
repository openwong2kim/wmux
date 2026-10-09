// moa_propose_handoff: wire mapping and the commander-only placement.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerMoaHandoffTool, PROPOSE_HANDOFF_TIMEOUT_MS } from '../handoff';
import { COMMANDER_ONLY_TOOLS, COMMANDER_RPC_METHODS } from '../../shared/commanderSurface';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

function collect(token: string | undefined = 'tok-hq') {
  const callRpc = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: '{"ok":true,"id":"h1","mode":"card"}' }] }));
  let handler: Handler | undefined;
  registerMoaHandoffTool(((name: string, _d: string, _s: unknown, h: Handler) => {
    if (name === 'moa_propose_handoff') handler = h;
  }) as never, { callRpc, getCommanderToken: () => token });
  if (!handler) throw new Error('moa_propose_handoff was not registered');
  return { callRpc, handler };
}

describe('moa_propose_handoff', () => {
  it('forwards token, target, body, title and externalSource to deck.proposeHandoff', async () => {
    const { callRpc, handler } = collect();
    const res = await handler({ ptyId: 'pty-7', body: 'Fix the flaky test', title: 'Flaky test', external_source: true });
    expect(callRpc).toHaveBeenCalledWith('deck.proposeHandoff', {
      token: 'tok-hq', ptyId: 'pty-7', body: 'Fix the flaky test', title: 'Flaky test', externalSource: true,
    }, PROPOSE_HANDOFF_TIMEOUT_MS);
    // The call outwaits a danger-mode delivery's gated wait.
    expect(PROPOSE_HANDOFF_TIMEOUT_MS).toBeGreaterThan(45_000);
    // The result is passed through untouched.
    expect(JSON.stringify(res)).toContain('"mode\\":\\"card');
  });

  it('sends no origin, caller pane id or absent optionals', async () => {
    const { callRpc, handler } = collect();
    await handler({ paneId: 'pane-3', body: 'x' });
    const params = callRpc.mock.calls[0][1];
    expect(params).toEqual({ token: 'tok-hq', paneId: 'pane-3', body: 'x' });
    expect(params).not.toHaveProperty('origin');
    expect(params).not.toHaveProperty('callerPtyId');
  });

  it('resolves a #pane name in ptyId or paneId before calling main', async () => {
    const callRpc = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: "{}" }] }));
    let handler: Handler | undefined;
    registerMoaHandoffTool(((name: string, _d: string, _s: unknown, h: Handler) => {
      if (name === 'moa_propose_handoff') handler = h;
    }) as never, {
      callRpc,
      getCommanderToken: () => 'tok-hq',
      resolvePtyId: async (ref) => (ref === '#backend' ? 'daemon-1' : ref),
      resolvePaneId: async (ref) => (ref === '#w2-1' ? 'pane-21' : ref),
    });
    await handler!({ ptyId: '#backend', body: 'x' });
    await handler!({ paneId: '#w2-1', body: 'y' });
    expect(callRpc.mock.calls[0][1]).toEqual({ token: 'tok-hq', ptyId: 'daemon-1', body: 'x' });
    expect(callRpc.mock.calls[1][1]).toEqual({ token: 'tok-hq', paneId: 'pane-21', body: 'y' });
  });

  it('is commander-only, with its RPC in the commander lane and the first-party set', () => {
    expect(COMMANDER_ONLY_TOOLS).toContain('moa_propose_handoff');
    expect(COMMANDER_RPC_METHODS.has('deck.proposeHandoff')).toBe(true);
    expect(FIRST_PARTY_METHODS.has('deck.proposeHandoff')).toBe(true);
    const baseline = JSON.parse(readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'mcp-protocol-baseline.json'), 'utf8'));
    expect(baseline.profiles.commander.toolNames).toContain('moa_propose_handoff');
    expect(baseline.profiles.full.toolNames).not.toContain('moa_propose_handoff');
    expect(baseline.profiles.core.toolNames).not.toContain('moa_propose_handoff');
  });
});
