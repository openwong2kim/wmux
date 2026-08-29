import { describe, expect, it } from 'vitest';
import { en } from '../locales/en';
import { ko } from '../locales/ko';
import { pl } from '../locales/pl';
import { zh } from '../locales/zh';
import { zhTW } from '../locales/zh-TW';

const KEYS = [
  'toolbar.schedule',
  'toolbar.scheduleTooltip',
  'sessionSchedule.title',
  'sessionSchedule.hint',
  'sessionSchedule.empty',
  'sessionSchedule.promptPlaceholder',
  'sessionSchedule.quick',
  'sessionSchedule.saving',
  'sessionSchedule.invalid',
  'sessionSchedule.limit',
  'sessionSchedule.agentUnavailable',
  'sessionSchedule.error',
  'sessionSchedule.needsAgent',
  'sessionSchedule.noAgent',
  'sessionSchedule.statusWaiting',
  'sessionSchedule.statusBusy',
  'sessionSchedule.statusUnavailable',
  'sessionSchedule.statusSessionChanged',
  'sessionSchedule.statusSent',
  'sessionSchedule.statusError',
  'sessionSchedule.statusPaused',
  'sessionSchedule.daemonRequired',
  'sessionSchedule.promptLabel',
  'sessionSchedule.whenLabel',
  'sessionSchedule.repeatLabel',
  'sessionSchedule.quickHours',
  'sessionSchedule.repeatNone',
  'sessionSchedule.repeat30m',
  'sessionSchedule.repeat1h',
  'sessionSchedule.repeat6h',
  'sessionSchedule.repeat24h',
  'sessionSchedule.pause',
  'sessionSchedule.resume',
  'sessionSchedule.delete',
  'sessionSchedule.add',
  'sessionSchedule.otherSession',
] as const satisfies ReadonlyArray<keyof typeof en>;

describe('session prompt schedule locale coverage', () => {
  for (const [locale, messages] of Object.entries({ en, ko, pl, zh, 'zh-TW': zhTW })) {
    it(`${locale} owns every schedule-surface string`, () => {
      for (const key of KEYS) {
        expect(Object.prototype.hasOwnProperty.call(messages, key), `${locale}: ${key}`).toBe(true);
        expect(messages[key as keyof typeof messages]).toBeTruthy();
      }
    });
  }
});
