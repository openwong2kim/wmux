// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installWindowGlass } from '../windowGlass';

const setAppearance = vi.fn();

function mount(level: string, bgBase: string): () => void {
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'darwin', window: { setAppearance } };
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  const root = document.documentElement;
  root.style.setProperty('--bg-base', bgBase);
  root.setAttribute('data-glass-level', level);
  return installWindowGlass(root);
}

afterEach(() => {
  setAppearance.mockReset();
  document.documentElement.removeAttribute('data-glass');
});

describe('installWindowGlass', () => {
  it('marks glass with the material appearance once the theme matches it', () => {
    const stop = mount('soft', '#FFFFFF');
    expect(setAppearance).toHaveBeenCalledWith('light');
    expect(document.documentElement.getAttribute('data-glass')).toBe('light');
    stop();
  });

  it('hands the appearance back to the system when glass is off', () => {
    const stop = mount('off', '#FFFFFF');
    expect(setAppearance).toHaveBeenCalledWith('system');
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    stop();
  });
});
