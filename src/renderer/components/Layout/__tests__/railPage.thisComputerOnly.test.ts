import { describe, expect, it } from 'vitest';
import { thisComputerOnlyLine } from '../RailPage';
import { t } from '../../../i18n';

describe('thisComputerOnlyLine', () => {
  it('names the selected computer on Fleet, Schedules and Git', () => {
    for (const route of ['fleet', 'schedules', 'git']) {
      expect(thisComputerOnlyLine(route, 'office-mac', t)).toBe("This computer · office-mac isn't shown here yet");
    }
  });

  it('stays off for this computer, an unnamed computer and the Remote page', () => {
    expect(thisComputerOnlyLine('fleet', null, t)).toBeNull();
    expect(thisComputerOnlyLine('fleet', '', t)).toBeNull();
    expect(thisComputerOnlyLine('remote', 'office-mac', t)).toBeNull();
  });
});
