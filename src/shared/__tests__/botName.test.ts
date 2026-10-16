import { describe, expect, it } from 'vitest';
import { BOT_NAME_MAX, normalizeBotName, storedBotName } from '../bot';

describe('bot names', () => {
  it('a new name: no path separator, control character or line separator, at most BOT_NAME_MAX', () => {
    expect(normalizeBotName('cd /private/tmp/wmux-e2e')).toBeUndefined();
    expect(normalizeBotName('C:\\Users\\dev')).toBeUndefined();
    expect(normalizeBotName('Rex\tTwo')).toBeUndefined();
    expect(normalizeBotName('Rex\u2028Two')).toBeUndefined();
    expect(normalizeBotName('x'.repeat(BOT_NAME_MAX + 1))).toBeUndefined();
    expect(normalizeBotName('   ')).toBeUndefined();
    expect(normalizeBotName('x'.repeat(BOT_NAME_MAX))).toBe('x'.repeat(BOT_NAME_MAX));
    for (const ok of ['Rex', '  Wmux Issue ', '대장', 'レビュー担当', "O'Brien", 'Rex-2, the reviewer (beta)!']) {
      expect(normalizeBotName(ok)).toBe(ok.trim());
    }
  });

  it('a stored name from before the separator rule still reads back', () => {
    expect(storedBotName('ops/main')).toBe('ops/main');
    expect(storedBotName('Rex\nTwo')).toBeUndefined();
  });
});
