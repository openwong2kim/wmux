import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { withPhoneBrowserInputFocus } from '../PhoneBrowserInput';

function fixture(focused = false) {
  return {id:1,isDestroyed:()=>false,focus:vi.fn(),debugger:{sendCommand:vi.fn(async (method:string) =>
    method === 'Runtime.evaluate' ? {result:{value:focused}} : {})}};
}
describe('phone browser input focus', () => {
  it('restores temporary focus even after input fails, and permits the next operation', async () => {
    const contents = fixture();
    const wc = contents as unknown as WebContents;
    await expect(withPhoneBrowserInputFocus(wc,async () => {throw new Error('input failed');})).rejects.toThrow('input failed');
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setFocusEmulationEnabled',{enabled:false});
    expect(await withPhoneBrowserInputFocus(wc,async () => 'next')).toBe('next');
  });
  it('preserves existing focus and rejects concurrent input without executing it', async () => {
    const contents = fixture(true);
    const wc = contents as unknown as WebContents;
    const rejected = vi.fn(async () => 'unexpected');
    await withPhoneBrowserInputFocus(wc,async () => {
      await expect(withPhoneBrowserInputFocus(wc,rejected)).rejects.toThrow('unavailable');
    });
    expect(rejected).not.toHaveBeenCalled();
    expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Emulation.setFocusEmulationEnabled')).toBe(false);
  });
  it('releases the input lock when restoring focus fails without retrying the action', async () => {
    const contents = fixture();
    let rejectRestore = true;
    contents.debugger.sendCommand = vi.fn(async (method:string,params?:Record<string,unknown>) => {
      if (method === 'Emulation.setFocusEmulationEnabled' && params?.enabled === false && rejectRestore) {
        throw new Error('restore failed');
      }
      return method === 'Runtime.evaluate' ? {result:{value:false}} : {};
    });
    const operation = vi.fn(async () => 'accepted');
    const wc = contents as unknown as WebContents;
    await expect(withPhoneBrowserInputFocus(wc,operation)).rejects.toThrow('restore failed');
    expect(operation).toHaveBeenCalledTimes(1);
    rejectRestore = false;
    expect(await withPhoneBrowserInputFocus(wc,operation)).toBe('accepted');
    expect(operation).toHaveBeenCalledTimes(2);
  });

});
