// The new-package line on a `terminal_prompt` record: only on a card that
// shows the call the line was read from, and kept when the record is replaced
// for the same call.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS, type PromptScreenMark } from '../ApprovalRegistry';
import { TERMINAL_PROMPT_WEB_ANSWER, type ApprovalRequest, type PackageCheck } from '../types';
import type { PendingToolUse } from '../../transcript/pendingToolUse';

const dialog = (command: string, description: string): string[] => [
  `● Bash(${command})`,
  '',
  '────────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  `   ${command}`,
  `   ${description}`,
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
];

const INSTALL = 'npm i react-codeshift';
const INSTALL_CALL: PendingToolUse = { id: 'toolu_01', name: 'Bash', input: { command: INSTALL, description: 'Add the codemod' } };
const CHECK: PackageCheck = {
  command: INSTALL,
  newPackages: [{ ecosystem: 'npm', name: 'react-codeshift', checked: 'package.json', via: 'install' }],
};

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-new-pkg-prompt-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function harness(rows: string[], pending: PendingToolUse) {
  const pane: PromptScreenMark & { rows: string[]; pending: PendingToolUse } = {
    bytes: 100, keyInputRevision: 3, incarnation: 'inc-1', rows, pending,
  };
  const clock = { now: 10_000 };
  let next = 1;
  const mark = () => ({ bytes: pane.bytes, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation });
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: () => true,
    readPromptScreen: async () => ({ rows: pane.rows, mark: mark() }),
    promptScreenMark: mark,
    pendingToolUse: () => pane.pending,
    promptReadDelay: async () => undefined,
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  const create = async (): Promise<ApprovalRequest> => {
    await registry.noteTerminalPrompt({
      sessionId: 'pty-a', agent: 'claude', source: 'detector', packageCheckPending: Promise.resolve(CHECK),
    });
    const [record] = registry.list().pending;
    if (!record) throw new Error('no record');
    return record;
  };
  return { registry, pane, clock, create };
}

describe('new-package line on a terminal_prompt record', () => {
  it('a dialog bound to the call the line was read from carries it', async () => {
    const { create } = harness(dialog(INSTALL, 'Add the codemod'), INSTALL_CALL);
    const record = await create();
    expect(record.summary).toBe(INSTALL);
    expect(record.newPackages).toEqual(CHECK.newPackages);
  });

  it('a card that shows the screen\'s command, not the call\'s, does not', async () => {
    // The transcript's pending call is the install, but the dialog on screen is
    // another call's (a subagent's): the card shows `rm x`, so no package line.
    const { create } = harness(dialog('rm x', 'Remove x'), INSTALL_CALL);
    const record = await create();
    expect(record.summary).toMatch(/^rm x/);
    expect(record.newPackages).toBeUndefined();
  });

  it('kept when a key at the desk replaces the record for the same call, dropped for another call', async () => {
    const same = harness(dialog(INSTALL, 'Add the codemod'), INSTALL_CALL);
    const first = await same.create();
    same.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    same.pane.keyInputRevision += 1; // ↓ in the pane
    const answer = (r: ApprovalRequest) => same.registry.resolve({
      id: r.id, decision: 'approve', choiceKey: '1', promptFingerprint: r.promptFingerprint,
      resolvedBy: 'device Test phone (dev-1)', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    });
    expect(await answer(first)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    const [fresh] = same.registry.list().pending;
    expect(fresh?.id).not.toBe(first.id);
    expect(fresh?.newPackages).toEqual(CHECK.newPackages);

    const other = harness(dialog(INSTALL, 'Add the codemod'), INSTALL_CALL);
    const before = await other.create();
    other.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    other.pane.keyInputRevision += 1;
    other.pane.rows = dialog('npm i left-pad', 'Add left-pad');
    other.pane.pending = { id: 'toolu_02', name: 'Bash', input: { command: 'npm i left-pad', description: 'Add left-pad' } };
    await other.registry.resolve({
      id: before.id, decision: 'approve', choiceKey: '1', promptFingerprint: before.promptFingerprint,
      resolvedBy: 'device Test phone (dev-1)', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    });
    const [replaced] = other.registry.list().pending;
    expect(replaced?.id).not.toBe(before.id);
    expect(replaced?.summary).toMatch(/^npm i left-pad/);
    expect(replaced?.newPackages).toBeUndefined();
  });
});
