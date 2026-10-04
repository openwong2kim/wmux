// #1624 — Codex capture admission against a real TranscriptDiscovery, with the
// same apply order the daemon's applyResumeBinding uses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isProvisionalCapture, mergeResumeBinding, type ResumeBinding } from '../../../shared/agentResume';
import type { AgentSignal } from '../../../shared/hooks/signal-types';
import { TranscriptDiscovery } from '../TranscriptDiscovery';
import { admitCodexCapture, gateCodexStop, HELD_BACK_SEARCH_MS } from '../codexCapture';

const A = '01a0e700-0000-7000-8000-00000000000a';
const B = '01a0e700-0000-7000-8000-00000000000b';
const T = '01a0e700-0000-7000-8000-00000000000c';
const PANE = 'pty-1';

let home: string;
let env: Record<string, string>;
let discovery: TranscriptDiscovery;
let binding: ResumeBinding | undefined;
let ts = 0;
const starts: Array<{ id: string; deadlineMs?: number }> = [];

function rollout(id: string): string {
  const dir = path.join(home, 'sessions', '2026', '09', '28');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-28T21-00-00-${id}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  return file;
}

/** Mirrors applyResumeBinding for a Codex capture. */
function apply(next: ResumeBinding): void {
  const prev = binding;
  const decision = admitCodexCapture(PANE, prev, next, env, discovery);
  if (!decision.apply || isProvisionalCapture(prev, decision.binding)) return;
  binding = mergeResumeBinding(binding, decision.binding);
}

const notify = (id: string) => apply({ agent: 'codex', sessionId: id, cwd: '/w', ts: ++ts });

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-capture-'));
  fs.mkdirSync(path.join(home, 'sessions'));
  env = { CODEX_HOME: home };
  binding = undefined;
  starts.length = 0;
  discovery = new TranscriptDiscovery({
    getSessionEnv: () => env,
    onFound: (f) => apply({ agent: 'codex', sessionId: f.agentSessionId, cwd: f.cwd, transcriptPath: f.transcriptPath, ts: ++ts }),
    pollMs: 10,
    debounceMs: 5,
  });
  const start = discovery.start.bind(discovery);
  discovery.start = (pane, id, cwd, agent, deadlineMs) => {
    starts.push({ id, ...(deadlineMs !== undefined ? { deadlineMs } : {}) });
    start(pane, id, cwd, agent, deadlineMs);
  };
});

afterEach(() => {
  discovery.dispose();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('admitCodexCapture (#1624)', () => {
  it('first turn: the title thread does not replace the bound rollout and starts no long search', () => {
    const file = rollout(A);
    notify(A);
    expect(binding).toMatchObject({ sessionId: A, transcriptPath: file });
    notify(T);
    expect(binding).toMatchObject({ sessionId: A, transcriptPath: file });
    expect(starts).toEqual([{ id: T, deadlineMs: HELD_BACK_SEARCH_MS }]);
  });

  it('/new with a late rollout: the title thread does not cancel B\'s search, and B binds when its rollout appears', async () => {
    const fileA = rollout(A);
    notify(A);
    notify(B);
    notify(T);
    expect(binding).toMatchObject({ sessionId: A, transcriptPath: fileA });
    expect(discovery.pendingFor(PANE)).toEqual({ agent: 'codex', agentSessionId: B });
    const fileB = rollout(B);
    await until(() => binding?.sessionId === B);
    expect(binding).toMatchObject({ sessionId: B, transcriptPath: fileB });
  });

  it('first-use pane with a late rollout: nothing binds until B\'s rollout exists, and the title thread does not displace B\'s search', async () => {
    notify(B);
    expect(binding).toBeUndefined();
    notify(T);
    expect(binding).toBeUndefined();
    expect(discovery.pendingFor(PANE)).toEqual({ agent: 'codex', agentSessionId: B });
    const fileB = rollout(B);
    await until(() => binding?.transcriptPath === fileB);
    expect(binding).toMatchObject({ sessionId: B, transcriptPath: fileB });
  });

  it('title thread first: the real session binds as soon as its rollout exists', () => {
    notify(T);
    const fileB = rollout(B);
    notify(B);
    expect(binding).toMatchObject({ sessionId: B, transcriptPath: fileB });
    expect(discovery.pendingFor(PANE)).toBeUndefined();
  });

  it('fresh pane: a title-thread notify does not bind the pane', () => {
    notify(T);
    expect(binding).toBeUndefined();
    expect(starts).toEqual([{ id: T, deadlineMs: HELD_BACK_SEARCH_MS }]);
  });

  it('a real-thread notify on a fresh pane binds with its rollout path', () => {
    const file = rollout(A);
    notify(A);
    expect(binding).toMatchObject({ sessionId: A, transcriptPath: file });
    expect(discovery.pendingFor(PANE)).toBeUndefined();
  });
});

describe('gateCodexStop', () => {
  const stop = (id: string) => ({ agent: 'codex' as const, kind: 'agent.stop' as const, agentSessionId: id, payload: {} as Record<string, unknown> });
  const boundTo = (id: string, transcriptPath: string): ResumeBinding => ({ agent: 'codex', sessionId: id, cwd: '/w', transcriptPath, ts: 1 });

  function gate(id: string, extra: { bound?: ResumeBinding; wsl?: boolean } = {}) {
    const calls: Array<{ kind: 'admit'; path: unknown } | { kind: 'drop' }> = [];
    const now = gateCodexStop(stop(id), {
      env, ...extra, graceMs: 60, pollMs: 10,
      admit: (late) => calls.push({ kind: 'admit', path: late.payload.transcript_path }),
      drop: () => calls.push({ kind: 'drop' }),
    });
    return { now, calls };
  }

  it('a title-thread stop on a rollout-bound pane is not the turn end: held, then dropped', async () => {
    const { now, calls } = gate(T, { bound: boundTo(A, rollout(A)) });
    expect(now).toBeNull();
    expect(calls).toEqual([]);
    await until(() => calls.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([{ kind: 'drop' }]);
  });

  it('a stop whose rollout lands inside the grace is admitted late, once, with its path', async () => {
    const { now, calls } = gate(B, { bound: boundTo(A, rollout(A)) });
    expect(now).toBeNull();
    const fileB = rollout(B);
    await until(() => calls.length > 0);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual([{ kind: 'admit', path: fileB }]);
  });

  it('a stop whose rollout exists passes at once, carrying the path so admission does not rescan', () => {
    const file = rollout(A);
    expect(gate(A).now?.payload).toEqual({ transcript_path: file });
  });

  it('a stop for the thread the pane is bound to passes with the bound path, without a scan', () => {
    expect(gate(A, { bound: boundTo(A, '/elsewhere/a.jsonl') }).now?.payload).toEqual({ transcript_path: '/elsewhere/a.jsonl' });
  });

  it('passes a rollout-less stop when nothing proves where this pane writes rollouts', () => {
    // A fresh pane with no binding: the root may simply be the wrong one.
    expect(gate(T).now).toEqual(stop(T));
    // A binding whose path is outside the pane env's sessions root (CODEX_HOME set in a shell rc).
    expect(gate(T, { bound: boundTo(A, path.join(os.tmpdir(), 'not-codex-home', 'a.jsonl')) }).now).toEqual(stop(T));
  });

  it('a WSL pane\'s normal stop passes: its rollout lives in the distro', () => {
    const { now, calls } = gate(B, { bound: boundTo(A, rollout(A)), wsl: true });
    expect(now).toEqual(stop(B));
    expect(calls).toEqual([]);
  });

  it('passes every other signal untouched', () => {
    const calls: string[] = [];
    const opts = { env, admit: () => calls.push('a'), drop: () => calls.push('d') };
    const others: Array<Pick<AgentSignal, 'agent' | 'kind' | 'agentSessionId' | 'payload'>> = [
      { agent: 'claude', kind: 'agent.stop', agentSessionId: T, payload: {} },
      { agent: 'codex', kind: 'agent.subagent_stop', agentSessionId: T, payload: {} },
      { agent: 'codex', kind: 'agent.stop', payload: {} },
    ];
    for (const signal of others) expect(gateCodexStop(signal, opts)).toBe(signal);
    expect(calls).toEqual([]);
  });
});

describe('spooled Codex records', () => {
  it('a spooled title-thread id (no rollout) is not admitted at boot', () => {
    const decision = admitCodexCapture(PANE, undefined, { agent: 'codex', sessionId: T, cwd: '/w', ts: 1 }, env, null);
    expect(decision).toEqual({ apply: false });
  });

  it('a spooled real-thread id is admitted with its path', () => {
    const file = rollout(A);
    expect(admitCodexCapture(PANE, undefined, { agent: 'codex', sessionId: A, cwd: '/w', ts: 1 }, env, null))
      .toEqual({ apply: true, binding: { agent: 'codex', sessionId: A, cwd: '/w', ts: 1, transcriptPath: file } });
  });

  it('the boot spool ingest routes Codex records through admitCodexCapture', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf8');
    const body = src.slice(src.indexOf('function ingestResumeSpool'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/binding\.agent === 'codex'[\s\S]*admitCodexCapture\(ptyId, prev, binding, managed\.meta\.env, null\)/);
  });
});
