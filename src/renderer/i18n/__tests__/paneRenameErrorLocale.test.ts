import { describe, expect, it } from 'vitest';
import { LOCALE_OPTIONS, type Locale } from '../index';
import { ar } from '../locales/ar';
import { bs } from '../locales/bs';
import { da } from '../locales/da';
import { de } from '../locales/de';
import { en } from '../locales/en';
import { es } from '../locales/es';
import { fr } from '../locales/fr';
import { hi } from '../locales/hi';
import { id } from '../locales/id';
import { it as italian } from '../locales/it';
import { ja } from '../locales/ja';
import { ko } from '../locales/ko';
import { ms } from '../locales/ms';
import { nb } from '../locales/nb';
import { pl } from '../locales/pl';
import { ptBR } from '../locales/pt-BR';
import { ru } from '../locales/ru';
import { th } from '../locales/th';
import { tr } from '../locales/tr';
import { uk } from '../locales/uk';
import { vi } from '../locales/vi';
import { zhTW } from '../locales/zh-TW';
import { zh } from '../locales/zh';
import { paneLabelRejectionKey } from '../../utils/paneNaming';

const KEYS = [
  'pane.renameError.whitespace',
  'pane.renameError.reservedChar',
  'pane.renameError.leadingDigit',
  'pane.renameError.autoName',
  'pane.renameError.duplicate',
  'pane.renameError.failed',
] as const;

type Key = (typeof KEYS)[number];

const LOCALE_TRANSLATIONS = {
  en, ko, ja, zh, 'zh-TW': zhTW, ar, bs, da, de, es, fr, hi, id, it: italian, ms, nb, pl, 'pt-BR': ptBR, ru, th, tr, uk, vi,
} satisfies Record<Locale, Partial<Record<Key, string>>>;

describe('pane rename refusal locale contract', () => {
  it('every locale names every refusal reason', () => {
    for (const option of LOCALE_OPTIONS) {
      const table = LOCALE_TRANSLATIONS[option.value] as Partial<Record<Key, string>>;
      for (const key of KEYS) expect(table[key], `${option.value} ${key}`).toBeTruthy();
    }
  });

  it('maps each MetadataStore rejection code to its key, unknown codes to the generic one', () => {
    expect(paneLabelRejectionKey('duplicate')).toBe('pane.renameError.duplicate');
    expect(paneLabelRejectionKey('auto-name')).toBe('pane.renameError.autoName');
    expect(paneLabelRejectionKey('toString')).toBe('pane.renameError.failed');
    expect(paneLabelRejectionKey(undefined)).toBe('pane.renameError.failed');
  });
});
