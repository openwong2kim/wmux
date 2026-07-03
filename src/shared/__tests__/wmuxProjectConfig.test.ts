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

describe('normalizeWmuxProjectConfig — X8 supervision (strict, decision ⑪)', () => {
  // Helper: a two-leaf horizontal branch whose FIRST leaf carries the override
  // under test, so layout-drop vs. leaf-shape is unambiguous.
  function layoutWith(leaf: Record<string, unknown>) {
    return { direction: 'horizontal', panes: [{ command: 'claude /loop', ...leaf }, { command: 'echo sibling' }] };
  }
  function firstLeaf(input: Record<string, unknown>) {
    const config = normalizeWmuxProjectConfig({ layout: layoutWith(input) });
    const layout = config?.layout;
    if (!layout || layout.type !== 'branch') return undefined;
    return layout.children[0];
  }

  it('accepts restart: on-failure and always', () => {
    expect(firstLeaf({ restart: 'on-failure' })).toEqual({ type: 'leaf', command: 'claude /loop', restart: 'on-failure' });
    expect(firstLeaf({ restart: 'always' })).toEqual({ type: 'leaf', command: 'claude /loop', restart: 'always' });
  });

  it("normalizes restart: 'never' to an omitted field (documented no-op)", () => {
    const leaf = firstLeaf({ restart: 'never' });
    expect(leaf).toEqual({ type: 'leaf', command: 'claude /loop' });
    expect(leaf && 'restart' in leaf).toBe(false);
  });

  it('drops the whole layout on an unknown restart value (no silent downgrade)', () => {
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'on-fail' }) })).toBeUndefined();
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restart: true }) })).toBeUndefined();
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 1 }) })).toBeUndefined();
  });

  it('drops the layout when restart has no command', () => {
    expect(
      normalizeWmuxProjectConfig({
        layout: { direction: 'horizontal', panes: [{ restart: 'always' }, { command: 'x' }] },
      }),
    ).toBeUndefined();
  });

  it('drops the layout when restart accompanies a url', () => {
    expect(
      normalizeWmuxProjectConfig({
        layout: { direction: 'horizontal', panes: [{ url: 'http://localhost:3000', restart: 'always' }, { command: 'x' }] },
      }),
    ).toBeUndefined();
  });

  it('accepts a restartLimit within caps', () => {
    expect(firstLeaf({ restart: 'on-failure', restartLimit: { burst: 3, healthyUptimeSec: 600 } })).toEqual({
      type: 'leaf',
      command: 'claude /loop',
      restart: 'on-failure',
      restartLimit: { burst: 3, healthyUptimeSec: 600 },
    });
  });

  it('floors fractional restartLimit values', () => {
    expect(firstLeaf({ restart: 'always', restartLimit: { burst: 4.9, healthyUptimeSec: 120.7 } })).toMatchObject({
      restartLimit: { burst: 4, healthyUptimeSec: 120 },
    });
  });

  it('drops the layout on out-of-range or NaN restartLimit', () => {
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'on-failure', restartLimit: { burst: 0 } }) })).toBeUndefined();
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'on-failure', restartLimit: { burst: 21 } }) })).toBeUndefined();
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'on-failure', restartLimit: { healthyUptimeSec: 29 } }) })).toBeUndefined();
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'on-failure', restartLimit: { healthyUptimeSec: 3601 } }) })).toBeUndefined();
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'on-failure', restartLimit: { burst: Number.NaN } }) })).toBeUndefined();
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'on-failure', restartLimit: { burst: 'five' } }) })).toBeUndefined();
  });

  it('accepts a partial restartLimit (missing field defaulted later at the funnel)', () => {
    expect(firstLeaf({ restart: 'on-failure', restartLimit: { burst: 7 } })).toEqual({
      type: 'leaf',
      command: 'claude /loop',
      restart: 'on-failure',
      restartLimit: { burst: 7 },
    });
    expect(firstLeaf({ restart: 'always', restartLimit: { healthyUptimeSec: 90 } })).toEqual({
      type: 'leaf',
      command: 'claude /loop',
      restart: 'always',
      restartLimit: { healthyUptimeSec: 90 },
    });
  });

  it('silently drops a restartLimit orphan with no effective restart (cosmetic)', () => {
    // No restart → leaf stays valid, restartLimit is simply not carried.
    expect(firstLeaf({ restartLimit: { burst: 3 } })).toEqual({ type: 'leaf', command: 'claude /loop' });
    // restart:'never' also leaves no effective restart → orphan dropped.
    expect(firstLeaf({ restart: 'never', restartLimit: { burst: 3 } })).toEqual({ type: 'leaf', command: 'claude /loop' });
  });

  it('still validates a restartLimit even when its restart resolves away (strictness)', () => {
    // An orphan restartLimit is cosmetic, but a MALFORMED one is still a typo —
    // an empty restartLimit object carries no present fields and is harmless,
    // while a present-but-bad field is caught regardless of restart presence.
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restartLimit: { burst: 0 } }) })).toBeUndefined();
  });

  it('keeps supervised commands in the trust-dialog command list', () => {
    const config = normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'on-failure' }) });
    expect(config).toBeDefined();
    expect(collectConfigCommands(config!)).toEqual(['claude /loop', 'echo sibling']);
  });
});

describe('normalizeWmuxProjectConfig — unattended sugar + restorePermissionMode (decision ⑨/⑩)', () => {
  function layoutWith(leaf: Record<string, unknown>) {
    return { direction: 'horizontal', panes: [{ command: 'claude', ...leaf }, { command: 'echo sibling' }] };
  }
  function firstLeaf(input: Record<string, unknown>) {
    const config = normalizeWmuxProjectConfig({ layout: layoutWith(input) });
    const layout = config?.layout;
    if (!layout || layout.type !== 'branch') return undefined;
    return layout.children[0];
  }

  it('expands `unattended: true` to restart:on-failure + restorePermissionMode', () => {
    expect(firstLeaf({ unattended: true })).toEqual({
      type: 'leaf',
      command: 'claude',
      restart: 'on-failure',
      restorePermissionMode: true,
    });
  });

  it('lets an explicit restart override the sugar default (keeps restore)', () => {
    expect(firstLeaf({ unattended: true, restart: 'always' })).toEqual({
      type: 'leaf',
      command: 'claude',
      restart: 'always',
      restorePermissionMode: true,
    });
  });

  it('lets explicit restorePermissionMode:false opt out of restore while staying supervised', () => {
    const leaf = firstLeaf({ unattended: true, restorePermissionMode: false });
    expect(leaf).toEqual({ type: 'leaf', command: 'claude', restart: 'on-failure' });
    expect(leaf && 'restorePermissionMode' in leaf).toBe(false);
  });

  it('accepts the explicit (non-sugar) restart + restorePermissionMode form', () => {
    expect(firstLeaf({ restart: 'always', restorePermissionMode: true })).toEqual({
      type: 'leaf',
      command: 'claude',
      restart: 'always',
      restorePermissionMode: true,
    });
  });

  it('carries restartLimit alongside the unattended expansion', () => {
    expect(firstLeaf({ unattended: true, restartLimit: { burst: 3 } })).toEqual({
      type: 'leaf',
      command: 'claude',
      restart: 'on-failure',
      restartLimit: { burst: 3 },
      restorePermissionMode: true,
    });
  });

  it('treats `unattended: false` as a no-op', () => {
    expect(firstLeaf({ unattended: false })).toEqual({ type: 'leaf', command: 'claude' });
  });

  it('treats a bare `restorePermissionMode: false` as a no-op', () => {
    expect(firstLeaf({ restorePermissionMode: false })).toEqual({ type: 'leaf', command: 'claude' });
  });

  it('rejects restore-without-supervision: unattended:true + restart:never (conflict guard)', () => {
    expect(
      normalizeWmuxProjectConfig({ layout: layoutWith({ unattended: true, restart: 'never' }) }),
    ).toBeUndefined();
  });

  it('rejects a bare restorePermissionMode:true with no restart (conflict guard)', () => {
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ restorePermissionMode: true }) })).toBeUndefined();
  });

  it('rejects unattended:true on a leaf with no command (restart needs a unit)', () => {
    expect(
      normalizeWmuxProjectConfig({ layout: { direction: 'horizontal', panes: [{ unattended: true }, { command: 'x' }] } }),
    ).toBeUndefined();
  });

  it('rejects unattended:true alongside a url', () => {
    expect(
      normalizeWmuxProjectConfig({
        layout: { direction: 'horizontal', panes: [{ url: 'http://localhost:3000', unattended: true }, { command: 'x' }] },
      }),
    ).toBeUndefined();
  });

  it('drops the layout on a non-boolean unattended (no silent downgrade)', () => {
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ unattended: 'yes' }) })).toBeUndefined();
    expect(normalizeWmuxProjectConfig({ layout: layoutWith({ unattended: 1 }) })).toBeUndefined();
  });

  it('drops the layout on a non-boolean restorePermissionMode', () => {
    expect(
      normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'always', restorePermissionMode: 'true' }) }),
    ).toBeUndefined();
    expect(
      normalizeWmuxProjectConfig({ layout: layoutWith({ restart: 'always', restorePermissionMode: 1 }) }),
    ).toBeUndefined();
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
