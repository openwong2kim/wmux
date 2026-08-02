// TranscriptDiscovery against a real filesystem: the file appearing AFTER the
// session started is adopted (that is the whole point — SessionStart fires
// before Claude Code writes the `.jsonl`), a search stops on session end / on a
// superseding session / at its deadline, and the projector picks the discovered
// path up without defeating the `/clear` stale-session hold.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { TranscriptDiscovery } from '../TranscriptDiscovery';
import { TranscriptProjector } from '../TranscriptProjector';
import type { ResumeBinding } from '../../../shared/agentResume';
import type { TranscriptAppendData } from '../../../shared/transcript/turnEvents';

const OLD_ID = '11111111-1111-1111-1111-111111111111';
const NEW_ID = '22222222-2222-2222-2222-222222222222';

let home: string;
let root: string;
let env: Record<string, string>;
let discovery: TranscriptDiscovery | null;
let found: { sessionId: string; agentSessionId: string; transcriptPath: string; cwd: string }[];

function entry(id: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: id,
    timestamp: '2026-07-27T09:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';
}

function makeDiscovery(opts?: { deadlineMs?: number; pollMs?: number }): TranscriptDiscovery {
  return new TranscriptDiscovery({
    getSessionEnv: () => env,
    onFound: (f) => found.push(f),
    pollMs: opts?.pollMs ?? 30,
    debounceMs: 10,
    deadlineMs: opts?.deadlineMs ?? 3000,
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-discovery-rt-'));
  root = path.join(home, 'config', 'projects');
  fs.mkdirSync(root, { recursive: true });
  env = { CLAUDE_CONFIG_DIR: path.join(home, 'config') };
  found = [];
  discovery = null;
});

afterEach(() => {
  discovery?.dispose();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('adoption', () => {
  it('adopts the transcript the moment it appears in an existing project dir', async () => {
    const dir = path.join(root, '-synthetic-repo');
    fs.mkdirSync(dir);
    discovery = makeDiscovery();
    discovery.start('pty-1', NEW_ID, '/repo');
    // Nothing yet — this is the state the operator used to be stuck in.
    expect(found).toEqual([]);
    expect(discovery.activeCount).toBe(1);

    fs.writeFileSync(path.join(dir, `${NEW_ID}.jsonl`), entry('e-1', 'hello'), 'utf8');
    await waitFor(() => found.length === 1);
    expect(found[0]).toMatchObject({
      sessionId: 'pty-1',
      agentSessionId: NEW_ID,
      transcriptPath: path.join(dir, `${NEW_ID}.jsonl`),
      cwd: '/repo',
    });
    // The search tears itself down on the first hit.
    expect(discovery.activeCount).toBe(0);
  });

  it('adopts a transcript in a project directory created after the session started', async () => {
    discovery = makeDiscovery();
    discovery.start('pty-1', NEW_ID, '/repo');
    const dir = path.join(root, '-brand-new-repo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${NEW_ID}.jsonl`), entry('e-1', 'hello'), 'utf8');
    await waitFor(() => found.length === 1);
    expect(found[0].transcriptPath).toBe(path.join(dir, `${NEW_ID}.jsonl`));
  });

  it('adopts immediately when the file already exists', () => {
    const dir = path.join(root, '-synthetic-repo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${NEW_ID}.jsonl`), entry('e-1', 'hello'), 'utf8');
    discovery = makeDiscovery();
    discovery.start('pty-1', NEW_ID, '/repo');
    expect(found).toHaveLength(1);
    expect(discovery.activeCount).toBe(0);
  });

  it('re-starting with the same id keeps one search, not two', () => {
    discovery = makeDiscovery();
    discovery.start('pty-1', NEW_ID, '/repo');
    discovery.start('pty-1', NEW_ID, '/repo');
    discovery.start('pty-1', NEW_ID, '/repo');
    expect(discovery.activeCount).toBe(1);
  });
});

describe('stopping', () => {
  it('stops on session end — a file appearing afterwards is not adopted', async () => {
    const dir = path.join(root, '-synthetic-repo');
    fs.mkdirSync(dir);
    discovery = makeDiscovery();
    discovery.start('pty-1', NEW_ID, '/repo');
    discovery.cancel('pty-1');
    expect(discovery.activeCount).toBe(0);

    fs.writeFileSync(path.join(dir, `${NEW_ID}.jsonl`), entry('e-1', 'hello'), 'utf8');
    await delay(150);
    expect(found).toEqual([]);
  });

  it('stops at its deadline', async () => {
    const dir = path.join(root, '-synthetic-repo');
    fs.mkdirSync(dir);
    discovery = makeDiscovery({ deadlineMs: 60 });
    discovery.start('pty-1', NEW_ID, '/repo');
    await waitFor(() => discovery!.activeCount === 0);

    fs.writeFileSync(path.join(dir, `${NEW_ID}.jsonl`), entry('e-1', 'hello'), 'utf8');
    await delay(150);
    expect(found).toEqual([]);
  });

  it('a NEW session id supersedes the old search (/clear in the same pane)', async () => {
    const dir = path.join(root, '-synthetic-repo');
    fs.mkdirSync(dir);
    discovery = makeDiscovery();
    discovery.start('pty-1', OLD_ID, '/repo');
    discovery.start('pty-1', NEW_ID, '/repo');
    expect(discovery.activeCount).toBe(1);

    // The PREVIOUS conversation's file must not be re-adopted...
    fs.writeFileSync(path.join(dir, `${OLD_ID}.jsonl`), entry('o-1', 'previous'), 'utf8');
    await delay(150);
    expect(found).toEqual([]);

    // ...but the new session's own file is legitimate.
    fs.writeFileSync(path.join(dir, `${NEW_ID}.jsonl`), entry('n-1', 'fresh'), 'utf8');
    await waitFor(() => found.length === 1);
    expect(found[0].agentSessionId).toBe(NEW_ID);
  });

  it('dispose stops every search', () => {
    discovery = makeDiscovery();
    discovery.start('pty-1', NEW_ID, '/a');
    discovery.start('pty-2', OLD_ID, '/b');
    expect(discovery.activeCount).toBe(2);
    discovery.dispose();
    expect(discovery.activeCount).toBe(0);
  });
});

describe('projector handoff', () => {
  let projector: TranscriptProjector;
  let bindings: Map<string, ResumeBinding>;
  let appends: TranscriptAppendData[];

  beforeEach(() => {
    bindings = new Map();
    appends = [];
    projector = new TranscriptProjector({
      getResumeBinding: (id) => bindings.get(id),
      getSessionEnv: () => env,
      emitAppend: (_id, data) => appends.push(data),
      debounceMs: 20,
    });
  });

  afterEach(() => projector.dispose());

  it('a discovered path reaches an already-open Chat surface via rebind', async () => {
    const dir = path.join(root, '-synthetic-repo');
    fs.mkdirSync(dir);
    // The pane has a SessionStart binding with no path — Chat is unavailable.
    bindings.set('pty-1', { agent: 'claude', sessionId: NEW_ID, cwd: '/repo', ts: 1 });
    expect(projector.status('pty-1')).toMatchObject({ available: false, reason: 'no-transcript-path' });
    projector.subscribe('c1', 'pty-1');

    discovery = new TranscriptDiscovery({
      getSessionEnv: () => env,
      onFound: (f) => {
        found.push(f);
        bindings.set(f.sessionId, {
          agent: 'claude',
          sessionId: f.agentSessionId,
          cwd: f.cwd,
          transcriptPath: f.transcriptPath,
          ts: 2,
        });
        projector.rebind(f.sessionId);
      },
      pollMs: 30,
      debounceMs: 10,
      deadlineMs: 3000,
    });
    discovery.start('pty-1', NEW_ID, '/repo');

    fs.writeFileSync(path.join(dir, `${NEW_ID}.jsonl`), entry('n-1', 'fresh'), 'utf8');
    await waitFor(() => appends.length >= 1);
    expect(projector.status('pty-1')).toMatchObject({ available: true, reason: 'ok' });
    expect(appends[0].reset).toBe(true);
    expect(appends[0].events.map((e) => (e.kind === 'assistant_text' ? e.text : ''))).toEqual(['fresh']);
  });

  it('rebind does not defeat the /clear stale-session hold', async () => {
    const dir = path.join(root, '-synthetic-repo');
    fs.mkdirSync(dir);
    const oldFile = path.join(dir, `${OLD_ID}.jsonl`);
    fs.writeFileSync(oldFile, entry('o-1', 'previous conversation'), 'utf8');
    bindings.set('pty-1', {
      agent: 'claude', sessionId: OLD_ID, cwd: '/repo', transcriptPath: oldFile, ts: 1,
    });
    projector.subscribe('c1', 'pty-1');
    await waitFor(() => appends.length === 1);
    expect(appends[0].events).toHaveLength(1);

    // `/clear`: a SessionStart for a NEW id, whose provisional capture carries no
    // path, so the OLD binding is still the one on file.
    projector.nudge('pty-1', 'agent.session_start', NEW_ID);
    await delay(80);
    const afterClear = appends.length;

    // Anything that re-reads the binding — including the discovery handoff —
    // must NOT re-adopt the old transcript.
    projector.rebind('pty-1');
    await delay(80);
    expect(appends).toHaveLength(afterClear);
    expect(projector.status('pty-1')).toMatchObject({ available: true, reason: 'ok' });

    // The new session's own file IS legitimate: discovery finds it, the binding
    // moves, and the hold releases.
    const newFile = path.join(dir, `${NEW_ID}.jsonl`);
    fs.writeFileSync(newFile, entry('n-1', 'fresh conversation'), 'utf8');
    bindings.set('pty-1', {
      agent: 'claude', sessionId: NEW_ID, cwd: '/repo', transcriptPath: newFile, ts: 2,
    });
    projector.rebind('pty-1');
    await waitFor(() => appends.length > afterClear);
    const latest = appends[appends.length - 1];
    expect(latest.reset).toBe(true);
    expect(latest.events.map((e) => (e.kind === 'assistant_text' ? e.text : ''))).toEqual([
      'fresh conversation',
    ]);
  });

  it('a later hook-supplied path takes over from the discovered one cleanly', async () => {
    const dir = path.join(root, '-synthetic-repo');
    fs.mkdirSync(dir);
    const file = path.join(dir, `${NEW_ID}.jsonl`);
    fs.writeFileSync(file, entry('n-1', 'fresh'), 'utf8');

    discovery = makeDiscovery();
    discovery.start('pty-1', NEW_ID, '/repo');
    expect(found).toHaveLength(1);
    bindings.set('pty-1', {
      agent: 'claude', sessionId: NEW_ID, cwd: '/repo', transcriptPath: found[0].transcriptPath, ts: 2,
    });
    projector.subscribe('c1', 'pty-1');
    await waitFor(() => appends.length === 1);

    // The first agent.stop arrives with the SAME path the search adopted, so the
    // handover is a no-op for the client — no reset, no second snapshot.
    projector.nudge('pty-1', 'agent.stop', NEW_ID);
    await delay(80);
    expect(appends).toHaveLength(1);

    // ...and the search is gone, so it cannot fight the hook afterwards.
    discovery.cancel('pty-1');
    expect(discovery.activeCount).toBe(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
