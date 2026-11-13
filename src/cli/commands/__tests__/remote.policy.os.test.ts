/**
 * `wmux remote allow | allowed | revoke` — the remote spawn policy written
 * from a daemon-only host. The daemon pipe is a fake store with the real
 * optimistic-version rule (a stale save is a `conflict`); roots are real git
 * repositories in a temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
  sendDaemonRequest: vi.fn(),
  isDefinitelyNotRunning: (err: unknown) => {
    const code = (err as { code?: string })?.code;
    return code === 'ENOENT' || code === 'ECONNREFUSED';
  },
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendDaemonRequest } from '../../client';
import { resolveSelfContext } from '../../identity';
import { ASK_ON_HEADLESS, handleRemote, policyIo, rootLabel } from '../remote';
import { defaultSpawnPolicy, type A2aSpawnPolicyV1 } from '../../../shared/a2aSpawn';
import { isNestingMarker } from '../../../shared/envFilter';

const daemonRpc = sendDaemonRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

class ExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`exit(${code})`);
  }
}

const FP = Array.from({ length: 32 }, () => 'CD').join(':');
const DESK = '0f1e2d3c-4b5a-4968-8776-655443322110';
const LAPTOP = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const TWIN = '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e';

let tmp: string;
let repo: string;
let plainDir: string;

beforeAll(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-policy-')));
  repo = path.join(tmp, 'repo');
  plainDir = path.join(tmp, 'plain');
  fs.mkdirSync(repo);
  fs.mkdirSync(plainDir);
  execFileSync('git', ['init', '-q', repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The fake daemon: its policy, the PCs it lists, and an optional hook run before a save is checked. */
let store: A2aSpawnPolicyV1;
let hosts: unknown[];
let peers: unknown[];
let beforeSet: ((p: A2aSpawnPolicyV1) => void) | null;
let sets: A2aSpawnPolicyV1[];
let setRefusal: string | null;
/** What the daemon answers when asked whether it finds an agent; undefined: it does not say (an older daemon). */
let agentFound: boolean | undefined;
/** What `daemon.headless.status` answers: in effect or not; undefined: the daemon does not know the method. */
let headlessOn: boolean | undefined;

function policy(patch: Partial<A2aSpawnPolicyV1> = {}): A2aSpawnPolicyV1 {
  return { ...defaultSpawnPolicy(), ...patch };
}

function fakeDaemon(): void {
  daemonRpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    const ok = (result: unknown) => ({ id: 'x', ok: true as const, result });
    switch (method) {
      case 'a2a.remote.hosts.list': return ok({ hosts });
      case 'a2a.remote.peers.list': return ok({ peers });
      case 'daemon.headless.status':
        if (headlessOn === undefined) throw new Error('Unknown method daemon.headless.status');
        return ok({ appAttached: false, optedIn: headlessOn, inEffect: headlessOn });
      case 'a2a.remote.spawnPolicy.get':
        return ok({ policy: structuredClone(store), ...(params['agent'] !== undefined && agentFound !== undefined ? { agentInstalled: agentFound } : {}) });
      case 'a2a.remote.spawnPolicy.set': {
        const next = params['policy'] as A2aSpawnPolicyV1;
        sets.push(structuredClone(next));
        beforeSet?.(store);
        if (setRefusal) return ok({ ok: false, error: setRefusal });
        if (next.version !== store.version) return ok({ ok: false, conflict: true, error: 'the settings changed in the meantime' });
        store = { ...structuredClone(next), version: store.version + 1 };
        return ok({ ok: true, policy: structuredClone(store) });
      }
      default: throw new Error(`unexpected method ${method}`);
    }
  });
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let askSpy: ReturnType<typeof vi.spyOn>;
let ttySpy: ReturnType<typeof vi.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

function printed(): string {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(' ')).join('\n');
}

async function run(sub: string, args: string[], json = false): Promise<number | undefined> {
  try {
    await handleRemote(sub, args, json);
    return 0;
  } catch (err) {
    if (err instanceof ExitCalled) return err.code;
    throw err;
  }
}

const allowArgs = (extra: string[] = []): string[] => ['--from', DESK, '--root', repo, '--agent', 'claude', ...extra];

beforeEach(() => {
  vi.clearAllMocks();
  // This suite itself may run inside an agent session or a wmux pane.
  for (const k of Object.keys(process.env)) {
    if (k === 'WMUX_PTY_ID' || isNestingMarker(k)) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  // Outside a pane by default: the PID walk finds nothing.
  selfContext.mockResolvedValue({});
  store = policy();
  hosts = [{ v: 1, hostId: DESK, name: 'desk', addresses: ['desk.local'], port: 7843, fingerprint256: FP, peerId: 'p1', createdAt: '2026-11-12T00:00:00.000Z' }];
  peers = [{ v: 1, peerId: 'p2', hostId: LAPTOP, name: 'laptop', createdAt: '2026-11-12T00:00:00.000Z' }];
  beforeSet = null;
  setRefusal = null;
  agentFound = undefined;
  headlessOn = undefined;
  sets = [];
  fakeDaemon();
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  ttySpy = vi.spyOn(policyIo, 'stdinIsTty').mockReturnValue(true);
  askSpy = vi.spyOn(policyIo, 'ask').mockResolvedValue('yes');
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
    delete savedEnv[k];
  }
  delete process.env['CLAUDECODE'];
  delete process.env['WMUX_PTY_ID'];
});

describe('wmux remote allow', () => {
  it('writes what the desktop writes for an allow-list rule, after a typed yes', async () => {
    expect(await run('allow', allowArgs(['--sub', './pkg//web/']))).toBe(0);
    expect(askSpy).toHaveBeenCalledTimes(1);
    expect(store.enabled).toBe(true);
    expect(store.approval).toBe('allow-list');
    expect(store.hosts[DESK]).toEqual({ allowed: true });
    expect(store.roots).toHaveLength(1);
    expect(store.roots[0].path).toBe(repo);
    expect(store.roots[0].id).toMatch(/^repo-[a-z0-9]{6}$/);
    expect(store.agents).toEqual(['claude']);
    expect(store.rules).toEqual([{ hostId: DESK, rootId: store.roots[0].id, agent: 'claude', sub: 'pkg/web' }]);
    const out = printed();
    expect(out).toContain(`desk (${DESK}) will be able to start claude in ${path.join(repo, 'pkg', 'web')}`);
    expect(out).toContain('without a per-request approval on this PC');
    expect(out).toContain("access to this machine");
    expect(out).toContain('Policy-wide, applying to every allowed PC: remote spawn turns on; approval changes from ask to allow-list');
    expect(daemonRpc).toHaveBeenCalledWith('a2a.remote.spawnPolicy.set', expect.anything(), 30_000);
  });

  it('warns only when the daemon says it does not find the agent, whatever this shell\'s PATH holds', async () => {
    const warning = 'the daemon did not find claude on the login PATH or in ~/.local/bin of the account it runs as';
    agentFound = false;
    expect(await run('allow', allowArgs())).toBe(0);
    expect(printed()).toContain(warning);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.remote.spawnPolicy.get', { agent: 'claude' });
    for (const found of [true, undefined]) {
      errSpy.mockClear();
      logSpy.mockClear();
      store = policy();
      agentFound = found;
      expect(await run('allow', allowArgs())).toBe(0);
      expect(printed()).not.toContain('did not find');
    }
  });

  it('on a host in headless mode, a rule saved with follow-ups on ask says they will be refused here', async () => {
    headlessOn = true;
    expect(await run('allow', allowArgs())).toBe(0);
    expect(store.followUps).toBe('ask');
    expect(printed()).toContain(ASK_ON_HEADLESS);
    // Already allowed, still on ask: said again.
    logSpy.mockClear();
    expect(await run('allow', allowArgs())).toBe(0);
    expect(printed()).toContain('Already allowed');
    expect(printed()).toContain(ASK_ON_HEADLESS);
    // Not said with direct, nor where headless mode is off or the daemon cannot say.
    for (const [on, extra] of [[true, ['--follow-ups', 'direct']], [false, []], [undefined, []]] as const) {
      logSpy.mockClear();
      errSpy.mockClear();
      store = policy();
      headlessOn = on;
      expect(await run('allow', allowArgs([...extra]))).toBe(0);
      expect(printed()).not.toContain(ASK_ON_HEADLESS);
    }
  });

  it('saves nothing when the answer is not yes', async () => {
    askSpy.mockResolvedValue('y');
    expect(await run('allow', allowArgs())).toBe(1);
    expect(sets).toHaveLength(0);
    expect(printed()).toContain('nothing was saved');
  });

  it('retries a conflict on a fresh read and keeps what the other save did', async () => {
    let raced = false;
    beforeSet = (current) => {
      if (raced) return;
      raced = true;
      // Another save lands first: an unrelated folder added in the desktop app.
      store = { ...current, roots: [...current.roots, { id: 'other-abc123', label: 'other', path: '/srv/other' }], version: current.version + 1 };
    };
    expect(await run('allow', allowArgs())).toBe(0);
    expect(sets).toHaveLength(2);
    expect(askSpy).toHaveBeenCalledTimes(1);
    expect(store.roots.map((r) => r.id)).toContain('other-abc123');
    expect(store.rules).toHaveLength(1);
  });

  it('refuses when a conflicting save changes what was confirmed', async () => {
    beforeSet = (current) => {
      if (current.version > 0) return;
      store = { ...current, permissionMode: 'bypassPermissions', version: current.version + 1 };
    };
    expect(await run('allow', allowArgs())).toBe(1);
    expect(sets).toHaveLength(1);
    expect(store.rules).toHaveLength(0);
    expect(printed()).toContain('Run the command again');
  });

  it('refuses a folder that is not a git top level, before any prompt or save', async () => {
    expect(await run('allow', ['--from', DESK, '--root', plainDir, '--agent', 'claude'])).toBe(1);
    expect(askSpy).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
    expect(printed()).toContain('is not the top level of a git repository');
    fs.mkdirSync(path.join(repo, 'inner'), { recursive: true });
    expect(await run('allow', ['--from', DESK, '--root', path.join(repo, 'inner'), '--agent', 'claude'])).toBe(1);
    expect(printed()).toContain(`(${repo})`);
  });

  it('passes the daemon\'s own refusal through', async () => {
    setRefusal = 'old: the folder does not exist';
    expect(await run('allow', allowArgs())).toBe(1);
    expect(printed()).toContain('the daemon did not save it: old: the folder does not exist');
  });

  it('refuses an unknown host id, and an unknown or ambiguous name', async () => {
    expect(await run('allow', ['--from', TWIN, '--root', repo, '--agent', 'claude'])).toBe(1);
    expect(printed()).toContain('is not a PC paired with this one');
    expect(await run('allow', ['--from', 'nobody', '--root', repo, '--agent', 'claude'])).toBe(1);
    expect(printed()).toContain('no paired PC has the host id or name "nobody"');
    peers = [...peers, { v: 1, peerId: 'p3', hostId: TWIN, name: 'desk', createdAt: '2026-11-12T00:00:00.000Z' }];
    expect(await run('allow', ['--from', 'desk', '--root', repo, '--agent', 'claude'])).toBe(1);
    expect(printed()).toContain('2 paired PCs are named "desk"');
    expect(sets).toHaveLength(0);
    expect(askSpy).not.toHaveBeenCalled();
  });

  it('shows the host id and fingerprint for a unique name, then asks', async () => {
    expect(await run('allow', ['--from', 'desk', '--root', repo, '--agent', 'claude'])).toBe(0);
    const out = printed();
    expect(out).toContain(`"desk" is ${DESK}.`);
    expect(out).toContain(`Certificate fingerprint: ${FP}`);
    expect(askSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses inside an agent session or a wmux pane, before any RPC', async () => {
    process.env['CLAUDECODE'] = '1';
    expect(await run('allow', allowArgs())).toBe(1);
    expect(printed()).toContain('A person must run it');
    delete process.env['CLAUDECODE'];
    process.env['WMUX_PTY_ID'] = 'pty-1';
    expect(await run('allow', allowArgs())).toBe(1);
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  it('refuses without a terminal', async () => {
    ttySpy.mockReturnValue(false);
    expect(await run('allow', allowArgs())).toBe(1);
    expect(printed()).toContain('Run it in a terminal');
    expect(daemonRpc).not.toHaveBeenCalled();
  });

  it('leaves follow-ups and the permission mode alone unless passed', async () => {
    store = policy({ followUps: 'direct', permissionMode: 'acceptEdits' });
    expect(await run('allow', allowArgs())).toBe(0);
    expect(store.followUps).toBe('direct');
    expect(store.permissionMode).toBe('acceptEdits');
    expect(printed()).not.toContain('permission mode changes');
  });

  it('changes them when passed and says it applies to every allowed PC', async () => {
    expect(await run('allow', allowArgs(['--follow-ups', 'direct', '--permission-mode', 'acceptEdits']))).toBe(0);
    expect(store.followUps).toBe('direct');
    expect(store.permissionMode).toBe('acceptEdits');
    expect(printed()).toContain('applying to every allowed PC');
    expect(printed()).toContain('permission mode changes from auto to acceptEdits');
  });

  it('takes bypassPermissions only with its own flag', async () => {
    expect(await run('allow', allowArgs(['--permission-mode', 'bypassPermissions']))).toBe(1);
    expect(sets).toHaveLength(0);
    expect(await run('allow', allowArgs(['--permission-mode', 'bypassPermissions', '--bypass-permissions']))).toBe(0);
    expect(store.permissionMode).toBe('bypassPermissions');
  });

  it('refuses an agent that cannot be started from another PC', async () => {
    expect(await run('allow', ['--from', DESK, '--root', repo, '--agent', 'nope'])).toBe(1);
    expect(printed()).toContain('cannot be started from another PC');
  });

  it('refuses a flag given without its value instead of reading it as absent', async () => {
    expect(await run('allow', allowArgs(['--sub']))).toBe(1);
    expect(await run('allow', allowArgs(['--sub', '--json']))).toBe(1);
    expect(printed()).toContain('--sub needs a value');
    expect(sets).toHaveLength(0);
  });

  it('refuses an explicit --sub that names the root itself', async () => {
    for (const sub of ['', './', './/.']) {
      expect(await run('allow', allowArgs(['--sub', sub]))).toBe(1);
    }
    expect(printed()).toContain('--sub names no folder below the root');
    expect(sets).toHaveLength(0);
    expect(askSpy).not.toHaveBeenCalled();
  });

  it('maps a not_first_party refusal of a call from a pane to running outside wmux', async () => {
    selfContext.mockResolvedValue({ ptyId: 'pty-9' });
    daemonRpc.mockResolvedValue({
      id: 'x', ok: false, code: 'not_first_party',
      error: "not_first_party: a2a.remote.spawnPolicy.get is accepted only from the app's own connection",
    });
    expect(await run('allowed', [])).toBe(1);
    const out = printed();
    expect(out).toContain('not accepted from inside a wmux pane');
    expect(out).toContain('terminal outside wmux');
    expect(out).not.toContain('Remote page');
  });

  it('maps a not_first_party refusal to where the settings are managed', async () => {
    daemonRpc.mockResolvedValue({
      id: 'x', ok: false, code: 'not_first_party',
      error: "not_first_party: a2a.remote.spawnPolicy.get is accepted only from the app's own connection",
    });
    expect(await run('allowed', [])).toBe(1);
    const out = printed();
    expect(out).toContain("managed from the app's Remote page");
    expect(out).not.toContain('accepted only from');
  });

  it('--json keeps stdout to the result: the statement and prompt go to stderr', async () => {
    expect(await run('allow', ['--from', 'desk', '--root', repo, '--agent', 'claude'], true)).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({ ok: true, changed: true });
    expect(askSpy).toHaveBeenCalledWith(expect.any(String), true);
    expect(errSpy.mock.calls.join('\n')).toContain('will be able to start claude');
  });

  it('names allowed PCs without rules that can send requests again when the feature turns on', async () => {
    store = policy({ hosts: { [LAPTOP]: { allowed: true } } });
    expect(await run('allow', allowArgs())).toBe(0);
    expect(printed()).toContain(`can send requests again: laptop (${LAPTOP})`);
  });

  it('refuses a --sub that leaves the root', async () => {
    expect(await run('allow', allowArgs(['--sub', '../x']))).toBe(1);
    expect(sets).toHaveLength(0);
  });

  it('reuses a listed folder, and does nothing when the rule already exists', async () => {
    store = policy({
      enabled: true, approval: 'allow-list', agents: ['claude'], hosts: { [DESK]: { allowed: true } },
      roots: [{ id: 'repo-aaaaaa', label: 'repo', path: repo }],
      rules: [{ hostId: DESK, rootId: 'repo-aaaaaa', agent: 'claude' }],
    });
    expect(await run('allow', allowArgs())).toBe(0);
    expect(askSpy).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
    expect(printed()).toContain('Already allowed');
  });

  it('names other PCs whose saved rules take effect when approval turns to the allow list', async () => {
    store = policy({
      enabled: true, approval: 'ask', agents: ['codex'], hosts: { [LAPTOP]: { allowed: true } },
      roots: [{ id: 'repo-aaaaaa', label: 'repo', path: repo }],
      rules: [{ hostId: LAPTOP, rootId: 'repo-aaaaaa', agent: 'codex' }],
    });
    expect(await run('allow', allowArgs())).toBe(0);
    expect(printed()).toContain(`take effect too: laptop (${LAPTOP})`);
    expect(store.roots).toHaveLength(1);
  });
});

describe('rootLabel', () => {
  it('stays within 64 UTF-16 units without splitting a character', () => {
    const label = rootLabel(`/x/${'😀'.repeat(40)}`);
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label).toBe('😀'.repeat(32));
  });
});

describe('wmux remote allowed', () => {
  it('--json prints the policy as the daemon holds it', async () => {
    store = policy({ enabled: true, hosts: { [DESK]: { allowed: true } }, version: 4 });
    expect(await run('allowed', [], true)).toBe(0);
    const parsed = JSON.parse(String(logSpy.mock.calls[0][0])) as { policy: A2aSpawnPolicyV1 };
    expect(parsed.policy).toEqual(store);
  });

  it('prints each PC with its rules and the policy-wide fields', async () => {
    store = policy({
      enabled: true, approval: 'allow-list', agents: ['claude'], hosts: { [DESK]: { allowed: true } },
      roots: [{ id: 'repo-aaaaaa', label: 'repo', path: repo }],
      rules: [{ hostId: DESK, rootId: 'repo-aaaaaa', agent: 'claude', sub: 'web' }],
    });
    expect(await run('allowed', [])).toBe(0);
    const out = printed();
    expect(out).toContain('Remote spawn: on');
    expect(out).toContain('permission mode: auto');
    expect(out).toContain(`desk (${DESK}): allowed`);
    expect(out).toContain(`claude in ${path.join(repo, 'web')}`);
  });
});

describe('wmux remote revoke', () => {
  beforeEach(() => {
    store = policy({
      enabled: true, approval: 'allow-list', agents: ['claude'],
      hosts: { [DESK]: { allowed: true }, [LAPTOP]: { allowed: true } },
      roots: [{ id: 'repo-aaaaaa', label: 'repo', path: repo }, { id: 'other-bbbbbb', label: 'other', path: '/srv/other' }],
      rules: [
        { hostId: DESK, rootId: 'repo-aaaaaa', agent: 'claude' },
        { hostId: DESK, rootId: 'repo-aaaaaa', agent: 'claude', sub: 'web' },
        { hostId: DESK, rootId: 'other-bbbbbb', agent: 'claude' },
        { hostId: LAPTOP, rootId: 'repo-aaaaaa', agent: 'claude' },
      ],
    });
  });

  it('with --root and --sub removes only that exact rule', async () => {
    expect(await run('revoke', ['--from', DESK, '--root', repo, '--sub', 'web'])).toBe(0);
    expect(store.rules).toHaveLength(3);
    expect(store.rules.some((r) => r.hostId === DESK && r.sub === 'web')).toBe(false);
  });

  it('with --root removes that PC\'s rules for the folder, other PCs untouched', async () => {
    expect(await run('revoke', ['--from', DESK, '--root', repo])).toBe(0);
    expect(store.rules).toEqual([
      { hostId: DESK, rootId: 'other-bbbbbb', agent: 'claude' },
      { hostId: LAPTOP, rootId: 'repo-aaaaaa', agent: 'claude' },
    ]);
    expect(store.roots).toHaveLength(2);
    expect(store.hosts[DESK]).toEqual({ allowed: true });
  });

  it('with --from alone removes that PC\'s allowance and all its rules', async () => {
    expect(await run('revoke', ['--from', DESK])).toBe(0);
    expect(store.hosts[DESK]).toBeUndefined();
    expect(store.rules).toEqual([{ hostId: LAPTOP, rootId: 'repo-aaaaaa', agent: 'claude' }]);
    expect(store.agents).toEqual(['claude']);
  });

  it('refuses --root without a value instead of revoking the whole allowance', async () => {
    expect(await run('revoke', ['--from', DESK, '--root'])).toBe(1);
    expect(sets).toHaveLength(0);
    expect(store.hosts[DESK]).toEqual({ allowed: true });
  });

  it('refuses an explicit --sub that names the root itself', async () => {
    expect(await run('revoke', ['--from', DESK, '--root', repo, '--sub', './'])).toBe(1);
    expect(printed()).toContain('--sub names no folder below the root');
    expect(sets).toHaveLength(0);
    expect(store.rules).toHaveLength(4);
  });

  it('says what approval means once the last rule is gone', async () => {
    store = { ...store, rules: [{ hostId: DESK, rootId: 'repo-aaaaaa', agent: 'claude' }] };
    expect(await run('revoke', ['--from', DESK, '--root', repo])).toBe(0);
    expect(store.approval).toBe('allow-list');
    expect(printed()).toContain('Approval is still "allow list", and no rule is left');
  });

  it('says it when --from alone removes the only PC and its last rule', async () => {
    store = policy({
      enabled: true, approval: 'allow-list', agents: ['claude'], hosts: { [DESK]: { allowed: true } },
      roots: [{ id: 'repo-aaaaaa', label: 'repo', path: repo }],
      rules: [{ hostId: DESK, rootId: 'repo-aaaaaa', agent: 'claude' }],
    });
    expect(await run('revoke', ['--from', DESK])).toBe(0);
    const out = printed();
    expect(out).toContain('may no longer ask this PC to start agents (1 rule removed)');
    expect(out).toContain('Approval is still "allow list", and no rule is left');
    expect(store.approval).toBe('allow-list');
  });

  it('does not say it while rules remain', async () => {
    expect(await run('revoke', ['--from', DESK, '--root', repo])).toBe(0);
    expect(printed()).not.toContain('no rule is left');
  });

  it('exits 1 when nothing matches', async () => {
    expect(await run('revoke', ['--from', DESK, '--root', plainDir])).toBe(1);
    expect(sets).toHaveLength(0);
  });

  it('retries a conflict', async () => {
    let raced = false;
    beforeSet = (current) => {
      if (raced) return;
      raced = true;
      store = { ...current, version: current.version + 1 };
    };
    expect(await run('revoke', ['--from', DESK])).toBe(0);
    expect(sets).toHaveLength(2);
    expect(store.hosts[DESK]).toBeUndefined();
  });

  it('stamps the pane the PID walk finds as senderPtyId, without the env hint', async () => {
    selfContext.mockResolvedValue({ ptyId: 'pty-walk' });
    expect(await run('revoke', ['--from', DESK])).toBe(0);
    expect(daemonRpc.mock.calls.length).toBeGreaterThan(0);
    for (const c of daemonRpc.mock.calls) expect(c[1]).toMatchObject({ senderPtyId: 'pty-walk' });
    expect(selfContext).toHaveBeenCalledTimes(1);
  });

  it('sends no senderPtyId outside a pane, even when the app pipe is down', async () => {
    selfContext.mockRejectedValue(new Error('no app'));
    expect(await run('allowed', [])).toBe(0);
    expect(daemonRpc.mock.calls.every((c) => !('senderPtyId' in (c[1] as object)))).toBe(true);
  });

  it('sends senderPtyId from the WMUX_PTY_ID hint when the walk finds none, and not otherwise', async () => {
    expect(await run('revoke', ['--from', DESK])).toBe(0);
    expect(daemonRpc.mock.calls.every((c) => !('senderPtyId' in (c[1] as object)))).toBe(true);
    daemonRpc.mockClear();
    store = policy({ hosts: { [DESK]: { allowed: true } } });
    process.env['WMUX_PTY_ID'] = 'pty-7';
    expect(await run('revoke', ['--from', DESK])).toBe(0);
    expect(daemonRpc.mock.calls.length).toBeGreaterThan(0);
    for (const c of daemonRpc.mock.calls) expect(c[1]).toMatchObject({ senderPtyId: 'pty-7' });
  });

  it('needs no terminal and runs inside an agent session', async () => {
    ttySpy.mockReturnValue(false);
    process.env['CLAUDECODE'] = '1';
    expect(await run('revoke', ['--from', DESK])).toBe(0);
  });
});
