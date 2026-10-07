import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MOA_ASK_LIMITS, parseMoaAskInput, parseMoaAskStatusInput } from '../moaAsk';
import { readMoaAskEnabled } from '../moaAskSwitch';

const HEAD = '995e9d9a3124628f51c0a3989bf2eced7ea2f97c';
const OPTIONS = [{ key: '1', label: 'Yes' }, { key: '2', label: 'No', description: 'leave it' }];

describe('parseMoaAskInput', () => {
  it('accepts a free question, trimmed, with its category as topic', () => {
    expect(parseMoaAskInput({ question: '  Use the existing helper? ', options: OPTIONS, kind: 'approach', askId: 'a-1', context: ' ctx ' })).toEqual({
      ok: true,
      value: { askId: 'a-1', body: { type: 'question', question: 'Use the existing helper?', options: OPTIONS, topic: 'approach', context: 'ctx' } },
    });
  });

  it('accepts a typed merge action', () => {
    expect(parseMoaAskInput({ action: { type: 'merge', prNumber: 1858, expectHead: HEAD } })).toEqual({
      ok: true,
      value: { body: { type: 'merge', prNumber: 1858, expectHead: HEAD } },
    });
  });

  it.each([
    ['not an object', 'x', ''],
    ['neither question nor action', {}, 'question'],
    ['both question and action', { question: 'q', options: OPTIONS, action: { type: 'merge', prNumber: 1, expectHead: HEAD } }, 'action'],
    ['an unknown top-level key', { question: 'q', options: OPTIONS, asker: 'pty-1' }, 'asker'],
    ['an empty question', { question: '   ', options: OPTIONS }, 'question'],
    ['an over-long question', { question: 'x'.repeat(MOA_ASK_LIMITS.QUESTION_MAX + 1), options: OPTIONS }, 'question'],
    ['one option', { question: 'q', options: [OPTIONS[0]] }, 'options'],
    ['seven options', { question: 'q', options: Array.from({ length: 7 }, (_, i) => ({ key: String(i), label: 'x' })) }, 'options'],
    ['a duplicate key', { question: 'q', options: [{ key: '1', label: 'a' }, { key: '1', label: 'b' }] }, 'options[1].key'],
    ['a bad key', { question: 'q', options: [{ key: 'a b', label: 'a' }, OPTIONS[1]] }, 'options[0].key'],
    ['an empty label', { question: 'q', options: [{ key: '1', label: '' }, OPTIONS[1]] }, 'options[0].label'],
    ['a bad category', { question: 'q', options: OPTIONS, kind: 'Not Valid' }, 'kind'],
    ['a bad askId', { question: 'q', options: OPTIONS, askId: 'has space' }, 'askId'],
    ['options with an action', { action: { type: 'merge', prNumber: 1, expectHead: HEAD }, options: OPTIONS }, 'options'],
    ['an unknown action', { action: { type: 'approve', prNumber: 1, expectHead: HEAD } }, 'action.type'],
    ['an extra action field', { action: { type: 'merge', prNumber: 1, expectHead: HEAD, repo: 'x/y' } }, 'action.repo'],
    ['a PR number as text', { action: { type: 'merge', prNumber: '#12', expectHead: HEAD } }, 'action.prNumber'],
    ['a fractional PR number', { action: { type: 'merge', prNumber: 1.5, expectHead: HEAD } }, 'action.prNumber'],
    ['a short SHA', { action: { type: 'merge', prNumber: 1, expectHead: HEAD.slice(0, 12) } }, 'action.expectHead'],
    ['an uppercase SHA', { action: { type: 'merge', prNumber: 1, expectHead: HEAD.toUpperCase() } }, 'action.expectHead'],
  ])('rejects %s', (_name, raw, field) => {
    const r = parseMoaAskInput(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe(field);
  });

  it('never reads a PR number out of a question', () => {
    const r = parseMoaAskInput({ question: 'Merge PR #1858 now?', options: OPTIONS });
    expect(r.ok && r.value.body.type).toBe('question');
  });
});

describe('parseMoaAskStatusInput', () => {
  it('accepts a ticket id and nothing else', () => {
    const id = 'moa-t-0b8a6c1e-2f3d-4a5b-9c8d-7e6f5a4b3c2d';
    expect(parseMoaAskStatusInput({ ticketId: id })).toEqual({ ok: true, value: { ticketId: id } });
    expect(parseMoaAskStatusInput({ ticketId: 'moa-d-0b8a6c1e-2f3d-4a5b-9c8d-7e6f5a4b3c2d' }).ok).toBe(false);
    expect(parseMoaAskStatusInput({ ticketId: id, asker: 'x' }).ok).toBe(false);
  });
});

describe('readMoaAskEnabled (fail closed)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-ask-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('is on only for a literal true', () => {
    const file = path.join(dir, 'moa-ask.json');
    expect(readMoaAskEnabled(file)).toBe(false);
    for (const [body, want] of [['{"enabled":true}', true], ['{"enabled":"true"}', false], ['{"enabled":1}', false], ['not json', false], ['null', false]] as const) {
      fs.writeFileSync(file, body);
      expect(readMoaAskEnabled(file), body).toBe(want);
    }
  });
});
