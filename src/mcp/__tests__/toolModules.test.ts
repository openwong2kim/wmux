import { afterEach, describe, expect, it, vi } from 'vitest';
// The SDK's subpath exports resolve under vitest but not under the import plugin.
// eslint-disable-next-line import/no-unresolved
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  __resetToolModulesForTesting,
  installBotTools,
  registerToolModule,
  registeredToolModules,
  type ToolModule,
} from '../toolModules';
import { ROLE_SURFACES, ROOM_POST_SURFACE_TOOLS, SHARED_SURFACE, botSurfaceTools } from '../../shared/botSurface';

function fakeServer() {
  const names: string[] = [];
  const raw = (name: string) => {
    names.push(name);
    return { name };
  };
  return { names, rawTool: vi.fn(raw), rawRegisterTool: vi.fn(raw) };
}

const deps = { role: 'verifier' as const, callRpc: vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{}' }] })) };

afterEach(() => __resetToolModulesForTesting());

describe('registerToolModule', () => {
  it('keeps modules in registration order', () => {
    registerToolModule({ name: 'a', tools: ['fact_poll'], register: () => undefined });
    registerToolModule({ name: 'b', tools: ['room_post'], register: () => undefined });
    expect(registeredToolModules().map((m) => m.name)).toEqual(['a', 'b']);
  });

  it('refuses a duplicate module, a non-bot tool and a tool two modules claim', () => {
    registerToolModule({ name: 'a', tools: ['fact_poll'], register: () => undefined });
    expect(() => registerToolModule({ name: 'a', tools: [], register: () => undefined })).toThrow(/twice/);
    expect(() => registerToolModule({ name: 'c', tools: ['terminal_send' as never], register: () => undefined })).toThrow(/not a bot tool/);
    expect(() => registerToolModule({ name: 'd', tools: ['fact_poll'], register: () => undefined })).toThrow(/claimed by both/);
  });
});

describe('installBotTools', () => {
  it('registers a module\'s surface tools and placeholders for the rest of the surface', () => {
    const s = fakeServer();
    const module: ToolModule = {
      name: 'facts',
      tools: ['fact_poll'],
      register: (host) => {
        host.tool('fact_poll', 'poll facts', {}, async () => ({ content: [] }));
      },
    };
    const registered = new Set<string>(['pr_read']);
    installBotTools({ role: 'verifier', ...s, deps, registered, modules: [module] });
    expect(s.names[0]).toBe('fact_poll');
    expect(s.names).not.toContain('pr_read');
    expect(new Set([...registered])).toEqual(new Set(ROLE_SURFACES.verifier.tools));
  });

  it('a bot on My Hermes (--bot-surface=room-post) lists exactly room_post; any other value lists nothing', () => {
    const s = fakeServer();
    const registered = new Set<string>();
    installBotTools({ role: 'lead', ...s, deps, registered, modules: [], surface: botSurfaceTools('room-post') });
    expect([...registered]).toEqual(['room_post']);
    expect(botSurfaceTools('room-post')).toBe(ROOM_POST_SURFACE_TOOLS);
    expect(botSurfaceTools(undefined)).toBe(SHARED_SURFACE.tools);
    expect(botSurfaceTools('wide').size).toBe(0);
  });

  it('drops a module tool that is off the bot surface', () => {
    const s = fakeServer();
    const module: ToolModule = {
      name: 'park-tools',
      tools: ['bot_park'],
      register: (host) => {
        expect(host.tool('bot_park', 'x', {}, async () => ({ content: [] }))).toBeUndefined();
      },
    };
    const registered = new Set<string>();
    installBotTools({ role: 'moa', ...s, deps, registered, modules: [module] });
    expect(registered.has('bot_park')).toBe(false);
  });

  it('a module that throws or registers an undeclared name is skipped; its tools get placeholders', () => {
    const s = fakeServer();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bad: ToolModule = {
      name: 'bad',
      tools: ['room_post'],
      register: (host) => {
        host.tool('room_read', 'not mine', {}, async () => ({ content: [] }));
      },
    };
    const registered = new Set<string>();
    installBotTools({ role: 'lead', ...s, deps, registered, modules: [bad] });
    expect(errSpy).toHaveBeenCalled();
    expect(registered.has('room_post')).toBe(true);
    expect(registered.has('room_read')).toBe(true);
    errSpy.mockRestore();
  });

  it('a module cannot rename a registered tool past the surface (real SDK handle)', () => {
    const server = new McpServer({ name: 't', version: '1' });
    let renamed: unknown;
    const module: ToolModule = {
      name: 'rooms',
      tools: ['room_post'],
      register: (host) => {
        const handle = host.tool('room_post', 'post', {}, async () => ({ content: [] }));
        try {
          handle?.update({ name: 'terminal_send' });
        } catch (err) {
          renamed = err;
        }
        handle?.update({ description: 'still fine' });
      },
    };
    installBotTools({
      role: 'lead',
      rawTool: server.tool.bind(server) as never,
      rawRegisterTool: server.registerTool.bind(server) as never,
      deps,
      registered: new Set(),
      modules: [module],
    });
    expect(String(renamed)).toContain('cannot be renamed');
    const tools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
    expect(Object.keys(tools)).not.toContain('terminal_send');
    expect(tools.room_post.description).toBe('still fine');
  });

  it('a placeholder forwards to the tool\'s primary RPC', async () => {
    let handler: ((a: { args?: Record<string, unknown> }) => Promise<unknown>) | undefined;
    const rawTool = vi.fn((name: string, ...rest: unknown[]) => {
      if (name === 'ask_person') handler = rest[rest.length - 1] as typeof handler;
      return {};
    });
    installBotTools({ role: 'moa', rawTool, rawRegisterTool: vi.fn(), deps, registered: new Set(), modules: [] });
    await handler?.({ args: { title: 't' } });
    expect(deps.callRpc).toHaveBeenCalledWith('ask.person', { title: 't' });
  });
});
