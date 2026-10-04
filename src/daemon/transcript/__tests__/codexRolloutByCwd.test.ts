// Codex rollout by cwd: a fresh pane binds to its rollout without a notify,
// and anything it cannot decide alone refuses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexCwdBinder, findCodexRolloutByCwd, type CodexCwdQuery } from '../codexRolloutByCwd';

const A = '01a0e700-0000-7000-8000-00000000000a';
const B = '01a0e700-0000-7000-8000-00000000000b';
const C = '01a0e700-0000-7000-8000-00000000000c';

const NOW = new Date(2026, 9, 4, 12, 0, 0).getTime();
const LAUNCH = NOW - 10_000;

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
  fs.utimesSync(file, new Date(at), new Date(at));
  return file;
}

const query = (extra: Partial<CodexCwdQuery> = {}): CodexCwdQuery => ({ cwd, notBefore: LAUNCH, env, now: NOW, ...extra });

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
  it('binds the one rollout started in the pane cwd after the launch', () => {
    const file = rollout(A);
    rollout(B, { cwd: path.join(cwd, 'elsewhere') });
    rollout(C, {}, LAUNCH - 60_000); // an older session in the same cwd
    expect(findCodexRolloutByCwd(query())).toEqual({ ok: true, threadId: A, transcriptPath: file, cwd });
  });

  it('refuses when two rollouts share the cwd', () => {
    rollout(A);
    rollout(B, {}, LAUNCH + 2_000);
    expect(findCodexRolloutByCwd(query())).toEqual({ ok: false, reason: 'ambiguous' });
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

describe('CodexCwdBinder', () => {
  async function until(check: () => boolean): Promise<void> {
    const end = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('retries until the rollout appears, then binds once', async () => {
    const bound: string[] = [];
    const binder = new CodexCwdBinder({
      pane: () => (bound.length ? undefined : { cwd, notBefore: Date.now() - 5_000, env, sharedCwd: false }),
      bind: (_pane, match) => bound.push(match.threadId),
      delaysMs: [0, 20, 20, 20, 20],
    });
    binder.arm('pty-1');
    await new Promise((r) => setTimeout(r, 10));
    expect(bound).toEqual([]);
    rollout(A, {}, Date.now());
    await until(() => bound.length > 0);
    binder.arm('pty-1'); // a later banner after the bind is a no-op
    await new Promise((r) => setTimeout(r, 50));
    expect(bound).toEqual([A]);
    binder.dispose();
  });

  it('refuses a cwd another unbound Codex pane shares', async () => {
    rollout(A, {}, Date.now());
    const bound: string[] = [];
    const logs: string[] = [];
    const binder = new CodexCwdBinder({
      pane: () => ({ cwd, notBefore: Date.now() - 5_000, env, sharedCwd: true }),
      bind: (_pane, match) => bound.push(match.threadId),
      log: (_level, message) => logs.push(message),
      delaysMs: [0],
    });
    binder.arm('pty-1');
    await until(() => logs.length > 0);
    expect(bound).toEqual([]);
    expect(logs[0]).toContain('shares its cwd');
    binder.dispose();
  });
});
