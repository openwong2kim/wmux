/**
 * External sessions: the bridge's `where` hint for a hook from outside a wmux
 * pane. Runs the REAL `whereFromEnv` of both bridges (the CLI entrypoint is
 * stripped and the function re-exported from a temp copy), with the tmux
 * lookup injected so no tmux is spawned. Every built value must pass the
 * daemon's own validation, or the whole envelope would be refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAgentSignal, isExternalSessionWhere } from '../../../src/shared/hooks/signal-types';
import { EXTERNAL_SESSION_LIMITS } from '../../../src/shared/externalSessions';

type Env = Record<string, string | undefined>;
type TmuxQuery = ((env: Env) => { session: string; window: string } | null) | null;
type WhereFromEnv = (env: Env, queryTmux: TmuxQuery) => Record<string, string> | undefined;

const BRIDGES = {
  claude: 'integrations/claude/bin/wmux-bridge.mjs',
  openclaude: 'integrations/openclaude/bin/wmux-bridge.mjs',
};
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
const loaded: Record<string, WhereFromEnv> = {};
let openClaudeLookupHooks: Set<string> | undefined;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-where-'));
  for (const [name, rel] of Object.entries(BRIDGES)) {
    const src = readFileSync(path.resolve(process.cwd(), rel), 'utf8');
    const cut = src.indexOf(ENTRYPOINT_MARKER);
    expect(cut).toBeGreaterThan(-1);
    const exported = name === 'openclaude' ? 'whereFromEnv, TMUX_LOOKUP_HOOKS' : 'whereFromEnv';
    const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '') + `\nexport { ${exported} };\n`;
    const mod = path.join(tmp, `${name}-under-test.mjs`);
    writeFileSync(mod, testable, 'utf8');
    const imported = await import(pathToFileURL(mod).href);
    loaded[name] = imported.whereFromEnv;
    if (name === 'openclaude') openClaudeLookupHooks = imported.TMUX_LOOKUP_HOOKS;
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe.each(Object.keys(BRIDGES))('%s bridge whereFromEnv', (name) => {
  const where = (env: Env, query: TmuxQuery = null) => loaded[name](env, query);

  it('tmux: asks the injected lookup for the pane and keeps session and window', () => {
    const asked: Env[] = [];
    const got = where({ TMUX: '/tmp/tmux-501/default,123,0', TMUX_PANE: '%3' }, (env) => {
      asked.push(env);
      return { session: 'work', window: '2' };
    });
    expect(got).toEqual({ kind: 'tmux', session: 'work', window: '2' });
    expect(asked).toHaveLength(1);
  });

  it('tmux without a lookup (a per-tool hook) sends the kind alone, no empty fields', () => {
    expect(where({ TMUX: '/tmp/tmux-501/default,123,0' })).toEqual({ kind: 'tmux' });
    expect(where({ TMUX: 'x' }, () => null)).toEqual({ kind: 'tmux' });
  });

  it('a multiplexer wins over the ssh connection it runs in', () => {
    expect(where({ STY: '4242.pts-0.host', SSH_CONNECTION: '10.0.0.5 50000 10.0.0.1 22' }))
      .toEqual({ kind: 'screen', session: 'pts-0.host' });
    expect(where({ ZELLIJ_SESSION_NAME: 'dev', SSH_CONNECTION: '10.0.0.5 50000 10.0.0.1 22' }))
      .toEqual({ kind: 'zellij', session: 'dev' });
  });

  it('ssh: the label is the client address only', () => {
    expect(where({ SSH_CONNECTION: '192.168.1.20 51234 192.168.1.10 22', TERM_PROGRAM: 'iTerm.app' }))
      .toEqual({ kind: 'ssh', label: '192.168.1.20' });
  });

  it('terminal app, and a WSL distro riding along with any kind', () => {
    expect(where({ TERM_PROGRAM: 'WezTerm', WSL_DISTRO_NAME: 'Ubuntu' }))
      .toEqual({ kind: 'terminal', label: 'WezTerm', wslDistro: 'Ubuntu' });
    expect(where({ WSL_DISTRO_NAME: 'Ubuntu' })).toEqual({ kind: 'unknown', wslDistro: 'Ubuntu' });
  });

  it('nothing to say → undefined, so the envelope carries no `where`', () => {
    expect(where({})).toBeUndefined();
    expect(where({ HOME: '/Users/me' })).toBeUndefined();
  });

  it('strips control characters and caps every field so the daemon accepts it', () => {
    const long = 'x'.repeat(500);
    const got = where({ TMUX: 'x' }, () => ({ session: `\u001b[31mevil\u0007${long}`, window: '\n' }));
    expect(got?.kind).toBe('tmux');
    expect(got?.session?.startsWith('[31mevil')).toBe(true);
    expect(got?.session?.length).toBeLessThanOrEqual(EXTERNAL_SESSION_LIMITS.whereField);
    expect(got).not.toHaveProperty('window');
    expect(isExternalSessionWhere(got)).toBe(true);
    for (const env of [{ TERM_PROGRAM: long }, { SSH_CONNECTION: long }, { STY: `1.${long}`, WSL_DISTRO_NAME: long }]) {
      expect(isExternalSessionWhere(where(env))).toBe(true);
    }
  });
});

describe('AgentSignal `where` validation', () => {
  const base = { kind: 'agent.stop', agent: 'claude', cwd: '/repo', payload: {}, ts: 1 };

  it('accepts a signal without `where`, or with a valid one', () => {
    expect(isAgentSignal(base)).toBe(true);
    expect(isAgentSignal({ ...base, where: { kind: 'ssh', label: '10.0.0.5' } })).toBe(true);
  });

  it('refuses an unknown kind, a non-string or empty field, or a field over the cap', () => {
    expect(isAgentSignal({ ...base, where: { kind: 'kitty' } })).toBe(false);
    expect(isAgentSignal({ ...base, where: { kind: 'tmux', session: 3 } })).toBe(false);
    expect(isAgentSignal({ ...base, where: { kind: 'tmux', session: '' } })).toBe(false);
    expect(isAgentSignal({ ...base, where: { kind: 'tmux', session: 'x'.repeat(EXTERNAL_SESSION_LIMITS.whereField + 1) } })).toBe(false);
    expect(isAgentSignal({ ...base, where: 'tmux' })).toBe(false);
    expect(isAgentSignal({ ...base, where: [] })).toBe(false);
  });
});

// The Claude bridge retries a failed lookup on every UserPromptSubmit; the
// OpenClaude bridge has no such hook, so its once-a-turn retry is Stop.
describe('openclaude bridge tmux lookup', () => {
  it('asks tmux on a session start and once a turn, never per tool call', () => {
    expect([...(openClaudeLookupHooks ?? [])].sort()).toEqual(['SessionStart', 'Stop']);
  });
});
