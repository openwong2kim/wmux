import { describe, it, expect } from 'vitest';
import { buildDefaultCustomKeybindings, DEFAULT_CUSTOM_KEYBINDINGS } from '../types';

describe('buildDefaultCustomKeybindings', () => {
  it('seeds Ctrl+F7 on macOS (bare F7 is swallowed by media keys)', () => {
    const kbs = buildDefaultCustomKeybindings('darwin');
    expect(kbs).toHaveLength(1);
    expect(kbs[0].id).toBe('kb-default-f7');
    expect(kbs[0].key).toBe('Ctrl+F7');
    expect(kbs[0].command).toBe('claude --dangerously-skip-permissions');
  });

  it('keeps bare F7 on Windows/Linux', () => {
    for (const platform of ['win32', 'linux', undefined]) {
      const kbs = buildDefaultCustomKeybindings(platform);
      expect(kbs[0].key).toBe('F7');
      // id는 플랫폼과 무관하게 동일해야 백필 매칭이 유지된다.
      expect(kbs[0].id).toBe('kb-default-f7');
    }
  });

  it('exposes a platform-agnostic F7 fallback constant', () => {
    expect(DEFAULT_CUSTOM_KEYBINDINGS[0].key).toBe('F7');
  });
});
