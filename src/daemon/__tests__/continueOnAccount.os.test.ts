import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  continueOnAccount, copyTranscript, planTranscriptCopy, relaunchLine, type ContinueOnAccountDeps,
} from '../continueOnAccount';
import type { ResumeBinding } from '../../shared/agentResume';

const SID = '0b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

let root: string;
let accountA: string;
let accountB: string;
let source: string;

const binding = (over: Partial<ResumeBinding> = {}): ResumeBinding => ({
  agent: 'claude', sessionId: SID, cwd: '/work/repo', transcriptPath: source, ts: 1, ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-continue-'));
  accountA = path.join(root, 'a');
  accountB = path.join(root, 'b');
  fs.mkdirSync(path.join(accountA, 'projects', '-work-repo'), { recursive: true });
  fs.mkdirSync(accountB);
  source = path.join(accountA, 'projects', '-work-repo', `${SID}.jsonl`);
  fs.writeFileSync(source, '{"turn":1}\n{"turn":2}\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('planTranscriptCopy', () => {
  it('copies into the same project folder name under the target account', () => {
    expect(planTranscriptCopy(binding(), accountB)).toEqual({
      ok: true, source, target: path.join(accountB, 'projects', '-work-repo', `${SID}.jsonl`),
    });
  });

  it('refuses what is not exactly the pane\'s own Claude conversation, or the same account', () => {
    expect(planTranscriptCopy(undefined, accountB)).toEqual({ ok: false, code: 'unknown_session' });
    expect(planTranscriptCopy(binding({ agent: 'codex' }), accountB)).toEqual({ ok: false, code: 'not_claude' });
    expect(planTranscriptCopy(binding({ transcriptPath: undefined }), accountB)).toEqual({ ok: false, code: 'unknown_session' });
    // The binding's id must be the transcript's own name.
    expect(planTranscriptCopy(binding({ sessionId: '1b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d' }), accountB))
      .toEqual({ ok: false, code: 'unknown_session' });
    expect(planTranscriptCopy(binding({ transcriptPath: path.join(root, `${SID}.jsonl`) }), accountB))
      .toEqual({ ok: false, code: 'unknown_session' });
    expect(planTranscriptCopy(binding(), accountA)).toEqual({ ok: false, code: 'same_account' });
  });
});

describe('copyTranscript', () => {
  it('never touches the source, replaces an earlier copy, refuses a diverged one', async () => {
    const target = path.join(accountB, 'projects', '-work-repo', `${SID}.jsonl`);
    expect(await copyTranscript(source, target)).toBe('copied');
    expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(source, 'utf8'));
    fs.appendFileSync(source, '{"turn":3}\n');
    expect(await copyTranscript(source, target)).toBe('copied');
    expect(fs.readFileSync(target, 'utf8')).toContain('"turn":3');
    fs.appendFileSync(target, '{"elsewhere":true}\n');
    expect(await copyTranscript(source, target)).toBe('diverged');
    expect(fs.readFileSync(source, 'utf8')).toBe('{"turn":1}\n{"turn":2}\n{"turn":3}\n');
  });

  it('refuses a target projects folder linked to the source one, leaving the source as it was', async () => {
    const linked = path.join(root, 'c');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(accountA, 'projects'), path.join(linked, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = fs.readFileSync(source, 'utf8');
    expect(await copyTranscript(source, path.join(linked, 'projects', '-work-repo', `${SID}.jsonl`))).toBe('same');
    expect(fs.readFileSync(source, 'utf8')).toBe(before);
  });
});

describe('relaunchLine', () => {
  it('pins the account on the agent only, in the session\'s folder, for both shells', () => {
    expect(relaunchLine(binding({ permissionMode: 'bypassPermissions' }), "/acct/it's", 'posix'))
      .toBe(`cd -- '/work/repo' && CLAUDE_CONFIG_DIR='/acct/it'\\''s' claude --resume ${SID} --dangerously-skip-permissions\r`);
    expect(relaunchLine(binding({ cwd: 'C:\\work\\repo' }), 'C:\\Users\\me\\.wmux\\accounts\\claude-1', 'pwsh'))
      .toBe(`if (Set-Location -LiteralPath 'C:\\work\\repo' -PassThru -ErrorAction SilentlyContinue) { $env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.wmux\\accounts\\claude-1'; claude --resume ${SID} }\r`);
  });
});

describe('continueOnAccount', () => {
  const deps = (over: Partial<ContinueOnAccountDeps> = {}): ContinueOnAccountDeps & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      pane: () => ({ resumeBinding: binding() }),
      liveAgent: () => 'claude',
      turnClosed: () => true,
      shellKind: () => 'posix',
      stopClaude: async (_id, stillIdle) => {
        calls.push('stop');
        return stillIdle() ? { ok: true, stopped: true, pid: 1, killed: 1 } : { ok: false, code: 'turn_open' };
      },
      paneFree: async () => true,
      promptRevision: () => 7,
      rebind: (_id, _dir, b) => { calls.push(`rebind:${b.transcriptPath}`); return () => { calls.push('undo'); }; },
      write: (_id, data) => { calls.push(`write:${data}`); return true; },
      copy: async (s, t) => { calls.push('copy'); return copyTranscript(s, t); },
      sleep: async () => undefined,
      ...over,
    };
  };

  it('stops, copies, rebinds and types the resume of the pane\'s own session, in that order', async () => {
    const d = deps();
    const res = await continueOnAccount(d, 'p1', accountB);
    expect(res).toEqual({ ok: true, sessionId: SID, transcriptPath: path.join(accountB, 'projects', '-work-repo', `${SID}.jsonl`) });
    expect(d.calls.slice(0, 3)).toEqual(['stop', 'copy', `rebind:${path.join(accountB, 'projects', '-work-repo', `${SID}.jsonl`)}`]);
    expect(d.calls[3]).toContain(`claude --resume ${SID}`);
    expect(fs.existsSync(source)).toBe(true);
  });

  it('refuses another agent or an open turn before anything stops, and undoes a rebind the prompt raced', async () => {
    const other = deps({ liveAgent: () => 'codex' });
    expect(await continueOnAccount(other, 'p1', accountB)).toEqual({ ok: false, code: 'not_claude' });
    const busy = deps({ turnClosed: () => false });
    expect(await continueOnAccount(busy, 'p1', accountB)).toEqual({ ok: false, code: 'turn_open' });
    expect([...other.calls, ...busy.calls]).toEqual([]);

    const revisions = [7, 8];
    const raced = deps({ promptRevision: vi.fn(() => revisions.shift() ?? null) });
    expect(await continueOnAccount(raced, 'p1', accountB)).toEqual({ ok: false, code: 'shell_busy' });
    expect(raced.calls.map((c) => c.split(':')[0])).toEqual(['stop', 'copy', 'rebind', 'undo']);

    // A hook rebound the pane to another conversation while Claude stopped: nothing is copied or typed.
    let reads = 0;
    const rebound = deps({ pane: () => ({ resumeBinding: reads++ === 0 ? binding() : binding({ sessionId: '1b5c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d' }) }) });
    expect(await continueOnAccount(rebound, 'p1', accountB)).toEqual({ ok: false, code: 'unknown_session' });
    expect(rebound.calls).toEqual(['stop']);
  });

  it('stops, copies and types nothing at a folder-trust prompt', async () => {
    const atTrust = deps({ atFolderTrust: async () => true });
    expect(await continueOnAccount(atTrust, 'p1', accountB)).toEqual({ ok: false, code: 'folder_trust' });
    expect(atTrust.calls).toEqual([]);
    const clear = deps({ atFolderTrust: async () => false });
    expect((await continueOnAccount(clear, 'p1', accountB)).ok).toBe(true);
  });

  it('waits for the prompt for its time, however long each look at the pane takes (#2507)', async () => {
    // A pane at its prompt with a child still running, where reading the
    // process table takes a second (Windows): the wait ends after its 5 s,
    // not after fifty looks.
    let clock = 0;
    const paneFree = vi.fn(async () => { clock += 1_000; return false; });
    const busy = deps({ paneFree, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(await continueOnAccount(busy, 'p1', accountB)).toEqual({ ok: false, code: 'shell_busy' });
    expect(paneFree.mock.calls.length).toBeLessThanOrEqual(6);
    expect(clock).toBeLessThan(7_000);

    // A command still running at the shell: no prompt, so the pane is never read.
    const running = vi.fn(async () => true);
    const mid = deps({ paneFree: running, promptRevision: () => null, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(await continueOnAccount(mid, 'p1', accountB)).toEqual({ ok: false, code: 'shell_busy' });
    expect(running).not.toHaveBeenCalled();
  });

  it('copy-only (a token account): copies and returns what the new pane resumes; stops, rebinds and types nothing', async () => {
    const shellKind = vi.fn(() => null);
    const d = deps({ shellKind, pane: () => ({ resumeBinding: binding({ permissionMode: 'acceptEdits' }) }) });
    const res = await continueOnAccount(d, 'p1', accountB, { copyOnly: true });
    const target = path.join(accountB, 'projects', '-work-repo', `${SID}.jsonl`);
    expect(res).toEqual({ ok: true, sessionId: SID, transcriptPath: target, cwd: '/work/repo', permissionMode: 'acceptEdits' });
    expect(d.calls).toEqual(['copy']);
    expect(fs.readFileSync(target, 'utf8')).toBe(fs.readFileSync(source, 'utf8'));
    // The source pane's shell is never asked about: nothing is typed there.
    expect(shellKind).not.toHaveBeenCalled();

    // The same checks first: an open turn or another agent copies nothing.
    const busy = deps({ turnClosed: () => false });
    expect(await continueOnAccount(busy, 'p1', accountB, { copyOnly: true })).toEqual({ ok: false, code: 'turn_open' });
    const other = deps({ liveAgent: () => 'codex' });
    expect(await continueOnAccount(other, 'p1', accountB, { copyOnly: true })).toEqual({ ok: false, code: 'not_claude' });
    expect([...busy.calls, ...other.calls]).toEqual([]);
  });
});
