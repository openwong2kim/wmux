import { describe, expect, it, vi } from 'vitest';
import { continueOnAccount, planWslTranscriptCopy, wslAccountEnv, type ContinueOnAccountDeps, type ContinueOnAccountWslDeps } from '../continueOnAccount';
import { keepOwnWslTranscriptPath } from '../hooks/transcriptPathGuard';
import { parseWslAccountCopy, runWslAccountCopy, wslAccountCopyArgs } from '../wslAccountCopy';
import { wslAccountHomeKey } from '../../shared/wslAccountHome';
import type { ResumeBinding } from '../../shared/agentResume';
import { buildWslInjection } from '../../shared/wslIntegration';
import { setWslAccountKeys } from '../../shared/wslAccountMark';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SID = '0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const TARGET = { distribution: 'Ubuntu', user: 'me' };
const ACCOUNT_B = 'C:\\Users\\me\\.wmux\\accounts\\claude-b';
const HOME_B = `/home/me/.wmux/accounts/claude-${wslAccountHomeKey(ACCOUNT_B)}`;
const SOURCE = `/home/me/.claude/projects/-home-me-repo/${SID}.jsonl`;
const COPY = `${HOME_B}/projects/-home-me-repo/${SID}.jsonl`;

const binding = (over: Partial<ResumeBinding> = {}): ResumeBinding => ({
  agent: 'claude', sessionId: SID, cwd: '/home/me/repo', wslTranscriptPath: SOURCE, ts: 1, ...over,
});

function deps(over: Partial<ContinueOnAccountDeps> = {}, wsl: Partial<ContinueOnAccountWslDeps> = {}): ContinueOnAccountDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pane: () => ({ wslTarget: TARGET, env: {}, resumeBinding: binding() }),
    liveAgent: () => 'claude',
    turnClosed: () => true,
    // The daemon's shellKind answers null for a WSL pane: the WSL branch never asks it.
    shellKind: () => null,
    stopClaude: async () => { calls.push('stop'); return { ok: true, stopped: true, pid: 1, killed: 0 }; },
    paneFree: async () => true,
    promptRevision: () => 7,
    markKeys: () => undefined,
    rebind: (_id, dir, b) => { calls.push(`rebind:${dir}:${b.wslTranscriptPath}:${b.transcriptPath ?? '-'}`); return () => { calls.push('undo'); }; },
    write: (_id, data) => { calls.push(`write:${data}`); return true; },
    sleep: async () => undefined,
    wsl: {
      agentTracked: () => true,
      sourceReady: async () => { calls.push('ready'); return true; },
      copy: async (_id, req) => { calls.push(`copy:${req.plan.source}>${req.plan.target}`); return { result: 'copied', home: HOME_B }; },
      ...wsl,
    },
    ...over,
  };
}

describe('planWslTranscriptCopy', () => {
  it('copies the pane\'s own transcript into the account\'s home in the distro', () => {
    expect(planWslTranscriptCopy(binding(), { wslTarget: TARGET, env: {} }, ACCOUNT_B)).toEqual({
      ok: true, plan: { source: SOURCE, project: '-home-me-repo', home: HOME_B, target: COPY },
    });
  });

  it('honours the data suffix the pane\'s next spawn would use', () => {
    const planned = planWslTranscriptCopy(binding(), { wslTarget: TARGET, env: { WMUX_DATA_SUFFIX: '-dev' } }, ACCOUNT_B);
    expect(planned.ok && planned.plan.home).toBe(`/home/me/.wmux-dev/accounts/claude-${wslAccountHomeKey(ACCOUNT_B)}`);
  });

  it('refuses another user\'s transcript, a Windows path, and the account the pane already runs', () => {
    const plan = (b: ResumeBinding, env: Record<string, string> = {}) => planWslTranscriptCopy(b, { wslTarget: TARGET, env }, ACCOUNT_B);
    expect(plan(binding({ wslTranscriptPath: `/home/other/.claude/projects/-x/${SID}.jsonl` }))).toEqual({ ok: false, code: 'unknown_session' });
    expect(plan(binding({ wslTranscriptPath: undefined, transcriptPath: `C:\\x\\projects\\-x\\${SID}.jsonl` }))).toEqual({ ok: false, code: 'unknown_session' });
    expect(plan(binding({ agent: 'codex' }))).toEqual({ ok: false, code: 'not_claude' });
    const onB = { CLAUDE_CONFIG_DIR: ACCOUNT_B, WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR' };
    expect(plan(binding({ wslTranscriptPath: COPY }), onB)).toEqual({ ok: false, code: 'same_account' });
    expect(planWslTranscriptCopy(binding(), { wslTarget: TARGET }, 'relative\\dir')).toEqual({ ok: false, code: 'invalid_account' });
  });
});

describe('wslAccountEnv', () => {
  it('marks the account, so the new Claude\'s hooks are kept and a recovery runs its home', () => {
    const env = wslAccountEnv({ CODEX_HOME: 'C:\\codex', WMUX_WSL_ACCOUNT_KEYS: 'CODEX_HOME' }, ACCOUNT_B, TARGET);
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: ACCOUNT_B, WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR,CODEX_HOME', WMUX_WSL_ACCOUNT_DISTRO: 'Ubuntu' });
    const rebound = { ...binding(), wslTranscriptPath: COPY };
    expect(keepOwnWslTranscriptPath(rebound, TARGET, env)).toEqual({ binding: rebound, dropped: false });
    // Unmarked, the same path is not the pane's own.
    expect(keepOwnWslTranscriptPath(rebound, TARGET, { CLAUDE_CONFIG_DIR: ACCOUNT_B }).dropped).toBe(true);
  });
});

describe('continueOnAccount in a WSL pane', () => {
  it('stops the pane\'s Claude, copies in the distro, rebinds the Linux path only, then types the resume', async () => {
    const d = deps();
    expect(await continueOnAccount(d, 'p1', ACCOUNT_B)).toEqual({ ok: true, sessionId: SID, transcriptPath: COPY });
    expect(d.calls.slice(0, 4)).toEqual(['ready', 'stop', `copy:${SOURCE}>${COPY}`, `rebind:${ACCOUNT_B}:${COPY}:-`]);
    expect(d.calls[4]).toBe(`write:cd -- '/home/me/repo' && CLAUDE_CONFIG_DIR='${HOME_B}' claude --resume ${SID}\r`);
  });

  it('types nothing when the copy went to another home than the line names', async () => {
    const d = deps({}, { copy: async () => ({ result: 'copied', home: '/somewhere/else' }) });
    expect(await continueOnAccount(d, 'p1', ACCOUNT_B)).toEqual({ ok: false, code: 'copy_failed' });
    expect(d.calls.some((c) => c.startsWith('rebind') || c.startsWith('write'))).toBe(false);
  });

  it('maps the script\'s same and diverged answers', async () => {
    expect(await continueOnAccount(deps({}, { copy: async () => ({ result: 'same', home: HOME_B }) }), 'p1', ACCOUNT_B)).toEqual({ ok: false, code: 'same_account' });
    expect(await continueOnAccount(deps({}, { copy: async () => ({ result: 'diverged', home: HOME_B }) }), 'p1', ACCOUNT_B)).toEqual({ ok: false, code: 'diverged' });
  });

  it('copy-only (a vault sign-in): copies in the distro with Claude left running, and hands back the Linux folder', async () => {
    const d = deps();
    expect(await continueOnAccount(d, 'p1', ACCOUNT_B, { copyOnly: true, wslNewPane: true })).toEqual({
      ok: true, sessionId: SID, transcriptPath: COPY, cwd: '/home/me/repo', wsl: true,
    });
    expect(d.calls).toEqual(['ready', `copy:${SOURCE}>${COPY}`]);
  });

  it('copy-only: the new pane, run on the account as this pane\'s user, gets the home the copy was planned into', () => {
    const planned = planWslTranscriptCopy(binding(), { wslTarget: TARGET, env: {} }, ACCOUNT_B);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-home-match-'));
    try {
      // What pty.handler hands the daemon for the new pane: the account's folder, marked as the account's.
      const env: Record<string, string> = { CLAUDE_CONFIG_DIR: ACCOUNT_B };
      setWslAccountKeys(env, ['CLAUDE_CONFIG_DIR']);
      const injected = buildWslInjection({ target: TARGET, cwd: '/home/me/repo', env, integrationDir: dir, bashInit: '', bridgePath: '/unused' });
      expect(planned.ok && planned.plan.home).toBe(`/home/${TARGET.user}/.wmux/accounts/claude-${injected.env.WMUX_WSL_ACCOUNT_CLAUDE}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('copy-only refuses a copy into another home, an open turn, and the same or a diverged copy', async () => {
    const run = (d: ReturnType<typeof deps>) => continueOnAccount(d, 'p1', ACCOUNT_B, { copyOnly: true, wslNewPane: true });
    expect(await run(deps({}, { copy: async () => ({ result: 'copied', home: '/somewhere/else' }) }))).toEqual({ ok: false, code: 'copy_failed' });
    expect(await run(deps({}, { copy: async () => ({ result: 'failed', reason: 'x' }) }))).toEqual({ ok: false, code: 'copy_failed' });
    expect(await run(deps({}, { copy: async () => ({ result: 'same', home: HOME_B }) }))).toEqual({ ok: false, code: 'same_account' });
    expect(await run(deps({}, { copy: async () => ({ result: 'diverged', home: HOME_B }) }))).toEqual({ ok: false, code: 'diverged' });
    const open = deps({ turnClosed: () => false });
    expect(await run(open)).toEqual({ ok: false, code: 'turn_open' });
    expect(open.calls.filter((c) => c !== 'ready')).toEqual([]);
  });

  it('refuses before anything stops: an unreported Claude, no WSL support, a missing source', async () => {
    const cases: Array<[ReturnType<typeof deps>, { copyOnly?: boolean; wslNewPane?: boolean }, string]> = [
      // A main that would open a Windows pane at the Linux folder.
      [deps(), { copyOnly: true }, 'unsupported'],
      // An unreported Claude: its turn is not known to be closed either.
      [deps({}, { agentTracked: () => false }), { copyOnly: true, wslNewPane: true }, 'unsupported'],
      [deps({ wsl: undefined }), { copyOnly: true, wslNewPane: true }, 'unsupported'],
      [deps({}, { agentTracked: () => false }), {}, 'unsupported'],
      [deps({ wsl: undefined }), {}, 'unsupported'],
      [deps({}, { sourceReady: async () => false }), {}, 'unknown_session'],
      [deps({ pane: () => ({ wslTarget: TARGET, env: {}, resumeBinding: binding({ cwd: '~' }) }) }), {}, 'unknown_session'],
      [deps({ pane: () => ({ wslTarget: TARGET, exec: { command: 'x' }, resumeBinding: binding() }) }), {}, 'unsupported'],
    ];
    for (const [d, opts, code] of cases) {
      expect(await continueOnAccount(d, 'p1', ACCOUNT_B, opts)).toEqual({ ok: false, code });
      expect(d.calls.filter((c) => c !== 'ready')).toEqual([]);
    }
  });

  it('fails closed on a shell that reports no prompt (a .bashrc that execs zsh or fish): the copy stays, nothing is typed', async () => {
    let t = 0;
    const d = deps({ promptRevision: () => null, now: () => (t += 1_000) });
    const res = await continueOnAccount(d, 'p1', ACCOUNT_B);
    expect(res).toEqual({ ok: false, code: 'shell_busy', resumeCommand: `cd -- '/home/me/repo' && CLAUDE_CONFIG_DIR='${HOME_B}' claude --resume ${SID}` });
    expect(d.calls.some((c) => c.startsWith('rebind') || c.startsWith('write'))).toBe(false);
  });
});

describe('runWslAccountCopy', () => {
  const req = {
    shell: 'wsl.exe', target: TARGET, hostPid: 42, key: 'abcdef0123456789', share: true, suffix: '',
    accountScript: 'C:\\wmux\\wsl\\account.sh', source: SOURCE, project: '-home-me-repo', sessionId: SID,
  };

  it('never runs wsl.exe for a pane whose wsl.exe is gone (it would boot the distro)', async () => {
    const run = vi.fn();
    expect(await runWslAccountCopy(req, { run, hostAlive: () => false })).toMatchObject({ result: 'failed' });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs as the pane\'s user with every value an argument, and only the script path in WSLENV', async () => {
    const run = vi.fn(async () => ({ code: 10, stdout: `${HOME_B}\n`, stderr: '' }));
    expect(await runWslAccountCopy(req, { run, hostAlive: () => true })).toEqual({ result: 'copied', home: HOME_B });
    const [shell, args, env] = run.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
    expect(shell).toBe('wsl.exe');
    expect(args.slice(0, 9)).toEqual(['--distribution', 'Ubuntu', '--user', 'me', '--exec', '/bin/bash', '--noprofile', '--norc', '-c']);
    expect(args.slice(10)).toEqual(wslAccountCopyArgs(req));
    expect(env.WMUX_WSL_ACCOUNT_SH).toBe(req.accountScript);
    expect(env.WSLENV?.split(':')).toContain('WMUX_WSL_ACCOUNT_SH/p');
  });

  it('reads exit codes, not text', () => {
    expect(parseWslAccountCopy(11, `${HOME_B}\n`)).toEqual({ result: 'same', home: HOME_B });
    expect(parseWslAccountCopy(12, `${HOME_B}\n`)).toEqual({ result: 'diverged', home: HOME_B });
    expect(parseWslAccountCopy(0, 'copied\n')).toMatchObject({ result: 'failed' });
    expect(parseWslAccountCopy(10, '')).toMatchObject({ result: 'failed' });
  });
});
