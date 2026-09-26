import { describe, it, expect, vi } from 'vitest';
import { deliverChatInsert, registerChatInsertTarget, spliceAtCaret } from '../chatAttachments';

describe('mention insert into the Chat view composer', () => {
  it('splices at the caret with a space either side where words would touch', () => {
    expect(spliceAtCaret('', 0, '[ref]')).toEqual({ text: '[ref]', caret: 5 });
    expect(spliceAtCaret('ask to review', 3, '[ref]')).toEqual({ text: 'ask [ref] to review', caret: 9 });
    expect(spliceAtCaret('ask ', 4, '[ref]')).toEqual({ text: 'ask [ref]', caret: 9 });
    expect(spliceAtCaret('ask', 99, '[ref]')).toEqual({ text: 'ask [ref]', caret: 9 });
  });

  it('goes to the registered composer of that pane only, and not after unmount', () => {
    const insert = vi.fn(() => true);
    const unregister = registerChatInsertTarget('pty-1', { insert, focus: vi.fn() });
    expect(deliverChatInsert('pty-2', 'x')).toBeNull();
    expect(deliverChatInsert('pty-1', 'x')).toBe(true);
    expect(insert).toHaveBeenCalledWith('x');
    unregister();
    expect(deliverChatInsert('pty-1', 'x')).toBeNull();
  });
});
