import { describe, it, expect } from 'vitest';
import {
  buildDefaultCustomKeybindings,
  DEFAULT_CUSTOM_KEYBINDINGS,
  upgradeDefaultKeybindingsForPlatform,
  type CustomKeybinding,
} from '../types';

/** One set of original (F7) shipped defaults. */
const pristineF7 = (): CustomKeybinding => ({ ...buildDefaultCustomKeybindings(undefined)[0] });

describe('buildDefaultCustomKeybindings', () => {
  it('seeds Ctrl+7 on macOS (bare F7 = media keys, Ctrl+F7 = OS ^F7 shortcut)', () => {
    const kbs = buildDefaultCustomKeybindings('darwin');
    expect(kbs).toHaveLength(1);
    expect(kbs[0].id).toBe('kb-default-f7');
    expect(kbs[0].key).toBe('Ctrl+7');
    expect(kbs[0].command).toBe('claude --dangerously-skip-permissions');
  });

  it('keeps bare F7 on Windows/Linux', () => {
    for (const platform of ['win32', 'linux', undefined]) {
      const kbs = buildDefaultCustomKeybindings(platform);
      expect(kbs[0].key).toBe('F7');
      // id must stay platform-agnostic for backfill matching
      expect(kbs[0].id).toBe('kb-default-f7');
    }
  });

  it('exposes a platform-agnostic F7 fallback constant', () => {
    expect(DEFAULT_CUSTOM_KEYBINDINGS[0].key).toBe('F7');
  });
});

describe('upgradeDefaultKeybindingsForPlatform', () => {
  it('upgrades an untouched shipped F7 default to Ctrl+7 on macOS', () => {
    const out = upgradeDefaultKeybindingsForPlatform([pristineF7()], 'darwin');
    expect(out[0].key).toBe('Ctrl+7');
    // Preserve remaining fields.
    expect(out[0].id).toBe('kb-default-f7');
    expect(out[0].command).toBe('claude --dangerously-skip-permissions');
  });

  it('upgrades the v3.26 Ctrl+F7 default to Ctrl+7 on macOS (OS ^F7 conflict)', () => {
    const v326: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+F7' };
    const out = upgradeDefaultKeybindingsForPlatform([v326], 'darwin');
    expect(out[0].key).toBe('Ctrl+7');
  });

  it('leaves a user-modified F7 binding alone (different command)', () => {
    const edited: CustomKeybinding = { ...pristineF7(), command: 'vim' };
    const out = upgradeDefaultKeybindingsForPlatform([edited], 'darwin');
    expect(out[0].key).toBe('F7'); // no promotion — user intentionally remapped F7
  });

  it('leaves a user-chosen non-legacy key alone on macOS', () => {
    const custom: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+Shift+1' };
    const out = upgradeDefaultKeybindingsForPlatform([custom], 'darwin');
    expect(out[0].key).toBe('Ctrl+Shift+1');
  });

  it('is a no-op for the shipped F7 on Windows/Linux', () => {
    for (const platform of ['win32', 'linux', undefined]) {
      const out = upgradeDefaultKeybindingsForPlatform([pristineF7()], platform);
      expect(out[0].key).toBe('F7');
    }
  });

  it('leaves a Ctrl+F7 binding alone on Windows/Linux (never shipped there = user edit)', () => {
    // win/linux never shipped Ctrl+F7 as default, so that key is effectively always user-edited.
    // "Normalization" must not revert edits — that would be a regression.
    const edited: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+F7' };
    const out = upgradeDefaultKeybindingsForPlatform([edited], 'win32');
    expect(out[0].key).toBe('Ctrl+F7');
  });

  it('undefined platform is a strict no-op (preload race must not down-promote to F7)', () => {
    const v326: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+F7' };
    const out = upgradeDefaultKeybindingsForPlatform([v326], undefined);
    expect(out[0].key).toBe('Ctrl+F7');
  });

  it('skips promotion when another binding already uses the destination key', () => {
    // Prevent default binding from shadowing user binding in first-match key resolution.
    const userOnCtrl7: CustomKeybinding = {
      ...pristineF7(), id: 'kb-user-1', key: 'Ctrl+7', command: 'vim', label: 'vim',
    };
    const legacy: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+F7' };
    const out = upgradeDefaultKeybindingsForPlatform([legacy, userOnCtrl7], 'darwin');
    expect(out[0].key).toBe('Ctrl+F7'); // promotion deferred — keeping dead key is safer
    expect(out[1].key).toBe('Ctrl+7');
    expect(out[1].command).toBe('vim');
  });

  it('is idempotent — an already-upgraded Ctrl+7 stays put on macOS', () => {
    const upgraded: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+7' };
    const out = upgradeDefaultKeybindingsForPlatform([upgraded], 'darwin');
    expect(out[0].key).toBe('Ctrl+7');
  });
});
