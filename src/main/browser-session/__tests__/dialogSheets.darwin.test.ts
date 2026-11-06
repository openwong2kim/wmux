import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: vi.fn() } }));

import type { BrowserWindow } from 'electron';
import { createObjcSheetPort, type ObjcCall } from '../dialogSheets.darwin';

// A tiny fake Objective-C world: objects are plain records, messages are looked
// up by selector. What matters is which messages the port sends.

interface Obj { cls?: string; value?: string; subviews?: Obj[]; contentView?: Obj; sheets?: Obj[]; addr: bigint }

let next = 1n;
const obj = (o: Omit<Obj, 'addr'>): Obj => ({ ...o, addr: next++ });

function fakeObjc(window: Obj) {
  const sent: Array<{ selector: string; target: Obj }> = [];
  const later: Array<{ target: Obj; selector: string; argument: Obj; delay: number }> = [];
  const objc: ObjcCall = {
    send: (target, selector) => {
      const t = target as Obj;
      sent.push({ selector, target: t });
      switch (selector) {
        case 'sheets': return { items: t.sheets ?? [] };
        case 'contentView': return t.contentView;
        case 'subviews': return { items: t.subviews ?? [] };
        case 'className': return { str: t.cls ?? 'NSView' };
        case 'stringValue': return { str: t.value ?? '' };
        default: return undefined;
      }
    },
    count: (target) => ((target as { items: Obj[] }).items).length,
    objectAt: (array, index) => (array as { items: Obj[] }).items[index],
    utf8: (s) => (s as { str: string } | undefined)?.str ?? '',
    address: (p) => (p as Obj).addr,
    windowOf: () => window,
    performLater: (target, selector, argument, delay) => { later.push({ target: target as Obj, selector, argument: argument as Obj, delay }); },
  };
  return { objc, sent, later };
}

const alertSheet = (message: string) =>
  obj({ contentView: obj({ subviews: [obj({ cls: 'NSImageView' }), obj({ cls: 'NSTextField', value: message }), obj({ cls: 'NSButton' })] }) });

describe('the macOS sheet port', () => {
  const host = {} as BrowserWindow;

  it('lists the window\'s sheets in queue order and reads each one\'s text', () => {
    const first = alertSheet('Delete it?');
    const second = alertSheet('Quit wmux?');
    const window = obj({ sheets: [first, second] });
    const port = createObjcSheetPort(fakeObjc(window).objc);

    const sheets = port.list(host);

    expect(sheets).toEqual([first, second]);
    expect(port.texts(first)).toEqual(['Delete it?']);
    expect(port.same(first, sheets[0])).toBe(true);
    expect(port.same(first, second)).toBe(false);
  });

  it('ends a sheet only through performSelector afterDelay:0, never endSheet: directly', () => {
    // A synchronous endSheet: runs Electron's completion handler, which calls
    // back into JS inside the FFI call: a V8 check failure that kills main.
    const sheet = alertSheet('Sure?');
    const window = obj({ sheets: [sheet] });
    const { objc, sent, later } = fakeObjc(window);
    const port = createObjcSheetPort(objc);

    port.endLater(host, sheet);

    expect(later).toEqual([{ target: window, selector: 'endSheet:', argument: sheet, delay: 0 }]);
    expect(sent.some((m) => m.selector.startsWith('endSheet'))).toBe(false);
  });

  it('retains and releases the sheet it holds', () => {
    const sheet = alertSheet('Sure?');
    const { objc, sent } = fakeObjc(obj({ sheets: [sheet] }));
    const port = createObjcSheetPort(objc);

    port.retain(sheet);
    port.release(sheet);

    expect(sent.filter((m) => m.target === sheet).map((m) => m.selector)).toEqual(['retain', 'release']);
  });
});
