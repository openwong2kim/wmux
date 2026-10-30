// @vitest-environment jsdom
// Settings › Bots › Connections, the dialog, and a bot profile's row.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BotConnectionsSection } from '../BotConnectionsSection';
import { ConnectionDialog } from '../ConnectionDialog';
import { BotConnections, profileConnections } from '../../Bots/BotConnections';
import type { BotConnectorPort } from '../../Room/botConnectors';
import type { ConnectorView } from '../../../../shared/botConnector';
import { GITHUB_MCP_URL } from '../../../../shared/botConnectorPresets';
import type { FactoryBotRow } from '../../Room/factoryPorts';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'bot-0000000a';
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join(',')})` : key);

function view(over: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: 'con-00000001', name: 'gh', purpose: 'read issues', transport: 'http',
    remote: { url: 'https://x.dev/mcp', headers: {} },
    secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }],
    tools: { mode: 'all', blocked: [] }, scope: { kind: 'all' }, offFor: [], enabled: true,
    createdAt: 1, updatedAt: 1, missingKeys: ['GH_MCP_TOKEN'], ...over,
  };
}

function fakePort(list: ConnectorView[]): BotConnectorPort & { save: ReturnType<typeof vi.fn>; setOffForBot: ReturnType<typeof vi.fn> } {
  return {
    available: true,
    list: vi.fn(async () => ({ ok: true as const, connectors: list })),
    save: vi.fn(async () => ({ ok: true as const, connector: list[0] ?? view() })),
    remove: vi.fn(async () => ({ ok: true as const, deletedKeys: [], keptKeys: [] })),
    setOffForBot: vi.fn(async () => ({ ok: true as const, connector: view() })),
    setEnabled: vi.fn(async () => ({ ok: true as const, connector: view() })),
  };
}

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove(); });

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function type(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('BotConnectionsSection', () => {
  it('lists a connection with who gets it and Key missing in the needs-you text', async () => {
    await mount(<BotConnectionsSection t={t} port={fakePort([view({ offFor: [A] })])} />);
    const row = q('[data-connection="gh"]')!;
    expect(row.textContent).toContain('read issues');
    expect(row.querySelector('[data-connection-scope]')!.textContent).toBe('settings.factory.connections.scopeAllOff(1)');
    expect(row.querySelector('[data-connection-key-missing]')!.className).toContain('--attention-text');
  });

  it('says what connections do when there are none', async () => {
    await mount(<BotConnectionsSection t={t} port={fakePort([])} />);
    expect(host.textContent).toContain('settings.factory.connections.empty');
  });

  it('the GitHub preset saves the read-only server with its write tools blocked, and the typed key once', async () => {
    const port = fakePort([]);
    await mount(<BotConnectionsSection t={t} port={port} />);
    await act(async () => { q('[data-testid="connection-add"]')!.click(); });
    await act(async () => { q('[data-connection-preset="github"]')!.click(); });
    const value = q('[data-testid="connection-key-value-0"]') as HTMLInputElement;
    await act(async () => { type(value, 'ghp_typed_value_0123456789'); });
    await act(async () => { q('[data-testid="connection-save"]')!.click(); });
    await tick();
    expect(port.save).toHaveBeenCalledTimes(1);
    const req = port.save.mock.calls[0][0];
    expect(req.connector).toMatchObject({ name: 'github', transport: 'http', remote: { url: GITHUB_MCP_URL }, scope: { kind: 'all' } });
    expect(req.connector.tools.mode).toBe('all');
    expect(req.connector.terminalAccess?.mode).toBe('none');
    expect(req.connector.tools.blocked).toContain('merge_pull_request');
    expect(req.keyValues).toEqual({ GITHUB_MCP_TOKEN: 'ghp_typed_value_0123456789' });
    // The dialog closed and holds no value.
    expect(q('[data-testid="connection-dialog"]')).toBeNull();
  });

  it('picking bots: each bot\'s checkbox has its own id, and the Scope label names none of them', async () => {
    const row = (id: string, name: string) => ({ bot: { id, name, role: 'lead', workspaceId: 'ws-1', version: 1, engine: { kind: 'claude-sdk' }, triggers: [], budget: {}, enabled: true, createdAt: 1, updatedAt: 1 }, status: null }) as unknown as FactoryBotRow;
    const bots = [row('bot-0000000a', 'A'), row('bot-0000000b', 'B'), row('bot-0000000c', 'C')];
    // Added from a bot's profile: the scope starts as the bots picked.
    await mount(<ConnectionDialog t={t} bots={bots} presetBotId="bot-0000000a" onClose={() => undefined} port={fakePort([])} />);
    const boxes = [...document.querySelectorAll('[data-testid="connection-scope-bots"] [role="checkbox"]')];
    expect(boxes).toHaveLength(3);
    const ids = boxes.map((b) => b.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    for (const label of document.querySelectorAll('label[for]')) expect(ids).not.toContain(label.getAttribute('for'));
  });

  it('Custom starts as only the tools listed', async () => {
    await mount(<BotConnectionsSection t={t} port={fakePort([])} />);
    await act(async () => { q('[data-testid="connection-add"]')!.click(); });
    expect(q('[data-testid="connection-tool-mode"] [aria-checked="true"]')!.textContent).toBe('settings.factory.connections.toolsListed');
  });
});

describe('a bot\'s settings page: its connections', () => {
  it('profileConnections: every enabled one, ticked where it applies to the bot (an every-bot one unless switched off)', () => {
    const lib = [
      view({ id: 'con-00000001', name: 'all', offFor: [A] }),
      view({ id: 'con-00000002', name: 'mine', scope: { kind: 'bots', botIds: [A] } }),
      view({ id: 'con-00000003', name: 'theirs', scope: { kind: 'bots', botIds: ['bot-0000000b'] } }),
      view({ id: 'con-00000004', name: 'off', enabled: false }),
    ];
    expect(profileConnections(lib, A).map((x) => [x.c.name, x.source, x.on])).toEqual([['all', 'all', false], ['mine', 'bot', true], ['theirs', 'bot', false]]);
  });

  it('a tick acts at once: an every-bot one is switched off for this bot alone; a picked one gains or loses this bot in its scope', async () => {
    const port = fakePort([
      view({ name: 'all' }),
      view({ id: 'con-00000002', name: 'mine', scope: { kind: 'bots', botIds: [A, 'bot-0000000b'] } }),
      view({ id: 'con-00000003', name: 'theirs', scope: { kind: 'bots', botIds: ['bot-0000000b'] } }),
    ]);
    const row = { bot: { id: A, name: 'Dev' } } as unknown as FactoryBotRow;
    await mount(<BotConnections row={row} t={t} port={port} />);
    expect(q('[data-testid="bot-connection-manage"]')).toBeNull();
    await act(async () => { q('[data-testid="bot-connection-on-all"]')!.click(); });
    expect(port.setOffForBot).toHaveBeenCalledWith({ id: 'con-00000001', botId: A, off: true });
    await act(async () => { q('[data-testid="bot-connection-on-mine"]')!.click(); });
    const removed = port.save.mock.calls[0][0];
    expect(removed.connector).toMatchObject({ id: 'con-00000002', scope: { kind: 'bots', botIds: ['bot-0000000b'] } });
    expect('missingKeys' in removed.connector).toBe(false);
    await act(async () => { q('[data-testid="bot-connection-on-theirs"]')!.click(); });
    expect(port.save.mock.calls[1][0].connector).toMatchObject({ id: 'con-00000003', scope: { kind: 'bots', botIds: ['bot-0000000b', A] } });
  });
});
