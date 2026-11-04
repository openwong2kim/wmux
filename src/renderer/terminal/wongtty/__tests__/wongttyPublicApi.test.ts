import { describe, expect, it, vi } from 'vitest';
import { resetXtermKitty, xtermKittyFlags } from '../../kittyKeyboard';
import { markUserInput } from '../../../../shared/terminal/userInputGate';

describe('wongtty terminals (uiSlice.terminalWongtty)', () => {
  it('use the public kitty and user-input members instead of xterm internals', () => {
    const resetKittyKeyboard = vi.fn();
    const write = vi.fn();
    const term = { kittyKeyboardFlags: 3, resetKittyKeyboard, write };
    expect(xtermKittyFlags(term)).toBe(3);
    resetXtermKitty(term);
    expect(resetKittyKeyboard).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();

    let fire: () => void = () => undefined;
    const marker = markUserInput({ onUserInput: (listener) => { fire = listener; return { dispose: () => undefined }; } });
    expect(marker.gated).toBe(true);
    expect(marker.consume()).toBe(false);
    fire();
    expect(marker.consume()).toBe(true);
  });
});
