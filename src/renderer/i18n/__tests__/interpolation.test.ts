import { describe, it, expect } from 'vitest';
import { t } from '../index';

// `t()` interpolates with String.prototype.replace. Passing the value as a
// REPLACEMENT STRING makes `$&`, `$$`, "$`" and `$'` patterns rather than
// literal text, so a value containing one is rewritten on its way in.
//
// This was unreachable while every interpolated value was a count or a
// workspace name. It stopped being unreachable when raw `Error.message`,
// agent-authored channel titles and pane titles carrying paths started
// flowing through the same call.
describe('t() interpolation treats values as literal text', () => {
  // Keys that do not exist fall through to the key itself, which makes the
  // key usable as an inline template and keeps this test independent of the
  // locale files.
  const tpl = 'value: {message}!';

  it('inserts $& literally instead of re-inserting the placeholder', () => {
    expect(t(tpl, { message: 'boom $& oops' })).toBe('value: boom $& oops!');
  });

  it('inserts $$ literally instead of collapsing it to $', () => {
    expect(t(tpl, { message: 'cost $$5' })).toBe('value: cost $$5!');
  });

  it("inserts $` and $' literally instead of splicing the surrounding text", () => {
    expect(t(tpl, { message: "a $` b $' c" })).toBe("value: a $` b $' c!");
  });

  it('still interpolates ordinary values, every occurrence', () => {
    expect(t('{n} of {n}', { n: 3 })).toBe('3 of 3');
  });

  it('leaves an unsupplied placeholder alone', () => {
    expect(t(tpl, { other: 'x' })).toBe('value: {message}!');
  });
});
