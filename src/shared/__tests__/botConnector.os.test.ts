// The connection contract: what a connection may hold, what each bot gets.
import { describe, expect, it } from 'vitest';
import {
  commandRefusal,
  connectorsForBot,
  isConnectorUrl,
  libraryRefusal,
  otherConnectorsUsing,
  parseConnectorShape,
  type Connector,
} from '../botConnector';
import { CONNECTOR_PRESETS, customConnectorDraft, FILESYSTEM_WRITE_TOOLS, GITHUB_WRITE_TOOLS } from '../botConnectorPresets';
import { isBotSecretName } from '../botSecret';

const A = 'bot-0000000a';
const B = 'bot-0000000b';

function stdio(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'files',
    transport: 'stdio',
    stdio: { command: '/usr/local/bin/mcp-files', args: ['--root', '/data'], env: { LOG_LEVEL: 'info' } },
    secrets: [],
    tools: { mode: 'listed', allowed: ['read_file'] },
    scope: { kind: 'all' },
    enabled: true,
    ...over,
  };
}

function remote(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'gh',
    transport: 'http',
    remote: { url: 'https://api.example.com/mcp/', headers: { 'X-Mode': 'read' } },
    secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }],
    tools: { mode: 'all', blocked: ['merge_pull_request'] },
    scope: { kind: 'all' },
    enabled: true,
    ...over,
  };
}

const refusedField = (raw: unknown, platform: NodeJS.Platform = 'darwin') => {
  const r = parseConnectorShape(raw, platform);
  return r.ok ? null : r.field;
};

function lib(): Connector[] {
  const base = { transport: 'stdio' as const, stdio: { command: '/bin/x', args: [], env: {} }, secrets: [], tools: { mode: 'all' as const, blocked: [] }, createdAt: 1, updatedAt: 1 };
  return [
    { ...base, id: 'con-00000001', name: 'everyone', scope: { kind: 'all' }, offFor: [B], enabled: true },
    { ...base, id: 'con-00000002', name: 'picked', scope: { kind: 'bots', botIds: [A] }, offFor: [], enabled: true },
    { ...base, id: 'con-00000003', name: 'off', scope: { kind: 'all' }, offFor: [], enabled: false },
  ];
}

describe('parseConnectorShape', () => {
  it('accepts a stdio and a remote connection and keeps only their own fields', () => {
    const s = parseConnectorShape(stdio({ extra: 1 }), 'darwin');
    expect(s.ok && s.connector).toMatchObject({ name: 'files', transport: 'stdio', offFor: [] });
    expect(s.ok && 'extra' in s.connector).toBe(false);
    expect(parseConnectorShape(remote(), 'darwin').ok).toBe(true);
  });

  it('refuses names that are malformed, reserved or would split a tool name two ways', () => {
    for (const name of ['', 'G', 'git_hub', 'git--hub', '-x', 'x-', 'wmux', 'wmux-extra', 'claude-x', 'codex', 'ide', 'a'.repeat(33)]) {
      expect(refusedField(stdio({ name }))).toBe('name');
    }
  });

  it('refuses a relative, quoted or privilege-changing command; a bare name or an absolute path passes', () => {
    expect(commandRefusal('npx', 'darwin')).toBeNull();
    expect(commandRefusal('/opt/x/server', 'darwin')).toBeNull();
    expect(commandRefusal('C:\\tools\\server.exe', 'win32')).toBeNull();
    for (const c of ['./server', 'bin/server', 'node_modules/.bin/x', '"x"', 'x;y', '$(x)', 'sudo', '/usr/bin/sudo', '']) {
      expect(commandRefusal(c, 'darwin')).not.toBeNull();
    }
    expect(commandRefusal('tools\\server.exe', 'win32')).not.toBeNull();
    expect(commandRefusal('runas.exe', 'win32')).not.toBeNull();
  });

  it('refuses ${ and control characters in arguments, variables and headers', () => {
    expect(refusedField(stdio({ stdio: { command: '/bin/x', args: ['${GH_TOKEN}'], env: {} } }))).toBe('args');
    expect(refusedField(stdio({ stdio: { command: '/bin/x', args: ['a\nb'], env: {} } }))).toBe('args');
    expect(refusedField(stdio({ stdio: { command: '/bin/x', args: [], env: { MODE: '${HOME}' } } }))).toBe('env');
    expect(refusedField(remote({ remote: { url: 'https://x.dev/', headers: { 'X-A': '${GH_MCP_TOKEN}' } } }))).toBe('headers');
  });

  it('refuses variables that change how code loads, npm settings in any case, and credentials as literals', () => {
    for (const key of ['NODE_OPTIONS', 'PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NPM_CONFIG_REGISTRY', 'npm_config_registry', 'WMUX_X', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE', 'GITHUB_TOKEN', 'API_KEY']) {
      expect(refusedField(stdio({ stdio: { command: '/bin/x', args: [], env: { [key]: 'v' } } })), key).toBe('env');
    }
  });

  it('refuses a credential header given as a literal, and a header a key also sends', () => {
    expect(refusedField(remote({ remote: { url: 'https://x.dev/', headers: { Authorization: 'Bearer abc' } } }))).toBe('headers');
    expect(refusedField(remote({ remote: { url: 'https://x.dev/', headers: { 'X-Api-Key': 'abc' } } }))).toBe('headers');
    expect(refusedField(remote({ remote: { url: 'https://x.dev/', headers: { 'x-mode': 'r' } }, secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header', header: 'X-Mode', scheme: 'raw' }] }))).toBe('headers');
  });

  it('URLs: https anywhere, http to this computer only; no user info or fragment', () => {
    expect(isConnectorUrl('https://api.githubcopilot.com/mcp/readonly')).toBe(true);
    expect(isConnectorUrl('http://127.0.0.1:8080/mcp')).toBe(true);
    expect(isConnectorUrl('http://localhost/mcp')).toBe(true);
    for (const u of ['http://example.com/mcp', 'https://u:p@x.dev/', 'https://x.dev/#a', 'ftp://x.dev/', 'file:///etc/passwd', 'https://x.dev/${A}']) {
      expect(isConnectorUrl(u), u).toBe(false);
    }
  });

  it('keys: credential-shaped names, env for a command and headers for a URL only', () => {
    expect(refusedField(stdio({ secrets: [{ secret: 'LOG_LEVEL', as: 'env' }] }))).toBe('secrets');
    for (const secret of ['ANTHROPIC_API_KEY', 'CLAUDE_TOKEN', 'NPM_CONFIG__AUTH_TOKEN', 'ELECTRON_SECRET', 'LD_SECRET_KEY']) {
      expect(refusedField(stdio({ secrets: [{ secret, as: 'env' }] })), secret).toBe('secrets');
    }
    expect(refusedField(stdio({ secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }] }))).toBe('secrets');
    expect(refusedField(remote({ secrets: [{ secret: 'GH_MCP_TOKEN', as: 'env' }] }))).toBe('secrets');
    expect(refusedField(stdio({ secrets: [{ secret: 'GH_MCP_TOKEN', as: 'env' }, { secret: 'GH_MCP_TOKEN', as: 'env' }] }))).toBe('secrets');
    // A key's name is not also a literal variable.
    expect(refusedField(stdio({ secrets: [{ secret: 'GH_MCP_TOKEN', as: 'env' }], stdio: { command: '/bin/x', args: [], env: { GH_MCP_TOKEN: 'x' } } }))).toBe('env');
  });

  it('tools: valid names only; off-switches only on a connection for every bot', () => {
    expect(refusedField(stdio({ tools: { mode: 'all', blocked: ['bad name'] } }))).toBe('tools');
    expect(refusedField(stdio({ tools: { mode: 'some' } }))).toBe('tools');
    const picked = parseConnectorShape(stdio({ scope: { kind: 'bots', botIds: [A] }, offFor: [B] }), 'darwin');
    expect(picked.ok && picked.connector.offFor).toEqual([]);
  });
});

describe('presets', () => {
  it('every preset is a valid connection with its write tools blocked; Custom lists tools only', () => {
    for (const p of CONNECTOR_PRESETS) {
      const r = parseConnectorShape(p.draft, 'darwin');
      expect(r.ok, p.id).toBe(true);
      expect(p.draft.tools.mode).toBe('all');
    }
    const gh = CONNECTOR_PRESETS.find((p) => p.id === 'github')!.draft;
    expect(gh.remote?.url).toBe('https://api.githubcopilot.com/mcp/readonly');
    expect(gh.tools.mode === 'all' && gh.tools.blocked).toEqual(expect.arrayContaining([...GITHUB_WRITE_TOOLS, 'merge_pull_request', 'push_files']));
    expect(isBotSecretName(gh.secrets[0].secret)).toBe(true);
    const fsPreset = CONNECTOR_PRESETS.find((p) => p.id === 'filesystem')!.draft;
    expect(fsPreset.stdio?.args.join(' ')).toMatch(/@modelcontextprotocol\/server-filesystem@\d/);
    expect(fsPreset.tools.mode === 'all' && fsPreset.tools.blocked).toEqual([...FILESYSTEM_WRITE_TOOLS]);
    expect(customConnectorDraft().tools).toEqual({ mode: 'listed', allowed: [] });
  });
});

describe('connectorsForBot', () => {
  it('every-bot ones not switched off, plus the ones picked for it; a disabled one for nobody', () => {
    expect(connectorsForBot(lib(), A).map((c) => c.name)).toEqual(['everyone', 'picked']);
    expect(connectorsForBot(lib(), B).map((c) => c.name)).toEqual([]);
    // A new bot (Add team included): exactly the enabled every-bot ones.
    expect(connectorsForBot(lib(), 'bot-0000000c').map((c) => c.name)).toEqual(['everyone']);
  });

  it('libraryRefusal: a duplicate name and a bot that is gone', () => {
    const l = lib();
    expect(libraryRefusal({ name: 'picked', scope: { kind: 'all' } }, { library: l, botIds: new Set([A]) })?.field).toBe('name');
    expect(libraryRefusal({ id: 'con-00000002', name: 'picked', scope: { kind: 'bots', botIds: [A] } }, { library: l, botIds: new Set([A]) })).toBeNull();
    expect(libraryRefusal({ name: 'new', scope: { kind: 'bots', botIds: [B] } }, { library: l, botIds: new Set([A]) })?.field).toBe('scope');
  });

  it('otherConnectorsUsing finds the other users of a key', () => {
    const l = lib();
    l[0].secrets = [{ secret: 'SHARED_TOKEN', as: 'env' }];
    l[1].secrets = [{ secret: 'SHARED_TOKEN', as: 'env' }];
    expect(otherConnectorsUsing(l, 'SHARED_TOKEN', 'con-00000001').map((c) => c.name)).toEqual(['picked']);
  });
});
