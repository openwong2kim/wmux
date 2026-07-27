// PR-9 / A9① — the keep-warm setting's plumbing.
//
// Source-level, deliberately: `buildSessionData` is an EXPLICIT allowlist inside
// AppLayout (not a spread), so a setting that is missing there is silently never
// persisted, and no store-level test can see that. The load side's behaviour is
// covered in workspaceSlice.loadSession.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (...rel: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', ...rel), 'utf-8');

const uiSrc = read('stores', 'slices', 'uiSlice.ts');
const appLayoutSrc = read('components', 'Layout', 'AppLayout.tsx');
const settingsSrc = read('components', 'Settings', 'SettingsPanel.tsx');
const enSrc = read('i18n', 'locales', 'en.ts');
const typesSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'shared', 'types.ts'), 'utf-8');

describe('chatKeepWarmLru setting', () => {
  it('defaults to OFF in the store', () => {
    expect(uiSrc).toMatch(/chatKeepWarmLru:\s*false,/);
  });

  it('has a setter', () => {
    expect(uiSrc).toMatch(/setChatKeepWarmLru:\s*\(enabled\) => set/);
  });

  it('is a SessionData key', () => {
    expect(typesSrc).toMatch(/chatKeepWarmLru\?:\s*boolean;/);
  });

  it('is on buildSessionData’s explicit allowlist (it cannot ride a spread)', () => {
    const idx = appLayoutSrc.indexOf('function buildSessionData');
    expect(idx).toBeGreaterThan(0);
    // Bounded to the builder body, so a mention elsewhere cannot satisfy this.
    const body = appLayoutSrc.slice(idx, idx + 6000);
    expect(body).toMatch(/chatKeepWarmLru:\s*state\.chatKeepWarmLru,/);
  });

  it('has a Settings control bound to the store setter', () => {
    expect(settingsSrc).toMatch(/const setChatKeepWarmLru = useStore\(\(s\) => s\.setChatKeepWarmLru\);/);
    const idx = settingsSrc.indexOf("t('settings.chatKeepWarm')");
    expect(idx).toBeGreaterThan(0);
    expect(settingsSrc.slice(idx, idx + 400)).toMatch(/onChange=\{setChatKeepWarmLru\}/);
  });

  it('has English label and description strings', () => {
    expect(enSrc).toMatch(/'settings\.chatKeepWarm':/);
    expect(enSrc).toMatch(/'settings\.chatKeepWarmDesc':/);
  });
});
