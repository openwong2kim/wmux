// MoaTranscript — the HQ brain's transcript for Moa's right panel: bound only
// for the HQ while Moa is on, pushed only while the renderer is subscribed,
// and dropped on an HQ change, Moa off, or a retired brain.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoaTranscript, MOA_TRANSCRIPT_REASONS, rewritePastedPrompts } from '../moaTranscript';
import type { TranscriptAppendData } from '../../../shared/transcript/turnEvents';

const HQ_SESSION = '920b9112-1111-4222-8333-444455556666';
const OTHER_SESSION = '7a0c0de0-1111-4222-8333-444455556666';

function userLine(sessionId: string, uuid: string, text: string): string {
  return JSON.stringify({
    type: 'user', uuid, parentUuid: null, timestamp: '2026-10-04T09:00:00.000Z', sessionId,
    cwd: '/brains/ws-hq', userType: 'external', message: { role: 'user', content: text },
  }) + '\n';
}
function assistantLine(sessionId: string, uuid: string, text: string): string {
  return JSON.stringify({
    type: 'assistant', uuid, timestamp: '2026-10-04T09:00:01.000Z', sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';
}

let dir: string;
let projects: string;
let hq: string | null;
let moaOn: boolean;
let appends: TranscriptAppendData[];
let moa: MoaTranscript;

/** Write `<projects>/<slug>/<sessionId>.jsonl` and return its path. */
function transcript(sessionId: string, body: string, slug = '-brains-ws-hq'): string {
  const folder = path.join(projects, slug);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${sessionId}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}
const texts = (data: TranscriptAppendData[]): string[] =>
  data.flatMap((d) => d.events).map((e) => ('text' in e ? e.text : '')).filter(Boolean);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-transcript-')));
  projects = path.join(dir, 'projects');
  hq = 'ws-hq';
  moaOn = true;
  appends = [];
  moa = new MoaTranscript({
    getHqWorkspaceId: () => hq,
    isMoaEnabled: () => moaOn,
    emitAppend: (data) => appends.push(data),
    getSessionEnv: () => ({ CLAUDE_CONFIG_DIR: dir }),
    wmuxDir: () => dir,
    debounceMs: 1,
    pollMs: 20,
  });
});

afterEach(() => {
  moa.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MoaTranscript — binding', () => {
  it('answers empty when Moa is off, there is no HQ, or the HQ has no brain', () => {
    moaOn = false;
    expect(moa.status()).toEqual({ available: false, reason: MOA_TRANSCRIPT_REASONS.moaOff });
    moaOn = true;
    hq = null;
    expect(moa.status()).toEqual({ available: false, reason: MOA_TRANSCRIPT_REASONS.noHq });
    hq = 'ws-hq';
    expect(moa.status()).toEqual({ available: false, reason: MOA_TRANSCRIPT_REASONS.noBrain });
    expect(moa.snapshot()).toBeNull();
  });

  it('binds the HQ brain by session id (found by name) and serves its snapshot', () => {
    transcript(HQ_SESSION, userLine(HQ_SESSION, 'u1', 'status please') + assistantLine(HQ_SESSION, 'a1', 'all green'));
    moa.noteSessionId('ws-hq', HQ_SESSION);
    const status = moa.status();
    expect(status).toMatchObject({ available: true, reason: 'ok', agentSessionId: HQ_SESSION });
    const page = moa.snapshot();
    expect(page?.events.map((e) => e.kind)).toEqual(['user_text', 'assistant_text']);
  });

  it('ignores every workspace but the HQ, and every report while Moa is off', () => {
    transcript(OTHER_SESSION, userLine(OTHER_SESSION, 'u1', 'not the HQ'), '-elsewhere');
    moa.noteSessionId('ws-other', OTHER_SESSION);
    moa.noteHint('ws-other', { kind: 'agent.stop', agentSessionId: OTHER_SESSION });
    expect(moa.status().reason).toBe(MOA_TRANSCRIPT_REASONS.noBrain);
    moaOn = false;
    moa.noteSessionId('ws-hq', OTHER_SESSION);
    moaOn = true;
    expect(moa.status().reason).toBe(MOA_TRANSCRIPT_REASONS.noBrain);
  });

  it('takes the transcript path from a hook hint, and still refuses one outside the projects root', () => {
    const file = transcript(HQ_SESSION, userLine(HQ_SESSION, 'u1', 'hello'));
    moa.noteHint('ws-hq', { kind: 'agent.stop', agentSessionId: HQ_SESSION, transcriptPath: file });
    expect(moa.status()).toMatchObject({ available: true });

    const outside = path.join(dir, `${OTHER_SESSION}.jsonl`);
    fs.writeFileSync(outside, userLine(OTHER_SESSION, 'u2', 'secret'));
    moa.noteHint('ws-hq', { kind: 'agent.session_start', agentSessionId: OTHER_SESSION, transcriptPath: outside });
    expect(moa.status()).toEqual({ available: false, reason: 'unsafe-transcript-path' });
    expect(moa.snapshot()).toBeNull();
  });

  it('drops the binding when the HQ changes, Moa goes off, or the brain retires', () => {
    transcript(HQ_SESSION, userLine(HQ_SESSION, 'u1', 'hello'));
    moa.noteSessionId('ws-hq', HQ_SESSION);
    hq = 'ws-new';
    moa.sync();
    hq = 'ws-hq';
    expect(moa.status().reason).toBe(MOA_TRANSCRIPT_REASONS.noBrain);

    moa.noteSessionId('ws-hq', HQ_SESSION);
    moaOn = false;
    moa.sync();
    moaOn = true;
    expect(moa.status().reason).toBe(MOA_TRANSCRIPT_REASONS.noBrain);

    moa.noteSessionId('ws-hq', HQ_SESSION);
    moa.retire('ws-other');
    expect(moa.status().available).toBe(true);
    moa.retire('ws-hq');
    expect(moa.status().reason).toBe(MOA_TRANSCRIPT_REASONS.noBrain);
  });
});

describe('MoaTranscript — appends', () => {
  it('pushes nothing until subscribed, then a reset snapshot and live appends', async () => {
    const file = transcript(HQ_SESSION, userLine(HQ_SESSION, 'u1', 'first'));
    moa.noteSessionId('ws-hq', HQ_SESSION);
    fs.appendFileSync(file, assistantLine(HQ_SESSION, 'a1', 'unseen push'));
    await new Promise((r) => setTimeout(r, 60));
    expect(appends).toEqual([]);

    expect(moa.subscribe()).toMatchObject({ available: true });
    await vi.waitFor(() => expect(appends.length).toBeGreaterThan(0));
    expect(appends[0].reset).toBe(true);
    expect(texts(appends)).toEqual(['first', 'unseen push']);

    fs.appendFileSync(file, assistantLine(HQ_SESSION, 'a2', 'live line'));
    await vi.waitFor(() => expect(texts(appends)).toContain('live line'));

    moa.unsubscribe();
    expect(moa.watchCount).toBe(0);
    const before = appends.length;
    fs.appendFileSync(file, assistantLine(HQ_SESSION, 'a3', 'after unsubscribe'));
    await new Promise((r) => setTimeout(r, 80));
    expect(appends.length).toBe(before);
  });

  it('a subscription made before the brain exists arms when the brain binds', async () => {
    moa.subscribe();
    expect(appends).toEqual([]);
    transcript(HQ_SESSION, userLine(HQ_SESSION, 'u1', 'late brain'));
    moa.noteSessionId('ws-hq', HQ_SESSION);
    await vi.waitFor(() => expect(texts(appends)).toEqual(['late brain']));
  });

  it('a retired brain keeps the subscription; the next brain re-pushes a reset snapshot', async () => {
    transcript(HQ_SESSION, userLine(HQ_SESSION, 'u1', 'before swap'));
    moa.noteSessionId('ws-hq', HQ_SESSION);
    moa.subscribe();
    await vi.waitFor(() => expect(appends.length).toBe(1));
    moa.retire('ws-hq');
    expect(moa.watchCount).toBe(0);
    moa.noteSessionId('ws-hq', HQ_SESSION);
    await vi.waitFor(() => expect(appends.length).toBe(2));
    expect(appends[1]).toMatchObject({ reset: true });
  });

  it('an HQ change or Moa off drops the subscription for good', async () => {
    const file = transcript(HQ_SESSION, userLine(HQ_SESSION, 'u1', 'hello'));
    moa.noteSessionId('ws-hq', HQ_SESSION);
    moa.subscribe();
    await vi.waitFor(() => expect(appends.length).toBe(1));

    hq = 'ws-new';
    moa.sync();
    expect(moa.watchCount).toBe(0);
    hq = 'ws-hq';
    moa.noteSessionId('ws-hq', HQ_SESSION);
    fs.appendFileSync(file, assistantLine(HQ_SESSION, 'a1', 'not pushed'));
    await new Promise((r) => setTimeout(r, 80));
    expect(appends.length).toBe(1);

    moa.subscribe();
    await vi.waitFor(() => expect(appends.length).toBe(2));
    moaOn = false;
    moa.sync();
    expect(moa.watchCount).toBe(0);
  });
});

describe('rewritePastedPrompts — the chat shows what was asked, not the pasted wire', () => {
  const user = (id: string, text: string, ts?: number) => ({ id, kind: 'user_text' as const, text, ...(ts !== undefined ? { ts } : {}) });
  it('replaces a pasted user entry with the prompt sent just before it', () => {
    const events = [user('u1', '<pasted_content id="a">rules…</pasted_content>', 10_000), { id: 'a1', kind: 'assistant_text' as const, text: 'hi' }];
    const out = rewritePastedPrompts(events as never, [{ at: 1_000, text: 'old' }, { at: 9_000, text: 'Say hello' }, { at: 20_000, text: 'later' }]);
    expect((out[0] as { text: string }).text).toBe('Say hello');
    expect(out[1]).toBe(events[1]);
  });
  it('leaves typed (non-pasted) entries and unmatched pastes alone', () => {
    const typed = user('u2', 'typed in the terminal', 10_000);
    const early = user('u3', '<pasted_content id="b">x</pasted_content>', 500);
    const out = rewritePastedPrompts([typed, early] as never, [{ at: 9_000, text: 'p' }]);
    expect(out[0]).toBe(typed);
    expect((out[1] as { text: string }).text).toBe(early.text);
    expect(rewritePastedPrompts([early] as never, [])[0]).toEqual(early);
  });
});
