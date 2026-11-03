import { describe, expect, it } from 'vitest';
import type { ShortcutBinding } from '../../../shared/keymap';
import { parseBridgeKey, pluginPageKeyRoute } from '../pluginPageKey';

const BINDINGS = [
  { action: 'plugin:commander', combo: 'Ctrl+Alt+F' },
  { action: 'closeSurface', combo: 'Ctrl+W' },
] as unknown as ShortcutBinding[];

const keyOf = (over: Record<string, unknown> = {}) => { const k = parseBridgeKey(msg(over)); if (!k) throw new Error('rejected'); return k; };
const msg = (over: Record<string, unknown> = {}) => ({
  v: 1, kind: 'key', key: 'f', code: 'KeyF', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false, repeat: false, ...over,
});

describe('parseBridgeKey', () => {
  it('accepts a well-formed key message', () => {
    expect(parseBridgeKey(msg())).toMatchObject({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true, repeat: false });
  });

  it('refuses other kinds, versions and malformed fields', () => {
    expect(parseBridgeKey(msg({ kind: 'request' }))).toBeNull();
    expect(parseBridgeKey(msg({ v: 2 }))).toBeNull();
    expect(parseBridgeKey(msg({ key: '' }))).toBeNull();
    expect(parseBridgeKey(msg({ key: 'x'.repeat(40) }))).toBeNull();
    expect(parseBridgeKey(msg({ code: 7 }))).toBeNull();
    expect(parseBridgeKey(null)).toBeNull();
  });

  it('reads only literal true as a pressed modifier', () => {
    expect(parseBridgeKey(msg({ ctrlKey: 'yes' }))?.ctrlKey).toBe(false);
  });
});

describe('pluginPageKeyRoute', () => {
  it("closes the page with its own shortcut, back to Workspaces", () => {
    const key = keyOf();
    expect(pluginPageKeyRoute(key, BINDINGS, 'plugin:commander')).toBe('workspaces');
  });

  it('opens the page from another route', () => {
    const key = keyOf();
    expect(pluginPageKeyRoute(key, BINDINGS, 'fleet')).toBe('plugin:commander');
  });

  it('ignores any shortcut that is not a plugin page', () => {
    const key = keyOf({ key: 'w', code: 'KeyW', altKey: false });
    expect(pluginPageKeyRoute(key, BINDINGS, 'plugin:commander')).toBeNull();
  });

  it('ignores auto-repeat', () => {
    const key = keyOf({ repeat: true });
    expect(pluginPageKeyRoute(key, BINDINGS, 'plugin:commander')).toBeNull();
  });
});
