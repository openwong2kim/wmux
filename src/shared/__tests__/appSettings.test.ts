// The settings `wmux settings` may change: each key's parse, and the human-only
// list that stays out of reach of agents and the command line.
import { describe, expect, it } from 'vitest';
import {
  APP_SETTINGS,
  APP_SETTING_KEYS,
  HUMAN_ONLY_SETTINGS,
  appSettingKeyRefusal,
  humanOnlySettingSection,
  parseAppSetting,
  type AppSettingKey,
  type AppSettingSpec,
} from '../appSettings';
import { checkAppActionArgs, findAppAction } from '../appActions';

/** One value each key takes, one it does not, and one of the wrong type. */
function samples(key: AppSettingKey): { good: string; goodValue: unknown; outside: string; wrongType: string } {
  const spec: AppSettingSpec = APP_SETTINGS[key];
  switch (spec.kind) {
    case 'bool': return { good: ' ON ', goodValue: true, outside: 'maybe', wrongType: '2' };
    case 'enum': return { good: ` ${spec.values[0].toUpperCase()} `, goodValue: spec.values[0], outside: 'nope', wrongType: '7' };
    case 'intChoice': return { good: String(spec.values[0]), goodValue: spec.values[0], outside: String(spec.values[0] + 1), wrongType: 'soon' };
    case 'int': return { good: String(spec.max), goodValue: spec.max, outside: String(spec.max + 1), wrongType: `${spec.min}.5` };
    case 'number': return { good: String(spec.min + spec.step), goodValue: Number((spec.min + spec.step).toFixed(2)), outside: String(spec.max + spec.step), wrongType: 'big' };
    case 'theme':
    case 'locale':
    case 'font': return { good: ' x ', goodValue: 'x', outside: '', wrongType: '   ' };
  }
}

describe('parseAppSetting', () => {
  it.each(APP_SETTING_KEYS)('%s: a good value, one out of range, one of the wrong type', (key) => {
    const s = samples(key);
    expect(parseAppSetting(key, s.good)).toEqual({ ok: true, value: s.goodValue });
    expect(parseAppSetting(key, s.outside).ok).toBe(false);
    expect(parseAppSetting(key, s.wrongType).ok).toBe(false);
  });

  it('reads on/off words in any case, and a real boolean', () => {
    for (const w of ['true', 'On', '1', 'YES']) expect(parseAppSetting('titlebar.clock', w)).toEqual({ ok: true, value: true });
    for (const w of ['false', 'OFF', '0', 'no']) expect(parseAppSetting('titlebar.clock', w)).toEqual({ ok: true, value: false });
    expect(parseAppSetting('titlebar.clock', false)).toEqual({ ok: true, value: false });
  });

  it('stores a stepped number as its step, so the same value reads as unchanged', () => {
    expect(parseAppSetting('ui.scale', '1.15')).toEqual({ ok: true, value: 1.15 });
    expect(parseAppSetting('ui.scale', '1.1500000001')).toEqual({ ok: true, value: 1.15 });
    expect(parseAppSetting('ui.scale', '1.13').ok).toBe(false);
    expect(parseAppSetting('notifications.glowOpacity', '1')).toEqual({ ok: true, value: 1 });
  });

  it('takes the reminder interval as one of its choices, from text', () => {
    expect(parseAppSetting('attention.remindMs', '60000')).toEqual({ ok: true, value: 60000 });
    expect(parseAppSetting('attention.remindMs', 45000).ok).toBe(false);
  });
});

describe('human-only settings', () => {
  const concrete = (id: string) => (id.endsWith('.') ? `${id}anything` : id);

  it('names the Settings section for every human-only id, through settings.set and settings.get', () => {
    const set = findAppAction('settings.set')!;
    const get = findAppAction('settings.get')!;
    for (const { id, section } of HUMAN_ONLY_SETTINGS) {
      const key = concrete(id);
      expect(humanOnlySettingSection(key)).toBe(section);
      for (const spec of [set, get]) {
        const res = checkAppActionArgs(spec, spec.id === 'settings.get' ? { key } : { key, value: 'x' });
        expect(res.ok).toBe(false);
        expect((res as { error: string }).error).toContain(`Settings › ${section}`);
      }
    }
  });

  it('covers what a paired phone or another computer may reach', () => {
    for (const key of ['remote.shareGrant', 'remote.inputGrant', 'phone.upload', 'phone.transcript', 'tailscale', 'lanlink.enabled', 'a2a.listener']) {
      expect(humanOnlySettingSection(key)).toMatch(/Remote & phone|LAN/);
    }
  });

  it('keeps the table and the human-only list apart', () => {
    for (const key of APP_SETTING_KEYS) expect(humanOnlySettingSection(key)).toBeUndefined();
  });

  it('points an unknown key at the list', () => {
    expect(appSettingKeyRefusal('terminal.nope')).toMatch(/wmux settings list/);
    expect(appSettingKeyRefusal('theme')).toBeUndefined();
  });
});
