import { describe, expect, it } from 'vitest';
import {
  acceleratorFromKeyEvent,
  formatAccelerator,
  isGlobalAccelerator,
  normalizeQuickLaunchRequest,
  quickLaunchTitle,
} from '../quickLaunch';

const key = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('acceleratorFromKeyEvent', () => {
  it('records the platform primary modifier as CommandOrControl', () => {
    expect(acceleratorFromKeyEvent(key('Space', { metaKey: true, shiftKey: true }), true)).toBe('CommandOrControl+Shift+Space');
    expect(acceleratorFromKeyEvent(key('Space', { ctrlKey: true, shiftKey: true }), false)).toBe('CommandOrControl+Shift+Space');
  });

  it('keeps the other modifier distinct', () => {
    expect(acceleratorFromKeyEvent(key('KeyK', { ctrlKey: true }), true)).toBe('Control+K');
    expect(acceleratorFromKeyEvent(key('Digit3', { ctrlKey: true, altKey: true }), false)).toBe('CommandOrControl+Alt+3');
  });

  it('waits while only modifiers are down and refuses chords without Command or Control', () => {
    expect(acceleratorFromKeyEvent(key('ShiftLeft', { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(acceleratorFromKeyEvent(key('KeyA', { shiftKey: true }), true)).toBeNull();
    expect(acceleratorFromKeyEvent(key('KeyA', { altKey: true }), false)).toBeNull();
  });
});

describe('isGlobalAccelerator', () => {
  it('accepts the default and rejects malformed or modifier-less chords', () => {
    expect(isGlobalAccelerator('CommandOrControl+Shift+Space')).toBe(true);
    expect(isGlobalAccelerator('Shift+Space')).toBe(false);
    expect(isGlobalAccelerator('CommandOrControl+Shift')).toBe(false);
    expect(isGlobalAccelerator('CommandOrControl+CommandOrControl+A')).toBe(false);
    expect(isGlobalAccelerator('Hyper+A')).toBe(false);
    expect(isGlobalAccelerator(42)).toBe(false);
  });
});

describe('formatAccelerator', () => {
  it('spells the keys per platform', () => {
    expect(formatAccelerator('CommandOrControl+Shift+Space', true)).toBe('⌘+Shift+Space');
    expect(formatAccelerator('CommandOrControl+Shift+Space', false)).toBe('Ctrl+Shift+Space');
    expect(formatAccelerator('CommandOrControl+Alt+K', true)).toBe('⌘+⌥+K');
  });
});

describe('normalizeQuickLaunchRequest', () => {
  const ok = { prompt: ' fix the bug ', workspaceId: 'ws-1', agent: { kind: 'default' }, checkout: 'current' };

  it('trims and accepts a valid request', () => {
    expect(normalizeQuickLaunchRequest(ok)).toEqual({ ...ok, prompt: 'fix the bug' });
  });

  it('only accepts known roles and verified agents', () => {
    expect(normalizeQuickLaunchRequest({ ...ok, agent: { kind: 'role', role: 'Reviewer' } })).toMatchObject({ agent: { kind: 'role', role: 'Reviewer' } });
    expect(normalizeQuickLaunchRequest({ ...ok, agent: { kind: 'role', role: 'Admin' } })).toHaveProperty('error');
    expect(normalizeQuickLaunchRequest({ ...ok, agent: { kind: 'agent', agent: 'codex' } })).toMatchObject({ agent: { kind: 'agent', agent: 'codex' } });
    // Not verified end to end, so not launchable from here.
    expect(normalizeQuickLaunchRequest({ ...ok, agent: { kind: 'agent', agent: 'gemini' } })).toHaveProperty('error');
    expect(normalizeQuickLaunchRequest({ ...ok, agent: { kind: 'agent', agent: 'rm -rf' } })).toHaveProperty('error');
  });

  it('refuses an empty prompt, a missing workspace and an unknown checkout', () => {
    expect(normalizeQuickLaunchRequest({ ...ok, prompt: '   ' })).toHaveProperty('error');
    expect(normalizeQuickLaunchRequest({ ...ok, workspaceId: '' })).toHaveProperty('error');
    expect(normalizeQuickLaunchRequest({ ...ok, checkout: 'main' })).toHaveProperty('error');
    expect(normalizeQuickLaunchRequest({ ...ok, prompt: 'x'.repeat(9 * 1024) })).toHaveProperty('error');
  });
});

describe('quickLaunchTitle', () => {
  it('takes the first line, caps it, and adds a time suffix so repeats do not collide', () => {
    const at = new Date(2026, 9, 3, 9, 5, 7);
    expect(quickLaunchTitle('Fix login\nmore detail', at)).toBe('Fix login 090507');
    expect(quickLaunchTitle('a'.repeat(60), at)).toBe(`${'a'.repeat(40)} 090507`);
  });
});
