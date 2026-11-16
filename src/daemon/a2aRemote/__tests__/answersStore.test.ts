// This PC's setting for answers to a headless worker's question (answersStore.ts):
// its own file, the follow-ups policy when it is missing, off (and why) when damaged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANSWERS_FILE, AnswersStore } from '../answersStore';
import { STATUS_LABELS_FILE, StatusLabelsStore } from '../statusLabelsStore';

let dir: string;
let logs: Array<[string, string]>;
const store = (): AnswersStore => new AnswersStore({
  dir,
  log: (level, msg) => { logs.push([level, msg]); },
  scheduleHarden: () => undefined,
  now: () => Date.UTC(2026, 10, 16),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-'));
  logs = [];
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the answers setting', () => {
  it('no file: follows the follow-ups policy (direct: on, ask: off), nothing logged', () => {
    const s = store();
    expect(s.get()).toEqual({ answers: 'default', damaged: false });
    expect(s.effective(true)).toBe('on');
    expect(s.effective(false)).toBe('off');
    expect(logs).toEqual([]);
  });

  it('off is saved to its own file and read back by the next daemon, whatever the follow-ups policy', () => {
    expect(store().set('off')).toEqual({ ok: true, answers: 'off' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, ANSWERS_FILE), 'utf8'))).toEqual({ v: 1, answers: 'off' });
    expect(store().effective(true)).toBe('off');
  });

  it('default removes the file', () => {
    const s = store();
    s.set('on');
    expect(s.set('default')).toEqual({ ok: true, answers: 'default' });
    expect(fs.existsSync(path.join(dir, ANSWERS_FILE))).toBe(false);
  });

  it('a damaged file reads as off and says so, the next start too, until a person sets it again', () => {
    fs.writeFileSync(path.join(dir, ANSWERS_FILE), '{"v":1,"answers":"maybe"}');
    const s = store();
    expect(s.effective(true)).toBe('damaged');
    expect(s.get()).toEqual({ answers: 'off', damaged: true });
    expect(logs.filter(([level]) => level === 'warn')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ANSWERS_FILE), 'utf8'))).toEqual({ v: 1, answers: 'off', damagedAt: '2026-11-16T00:00:00.000Z' });
    expect(store().effective(true)).toBe('damaged');
    expect(store().set('on')).toEqual({ ok: true, answers: 'on' });
    expect(store().effective(false)).toBe('on');
  });

  it('a status labels write leaves the answers setting alone (separate files)', () => {
    store().set('off');
    new StatusLabelsStore({ dir, scheduleHarden: () => undefined }).set('keep');
    expect(JSON.parse(fs.readFileSync(path.join(dir, STATUS_LABELS_FILE), 'utf8'))).toEqual({ v: 1, labels: 'keep' });
    expect(store().effective(true)).toBe('off');
  });
});
