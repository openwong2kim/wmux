// #1823: a Codex pane saved as `agent: 'claude'` with a rollout filename stem
// is healed when sessions.json loads.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateWriter } from '../../StateWriter';
import type { DaemonSession } from '../../types';

const THREAD = '01234567-89ab-7cde-8fab-0123456789ab';
const STEM = `rollout-2026-10-03T12-48-30-${THREAD}`;
// The reporter's pane cwd (#1823). Kept verbatim: it is data, never resolved.
const WIN_CWD = 'C:\\work\\repo';

let tmp: string;
let codexHome: string;

function session(overrides: Partial<DaemonSession>): DaemonSession {
  return {
    id: 'pane-1', state: 'detached', createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    pid: 12345, cmd: 'pwsh.exe', cwd: WIN_CWD, env: { CODEX_HOME: codexHome }, cols: 120, rows: 30, deadTtlHours: 24,
    lastDetectedAgent: 'codex',
    resumeBinding: { agent: 'claude', sessionId: STEM, cwd: WIN_CWD, ts: 1791307112942 },
    ...overrides,
  };
}

function writeRollout(id: string): string {
  const dir = path.join(codexHome, 'sessions', '2026', '10', '03');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${STEM}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: WIN_CWD } })}\n`);
  return file;
}

function loadThroughMainWriter(s: DaemonSession): { loaded: DaemonSession; persisted: DaemonSession; warnings: string[] } {
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  new StateWriter(stateDir).saveImmediate({ version: 1, sessions: [s] });
  const warnings: string[] = [];
  const main = new StateWriter(stateDir, undefined, undefined, true, (m) => warnings.push(m));
  try {
    const loaded = main.load().sessions[0];
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'sessions.json'), 'utf8')).sessions[0];
    return { loaded, persisted, warnings };
  } finally {
    main.dispose();
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-heal-1823-'));
  codexHome = path.join(tmp, 'codex-home');
  fs.mkdirSync(codexHome);
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('load-time heal of a Claude binding over a Codex rollout (#1823)', () => {
  it('converts it to the Codex binding when the rollout resolves to its thread', () => {
    const file = writeRollout(THREAD);
    const { loaded, persisted, warnings } = loadThroughMainWriter(session({}));
    const want = { agent: 'codex', sessionId: THREAD, cwd: WIN_CWD, transcriptPath: file, ts: 1791307112942 };
    expect(loaded.resumeBinding).toEqual(want);
    expect(loaded.resumeBinding?.cwd).toBe(WIN_CWD);
    expect(loaded.lastDetectedAgent).toBe('codex');
    expect(persisted.resumeBinding).toEqual(loaded.resumeBinding);
    expect(warnings).toEqual(['[StateWriter] converted a Codex rollout resume binding stored as claude on session pane-1']);
  });

  it('points the pill at Codex when the poisoned binding had also set lastDetectedAgent to claude', () => {
    writeRollout(THREAD);
    const { loaded } = loadThroughMainWriter(session({ lastDetectedAgent: 'claude' }));
    expect(loaded.resumeBinding?.agent).toBe('codex');
    expect(loaded.lastDetectedAgent).toBe('codex');
  });

  it('drops it when the rollout file is gone', () => {
    const { loaded, persisted, warnings } = loadThroughMainWriter(session({}));
    expect(loaded.resumeBinding).toBeUndefined();
    expect(persisted.resumeBinding).toBeUndefined();
    expect(loaded.lastDetectedAgent).toBe('codex');
    expect(warnings[0]).toContain('dropped a Codex rollout resume binding');
  });

  it('drops it when the rollout names a different thread', () => {
    writeRollout('fedcba98-7654-7321-8fab-0123456789ab');
    const { loaded } = loadThroughMainWriter(session({}));
    expect(loaded.resumeBinding).toBeUndefined();
  });

  it('drops a Claude binding whose id is not a UUID at all', () => {
    const { loaded } = loadThroughMainWriter(session({
      lastDetectedAgent: 'claude',
      resumeBinding: { agent: 'claude', sessionId: 'not-a-session', cwd: WIN_CWD, ts: 1 },
    }));
    expect(loaded.resumeBinding).toBeUndefined();
  });

  it('leaves a genuine Claude binding alone', () => {
    const binding = { agent: 'claude', sessionId: '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', cwd: WIN_CWD, ts: 1 };
    const { loaded, warnings } = loadThroughMainWriter(session({ lastDetectedAgent: 'claude', resumeBinding: binding }));
    expect(loaded.resumeBinding).toEqual(binding);
    expect(warnings).toEqual([]);
  });
});
