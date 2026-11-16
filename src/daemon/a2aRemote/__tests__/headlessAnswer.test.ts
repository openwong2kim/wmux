// An answer from the asking PC typed into a headless worker's AskUserQuestion
// picker: the picker read off real Claude Code 2.1.325 captures (auto
// permission mode, no transcript call while it is open), the prompts that
// must never read as one, and the one-key path's fences.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseAskPicker } from '../../approvals/askPicker';
import type { PromptScreenMark } from '../../approvals/ApprovalRegistry';
import { answerPicker, screenPicker, type HeadlessAnswerDeps, type PromptScreen } from '../headlessAnswer';

const DIR = path.join(__dirname, '..', '..', 'approvals', '__tests__', 'fixtures', 'terminal-prompts');
// Read with fs, not a JSON import: a JSON import breaks the daemon build.
const screen = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as { screen: string[] }).screen;

const OPEN = screen('claude-2.1.325/claude-ask-single-01-open-80x24-2.1.325.json');
const ANSWERED = screen('claude-2.1.325/claude-ask-single-02-digit2-80x24-2.1.325.json');
const BASH = screen('claude-2.1.325/claude-bash-ask-rule-01-80x24-2.1.325.json');
const PLAN = screen('claude-2.1.325/claude-plan-exit-01-80x24-2.1.325.json');
const TRUST = screen('claude-2.1.325/claude-trust-folder-01-80x24-2.1.325.json');
const MULTI_SELECT = screen('claude-ask-multi-01-q1.json');

const SESSION = 'daemon-aaaa1111';

function pickerIdOf(rows: readonly string[], session = SESSION): string {
  const found = screenPicker(session, rows);
  if ('refused' in found) throw new Error(`no picker: ${found.refused}`);
  return found.pickerId;
}

describe('screenPicker', () => {
  it('reads the 2.1.325 picker: two choices (the free-text row is not one), a stable id bound to the session', () => {
    const found = screenPicker(SESSION, OPEN);
    expect('refused' in found).toBe(false);
    if ('refused' in found) return;
    expect(found.optionCount).toBe(2);
    expect(found.question.text).toBe('Deploy now?');
    expect(found.question.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(found.pickerId).toMatch(/^[0-9a-f]{16}$/);
    expect(pickerIdOf(OPEN)).toBe(found.pickerId);
    expect(pickerIdOf(OPEN, 'daemon-bbbb2222')).not.toBe(found.pickerId);
  });

  it('refuses a multi-select question whole', () => {
    expect(screenPicker(SESSION, MULTI_SELECT)).toEqual({ refused: 'not-single-select' });
  });

  it('sees no picker once it is answered', () => {
    expect(screenPicker(SESSION, ANSWERED)).toEqual({ refused: 'no-picker' });
  });

  // One real capture per prompt kind that must never be answered as a picker.
  it.each([
    ['the Bash permission prompt (`❯ 1. Yes / 2. No`)', BASH],
    ['the ExitPlanMode prompt', PLAN],
    ['the folder-trust prompt', TRUST],
  ])('%s never parses as a picker', (_kind, rows) => {
    expect(parseAskPicker(rows)).toBeNull();
    expect(screenPicker(SESSION, rows)).toEqual({ refused: 'no-picker' });
  });
});

/** A session whose screen is `frames` in turn (the last one repeats), with a mark the test can move. */
function fakeSession(frames: string[][], opts: { lock?: boolean } = {}) {
  let frame = 0;
  const mark: PromptScreenMark = { bytes: 100, keyInputRevision: 7, incarnation: 'inc-1' };
  const written: string[] = [];
  const unlocked: string[] = [];
  let reads = 0;
  const deps: HeadlessAnswerDeps & { mark: PromptScreenMark; written: string[]; unlocked: string[]; reads: () => number; afterWrite?: () => void } = {
    mark,
    written,
    unlocked,
    reads: () => reads,
    readPromptScreen: async (): Promise<PromptScreen> => {
      reads += 1;
      return { rows: frames[Math.min(frame, frames.length - 1)]!, mark: { ...mark } };
    },
    promptScreenMark: () => ({ ...mark }),
    writeStepKey: (_sid, data) => {
      written.push(data);
      mark.keyInputRevision += 1;
      frame += 1;
      deps.afterWrite?.();
      return mark.keyInputRevision;
    },
    lock: async () => (opts.lock === false ? null : 'token-1'),
    unlock: (_sid, token) => { unlocked.push(token); },
    now: (() => { let t = 0; return () => (t += 1000); })(),
    delay: async () => undefined,
  };
  return deps;
}

describe('answerPicker', () => {
  it('types the option\'s digit once and confirms Claude\'s "User answered" block, under the lock', async () => {
    const deps = fakeSession([OPEN, ANSWERED]);
    const res = await answerPicker(deps, SESSION, { pickerId: pickerIdOf(OPEN), option: 2 });
    expect(res).toEqual({ outcome: 'answered' });
    expect(deps.written).toEqual(['2']);
    expect(deps.unlocked).toEqual(['token-1']);
  });

  it('types nothing when another writer keeps the pane', async () => {
    const deps = fakeSession([OPEN, ANSWERED], { lock: false });
    expect(await answerPicker(deps, SESSION, { pickerId: pickerIdOf(OPEN), option: 1 })).toEqual({ outcome: 'not-answered', reason: 'lock-busy' });
    expect(deps.written).toEqual([]);
  });

  it('types nothing for another picker, an option it does not have, or a screen with no picker', async () => {
    const other = fakeSession([OPEN]);
    expect(await answerPicker(other, SESSION, { pickerId: '0123456789abcdef', option: 1 })).toEqual({ outcome: 'not-answered', reason: 'picker-changed' });
    const range = fakeSession([OPEN]);
    expect(await answerPicker(range, SESSION, { pickerId: pickerIdOf(OPEN), option: 3 })).toEqual({ outcome: 'not-answered', reason: 'option-out-of-range' });
    const none = fakeSession([BASH]);
    expect(await answerPicker(none, SESSION, { pickerId: pickerIdOf(OPEN), option: 1 })).toEqual({ outcome: 'not-answered', reason: 'no-picker' });
    for (const d of [other, range, none]) {
      expect(d.written).toEqual([]);
      expect(d.unlocked).toEqual(['token-1']);
    }
  });

  it('refuses a multi-select picker whole, before any key', async () => {
    const deps = fakeSession([MULTI_SELECT]);
    expect(await answerPicker(deps, SESSION, { pickerId: '0123456789abcdef', option: 1 })).toEqual({ outcome: 'not-answered', reason: 'not-single-select' });
    expect(deps.written).toEqual([]);
  });

  it('types nothing when a key reached the pane since the read', async () => {
    const deps = fakeSession([OPEN, ANSWERED]);
    const read = deps.readPromptScreen;
    deps.readPromptScreen = async (sid) => {
      const s = await read(sid);
      deps.mark.keyInputRevision += 1; // a person's key between the read and the write
      return s;
    };
    expect(await answerPicker(deps, SESSION, { pickerId: pickerIdOf(OPEN), option: 2 })).toEqual({ outcome: 'not-answered', reason: 'typed-meanwhile' });
    expect(deps.written).toEqual([]);
  });

  it('reads and proves again after output since the read, then types', async () => {
    const deps = fakeSession([OPEN, ANSWERED]);
    const read = deps.readPromptScreen;
    let first = true;
    deps.readPromptScreen = async (sid) => {
      const s = await read(sid);
      if (first) {
        first = false;
        deps.mark.bytes += 10; // the agent drew something after the first read
      }
      return s;
    };
    expect(await answerPicker(deps, SESSION, { pickerId: pickerIdOf(OPEN), option: 2 })).toEqual({ outcome: 'answered' });
    expect(deps.written).toEqual(['2']);
  });

  it('says unconfirmed when the screen never shows the answer after the key', async () => {
    const deps = fakeSession([OPEN, OPEN]);
    expect(await answerPicker(deps, SESSION, { pickerId: pickerIdOf(OPEN), option: 2 })).toEqual({ outcome: 'not-answered', reason: 'unconfirmed' });
    expect(deps.written).toEqual(['2']);
  });
});
