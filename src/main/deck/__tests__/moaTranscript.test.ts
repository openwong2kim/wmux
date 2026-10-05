// MoaTranscript — the HQ brain's transcript for Moa's right panel: bound only
// for the HQ while Moa is on, pushed only while the renderer is subscribed,
// and dropped on an HQ change, Moa off, or a retired brain.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoaTranscript, MOA_TRANSCRIPT_REASONS, foldMoaInternals, parseNotedPrompts, rewritePastedPrompts, type NotedPrompt } from '../moaTranscript';
import type { TranscriptAppendData, TurnEvent } from '../../../shared/transcript/turnEvents';
import { __resetMoaPaneFeedForTest, moaDialogUp, noteBrainHookSignal, setMoaPaneSource } from '../moaPaneFeed';

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
  it('also replaces a wire that lost its paste markers and first characters on a cold start', () => {
    const cut = user('u4', 'nd leave this work active. In one short sentence: what are you tracking?', 10_000);
    const out = rewritePastedPrompts([cut] as never, [{ at: 9_000, text: 'In one short sentence: what are you tracking?' }]);
    expect((out[0] as { text: string }).text).toBe('In one short sentence: what are you tracking?');
  });
  it('leaves typed (non-pasted) entries and unmatched pastes alone', () => {
    const typed = user('u2', 'typed in the terminal', 10_000);
    const early = user('u3', '<pasted_content id="b">x</pasted_content>', 500);
    const out = rewritePastedPrompts([typed, early] as never, [{ at: 9_000, text: 'p' }]);
    expect(out[0]).toBe(typed);
    expect((out[1] as { text: string }).text).toBe(early.text);
    expect(rewritePastedPrompts([early] as never, [])[0]).toEqual(early);
  });
  it('never takes a prompt sent after the entry (turn A keeps A, an old paste stays old)', () => {
    const a = user('ua', '<pasted_content id="a">ctx</pasted_content>', 10_000);
    const out = rewritePastedPrompts([a] as never, [{ at: 9_000, text: 'A' }, { at: 12_000, text: 'B' }]);
    expect((out[0] as { text: string }).text).toBe('A');
    // A pasted entry from before any noted prompt is left as recorded.
    const old = user('uo', '<pasted_content id="o">ctx</pasted_content>', 1_000);
    expect((rewritePastedPrompts([old] as never, [{ at: 3_000, text: 'later' }])[0] as { text: string }).text).toBe(old.text);
  });
  it('uses each prompt once, prefers the one the entry ends with, and stays stable across reads', () => {
    const p1 = { at: 9_000, text: 'first question' };
    const p2 = { at: 9_500, text: 'second question' };
    const assigned = new Map<string, typeof p1>();
    const e1 = user('e1', 'ctx… first question', 10_000);
    const e2 = user('e2', '<pasted_content id="x">ctx</pasted_content>', 10_200);
    const e3 = user('e3', '<pasted_content id="y">ctx</pasted_content>', 10_400);
    const out = rewritePastedPrompts([e1, e2, e3] as never, [p1, p2], assigned);
    // e1 ends with p1 even though p2 is later; e2 takes the one left; e3 has none.
    expect(out.map((e) => (e as { text: string }).text)).toEqual(['first question', 'second question', e3.text]);
    // A later read of the same entries (an append, a snapshot) gives the same answer.
    const again = rewritePastedPrompts([e2] as never, [p1, p2], assigned);
    expect((again[0] as { text: string }).text).toBe('second question');
  });
});

describe('a dialog only the terminal shows', () => {
  // The real path: the brain's hooks reach main's hook RPC, which feeds
  // moaPaneFeed (the phone fence's source); the chat reads the same state.
  const brainCwd = '/brains/ws-hq';
  const signal = (kind: string) => ({ kind, agent: 'claude', ptyId: 'pty-hq', cwd: brainCwd, payload: { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }, ts: Date.now() });
  let release: () => void;
  beforeEach(() => {
    __resetMoaPaneFeedForTest();
    release = setMoaPaneSource(() => (moaOn && hq === 'ws-hq' ? { sessionId: 'pty-hq', workspaceId: 'ws-hq', brainCwd } : null));
  });
  afterEach(() => {
    release();
    __resetMoaPaneFeedForTest();
  });

  it('reads as awaiting_input from the PermissionRequest hook until a tool runs, the turn ends or a prompt starts', () => {
    transcript(HQ_SESSION, userLine(HQ_SESSION, 'u1', 'hello'));
    moa.noteSessionId('ws-hq', HQ_SESSION);
    expect(moa.status().agentStatus).not.toBe('awaiting_input');
    for (const clear of ['agent.activity', 'agent.stop', 'agent.user_prompt_submit'] as const) {
      noteBrainHookSignal(signal('agent.awaiting_input'));
      expect(moaDialogUp()).toBe(true);
      expect(moa.status()).toMatchObject({ available: true, agentStatus: 'awaiting_input' });
      noteBrainHookSignal(signal(clear));
      expect(moa.status().agentStatus).not.toBe('awaiting_input');
    }
    // Another brain's dialog is not Moa's.
    noteBrainHookSignal({ ...signal('agent.awaiting_input'), ptyId: 'pty-other' });
    expect(moa.status().agentStatus).not.toBe('awaiting_input');
  });
});

describe('subscribers', () => {
  it('the panel and the reply dot cannot unsubscribe each other', () => {
    transcript(HQ_SESSION, userLine(HQ_SESSION, 'u1', 'hello'));
    moa.noteSessionId('ws-hq', HQ_SESSION);
    moa.subscribe('panel');
    moa.subscribe('notice');
    expect(moa.watchCount).toBe(1);
    moa.unsubscribe('panel');
    expect(moa.watchCount).toBe(1);
    moa.unsubscribe('notice');
    expect(moa.watchCount).toBe(0);
  });
});

describe('the remembered prompts', () => {
  const make = (store: { saved: NotedPrompt[] | null }) => new MoaTranscript({
    getHqWorkspaceId: () => 'ws-hq',
    isMoaEnabled: () => true,
    emitAppend: () => undefined,
    promptStore: { load: () => (store.saved ? { prompts: store.saved } : undefined), save: (p) => { store.saved = [...p]; } },
  });

  it('are saved for the HQ only, and a new run reads them back', () => {
    const store: { saved: NotedPrompt[] | null } = { saved: null };
    const first = make(store);
    first.notePrompt('ws-other', 'not the HQ', 1_000);
    first.notePrompt('ws-hq', 'Which task needs me first?', 2_000);
    first.dispose();
    expect(store.saved).toEqual([{ at: 2_000, text: 'Which task needs me first?', hq: 'ws-hq' }]);
    // A second instance (the next app run) appends to what the first saved.
    const second = make(store);
    second.notePrompt('ws-hq', 'And the second?', 3_000);
    second.dispose();
    expect(store.saved?.map((p) => p.text)).toEqual(['Which task needs me first?', 'And the second?']);
  });

  it('a file that is not ours reads as none', () => {
    expect(parseNotedPrompts(null)).toEqual([]);
    expect(parseNotedPrompts({ prompts: 'x' })).toEqual([]);
    expect(parseNotedPrompts({ prompts: [{ at: 1, text: 'ok', hq: 'h' }, { at: 'x', text: 1 }] })).toEqual([{ at: 1, text: 'ok', hq: 'h' }]);
  });
});

describe('foldMoaInternals — the chat shows Moa\'s replies, not its working', () => {
  it('folds tool calls and text written mid-turn; keeps the text that ended the turn and the prompt', () => {
    const events: TurnEvent[] = [
      { id: 'u', kind: 'user_text', text: 'math.js에 빼기 함수 추가해줘' },
      { id: 'th', kind: 'assistant_text', text: 'thinking', thinking: true },
      { id: 't', kind: 'tool_use', toolUseId: 'x', name: 'mcp__wmux__terminal_send', argSummary: '' },
      { id: 'r', kind: 'tool_result', toolUseId: 'x', ok: false, bytes: 10 },
      { id: 'n', kind: 'assistant_text', text: 'Proposing the handoff to the agent in the other workspace.' },
      { id: 'a', kind: 'assistant_text', text: '승인 카드를 올렸습니다.', turnComplete: true },
    ];
    const out = foldMoaInternals(events);
    expect(out.filter((e) => e.folded).map((e) => e.id)).toEqual(['t', 'r', 'n']);
    expect(out.find((e) => e.id === 'a')?.folded).toBeUndefined();
    expect(out.find((e) => e.id === 'u')?.folded).toBeUndefined();
    expect(out.find((e) => e.id === 'th')?.folded).toBeUndefined();
  });
});
