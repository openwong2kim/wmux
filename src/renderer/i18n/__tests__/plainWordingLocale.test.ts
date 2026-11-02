// @wmux-lane unit
// 'win32' is only an argument to the pure formatter; nothing here reads the OS.
import { describe, it, expect } from 'vitest';
import { en } from '../locales/en';
import { LOCALE_LOADERS, type LocaleTable } from '../localeLoaders';
import { t } from '../index';
import { displayCombo } from '../../../shared/keymap';

/**
 * One shortcut notation and one vocabulary. A key a hint names comes from the
 * live binding through displayCombo (⌘I on macOS, Ctrl+I elsewhere), so no
 * locale may bake a key into these strings: a baked key is wrong on macOS and
 * wrong again once the user rebinds it. And the internal names the UI used to
 * show (Surface, A2A, HQ, hook bridge, raw ids) stay out of these strings.
 */
const KEY_SLOT = ['notification.toggle'] as const;
const KEYLESS = [
  'sidebar.newWorkspaceTooltip', 'sidebar.hideTooltip', 'sidebar.expandTooltip',
  'search.prevTooltip', 'search.nextTooltip', 'search.closeTooltip',
] as const;
const BAKED_KEY = /Ctrl|Strg|ESC|ÉCHAP|Shift\+|Enter\)|⌘/;
const JARGON: Record<string, RegExp> = {
  'palette.catSurface': /Surface/,
  'palette.cmd.newSurface': /Surface/,
  'remotePage.a2aOff': /A2A/,
  'remotePage.a2aListening': /A2A/,
  'settings.a2aRemote': /A2A/,
  'settings.a2aAutoApproveExecuteDesc': /A2A|bypassPermissions|YOLO/,
  'settings.factory.phoneBotAuto': /HQ/,
  'settings.factory.laneAutoMerge': /lane/i,
  'integrationSetup.hooks.title': /bridge/i,
  'integrationSetup.hooks.updateNote': /\{hooks\}/,
  'claudeIntegration.signalHealth.unknownBody': /not yet observed/,
  'settings.soundDesc': /Web Audio/,
  'sessionSchedule.otherSession': /\{ptyId\}/,
  'sessionSchedule.daemonRequired': /daemon mode/,
  'settings.factory.connections.nameHint': /mcp__/,
};

async function allLocales(): Promise<[string, LocaleTable][]> {
  const rest = await Promise.all(Object.entries(LOCALE_LOADERS).map(async ([name, load]) => [name, await load()] as [string, LocaleTable]));
  return [['en', en as LocaleTable], ...rest];
}

describe('plain wording and one shortcut notation', () => {
  it('the hint reads the key in the platform notation', () => {
    expect(t('notification.toggle', { key: displayCombo('Meta+I', 'darwin') })).toBe('⌘I to toggle');
    expect(t('notification.toggle', { key: displayCombo('Ctrl+I', 'win32') })).toBe('Ctrl+I to toggle');
  });

  it('the notification hint takes its key as {key} in every locale', async () => {
    for (const [name, table] of await allLocales()) {
      for (const k of KEY_SLOT) {
        const v = (table as Record<string, string | undefined>)[k];
        if (v === undefined) continue;
        expect(v, `${name} ${k}`).toContain('{key}');
        expect(v, `${name} ${k}`).not.toMatch(BAKED_KEY);
      }
    }
  });

  it('tooltips that get their key from the binding carry none themselves', async () => {
    for (const [name, table] of await allLocales()) {
      for (const k of KEYLESS) {
        const v = (table as Record<string, string | undefined>)[k];
        if (v === undefined) continue;
        expect(v, `${name} ${k}`).not.toMatch(BAKED_KEY);
        expect(v, `${name} ${k}`).not.toMatch(/[()（）]/);
      }
    }
  });

  it('keeps internal names out of the strings that showed them', async () => {
    for (const [name, table] of await allLocales()) {
      for (const [k, bad] of Object.entries(JARGON)) {
        const v = (table as Record<string, string | undefined>)[k];
        if (v === undefined) continue;
        expect(v, `${name} ${k}`).not.toMatch(bad);
      }
    }
  });

  it('the auto-approve setting states its whole scope, local agents included', async () => {
    const workspaceWord: Record<string, string> = { en: 'this workspace', ko: '이 워크스페이스', pl: 'z tego obszaru roboczego', zh: '此工作区' };
    const tables = Object.fromEntries(await allLocales());
    for (const [name, word] of Object.entries(workspaceWord)) {
      const v = (tables[name] as Record<string, string | undefined>)['settings.a2aAutoApproveExecuteDesc'];
      expect(v, name).toContain(word);
    }
  });

  it('every singular key a plural has is in each locale that has the plural', async () => {
    const pairs = Object.keys(en).filter((k) => k.endsWith('One') && k.slice(0, -3) in en)
      .filter((k) => /^(strip|pcRail|pcSwitcher|workspace\.closeConfirm|git\.(mergeSummary|ship|allRepos)|prepCard)/.test(k));
    expect(pairs.length).toBeGreaterThanOrEqual(12);
    for (const [name, table] of await allLocales()) {
      const map = table as Record<string, string | undefined>;
      for (const one of pairs) {
        if (map[one.slice(0, -3)] === undefined) continue;
        expect(map[one], `${name} missing ${one}`).toBeTruthy();
      }
    }
  });
});
