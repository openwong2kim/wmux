// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installWindowGlass } from '../windowGlass';

// Windows: the renderer gate follows the preload's build number, and the
// level reaches main so it can switch the acrylic material at runtime.

const setAppearance = vi.fn();
const setGlass = vi.fn();

// The colours the coverage reads (glassCoverage.ts), as plain hex: jsdom
// never resolves var(), so --frame-bg is given directly.
const TINT = {
  '--bg-base': '#1A171D', '--frame-bg': '#121015', '--bg-mantle': '#18151C',
  '--text-main': '#F4F2F7', '--text-sub': '#c2bdc9', '--text-muted': '#8A8492',
};
const TAEGEUK = {
  '--bg-base': '#FFFFFF', '--frame-bg': '#F1F1F3', '--bg-mantle': '#EEEEF2',
  '--text-main': '#1A1A2E', '--text-sub': '#3a3a50', '--text-muted': '#6A6A7A',
};
// Paper's opaque tokens: its opaque muted misses 3:1 over a black window at
// the 90% cap, so only its glass-only muted (WINDOWS_GLASS_MUTED) lets it
// show glass.
const PAPER = {
  '--bg-base': '#FFFFFF', '--frame-bg': '#ECECEF', '--bg-mantle': '#F3F3F5',
  '--text-main': '#17171C', '--text-sub': '#3F3F48', '--text-muted': '#848491',
};
// Mid-grey tertiary text no coverage keeps at 3:1 over a white window.
const MURKY = {
  '--bg-base': '#171717', '--frame-bg': '#101010', '--bg-mantle': '#101010',
  '--text-main': '#FFFFFF', '--text-sub': '#c2bdc9', '--text-muted': '#444444',
};

// Stopped after each test as well, so a failed assertion cannot leave an
// observer behind to fight the next test's over the inline coverage.
const installed: Array<() => void> = [];

function paint(tokens: Record<string, string>): void {
  for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
}

const heardLevels: string[] = [];

function mount(level: string, tokens: Record<string, string>, windowsBuildNumber: number | null, systemDark: boolean): () => void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    windowsBuildNumber,
    window: { setAppearance, setGlass },
  };
  window.matchMedia = ((query: string) => ({
    matches: systemDark, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  const root = document.documentElement;
  paint(tokens);
  root.setAttribute('data-glass-level', level);
  const stop = installWindowGlass(root, undefined, (sent) => heardLevels.push(sent));
  installed.push(stop);
  return stop;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  installed.splice(0).forEach((stop) => stop());
  heardLevels.length = 0;
  setAppearance.mockReset();
  setGlass.mockReset();
  const root = document.documentElement;
  root.removeAttribute('data-glass');
  root.removeAttribute('data-glass-level');
  root.removeAttribute('data-theme');
  root.removeAttribute('style');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('installWindowGlass on Windows 11 22H2+', () => {
  it('sets the appearance, marks glass and sends the level with the solid overlay pair', () => {
    const stop = mount('soft', TINT, 26200, true);
    expect(setAppearance).toHaveBeenCalledWith('dark');
    expect(document.documentElement.getAttribute('data-glass')).toBe('dark');
    expect(setGlass).toHaveBeenCalledTimes(1);
    expect(setGlass).toHaveBeenCalledWith({ level: 'soft', color: '#1a171d', symbolColor: '#c2bdc9' });
    stop();
  });

  it('sends Off at runtime and hands the appearance back to the system', async () => {
    const stop = mount('clear', TAEGEUK, 26200, false);
    expect(document.documentElement.getAttribute('data-glass')).toBe('light');
    document.documentElement.setAttribute('data-glass-level', 'off');
    await flush();
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    expect(setGlass).toHaveBeenLastCalledWith({ level: 'off', color: '#ffffff', symbolColor: '#3a3a50' });
    expect(setAppearance).toHaveBeenLastCalledWith('system');
    stop();
  });

  it('sends a level once, not on every theme change', async () => {
    const stop = mount('soft', TINT, 26200, true);
    document.documentElement.style.setProperty('--bg-base', '#171717');
    await flush();
    expect(setGlass).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('installWindowGlass on Windows without glass', () => {
  it.each([19045, 22000, null])('build %s: no glass, no appearance override, nothing sent', (build) => {
    const stop = mount('soft', TINT, build, true);
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    expect(setAppearance).not.toHaveBeenCalled();
    expect(setGlass).not.toHaveBeenCalled();
    stop();
  });
});

describe('installWindowGlass theme polarity for the session save', () => {
  it('reports the theme polarity, with glass off too, and follows a theme change', async () => {
    const heard: string[] = [];
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      platform: 'win32', windowsBuildNumber: 26200, window: { setAppearance, setGlass },
    };
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const root = document.documentElement;
    root.style.setProperty('--bg-base', '#1A171D');
    root.setAttribute('data-glass-level', 'off');
    const stop = installWindowGlass(root, (appearance) => heard.push(appearance));
    expect(heard.at(-1)).toBe('dark');
    root.style.setProperty('--bg-base', '#FFFFFF');
    await flush();
    expect(heard.at(-1)).toBe('light');
    stop();
  });
});

describe('installWindowGlass coverage on Windows', () => {
  const inline = (name: string) => document.documentElement.style.getPropertyValue(name);

  it('sets the coverage derived from the look inline with data-glass', () => {
    const stop = mount('soft', TINT, 26200, true);
    expect(document.documentElement.getAttribute('data-glass')).toBe('dark');
    expect(inline('--glass-frame')).toBe('82%');
    expect(inline('--glass-sheet')).toBe('6%');
    stop();
  });

  it('judges a look by its glass-only muted text, so Paper shows glass', () => {
    document.documentElement.setAttribute('data-theme', 'paper');
    const stop = mount('soft', PAPER, 26200, false);
    expect(document.documentElement.getAttribute('data-glass')).toBe('light');
    expect(inline('--glass-frame')).toBe('90%');
    expect(setGlass).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'soft' }));
    stop();
  });

  it('keeps the same tokens opaque for a look with no glass-only muted', () => {
    const stop = mount('soft', PAPER, 26200, false);
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    expect(setGlass).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'off' }));
    stop();
  });

  it('keeps a look that cannot stay legible opaque, and tells main the window is Off', () => {
    const stop = mount('soft', MURKY, 26200, true);
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    expect(inline('--glass-frame')).toBe('');
    expect(setGlass).toHaveBeenCalledTimes(1);
    expect(setGlass).toHaveBeenCalledWith(expect.objectContaining({ level: 'off' }));
    expect(setAppearance).toHaveBeenLastCalledWith('system');
    stop();
  });

  it('goes opaque when the theme changes to one that cannot stay legible, and back', async () => {
    const stop = mount('soft', TINT, 26200, true);
    expect(setGlass).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'soft' }));
    paint(MURKY);
    await flush();
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    expect(inline('--glass-frame')).toBe('');
    expect(inline('--glass-sheet')).toBe('');
    expect(setGlass).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'off' }));
    paint(TINT);
    await flush();
    expect(document.documentElement.getAttribute('data-glass')).toBe('dark');
    expect(inline('--glass-frame')).toBe('82%');
    expect(setGlass).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'soft' }));
    stop();
  });

  it('reports each level sent to main for the session save, Off while the look blocks glass', async () => {
    const stop = mount('soft', MURKY, 26200, true);
    expect(heardLevels).toEqual(['off']);
    paint(TINT);
    await flush();
    expect(heardLevels).toEqual(['off', 'soft']);
    stop();
  });

  it('does not write the coverage again when it has not changed (the observer watches style)', async () => {
    const stop = mount('soft', TINT, 26200, true);
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty');
    document.documentElement.setAttribute('data-glass-level', 'soft');
    await flush();
    expect(setProperty.mock.calls.filter(([name]) => String(name).startsWith('--glass-'))).toEqual([]);
    setProperty.mockRestore();
    stop();
  });
});
