import { describe, expect, it } from 'vitest';
import { neutralName, TYPED_NAME_MAX } from '../typedLineName';

describe('neutralName', () => {
  it('keeps words and turns anything a shell would read as syntax into _', () => {
    expect(neutralName('nonowner.w5-1(claude)')).toBe('nonowner.w5-1_claude_');
    expect(neutralName('$(rm -rf ~)')).toBe('_rm -rf _');
    expect(neutralName('a`id`b')).toBe('a_id_b');
    expect(neutralName('x;rm y && z | w > f < g')).toBe('x_rm y _ z _ w _ f _ g');
    expect(neutralName('"q" \'s\' !bang #hash @at /p\\b *?')).toBe('_q_ _s_ _bang _hash _at _p_b _');
  });

  it('keeps a name on one line, without controls, escapes or direction marks', () => {
    expect(neutralName('one\ntwo\r\nthree\tfour')).toBe('one_two_three_four');
    expect(neutralName('a\x1b[31mred\x1b[0m\x1b]0;title\x07b')).toBe('aredb');
    expect(neutralName('evil‮gnp.exe')).toBe('evil_gnp.exe');
    expect(neutralName('zero​width')).toBe('zero_width');
  });

  it('keeps other scripts, and folds full-width forms before filtering', () => {
    expect(neutralName('백엔드 작업')).toBe('백엔드 작업');
    expect(neutralName('（claude）')).toBe('_claude_');
  });

  it('caps the length and never returns an empty name', () => {
    expect([...neutralName('a'.repeat(500))]).toHaveLength(TYPED_NAME_MAX);
    expect(neutralName('名'.repeat(100), 10)).toBe('名'.repeat(10));
    expect(neutralName('')).toBe('_');
    expect(neutralName(undefined)).toBe('_');
  });
});
