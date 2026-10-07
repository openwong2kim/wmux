import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseCodexLineDetailed } from '../parseCodexEntry';
import { checkNativeTranscriptPath, fileTranscriptProvider } from '../providers';
import { scanForCodexTranscript } from '../TranscriptDiscovery';
import { TranscriptProjector } from '../TranscriptProjector';
import { codexComposerEmpty, deliverChatPrompt } from '../deliverChatPrompt';
const nativeId = '11111111-2222-4333-8444-555555555555';
const entry = (payload: unknown) => JSON.stringify({ type: 'event_msg', timestamp: '2026-09-24T00:00:00Z', payload });
const user = entry({ type: 'item_completed', turn_id: 'turn-1', item: { type: 'UserMessage', content: [{ type: 'text', text: '안녕' }] } });
const assistant = entry({ type: 'item_completed', turn_id: 'turn-1', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Hello\n```ts\nconst x = 1;\n```' }] } });

describe('native Codex transcript', () => {
  it('projects display messages once without exposing injected model context', () => {
    expect(parseCodexLineDetailed(user, 10).events).toMatchObject([{ kind: 'user_text', text: '안녕', turnId: 'turn-1' }]);
    const parsed = parseCodexLineDetailed(assistant, 20);
    expect(parsed.events).toMatchObject([{ kind: 'assistant_text', codeBlocks: [{ srcOffset: 20 }] }]);
    expect(parsed.bodies.size).toBe(1);
    for (const role of ['user', 'assistant', 'developer', 'system']) {
      expect(parseCodexLineDetailed(JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text: 'injected context' }] } }), 30).events).toEqual([]);
    }
    expect(parseCodexLineDetailed('{partial', 0).events).toEqual([]);
    expect(fileTranscriptProvider('__proto__')).toBeUndefined();
  });
  it('requires explicit completion; a final-looking assistant message is not completion', () => {
    expect(parseCodexLineDetailed(assistant, 0).events[0]).not.toHaveProperty('turnComplete');
    expect(parseCodexLineDetailed(entry({ type: 'task_complete', turn_id: 'turn-1' }), 30).events).toMatchObject([{ kind: 'meta', subtype: 'turn_complete', turnId: 'turn-1' }]);
  });
  it('reads the exact native ID, pages and fetches code bodies with the same parser', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-'));
    const sessions = path.join(home, 'sessions'); fs.mkdirSync(sessions);
    const file = path.join(sessions, `rollout-test-${nativeId}.jsonl`);
    fs.writeFileSync(file, user + '\n' + assistant + '\n');
    const projector = new TranscriptProjector({ getResumeBinding: () => ({ agent: 'codex', sessionId: nativeId, cwd: home, transcriptPath: file, ts: 1 }), getSessionEnv: () => ({ CODEX_HOME: home }), emitAppend: () => undefined });
    try {
      expect(scanForCodexTranscript(nativeId, { CODEX_HOME: home })).toEqual([file]);
      expect(scanForCodexTranscript('../secret', { CODEX_HOME: home })).toEqual([]);
      expect(projector.status('pane')).toMatchObject({ available: true, agentSessionId: nativeId });
      const page = projector.snapshot('pane')!;
      expect(page.events.map(e => e.kind)).toEqual(['user_text', 'assistant_text']);
      const event = page.events[1];
      expect(event.kind).toBe('assistant_text');
      if (event.kind !== 'assistant_text') throw new Error('missing assistant');
      const ref = event.codeBlocks![0];
      expect(projector.codeBlock('pane', { srcOffset: ref.srcOffset!, n: ref.n, eventId: event.id })).toBeTruthy();
      expect(checkNativeTranscriptPath('codex', file, '00000000-2222-4333-8444-555555555555', { CODEX_HOME: home }).ok).toBe(false);
      const duplicate = path.join(sessions, `rollout-duplicate-${nativeId}.jsonl`); fs.copyFileSync(file, duplicate);
      expect(scanForCodexTranscript(nativeId, { CODEX_HOME: home })).toEqual([]);
      fs.unlinkSync(duplicate);
      const outside = path.join(home, `rollout-other-${nativeId}.jsonl`); fs.writeFileSync(outside, user);
      expect(checkNativeTranscriptPath('codex', outside, nativeId, { CODEX_HOME: home }).ok).toBe(false);
    } finally { projector.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('a Codex session file not written yet (first turn pending)', () => {
  it('reads as an available, empty conversation, then as the file once Codex writes it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-'));
    const sessions = path.join(home, 'sessions'); fs.mkdirSync(sessions);
    // Codex creates the date directories lazily too.
    const file = path.join(sessions, '2026', '10', '07', `rollout-2026-10-07T00-00-00-${nativeId}.jsonl`);
    const projector = new TranscriptProjector({ getResumeBinding: () => ({ agent: 'codex', sessionId: nativeId, cwd: home, transcriptPath: file, ts: 1 }), getSessionEnv: () => ({ CODEX_HOME: home }), emitAppend: () => undefined });
    try {
      expect(checkNativeTranscriptPath('codex', file, nativeId, { CODEX_HOME: home })).toEqual({ ok: true, reason: '', pending: true });
      expect(projector.status('pane')).toMatchObject({ available: true, reason: 'ok', agentSessionId: nativeId, sizeBytes: 0 });
      expect(projector.snapshot('pane')).toEqual({ events: [], cursor: { headOffset: 0, tailOffset: 0, fileSize: 0, mtimeMs: 0 }, hasMore: false, truncatedHead: false });
      expect(projector.delta('pane', 0)).toMatchObject({ events: [], reset: false });
      expect(projector.staleCursor('pane', 0)).toBe(false);

      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, user + '\n');
      expect(checkNativeTranscriptPath('codex', file, nativeId, { CODEX_HOME: home })).toEqual({ ok: true, reason: '' });
      expect(projector.delta('pane', 0)?.events.map((e) => e.kind)).toEqual(['user_text']);
    } finally { projector.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('still refuses a missing file whose containment does not hold', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-'));
    const sessions = path.join(home, 'sessions'); fs.mkdirSync(sessions);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-elsewhere-'));
    try {
      const check = (file: string) => checkNativeTranscriptPath('codex', file, nativeId, { CODEX_HOME: home });
      // Outside the sessions root, lexical escape, wrong thread id.
      expect(check(path.join(home, `rollout-x-${nativeId}.jsonl`)).ok).toBe(false);
      expect(check(`${sessions}/2026/../../rollout-x-${nativeId}.jsonl`).ok).toBe(false);
      expect(check(path.join(sessions, 'rollout-x-00000000-2222-4333-8444-555555555555.jsonl')).ok).toBe(false);
      // Symlinks need a privilege on Windows runners; the containment rule is the same.
      if (process.platform !== 'win32') {
        // A directory symlinked out of the root: the nearest existing ancestor resolves outside.
        fs.symlinkSync(elsewhere, path.join(sessions, 'link'));
        expect(check(path.join(sessions, 'link', `rollout-x-${nativeId}.jsonl`)).ok).toBe(false);
        // A dangling symlink is not a file Codex has yet to write.
        const dangling = path.join(sessions, `rollout-d-${nativeId}.jsonl`);
        fs.symlinkSync(path.join(sessions, 'nowhere.jsonl'), dangling);
        expect(check(dangling).ok).toBe(false);
      }

      const projector = new TranscriptProjector({ getResumeBinding: () => ({ agent: 'codex', sessionId: nativeId, cwd: home, transcriptPath: path.join(home, `rollout-x-${nativeId}.jsonl`), ts: 1 }), getSessionEnv: () => ({ CODEX_HOME: home }), emitAppend: () => undefined });
      try { expect(projector.status('pane')).toEqual({ available: false, reason: 'unsafe-transcript-path' }); } finally { projector.dispose(); }
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true }); }
  });
});

describe('existing Codex PTY composer', () => {
  const screen = ['› Ask Codex to do anything', '', '  GPT-6-Astra low · /tmp/project'];
  it('requires the known empty composer and refuses drafts and dialogs', () => {
    expect(codexComposerEmpty(screen)).toBe(true);
    for (const bad of [null, ['› my unfinished task', ...screen.slice(1)], [...screen, 'esc to cancel'], ['› Ask Codex to do anything']]) expect(codexComposerEmpty(bad)).toBe(false);
  });
  it('submits to the existing process with one Enter and no new native session', async () => {
    const state = { slug: 'codex' as const, incarnationId: 'process', status: 'idle' as const, inputQuiet: true, inputRevision: 0 };
    const write = vi.fn(() => { state.inputRevision++; return true; });
    expect(await deliverChatPrompt(nativeId, 'first\nsecond', { getTranscriptSessionId: () => nativeId, hasOpenApproval: () => false,
      readScreen: async () => screen, getAgentState: () => ({ ...state }), isAgentProcessAlive: async () => true, write, delay: async () => undefined })).toBe('sent');
    expect(write).toHaveBeenNthCalledWith(2, '\r');
  });
});
