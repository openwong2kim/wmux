// #1846: on Windows path.join gives backslashes while Vite hands plugins
// slash-form ids, so the WEB_STUBS table never matched and the browser build
// shipped the desktop Terminal instead of WebTerminal. node:path is swapped for
// its win32 join here so the Windows build is reproduced on any OS.
import { describe, it, expect, vi } from 'vitest';
import { webStubs } from '../../../../vite.web.config';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  const win = { ...actual, join: actual.win32.join };
  return { ...win, default: win };
});

// The slash-form id Vite resolves for a repo file on Windows.
const repoRoot = __dirname.replace(/\\/g, '/').replace(/\/src\/renderer\/web\/__tests__$/, '');
const id = (rel: string) => `${repoRoot}/${rel}`;

type ResolveId = (this: unknown, source: string, importer: string | undefined, options: object) => Promise<string | null>;

function run(resolvedId: string, importer: string) {
  const resolve = vi.fn(async () => ({ id: resolvedId }));
  const hook = webStubs().resolveId as unknown as ResolveId;
  return { resolve, result: hook.call({ resolve }, './x', importer, {}) };
}

describe('webStubs on Windows paths (#1846)', () => {
  it('swaps the desktop Terminal for WebTerminal', async () => {
    const { result } = run(id('src/renderer/components/Terminal/Terminal.tsx?v=1'), id('src/renderer/components/PaneContainer/Pane.tsx'));
    expect(await result).toBe(id('src/renderer/web/WebTerminal.tsx'));
  });

  it('stubs a desktop-only panel', async () => {
    const { result } = run(id('src/renderer/components/Browser/BrowserPanel.tsx'), id('src/renderer/components/PaneContainer/Pane.tsx'));
    expect(await result).toBe(id('src/renderer/web/stubs/NullComponent.tsx'));
  });

  it('lets WebTerminal itself import the real Terminal', async () => {
    const { resolve, result } = run(id('src/renderer/components/Terminal/Terminal.tsx'), id('src/renderer/web/WebTerminal.tsx'));
    expect(await result).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
