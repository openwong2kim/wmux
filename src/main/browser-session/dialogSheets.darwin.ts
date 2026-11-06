// macOS: a window's sheets, through the Objective-C runtime (koffi → libobjc).
// The only file that touches the FFI. dialogSheets.ts holds the rules.

import { BrowserWindow, type WebContents } from 'electron';
import type { SheetPort, SheetShape } from './dialogSheets';

/** The few Objective-C messages the port sends. A fake stands in for it in tests. */
export interface ObjcCall {
  /** A message with pointer arguments that returns an object pointer. */
  send(target: unknown, selector: string, ...args: unknown[]): unknown;
  /** A message that returns an NSUInteger. */
  count(target: unknown, selector: string): number;
  objectAt(array: unknown, index: number): unknown;
  utf8(nsstring: unknown): string;
  address(pointer: unknown): bigint;
  /** The NSWindow behind a BrowserWindow. */
  windowOf(host: BrowserWindow): unknown;
  /** [target performSelector:@selector(selector) withObject:argument afterDelay:delay] */
  performLater(target: unknown, selector: string, argument: unknown, delay: number): void;
}

/** Deep enough for an alert's content view. */
const MAX_VIEW_DEPTH = 6;

export function createObjcSheetPort(objc: ObjcCall): SheetPort<BrowserWindow, unknown> {
  const list = (host: BrowserWindow): unknown[] => {
    const sheets = objc.send(objc.windowOf(host), 'sheets');
    const n = objc.count(sheets, 'count');
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(objc.objectAt(sheets, i));
    return out;
  };
  const shape = (sheet: unknown): SheetShape => {
    const texts: string[] = [];
    const buttons: string[] = [];
    const walk = (view: unknown, depth: number): void => {
      if (!view || depth > MAX_VIEW_DEPTH) return;
      const cls = objc.utf8(objc.send(view, 'className'));
      if (cls === 'NSTextField') texts.push(objc.utf8(objc.send(view, 'stringValue')));
      else if (cls === 'NSButton') buttons.push(objc.utf8(objc.send(view, 'title')));
      const subviews = objc.send(view, 'subviews');
      const n = objc.count(subviews, 'count');
      for (let i = 0; i < n; i++) walk(objc.objectAt(subviews, i), depth + 1);
    };
    walk(objc.send(sheet, 'contentView'), 0);
    return { texts, buttons };
  };
  return {
    list,
    key: (sheet) => objc.address(sheet),
    shape,
    retain: (sheet) => { objc.send(sheet, 'retain'); },
    release: (sheet) => { objc.send(sheet, 'release'); },
    endLater: (host, sheet) => {
      // Never [window endSheet:] from here. Ending a sheet runs Electron's
      // completion handler, which calls back into JS; inside this FFI call that
      // trips a V8 check and takes main down (EXC_BREAKPOINT). From the run loop
      // it is safe. performSelector also keeps the window and the sheet alive
      // until it has run.
      objc.performLater(objc.windowOf(host), 'endSheet:', sheet, 0);
    },
  };
}

interface Koffi {
  load(path: string): { func(name: string, result: string, args: string[]): (...args: unknown[]) => unknown };
  decode(buffer: Buffer, type: string): unknown;
  address(pointer: unknown): bigint;
}

/** libobjc through the koffi the app already ships (as peerPid.ts loads it). Throws if unavailable. */
export function loadObjc(): ObjcCall {
  // Runtime require, external to every bundle (its binary sits beside the package).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi') as Koffi;
  const lib = koffi.load('/usr/lib/libobjc.A.dylib');
  const selectorOf = lib.func('sel_registerName', 'void *', ['const char *']);
  const selectors = new Map<string, unknown>();
  const sel = (name: string): unknown => {
    let s = selectors.get(name);
    if (s === undefined) {
      s = selectorOf(name);
      selectors.set(name, s);
    }
    return s;
  };
  const send0 = lib.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const send1 = lib.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
  const sendCount = lib.func('objc_msgSend', 'unsigned long', ['void *', 'void *']);
  const sendIndex = lib.func('objc_msgSend', 'void *', ['void *', 'void *', 'unsigned long']);
  const sendUtf8 = lib.func('objc_msgSend', 'const char *', ['void *', 'void *']);
  const sendLater = lib.func('objc_msgSend', 'void', ['void *', 'void *', 'void *', 'void *', 'double']);
  return {
    send: (target, selector, ...args) => {
      if (args.length === 0) return send0(target, sel(selector));
      if (args.length === 1) return send1(target, sel(selector), args[0]);
      throw new Error(`objc: ${selector} takes at most one argument here`);
    },
    count: (target, selector) => Number(sendCount(target, sel(selector))),
    objectAt: (array, index) => sendIndex(array, sel('objectAtIndex:'), index),
    utf8: (nsstring) => (nsstring ? String(sendUtf8(nsstring, sel('UTF8String')) ?? '') : ''),
    address: (pointer) => koffi.address(pointer),
    windowOf: (host) => send0(koffi.decode(host.getNativeWindowHandle(), 'void *'), sel('window')),
    performLater: (target, selector, argument, delay) => {
      sendLater(target, sel('performSelector:withObject:afterDelay:'), sel(selector), argument, delay);
    },
  };
}

/** The window a guest's <webview> lives in. */
export function hostWindowOf(guest: WebContents): BrowserWindow | null {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed()) return null;
  return BrowserWindow.fromWebContents(host);
}
