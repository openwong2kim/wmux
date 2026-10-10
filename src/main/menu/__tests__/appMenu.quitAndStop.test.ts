import { describe, expect, it, vi, beforeEach } from 'vitest';

const { setApplicationMenuMock, buildFromTemplateMock, quitAndStopSessionsMock } = vi.hoisted(() => ({
  setApplicationMenuMock: vi.fn(),
  buildFromTemplateMock: vi.fn((t: unknown) => ({ __built: t })),
  quitAndStopSessionsMock: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/nonexistent-wmux-test'), getLocale: vi.fn(() => 'ko-KR') },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  Menu: { setApplicationMenu: setApplicationMenuMock, buildFromTemplate: buildFromTemplateMock },
}));

vi.mock('../../quit/quitAndStopSessions', () => ({ quitAndStopSessions: quitAndStopSessionsMock }));
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), watchFile: vi.fn() }));

import { buildAppMenuTemplate, installApplicationMenu, keymapCollisions } from '../appMenu';

type Item = Electron.MenuItemConstructorOptions;
const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux'];

function quitMenu(template: Item[], platform: NodeJS.Platform): Item[] {
  const owner = platform === 'darwin' ? template[0] : template.find((m) => m.label === '&File');
  return (owner?.submenu ?? []) as Item[];
}

describe('Quit and Stop Sessions — menu wiring', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(PLATFORMS)('%s: sits right after Quit, with no accelerator', (platform) => {
    const onQuitAndStopSessions = vi.fn();
    const items = quitMenu(buildAppMenuTemplate({ platform, isDev: false, onQuitAndStopSessions }), platform);
    const quitAt = items.findIndex((i) => i.role === 'quit');
    expect(quitAt).toBeGreaterThanOrEqual(0);
    const item = items[quitAt + 1];
    expect(item.label).toBe('Quit and Stop Sessions');
    expect(item.accelerator).toBeUndefined();
    (item.click as () => void)();
    expect(onQuitAndStopSessions).toHaveBeenCalledOnce();
  });

  it.each(PLATFORMS)('%s: the expanded menu still claims no wmux key', (platform) => {
    const template = buildAppMenuTemplate({ platform, isDev: true, onQuitAndStopSessions: vi.fn() });
    expect(keymapCollisions(template, platform)).toEqual([]);
  });

  it('macOS keeps every app-menu member when spelled out', () => {
    const roles = quitMenu(buildAppMenuTemplate({ platform: 'darwin', isDev: false, onQuitAndStopSessions: vi.fn() }), 'darwin')
      .map((i) => i.role)
      .filter(Boolean);
    expect(roles).toEqual(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']);
  });

  it.each(PLATFORMS)('%s: without the callback the menu is unchanged (no item)', (platform) => {
    const template = buildAppMenuTemplate({ platform, isDev: false });
    expect(JSON.stringify(template)).not.toContain('Quit and Stop Sessions');
    if (platform === 'darwin') expect(template[0]).toEqual({ role: 'appMenu' });
  });

  it('takes the label it is given', () => {
    const items = quitMenu(buildAppMenuTemplate({ platform: 'darwin', isDev: false, onQuitAndStopSessions: vi.fn(), quitAndStopLabel: 'X' }), 'darwin');
    expect(items[items.findIndex((i) => i.role === 'quit') + 1].label).toBe('X');
  });

  it('installs in English at once, then re-installs in the UI language', async () => {
    installApplicationMenu({ onShutdownAll: vi.fn(), getDaemonClient: vi.fn(() => null), isQuitting: vi.fn(() => false), prepareStop: vi.fn() });
    const labelOf = (call: number): string | undefined =>
      quitMenu(buildFromTemplateMock.mock.calls[call][0] as Item[], process.platform)
        .find((i) => i.click && i.label !== 'Close Window')?.label;
    expect(labelOf(0)).toBe('Quit and Stop Sessions');
    await vi.waitFor(() => expect(buildFromTemplateMock).toHaveBeenCalledTimes(2));
    expect(labelOf(1)).toBe('종료하고 세션 멈추기');
  });

  it('installApplicationMenu routes the click to quitAndStopSessions with the callbacks', () => {
    const callbacks = { onShutdownAll: vi.fn(), getDaemonClient: vi.fn(() => null), isQuitting: vi.fn(() => false), prepareStop: vi.fn() };
    installApplicationMenu(callbacks);
    const template = buildFromTemplateMock.mock.calls[0][0] as Item[];
    const item = quitMenu(template, process.platform).find((i) => i.label === 'Quit and Stop Sessions');
    (item?.click as () => void)();
    expect(quitAndStopSessionsMock).toHaveBeenCalledWith(callbacks);
  });
});
