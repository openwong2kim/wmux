// Codex native decisions: request ids are small integers every pane on an
// account server shares, restarting at 0 with it. A record is keyed by the
// relay incarnation and thread too, and only the relay's own events settle it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import {
  TERMINAL_PROMPT_WEB_ANSWER,
  TERMINAL_PROMPT_WEB_DECLINE,
  type ApprovalRequest,
  type DecisionForm,
  type NativeDecisionRef,
  type NativeDecisionReply,
} from '../types';

const FORM: DecisionForm = { v: 1, kind: 'permission', actions: [{ id: 'approve', label: 'Yes' }, { id: 'deny', label: 'No' }] };
let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-native-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function setup() {
  const clock = { now: 10_000 };
  const answered: Array<{ ref: NativeDecisionRef; reply: NativeDecisionReply }> = [];
  const writes: string[] = [];
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => [],
    writeToSession: (_id, data) => { writes.push(data); return true; },
    answerNative: async (ref, reply) => { answered.push({ ref, reply }); return 'ok'; },
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  const note = async (relayId: string, requestId = '0', sessionId = 'pty-a'): Promise<ApprovalRequest | undefined> => {
    const id = await registry.noteNativeDecision({
      sessionId, agent: 'codex',
      native: { adapter: 'codex', relayId, threadId: 'thread-1', requestId, method: 'item/commandExecution/requestApproval' },
      form: FORM, question: 'Run this command?', toolName: 'command', summary: 'touch out.txt',
    });
    return registry.list().pending.find((r) => r.id === id);
  };
  return { registry, clock, answered, writes, note };
}

describe('Codex native decisions', () => {
  it('keep id 0 of a restarted server apart from the settled id 0 of the relay before it', async () => {
    const t = setup();
    const first = await t.note('relay-1');
    expect(first).toBeDefined();
    await t.registry.expireNative('pty-a', { adapter: 'codex', relayId: 'relay-1', threadId: 'thread-1', requestId: '0' }, 'pane-gone');
    // The same relay's id 0 again is the settled request: no card comes back.
    expect(await t.note('relay-1')).toBeUndefined();
    const second = await t.note('relay-2');
    expect(second).toBeDefined();
    expect(second!.formFingerprint).not.toBe(first!.formFingerprint);
    // Another pane's relay with the same id is a separate record too.
    expect(await t.note('relay-3', '0', 'pty-b')).toBeDefined();
    expect(t.registry.list().pending).toHaveLength(2);
  });

  it('expire for answered-locally only through expireNative, never the screen sweep', async () => {
    const t = setup();
    const record = (await t.note('relay-1'))!;
    await t.registry.expireForSession('pty-a', 'answered-locally');
    expect(t.registry.list().pending.map((r) => r.id)).toEqual([record.id]);
    // Another request id on the same relay leaves it alone.
    await t.registry.expireNative('pty-a', { adapter: 'codex', relayId: 'relay-1', threadId: 'thread-1', requestId: '1' }, 'answered-locally');
    expect(t.registry.list().pending).toHaveLength(1);
    await t.registry.expireNative('pty-a', { adapter: 'codex', relayId: 'relay-1', threadId: 'thread-1', requestId: '0' }, 'answered-locally');
    expect(t.registry.list().pending).toEqual([]);
    t.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    const late = await t.registry.resolve({
      id: record.id, decision: 'approve', choiceKey: '1', promptFingerprint: record.promptFingerprint,
      resolvedBy: 'device Phone (d1)', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    });
    expect(late).toMatchObject({ ok: false, reason: 'expired' });
    expect(t.answered).toEqual([]);
  });

  it('decline reaches the relay as a deny with the full request identity, and types nothing', async () => {
    const t = setup();
    const record = (await t.note('relay-1', '4'))!;
    t.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    const result = await t.registry.resolve({
      id: record.id, decision: 'deny', resolvedBy: 'device Phone (d1)', terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE,
    });
    expect(result).toMatchObject({ ok: true });
    expect(t.answered).toEqual([{
      ref: { adapter: 'codex', relayId: 'relay-1', threadId: 'thread-1', requestId: '4', method: 'item/commandExecution/requestApproval' },
      reply: { decision: 'deny', formKind: 'permission' },
    }]);
    expect(t.writes).toEqual([]);
  });
});
