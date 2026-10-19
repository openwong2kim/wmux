// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';
import { setLocale, t } from '../../i18n';
import { en } from '../../i18n/locales/en';
import { ko } from '../../i18n/locales/ko';
import { pl } from '../../i18n/locales/pl';
import { zh } from '../../i18n/locales/zh';
import { buildDefaultCustomKeybindings } from '../../../shared/types';
import {
  builtinKeyConflict,
  customKeyConflict,
  needsModifierKey,
  rebindProblemText,
} from '../shortcutRebind';

function onPlatform(platform: NodeJS.Platform): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform };
  useStore.setState({
    customKeybindings: buildDefaultCustomKeybindings(platform).map((kb) => ({ ...kb })),
    shortcutOverrides: {},
  });
}

beforeEach(() => {
  setLocale('en');
  onPlatform('win32');
});

// #1885 item 2 — the hint named ⌘ on Windows and Linux, which have no ⌘ key.
describe('needs-a-modifier hint', () => {
  it('names Ctrl and Alt on Windows and Linux, ⌘ and ⌥ on macOS', () => {
    expect(needsModifierKey('win32')).toBe('settings.sc.needsModifier');
    expect(needsModifierKey('linux')).toBe('settings.sc.needsModifier');
    expect(needsModifierKey('darwin')).toBe('settings.sc.needsModifierMac');
  });

  it.each([['en', en], ['ko', ko], ['pl', pl], ['zh', zh]] as const)(
    '%s: no Mac key names off the Mac, and the Mac string names them',
    (_name, locale) => {
      const other = locale['settings.sc.needsModifier'];
      const mac = locale['settings.sc.needsModifierMac'];
      expect(other).toContain('Ctrl');
      expect(other).toContain('Alt');
      expect(other).not.toMatch(/[⌘⌥]/);
      expect(mac).toContain('Ctrl');
      expect(mac).toContain('⌘');
      expect(mac).toContain('⌥');
      // Shift alone is not enough (invalidShortcutCombo), so it is never offered.
      expect(other).not.toContain('Shift');
      expect(mac).not.toContain('Shift');
    },
  );

  it('rebindProblemText shows the hint for the platform it runs on', () => {
    expect(rebindProblemText('toggleSidebar', 'A')).toBe('Hold Ctrl or Alt (or use an F-key)');
    onPlatform('linux');
    expect(rebindProblemText('toggleSidebar', 'A')).toBe('Hold Ctrl or Alt (or use an F-key)');
    onPlatform('darwin');
    expect(rebindProblemText('toggleSidebar', 'A')).toBe('Hold Ctrl, ⌘ or ⌥ (or use an F-key)');
  });
});

// #1885 item 1 — warn, then allow.
describe('key conflicts with custom keybindings', () => {
  it('a built-in recorded on F7 names the default custom keybinding it would silence', () => {
    // Not a refusal: the recorder still accepts the key.
    expect(rebindProblemText('toggleSidebar', 'F7')).toBeNull();
    const conflict = customKeyConflict('toggleSidebar', 'F7');
    expect(conflict).toEqual({ kind: 'shadowsCustom', combo: 'F7', name: 'Claude (skip permissions)' });
    expect(t('settings.sc.keyInUseTitle', { combo: conflict?.combo ?? '', name: conflict?.name ?? '' })).toBe('F7 is already used by “Claude (skip permissions)”');
  });

  it('no warning on a different key, or on the key the action already has', () => {
    expect(customKeyConflict('toggleSidebar', 'F8')).toBeNull();
    expect(customKeyConflict('toggleSidebar', 'Ctrl+F7')).toBeNull();
    useStore.setState({ shortcutOverrides: { toggleSidebar: 'F7' } });
    expect(customKeyConflict('toggleSidebar', 'F7')).toBeNull();
  });

  it('macOS: the custom Ctrl+7 conflicts with Ctrl+7, never with ⌘7', () => {
    onPlatform('darwin');
    expect(customKeyConflict('toggleSidebar', 'Ctrl+7')?.name).toBe('Claude (skip permissions)');
    expect(customKeyConflict('toggleSidebar', 'Meta+7')).toBeNull();
  });

  it('an unnamed custom keybinding is named by its command', () => {
    useStore.setState({ customKeybindings: [{ id: 'kb-1', key: 'F9', label: ' ', command: 'npm test', sendEnter: true }] });
    expect(customKeyConflict('toggleSidebar', 'F9')?.name).toBe('npm test');
  });

  it('a custom keybinding recorded on a built-in key names the built-in that wins', () => {
    const conflict = builtinKeyConflict('Ctrl+T');
    expect(conflict?.kind).toBe('builtinWins');
    expect(conflict?.combo).toBe('Ctrl+T');
    expect(conflict?.name).toBeTruthy();
    expect(builtinKeyConflict('Ctrl+B')?.name).toBe(t('settings.prefixMode'));
    expect(builtinKeyConflict('F7')).toBeNull();
    expect(builtinKeyConflict('Ctrl+Alt+Q')).toBeNull();
    // Once the built-in moves off the key, the custom keybinding is free to take it.
    useStore.setState({ shortcutOverrides: { newSurface: 'Ctrl+Alt+N' } });
    expect(builtinKeyConflict('Ctrl+T')).toBeNull();
  });
});
