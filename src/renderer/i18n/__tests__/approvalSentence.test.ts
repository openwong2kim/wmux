import { describe, it, expect } from 'vitest';
import { en } from '../locales/en';
import { zh } from '../locales/zh';

// The approval dialog asks whether to spawn an agent with bypassPermissions.
// Its wording used to be cut into Intro/Mid/End keys with the word order held
// in JSX, which no verb-final or right-to-left language can satisfy. These
// pin the whole-sentence shape so it cannot quietly regress to fragments.
describe('approval sentences stay whole and reorderable', () => {
  const SENTENCES = [
    { key: 'approval.sameWsSentence', slots: ['{workspace}', '{mode}'] },
    { key: 'approval.remoteSentence', slots: ['{mode}'] },
    { key: 'approval.fanoutSentence', slots: ['{tasks}'] },
  ] as const;

  for (const { key, slots } of SENTENCES) {
    it(`${key} carries every emphasised part as a slot`, () => {
      const value = (en as Record<string, string>)[key];
      expect(value, `${key} missing from en`).toBeTruthy();
      for (const slot of slots) expect(value).toContain(slot);
      // A sentence, not a fragment: it ends in terminal punctuation.
      expect(value.trimEnd()).toMatch(/[.!?]$/);
    });

    it(`${key} keeps the same slots in zh`, () => {
      const value = (zh as Record<string, string | undefined>)[key];
      if (value === undefined) return; // Partial<> + English fallback is fine.
      for (const slot of slots) {
        expect(value, `${key} dropped ${slot} in zh`).toContain(slot);
      }
    });
  }

  it('has no leftover fragment keys', () => {
    for (const dead of [
      'approval.sameWsIntro', 'approval.sameWsMid', 'approval.sameWsEnd',
      'approval.remoteIntro', 'approval.remoteEnd',
      'approval.fanoutIntro', 'approval.fanoutDesc', 'approval.fanoutCount',
    ]) {
      expect((en as Record<string, string>)[dead], `${dead} is back`).toBeUndefined();
      expect((zh as Record<string, string | undefined>)[dead], `${dead} is back in zh`).toBeUndefined();
    }
  });

  it('pluralises the fan-out task count instead of writing "task(s)"', () => {
    const one = (en as Record<string, string>)['approval.fanoutTasks'];
    const many = (en as Record<string, string>)['approval.fanoutTasksPlural'];
    expect(one).toContain('{count}');
    expect(many).toContain('{count}');
    expect(one).not.toContain('(s)');
    expect(many).not.toContain('(s)');
    expect(one).not.toBe(many);
  });
});
