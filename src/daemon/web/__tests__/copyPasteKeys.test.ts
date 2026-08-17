// Copy / paste / newline key decisions for the wmux web terminal.
//
// The frontend has no bundler: `copyPasteKeys.js` is inlined into terminal.html
// by scripts/build-daemon-web.mjs. Evaluate the shipped file verbatim, exactly
// like touchScroll.test.ts / pairQuery.test.ts, so this covers the bytes the
// browser actually runs.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

type KeyLike = {
  type: string;
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
};

type Decide = (ev: KeyLike, opts: { isMac?: boolean; hasSelection?: boolean; readOnly?: boolean }) => {
  action: string;
  data?: string;
} | null;

let decideWebKey: Decide;

const frontend = (name: string) => join(__dirname, '..', 'frontend', name);

beforeAll(() => {
  const src = readFileSync(frontend('copyPasteKeys.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  runInNewContext(src, sandbox);
  const mod = sandbox.wmuxWebKeys as Record<string, unknown>;
  decideWebKey = mod.decideWebKey as Decide;
});

const kd = (partial: Partial<KeyLike>): KeyLike => ({
  type: 'keydown',
  key: '',
  code: '',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...partial,
});

describe('newline keys', () => {
  it('Shift+Enter emits the CSI-u newline byte (kitty protocol)', () => {
    expect(decideWebKey(kd({ key: 'Enter', code: 'Enter', shiftKey: true }), {})).toEqual({
      action: 'newline',
      data: '\x1b[13;2u',
    });
  });

  it('Shift+Enter on a read-only host is swallowed', () => {
    expect(decideWebKey(kd({ key: 'Enter', code: 'Enter', shiftKey: true }), { readOnly: true })).toEqual({
      action: 'swallow',
    });
  });

  it('Shift+Enter during an IME composition passes through', () => {
    expect(decideWebKey(kd({ key: 'Enter', code: 'Enter', shiftKey: true, isComposing: true }), {})).toBeNull();
  });

  it('Ctrl+Enter emits LF (insert newline, not submit)', () => {
    expect(decideWebKey(kd({ key: 'Enter', code: 'Enter', ctrlKey: true }), {})).toEqual({
      action: 'newline',
      data: '\n',
    });
  });

  it('Ctrl+J emits LF, matched by physical code', () => {
    expect(decideWebKey(kd({ key: 'j', code: 'KeyJ', ctrlKey: true }), {})).toEqual({
      action: 'newline',
      data: '\n',
    });
  });

  it('plain Enter is not intercepted', () => {
    expect(decideWebKey(kd({ key: 'Enter', code: 'Enter' }), {})).toBeNull();
  });
});

describe('copy (Windows/Linux)', () => {
  it('Ctrl+C with a selection copies', () => {
    expect(decideWebKey(kd({ key: 'c', code: 'KeyC', ctrlKey: true }), { hasSelection: true })).toEqual({
      action: 'copy',
    });
  });

  it('Ctrl+C with an empty selection passes through (SIGINT is not taken away)', () => {
    expect(decideWebKey(kd({ key: 'c', code: 'KeyC', ctrlKey: true }), { hasSelection: false })).toBeNull();
  });

  it('Ctrl+C matches by physical code too (CJK IME mangles `key`)', () => {
    expect(decideWebKey(kd({ key: 'Process', code: 'KeyC', ctrlKey: true }), { hasSelection: true })).toEqual({
      action: 'copy',
    });
  });

  it('Ctrl+V asks app.js to step aside so the browser can paste natively', () => {
    expect(decideWebKey(kd({ key: 'v', code: 'KeyV', ctrlKey: true }), {})).toEqual({
      action: 'paste',
    });
  });

  it('Ctrl+D is swallowed so a browser pane cannot be killed by an errant EOF', () => {
    expect(decideWebKey(kd({ key: 'd', code: 'KeyD', ctrlKey: true }), {})).toEqual({
      action: 'swallow',
    });
  });

  it('Ctrl+Shift+C copies with a selection, swallows without', () => {
    expect(decideWebKey(kd({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }), { hasSelection: true })).toEqual({ action: 'copy' });
    expect(decideWebKey(kd({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }), { hasSelection: false })).toEqual({ action: 'swallow' });
  });
});

describe('copy (macOS)', () => {
  it('⌘C with a selection copies', () => {
    expect(decideWebKey(kd({ key: 'c', code: 'KeyC', metaKey: true }), { isMac: true, hasSelection: true })).toEqual({
      action: 'copy',
    });
  });

  it('⌘C with no selection passes (let the OS copy nothing)', () => {
    expect(decideWebKey(kd({ key: 'c', code: 'KeyC', metaKey: true }), { isMac: true, hasSelection: false })).toBeNull();
  });

  it('⌘V is left to the browser paste path', () => {
    expect(decideWebKey(kd({ key: 'v', code: 'KeyV', metaKey: true }), { isMac: true })).toBeNull();
  });

  it('macOS Ctrl+C stays SIGINT (bare Ctrl is not ⌘)', () => {
    expect(decideWebKey(kd({ key: 'c', code: 'KeyC', ctrlKey: true }), { isMac: true, hasSelection: true })).toBeNull();
  });
});

describe('pass-through', () => {
  it('a plain letter is untouched', () => {
    expect(decideWebKey(kd({ key: 'a', code: 'KeyA' }), {})).toBeNull();
  });

  it('a keyup is never decided', () => {
    expect(decideWebKey({ ...kd({ key: 'c', code: 'KeyC', ctrlKey: true }), type: 'keyup' }, { hasSelection: true })).toBeNull();
  });
});
