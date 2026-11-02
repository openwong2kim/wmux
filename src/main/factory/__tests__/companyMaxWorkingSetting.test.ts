// The per-PC cap on working company seats: a factory setting main reads, with
// a row of its own in Settings.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FACTORY_SETTINGS, getFactorySettings, mergeFactorySettings } from '../factorySettings';
import { COMPANY_MAX_WORKING_MAX, COMPANY_MAX_WORKING_MIN, DEFAULT_COMPANY_MAX_WORKING } from '../../../shared/factorySettings';
import { SETTINGS_CATALOG } from '../../../renderer/settings/catalog';
import { en } from '../../../renderer/i18n/locales/en';

const base = () => mergeFactorySettings({ ...DEFAULT_FACTORY_SETTINGS, trustedAuthors: [], morning: { hour: 9, weekdays: [1] }, defaultEngine: { kind: 'claude-sdk' } }, {});

describe('companyMaxWorking', () => {
  it('is 3 by default, also before the factory store is up', () => {
    expect(DEFAULT_COMPANY_MAX_WORKING).toBe(3);
    expect(base().companyMaxWorking).toBe(3);
    expect(getFactorySettings().companyMaxWorking).toBe(3);
  });

  it('keeps a whole number from 1 to 8 and drops anything else', () => {
    expect([COMPANY_MAX_WORKING_MIN, COMPANY_MAX_WORKING_MAX]).toEqual([1, 8]);
    for (const n of [1, 5, 8]) expect(mergeFactorySettings(base(), { companyMaxWorking: n }).companyMaxWorking).toBe(n);
    const five = mergeFactorySettings(base(), { companyMaxWorking: 5 });
    for (const bad of [0, 9, 2.5, '4', null, -1]) {
      expect(mergeFactorySettings(five, { companyMaxWorking: bad }).companyMaxWorking).toBe(5);
    }
    expect(mergeFactorySettings(five, {}).companyMaxWorking).toBe(5);
  });

  it('changes no other setting', () => {
    const before = base();
    const after = mergeFactorySettings(before, { companyMaxWorking: 6 });
    expect({ ...after, companyMaxWorking: before.companyMaxWorking }).toEqual(before);
  });

  it('has a searchable row on the factory tab', () => {
    const row = SETTINGS_CATALOG.find((e) => e.id === 'companymaxworking');
    expect(row).toMatchObject({ tab: 'factory', labelKey: 'settings.factory.companyMaxWorking', descKey: 'settings.factory.companyMaxWorkingDesc' });
    expect(en['settings.factory.companyMaxWorking']).toBe('Working seats per PC');
  });
});
