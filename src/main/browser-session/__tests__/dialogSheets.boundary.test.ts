import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// createDialogSheets is the one way into the sheet tracker from outside. Whatever
// throws behind it, a dialog's answer must not be lost and nothing may escape
// into main as an uncaught exception.

const world = vi.hoisted(() => ({
  keyThrows: false,
  sheets: [] as object[],
  closedListeners: [] as Array<() => void>,
}));

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: vi.fn() } }));
vi.mock('../dialogSheets.darwin', () => {
  const host = { once: (_event: string, listener: () => void) => { world.closedListeners.push(listener); } };
  return {
    loadObjc: () => ({}),
    hostWindowOf: () => host,
    createObjcSheetPort: () => ({
      list: () => [...world.sheets],
      // A raw error, not one the tracker's own guard raised.
      key: (sheet: object) => {
        if (world.keyThrows) throw new Error('Object has been destroyed');
        return sheet;
      },
      shape: () => ({ texts: ['Sure?', ''], buttons: ['OK'] }),
      retain: () => undefined,
      release: () => undefined,
      endLater: () => undefined,
    }),
  };
});

import type { WebContents } from 'electron';
import { createDialogSheets } from '../dialogSheets';
import { GuestDialogs } from '../guestDialogs';

const platform = Object.getOwnPropertyDescriptor(process, 'platform');

function rig() {
  const sheets = createDialogSheets();
  const guest = { isDestroyed: () => false } as unknown as WebContents;
  const answered: string[] = [];
  const dialogs = new GuestDialogs({
    answer: async (surfaceId) => { answered.push(surfaceId); },
    note: () => undefined,
    defer: (fn) => fn(),
    sheets: {
      trackOpening: (surfaceId, message, type) => sheets.trackOpening(surfaceId, guest, message, type),
      closeIfStale: (surfaceId) => sheets.closeIfStale(surfaceId),
      forget: (surfaceId) => sheets.forget(surfaceId),
    },
  });
  return { dialogs, answered };
}

describe('dialog sheets: nothing behind the boundary costs a dialog its answer', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.useFakeTimers();
    world.keyThrows = false;
    world.sheets = [{}];
    world.closedListeners = [];
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('an opening whose look throws still gets the agent\'s answer', () => {
    const { dialogs, answered } = rig();
    world.keyThrows = true;

    expect(() => dialogs.opening('agent', 'alert', 'Sure?', true)).not.toThrow();
    expect(answered).toEqual(['agent']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[dialog-sheets]'));
  });

  it('a retry that throws stays inside, and stops when the opening runs out of time', () => {
    const { dialogs } = rig();
    world.keyThrows = true;
    dialogs.opening('agent', 'alert', 'Sure?', true);

    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    const calls = warn.mock.calls.length;
    vi.advanceTimersByTime(5_000);
    expect(warn.mock.calls.length).toBe(calls);
  });

  it('a close whose end throws does not escape', () => {
    const { dialogs } = rig();
    // A person's dialog pairs with its box, then the box can no longer be read.
    dialogs.opening('person', 'alert', 'Sure?', false);
    world.keyThrows = true;

    expect(() => dialogs.closed('person')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[dialog-sheets]'));
  });

  it('forgetting a tab whose box throws does not escape', () => {
    const { dialogs } = rig();
    dialogs.opening('person', 'alert', 'Sure?', false);
    world.keyThrows = true;

    expect(() => dialogs.forget('person')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[dialog-sheets]'));
  });

  it('a window closing while its boxes throw does not escape', () => {
    const { dialogs } = rig();
    dialogs.opening('person', 'alert', 'Sure?', false);
    world.keyThrows = true;

    expect(() => { for (const listener of world.closedListeners) listener(); }).not.toThrow();
  });
});
