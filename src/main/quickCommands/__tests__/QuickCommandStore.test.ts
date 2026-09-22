import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuickCommandStore } from '../QuickCommandStore';
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-quick-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
describe('shared quick command persistence', () => {
  it('persists exact instructions and refuses stale concurrent writes', () => {
    const store = new QuickCommandStore(directory);
    const first = store.read();
    const next = store.replace({ ...first, commands: [{ id: 'one', title: ' Review ', text: 'line one\nline two' }] });
    expect(next.revision).not.toBe(first.revision);
    expect(new QuickCommandStore(directory).read()).toEqual(next);
    expect(() => store.replace({ ...first, commands: [] })).toThrow('changed elsewhere');
    expect(store.read().commands[0].text).toBe('line one\nline two');
    next.commands[0].text = 'mutated snapshot';
    expect(store.read().commands[0].text).toBe('line one\nline two');
  });
  it.each([
    [{ id: 'one', title: '', text: 'body' }],
    [{ id: 'one', title: 'Title', text: '\0' }],
    [{ id: 'one', title: 'Title', text: 'body' }, { id: 'one', title: 'Other', text: 'body' }],
    Array.from({ length: 101 }, (_, n) => ({ id: String(n), title: 'Title', text: 'body' })),
  ].map(commands => ({ commands })))('rejects invalid lists without advancing the revision', ({ commands }) => {
    const store = new QuickCommandStore(directory);
    const before = store.read();
    expect(() => store.replace({ ...before, commands })).toThrow();
    expect(store.read()).toEqual(before);
  });
  it('does not silently replace corrupt storage with an empty list', () => {
    fs.writeFileSync(path.join(directory, 'quick-commands.json'), '{bad');
    expect(() => new QuickCommandStore(directory)).toThrow();
  });
});
