// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installWindowGlass } from '../windowGlass';
import { mixHex } from '../../tailwindPalette';

// macOS: the coverage is derived from the look's tokens, as on Windows
// (#3283), but the vibrancy material never switches at runtime.

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
// Mid-grey tertiary text no coverage keeps at 3:1 over a white window.
const MURKY = {
  '--bg-base': '#171717', '--frame-bg': '#101010', '--bg-mantle': '#101010',
  '--text-main': '#FFFFFF', '--text-sub': '#c2bdc9', '--text-muted': '#444444',
};

const installed: Array<() => void> = [];
const heardLevels: string[] = [];

function mount(level: string, tokens: Record<string, string>, systemDark: boolean, theme?: string): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'darwin', window: { setAppearance, setGlass } };
  window.matchMedia = ((query: string) => ({
    matches: systemDark, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  const root = document.documentElement;
  const all = {
    '--text-sub2': mixHex(tokens['--text-main'], tokens['--text-sub'], 0.5),
    '--text-subtle': mixHex(tokens['--text-sub'], tokens['--text-muted'], 0.5),
    ...tokens,
  };
  for (const [name, value] of Object.entries(all)) root.style.setProperty(name, value);
  if (theme) root.setAttribute('data-theme', theme);
  root.setAttribute('data-glass-level', level);
  installed.push(installWindowGlass(root, undefined, (sent) => heardLevels.push(sent)));
}

const inline = (name: string) => document.documentElement.style.getPropertyValue(name);

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

describe('installWindowGlass on macOS', () => {
  it('marks glass with the material appearance and sets the derived coverage inline', () => {
    mount('soft', TAEGEUK, false);
    expect(setAppearance).toHaveBeenCalledWith('light');
    expect(document.documentElement.getAttribute('data-glass')).toBe('light');
    // Raised from the macOS light floor (10% / 4%) to stay legible over black.
    expect(Number.parseInt(inline('--glass-frame'), 10)).toBeGreaterThan(10);
    expect(inline('--glass-sheet')).toBe('4%');
    expect(heardLevels).toEqual(['soft']);
    // macOS has no runtime material switch.
    expect(setGlass).not.toHaveBeenCalled();
  });

  it('keeps the dark Tint sidebar legible over a white window: the old 25% is raised', () => {
    mount('soft', TINT, true);
    expect(document.documentElement.getAttribute('data-glass')).toBe('dark');
    expect(Number.parseInt(inline('--glass-frame'), 10)).toBeGreaterThan(25);
    expect(inline('--glass-sheet')).toBe('6%');
  });

  it('keeps a strongly hued look at its old floor at least', () => {
    mount('soft', TINT, true, 'catppuccin-mocha');
    expect(Number.parseInt(inline('--glass-frame'), 10)).toBeGreaterThanOrEqual(55);
    expect(inline('--glass-sheet')).toBe('20%');
  });

  it('keeps a look no coverage makes legible opaque, and reports it as Off', () => {
    mount('soft', MURKY, true);
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    expect(inline('--glass-frame')).toBe('');
    expect(heardLevels).toEqual(['off']);
    // As with the user's Off, the appearance goes back to the system.
    expect(setAppearance).toHaveBeenLastCalledWith('system');
    expect(setGlass).not.toHaveBeenCalled();
  });

  it('hands the appearance back to the system when glass is off', () => {
    mount('off', TAEGEUK, false);
    expect(setAppearance).toHaveBeenCalledWith('system');
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    expect(heardLevels).toEqual(['off']);
  });
});
