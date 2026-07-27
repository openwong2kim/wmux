// fs.watch behaviour of the projector against a real file: an append produces
// ONE debounced delta, a truncation produces a reset, an atomic replace is still
// observed (which is why the DIRECTORY is watched, not the file), and a watch
// that cannot arm degrades to polling instead of going silent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { TranscriptProjector } from '../TranscriptProjector';
import type { ResumeBinding } from '../../../shared/agentResume';
import type { TranscriptAppendData } from '../../../shared/transcript/turnEvents';

let dir: string;
let file: string;
let projector: TranscriptProjector;
let appends: { data: TranscriptAppendData; clientIds: readonly string[] }[];
let bindings: Map<string, ResumeBinding>;

function entry(id: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: id,
    timestamp: '2026-07-27T09:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';
}

function makeProjector(opts?: { pollMs?: number }): TranscriptProjector {
  return new TranscriptProjector({
    getResumeBinding: (id) => bindings.get(id),
    emitAppend: (_sessionId, data, clientIds) => appends.push({ data, clientIds }),
    debounceMs: 40,
    ...(opts?.pollMs ? { pollMs: opts.pollMs } : {}),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-projector-watch-'));
  file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, entry('e-1', 'first line'), 'utf8');
  appends = [];
  bindings = new Map([
    ['pty-1', { agent: 'claude', sessionId: 'session', cwd: dir, transcriptPath: file, ts: 1 }],
  ]);
  projector = makeProjector();
});

afterEach(() => {
  projector.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('fs.watch — append', () => {
  it('emits ONE debounced append carrying only the delta', async () => {
    projector.subscribe('c1', 'pty-1');
    // First read is the snapshot/reset.
    await waitFor(() => appends.length === 1);
    expect(appends[0].data.reset).toBe(true);
    expect(appends[0].data.events).toHaveLength(1);

    // Several writes inside one debounce window must coalesce into one append.
    fs.appendFileSync(file, entry('e-2', 'second line'));
    fs.appendFileSync(file, entry('e-3', 'third line'));
    await waitFor(() => appends.length === 2);
    await delay(120);

    expect(appends).toHaveLength(2);
    const delta = appends[1].data;
    expect(delta.reset).toBeUndefined();
    expect(delta.seq).toBe(2);
    expect(delta.events.map((e) => (e.kind === 'assistant_text' ? e.text : ''))).toEqual([
      'second line',
      'third line',
    ]);
    // The delta starts where the last one stopped — no re-send of 'first line'.
    expect(delta.cursor.headOffset).toBe(appends[0].data.cursor.tailOffset);
    expect(appends[1].clientIds).toEqual(['c1']);
  });

  it('does not wake a subscriber for a SIBLING file in the same directory', async () => {
    projector.subscribe('c1', 'pty-1');
    await waitFor(() => appends.length === 1);

    fs.writeFileSync(path.join(dir, 'other-session.jsonl'), entry('x-1', 'not ours'), 'utf8');
    await delay(200);
    expect(appends).toHaveLength(1);
  });

  it('stops reading once the last subscriber leaves', async () => {
    projector.subscribe('c1', 'pty-1');
    await waitFor(() => appends.length === 1);
    projector.unsubscribe('c1', 'pty-1');

    fs.appendFileSync(file, entry('e-2', 'after unsubscribe'));
    await delay(200);
    expect(appends).toHaveLength(1);
  });
});

describe('fs.watch — truncation and rotation', () => {
  it('a truncation makes the next append a reset', async () => {
    projector.subscribe('c1', 'pty-1');
    await waitFor(() => appends.length === 1);

    fs.writeFileSync(file, entry('e-9', 'only entry now'), 'utf8');
    await waitFor(() => appends.length === 2);
    const second = appends[1].data;
    expect(second.reset).toBe(true);
    expect(second.events.map((e) => (e.kind === 'assistant_text' ? e.text : ''))).toEqual([
      'only entry now',
    ]);
  });

  it('survives an ATOMIC RENAME over the watched file (A4)', async () => {
    projector.subscribe('c1', 'pty-1');
    await waitFor(() => appends.length === 1);

    // The failure this guards: watching the FILE goes silent after a rename,
    // with no error event to re-arm on. The directory watch still fires.
    const staging = path.join(dir, 'session.next');
    fs.writeFileSync(staging, entry('r-1', 'rotated content'), 'utf8');
    fs.renameSync(staging, file);

    await waitFor(() => appends.length === 2);
    expect(appends[1].data.reset).toBe(true);

    // And the watch is STILL live for the replacement file.
    fs.appendFileSync(file, entry('r-2', 'after rotation'));
    await waitFor(() => appends.length === 3);
    expect(appends[2].data.events.map((e) => (e.kind === 'assistant_text' ? e.text : ''))).toEqual([
      'after rotation',
    ]);
  });

  it('recovers when the file is deleted and recreated', async () => {
    projector.subscribe('c1', 'pty-1');
    await waitFor(() => appends.length === 1);
    const seenBefore = appends.length;

    fs.rmSync(file);
    await delay(120);
    // A missing file yields nothing — never a throw and never a bogus append.
    expect(appends).toHaveLength(seenBefore);

    fs.writeFileSync(file, entry('n-1', 'recreated'), 'utf8');
    await waitFor(() => appends.length === seenBefore + 1);
    expect(appends.at(-1)!.data.reset).toBe(true);
  });
});

describe('polling fallback', () => {
  it('reads on a poll when fs.watch cannot arm', async () => {
    projector.dispose();
    // A path whose DIRECTORY does not exist: fs.watch throws, which is the
    // network-home-dir / uninstalled-inotify case the fallback exists for.
    const nested = path.join(dir, 'not-yet', 'session.jsonl');
    bindings.set('pty-2', {
      agent: 'claude',
      sessionId: 'session',
      cwd: dir,
      transcriptPath: nested,
      ts: 1,
    });
    projector = makeProjector({ pollMs: 25 });
    projector.subscribe('c1', 'pty-2');
    expect(appends).toHaveLength(0);

    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, entry('p-1', 'appeared later'), 'utf8');

    await waitFor(() => appends.length === 1, 4000);
    expect(appends[0].data.reset).toBe(true);
    expect(appends[0].data.events.map((e) => (e.kind === 'assistant_text' ? e.text : ''))).toEqual([
      'appeared later',
    ]);
  });

  it('drops the poll timer with the last subscriber', async () => {
    projector.dispose();
    const nested = path.join(dir, 'later', 'session.jsonl');
    bindings.set('pty-2', {
      agent: 'claude',
      sessionId: 'session',
      cwd: dir,
      transcriptPath: nested,
      ts: 1,
    });
    projector = makeProjector({ pollMs: 25 });
    projector.subscribe('c1', 'pty-2');
    expect(projector.watchCount).toBe(1);
    projector.unsubscribe('c1', 'pty-2');
    expect(projector.watchCount).toBe(0);

    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, entry('p-2', 'nobody is listening'), 'utf8');
    await delay(150);
    expect(appends).toHaveLength(0);
  });
});

describe('byte budget on emitted appends (A3)', () => {
  it('never emits more than the budget in one event', async () => {
    projector.subscribe('c1', 'pty-1');
    await waitFor(() => appends.length === 1);

    // ~1.2MB of prose appended at once: the emitted append must stay bounded,
    // and the cursor must still advance so the rest arrives next time.
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(entry(`big-${i}`, 'q'.repeat(4000)));
    fs.appendFileSync(file, lines.join(''));

    await waitFor(() => appends.length === 2);
    const data = appends[1].data;
    expect(Buffer.byteLength(JSON.stringify(data.events), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(data.cursor.tailOffset).toBeGreaterThan(appends[0].data.cursor.tailOffset);
    expect(data.cursor.tailOffset).toBeLessThan(data.cursor.fileSize);
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
