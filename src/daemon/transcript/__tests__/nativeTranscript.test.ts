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
