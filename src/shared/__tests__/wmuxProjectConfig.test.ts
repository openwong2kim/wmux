import { describe, it, expect } from 'vitest';
import {
  normalizeWmuxProjectConfig,
  collectConfigCommands,
  countLayoutLeaves,
  isValidProjectRelativeCwd,
  isSafeProjectUrl,
  PROJECT_CONFIG_MAX_COMMANDS,
  PROJECT_CONFIG_MAX_LAYOUT_LEAVES,
} from '../wmuxProjectConfig';

describe('normalizeWmuxProjectConfig — top level', () => {
  it('rejects non-objects', () => {
    expect(normalizeWmuxProjectConfig(null)).toBeUndefined();
    expect(normalizeWmuxProjectConfig('x')).toBeUndefined();
    expect(normalizeWmuxProjectConfig([])).toBeUndefined();
    expect(normalizeWmuxProjectConfig(42)).toBeUndefined();
  });

  it('rejects unknown versions entirely (forward-compat)', () => {
    expect(
      normalizeWmuxProjectConfig({ version: 2, commands: [{ id: 'a', title: 'A', command: 'echo a' }] }),
    ).toBeUndefined();
  });

  it('treats absent version as v1', () => {
    const config = normalizeWmuxProjectConfig({ commands: [{ id: 'a', title: 'A', command: 'echo a' }] });
    expect(config?.version).toBe(1);
    expect(config?.commands).toHaveLength(1);
  });

  it('returns undefined when nothing usable remains', () => {
    expect(normalizeWmuxProjectConfig({ version: 1 })).toBeUndefined();
    expect(normalizeWmuxProjectConfig({ version: 1, commands: [], layout: 'bogus' })).toBeUndefined();
  });
});

describe('normalizeWmuxProjectConfig — commands (item-wise forgiving)', () => {
  it('drops invalid entries but keeps valid ones', () => {
    const config = normalizeWmuxProjectConfig({
      commands: [
        { id: 'ok', title: 'OK', command: 'npm test' },
        { id: 'bad id!', title: 'Bad', command: 'x' },          // invalid id
        { id: 'no-title', title: '', command: 'x' },              // empty title
        { id: 'no-cmd', title: 'NoCmd', command: '   ' },         // blank command
        'not-an-object',
        { id: 'ok2', title: 'OK2', command: 'npm run dev' },
      ],
    });
    expect(config?.commands?.map((c) => c.id)).toEqual(['ok', 'ok2']);
  });

  it('keeps the first declaration on duplicate ids', () => {
    const config = normalizeWmuxProjectConfig({
      commands: [
        { id: 'dev', title: 'First', command: 'first' },
        { id: 'dev', title: 'Second', command: 'second' },
      ],
    });
    expect(config?.commands).toEqual([{ id: 'dev', title: 'First', command: 'first' }]);
  });

  it('caps the command count', () => {
    const commands = Array.from({ length: PROJECT_CONFIG_MAX_COMMANDS + 5 }, (_, i) => ({
      id: `c${i}`,
      title: `C${i}`,
      command: `echo ${i}`,
    }));
    const config = normalizeWmuxProjectConfig({ commands });
    expect(config?.commands).toHaveLength(PROJECT_CONFIG_MAX_COMMANDS);
  });

  it('preserves command content verbatim (no trim inside)', () => {
    const config = normalizeWmuxProjectConfig({
      commands: [{ id: 'a', title: 'A', command: '  spaced   args  ' }],
    });
    expect(config?.commands?.[0]?.command).toBe('  spaced   args  ');
  });
});

describe('normalizeWmuxProjectConfig — layout (all-or-nothing)', () => {
  const validLayout = {
    direction: 'horizontal',
    panes: [{ command: 'claude' }, { direction: 'vertical', panes: [{ command: 'npm run dev' }, { url: 'http://localhost:3000' }] }],
  };

  it('normalizes a nested branch/leaf tree', () => {
    const config = normalizeWmuxProjectConfig({ layout: validLayout });
    expect(config?.layout).toEqual({
      type: 'branch',
      direction: 'horizontal',
      children: [
        { type: 'leaf', command: 'claude' },
        {
          type: 'branch',
          direction: 'vertical',
          children: [
            { type: 'leaf', command: 'npm run dev' },
            { type: 'leaf', url: 'http://localhost:3000' },
          ],
        },
      ],
    });
  });

  it('rejects the whole layout when any node is invalid', () => {
    const config = normalizeWmuxProjectConfig({
      commands: [{ id: 'a', title: 'A', command: 'echo a' }],
      layout: {
        direction: 'horizontal',
        panes: [{ command: 'ok' }, { url: 'file:///etc/passwd' }], // unsafe URL
      },
    });
    expect(config?.layout).toBeUndefined();
    expect(config?.commands).toHaveLength(1); // commands survive independently
  });

  it('rejects a leaf mixing url with command/cwd', () => {
    expect(
      normalizeWmuxProjectConfig({
        layout: { direction: 'horizontal', panes: [{ command: 'x' }, { url: 'http://a', command: 'y' }] },
      }),
    ).toBeUndefined();
  });

  it('rejects single-child and missing-direction branches', () => {
    expect(
      normalizeWmuxProjectConfig({ layout: { direction: 'horizontal', panes: [{ command: 'x' }] } }),
    ).toBeUndefined();
    expect(
      normalizeWmuxProjectConfig({ layout: { panes: [{ command: 'x' }, { command: 'y' }] } }),
    ).toBeUndefined();
  });

  it('accepts a bare-leaf root', () => {
    const config = normalizeWmuxProjectConfig({ layout: { command: 'claude' } });
    expect(config?.layout).toEqual({ type: 'leaf', command: 'claude' });
  });

  it('drops mismatched sizes but keeps the branch', () => {
    const config = normalizeWmuxProjectConfig({
      layout: { direction: 'horizontal', sizes: [10], panes: [{ command: 'a' }, { command: 'b' }] },
    });
    expect(config?.layout).toMatchObject({ type: 'branch' });
    expect((config?.layout as { sizes?: number[] }).sizes).toBeUndefined();
  });

  it('keeps matching positive sizes', () => {
    const config = normalizeWmuxProjectConfig({
      layout: { direction: 'horizontal', sizes: [30, 70], panes: [{ command: 'a' }, { command: 'b' }] },
    });
    expect((config?.layout as { sizes?: number[] }).sizes).toEqual([30, 70]);
  });

  it('rejects layouts over the leaf cap', () => {
    const panes = Array.from({ length: PROJECT_CONFIG_MAX_LAYOUT_LEAVES + 1 }, () => ({ command: 'x' }));
    expect(normalizeWmuxProjectConfig({ layout: { direction: 'horizontal', panes } })).toBeUndefined();
  });

  it('rejects layouts over the depth cap', () => {
    let node: Record<string, unknown> = { command: 'x' };
    for (let i = 0; i < 6; i++) {
      node = { direction: 'horizontal', panes: [node, { command: 'y' }] };
    }
    expect(normalizeWmuxProjectConfig({ layout: node })).toBeUndefined();
  });

  it('rejects relative-cwd escapes', () => {
    expect(
      normalizeWmuxProjectConfig({
        layout: { direction: 'horizontal', panes: [{ cwd: '../outside' }, { command: 'x' }] },
      }),
    ).toBeUndefined();
    expect(
      normalizeWmuxProjectConfig({
        layout: { direction: 'horizontal', panes: [{ cwd: 'C:\\abs' }, { command: 'x' }] },
      }),
    ).toBeUndefined();
  });

  it('accepts nested relative cwd', () => {
    const config = normalizeWmuxProjectConfig({
      layout: { direction: 'horizontal', panes: [{ cwd: 'packages/web' }, { command: 'x' }] },
    });
    expect(config?.layout).toMatchObject({
      children: [{ type: 'leaf', cwd: 'packages/web' }, { type: 'leaf', command: 'x' }],
    });
  });
});

describe('isValidProjectRelativeCwd', () => {
  it('accepts plain relative segments', () => {
    expect(isValidProjectRelativeCwd('src')).toBe(true);
    expect(isValidProjectRelativeCwd('packages/web')).toBe(true);
    expect(isValidProjectRelativeCwd('./src')).toBe(true);
  });
  it('rejects escapes and absolutes', () => {
    expect(isValidProjectRelativeCwd('..')).toBe(false);
    expect(isValidProjectRelativeCwd('a/../../b')).toBe(false);
    expect(isValidProjectRelativeCwd('/etc')).toBe(false);
    expect(isValidProjectRelativeCwd('\\\\server\\share')).toBe(false);
    expect(isValidProjectRelativeCwd('D:stuff')).toBe(false);
    expect(isValidProjectRelativeCwd('')).toBe(false);
  });
});

describe('isSafeProjectUrl', () => {
  it('allows http/https only', () => {
    expect(isSafeProjectUrl('http://localhost:3000')).toBe(true);
    expect(isSafeProjectUrl('https://github.com')).toBe(true);
    expect(isSafeProjectUrl('file:///C:/x')).toBe(false);
    expect(isSafeProjectUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeProjectUrl('not a url')).toBe(false);
  });
});

describe('collectConfigCommands / countLayoutLeaves', () => {
  it('lists custom commands then layout commands depth-first', () => {
    const config = normalizeWmuxProjectConfig({
      commands: [{ id: 'a', title: 'A', command: 'cmd-a' }],
      layout: {
        direction: 'horizontal',
        panes: [{ command: 'left' }, { direction: 'vertical', panes: [{ command: 'top' }, { url: 'http://x' }] }],
      },
    });
    expect(config).toBeDefined();
    expect(collectConfigCommands(config!)).toEqual(['cmd-a', 'left', 'top']);
    expect(countLayoutLeaves(config!.layout!)).toBe(3);
  });
});
