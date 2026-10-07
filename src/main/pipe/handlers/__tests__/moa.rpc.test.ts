// moa.ask / moa.askStatus on the pipe: off answers `off` with nothing called,
// the asker is stamped from the verified pane, never from params.
import { describe, it, expect, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import type { MoaDelegateServicePort } from '../../../deck/moaDelegatePorts';
import { agentSlugOf, registerMoaRpc } from '../moa.rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;
const CTX: RpcContext = { origin: 'local', clientName: 'claude-code', externalWire: true };
const ASK = { question: 'Reuse it?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] };

function setup(service: Partial<MoaDelegateServicePort> | null) {
  const handlers = new Map<string, Handler>();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) };
  registerMoaRpc(router as never, {
    getService: () => service as MoaDelegateServicePort | null,
    resolvePtyWorkspace: async (pty) => (pty === 'pty-1' ? 'ws-1' : null),
    paneCwd: () => '/repo/wt',
  });
  const call = (m: string, p: Record<string, unknown>, ctx: RpcContext = CTX) => (handlers.get(m) as Handler)(p, ctx);
  return { call };
}

describe('moa.rpc', () => {
  it('with the delegate off answers off and records nothing', async () => {
    const { call } = setup(null);
    expect(await call('moa.ask', { ...ASK, senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'off' });
    expect(await call('moa.askStatus', { ticketId: 'x', senderPtyId: 'pty-1' })).toMatchObject({ ok: false, code: 'off' });
  });

  it('stamps the asker from the verified pane and its cwd; refuses an unresolved or brain caller', async () => {
    const ask = vi.fn(async () => ({ ok: true as const, ticket: { ticketId: 't', status: 'pending' as const } }));
    const { call } = setup({ ask });
    await call('moa.ask', { ...ASK, senderPtyId: 'pty-1' });
    expect(ask).toHaveBeenCalledWith({ ptyId: 'pty-1', workspaceId: 'ws-1', agent: 'claude' }, '/repo/wt', { body: { type: 'question', ...ASK } });
    expect(await call('moa.ask', { ...ASK, senderPtyId: 'pty-9' })).toMatchObject({ ok: false, code: 'not-attributed' });
    expect(await call('moa.ask', { ...ASK })).toMatchObject({ ok: false, code: 'not-attributed' });
    expect(await call('moa.ask', { ...ASK, senderPtyId: 'pty-1' }, { ...CTX, commanderWorkspace: 'ws-1' })).toMatchObject({ ok: false, code: 'not-attributed' });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a caller-named asker or workspace is an unknown field, not an identity', async () => {
    const ask = vi.fn();
    const { call } = setup({ ask });
    expect(await call('moa.ask', { ...ASK, senderPtyId: 'pty-1', workspaceId: 'ws-evil' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call('moa.ask', { ...ASK, senderPtyId: 'pty-1', asker: { ptyId: 'pty-2' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('agent slugs match the daemon\'s', () => {
    expect(agentSlugOf('claude-code')).toBe('claude');
    expect(agentSlugOf('codex-mcp-client')).toBe('codex');
    expect(agentSlugOf(undefined)).toBe('unknown');
  });
});
