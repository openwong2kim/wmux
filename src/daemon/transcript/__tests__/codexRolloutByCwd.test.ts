// Codex rollout by cwd: a fresh pane binds to its rollout without a notify,
// and anything it cannot decide alone refuses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResumeBinding } from '../../../shared/agentResume';
import {
  CodexCwdBinder, describeCodexPane, findCodexRolloutByCwd, LAUNCH_WINDOW_MS, MAX_HEAD_READS, parseEtime,
  type CodexCwdQuery, type CodexPaneFacts,
} from '../codexRolloutByCwd';

const A = '01a0e700-0000-7000-8000-00000000000a';
const B = '01a0e700-0000-7000-8000-00000000000b';
const C = '01a0e700-0000-7000-8000-00000000000c';

const LAUNCH = new Date(2026, 9, 4, 12, 0, 0).getTime();

let home: string;
let cwd: string;
let env: Record<string, string>;

function rollout(id: string, meta: Record<string, unknown> = {}, at = LAUNCH + 1_000): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dir = path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  const payload = {
    id, session_id: id, timestamp: new Date(at).toISOString(), cwd,
    originator: 'codex-tui', source: 'cli', thread_source: 'user',
    base_instructions: { text: 'x'.repeat(30_000) },
    ...meta,
  };
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'session_meta', payload })}\n`);
  return file;
}

const uuid = (n: number) => `01a0e700-0000-7000-8000-${String(n).padStart(12, '0')}`;
const query = (extra: Partial<CodexCwdQuery> = {}): CodexCwdQuery => ({ cwd, notBefore: LAUNCH, env, ...extra });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-cwd-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-wt-'));
  env = { CODEX_HOME: home };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('findCodexRolloutByCwd', () => {
  it('binds the one rollout started in the pane cwd inside the launch window', () => {
    const file = rollout(A);
    rollout(B, { cwd: path.join(cwd, 'elsewhere') });
    rollout(C, {}, LAUNCH - 60_000); // an older session in the same cwd
    rollout(uuid(9), {}, LAUNCH + LAUNCH_WINDOW_MS + 30_000); // a later one, past the window
    expect(findCodexRolloutByCwd(query())).toEqual({ ok: true, threadId: A, transcriptPath: file, cwd });
  });

  it('refuses when two rollouts share the cwd', () => {
    rollout(A);
    rollout(B, {}, LAUNCH + 2_000);
    expect(findCodexRolloutByCwd(query())).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('refuses when there are more candidates than it reads, instead of binding the first one it read', () => {
    rollout(A);
    for (let i = 1; i <= MAX_HEAD_READS; i += 1) rollout(uuid(100 + i), { cwd: path.join(cwd, `other-${i}`) }, LAUNCH + 2_000);
    expect(findCodexRolloutByCwd(query())).toEqual({ ok: false, reason: 'budget' });
  });

  it('skips sub-agent, relay and excluded threads', () => {
    rollout(A, { thread_source: 'subagent', source: { subagent: { thread_spawn: {} } } });
    rollout(B, { originator: 'wmux_phone', source: 'vscode' });
    rollout(C);
    expect(findCodexRolloutByCwd(query({ exclude: new Set([C]) }))).toEqual({ ok: false, reason: 'none' });
  });

  it('finds nothing before the rollout is written', () => {
    expect(findCodexRolloutByCwd(query())).toEqual({ ok: false, reason: 'none' });
  });
});

describe('describeCodexPane', () => {
  const binding = (sessionId: string, ts: number): ResumeBinding => ({ agent: 'codex', sessionId, cwd, transcriptPath: `/x/${sessionId}.jsonl`, ts });
  const pane = (extra: Partial<CodexPaneFacts> = {}): CodexPaneFacts => ({ id: 'pty-self', cwd, launchAt: LAUNCH, codexLive: true, ...extra });

  it('waits when the launch is unknown (no command-start, no process start time)', () => {
    expect(describeCodexPane(pane({ launchAt: undefined }), [])).toEqual({ kind: 'wait' });
  });

  it('treats a pane bound only for an earlier run as a cwd conflict', () => {
    const other = pane({ id: 'pty-a', binding: binding(A, LAUNCH - 3_600_000), launchAt: LAUNCH - 1_000 });
    expect(describeCodexPane(pane(), [other])).toEqual({ kind: 'refuse', reason: 'shared-cwd' });
  });

  it('treats a live Codex pane with no launch marker in the same cwd as a conflict', () => {
    expect(describeCodexPane(pane(), [pane({ id: 'pty-a', launchAt: undefined })])).toEqual({ kind: 'refuse', reason: 'shared-cwd' });
  });

  it('lets a pane bound for its current run share the cwd, and excludes its thread', () => {
    const other = pane({ id: 'pty-a', binding: binding(A, LAUNCH + 5_000), launchAt: LAUNCH - 1_000 });
    const decision = describeCodexPane(pane(), [other, pane({ id: 'pty-b', codexLive: false, cwd: '/elsewhere' })], env);
    expect(decision).toMatchObject({ kind: 'query', query: { cwd, notBefore: LAUNCH, env } });
    expect(decision.kind === 'query' && [...(decision.query.exclude ?? [])]).toEqual([A]);
  });

  it('skips a pane already bound for its current run, but not one bound for an earlier run', () => {
    expect(describeCodexPane(pane({ binding: binding(A, LAUNCH + 1) }), [])).toEqual({ kind: 'skip' });
    expect(describeCodexPane(pane({ binding: binding(A, LAUNCH - 60_000) }), []).kind).toBe('query');
  });
});

describe('parseEtime', () => {
  it('reads every ps elapsed-time shape', () => {
    expect(parseEtime('  00:07\n')).toBe(7_000);
    expect(parseEtime('01:02:03')).toBe(3_723_000);
    expect(parseEtime('2-00:00:01')).toBe(172_801_000);
    expect(parseEtime('')).toBeUndefined();
  });
});

describe('CodexCwdBinder', () => {
  async function until(check: () => boolean): Promise<void> {
    const end = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('waits for a launch marker, retries until the rollout appears, then binds once', async () => {
    const bound: string[] = [];
    const marker: { launchAt?: number } = {};
    const binder = new CodexCwdBinder({
      pane: () => (bound.length ? { kind: 'skip' } : describeCodexPane({ id: 'pty-1', cwd, codexLive: true, ...marker }, [], env)),
      bind: (_pane, match) => bound.push(match.threadId),
      delaysMs: [0, 20, 20, 20, 20, 20],
    });
    binder.arm('pty-1');
    rollout(A, {}, Date.now());
    await new Promise((r) => setTimeout(r, 30));
    expect(bound).toEqual([]); // no launch marker yet
    marker.launchAt = Date.now() - 5_000;
    await until(() => bound.length > 0);
    binder.arm('pty-1'); // a later banner after the bind is a no-op
    await new Promise((r) => setTimeout(r, 50));
    expect(bound).toEqual([A]);
    binder.dispose();
  });

  it('logs and stops on a shared cwd', async () => {
    rollout(A, {}, Date.now());
    const bound: string[] = [];
    const logs: string[] = [];
    const binder = new CodexCwdBinder({
      pane: () => ({ kind: 'refuse', reason: 'shared-cwd' }),
      bind: (_pane, match) => bound.push(match.threadId),
      log: (_level, message) => logs.push(message),
      delaysMs: [0, 10],
    });
    binder.arm('pty-1');
    await until(() => logs.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(bound).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('shares its cwd');
    binder.dispose();
  });
});
