// Windows: the box a page dialog leaves, found through user32 and read through
// MSAA (koffi → user32, oleacc). The only file that touches that FFI;
// dialogSheets.ts holds the rules.
//
// Electron shows a page's alert and confirm as a TaskDialog: a top-level
// `#32770` window of this process with a `DirectUIHWND` child. Its message and
// its buttons live in DirectUI, so no window text or control id carries them;
// MSAA does: the DirectUIHWND client's children are the message (static text)
// and one window per button. Button labels are localized ("확인", "취소"), so
// the port reports a page dialog's buttons by count and leaves the rules to
// match on the exact message.
//
// The first box is owned by the tab's window and disables it; a box opened
// while one is up is unowned. Both are listed for a window, so each can be
// claimed by its own dialog.

import type { BrowserWindow } from 'electron';
import type { SheetPort, SheetShape } from './dialogSheets';

/** A box: its window and the order this port first saw it in. */
export interface Win32Box {
  readonly hwnd: bigint;
  readonly serial: number;
}

/** One MSAA child of the DirectUIHWND client. */
export interface AccChild {
  role: number;
  name: string;
}

/** The user32 and MSAA calls the port makes. A fake stands in for it in tests. */
export interface Win32Calls {
  ownPid(): number;
  /** Top-level `#32770` windows, top of the Z order first. */
  dialogWindows(): bigint[];
  pidOf(hwnd: bigint): number;
  isVisible(hwnd: bigint): boolean;
  /** GW_OWNER; 0n for none. */
  ownerOf(hwnd: bigint): bigint;
  /** The first child window of a class; 0n for none. */
  childOfClass(hwnd: bigint, className: string): bigint;
  /** The DirectUIHWND client's children through MSAA. Throws when they can't be read in time. */
  accChildren(hwnd: bigint, budgetMs: number): AccChild[];
  hostOf(host: BrowserWindow): bigint;
  /** PostMessage(WM_CLOSE). Never SendMessage: the box closes from its own loop. */
  postClose(hwnd: bigint): boolean;
}

/** MSAA roles a TaskDialog's DirectUI shows. */
export const ROLE_WINDOW = 9;
export const ROLE_STATICTEXT = 41;
export const ROLE_PUSHBUTTON = 43;

/**
 * The whole MSAA read of one box stays under this, or it is abandoned and the
 * box stays: it runs on main's thread, inside the box's own modal loop.
 */
export const MSAA_BUDGET_MS = 50;

/** What Electron puts on a page dialog's box, by button count (alert: OK; confirm: OK, Cancel). */
const PAGE_BUTTONS_BY_COUNT: Readonly<Record<number, readonly string[]>> = {
  1: ['OK'],
  2: ['Cancel', 'OK'],
};

export function createWin32BoxPort(win: Win32Calls): SheetPort<BrowserWindow, Win32Box> {
  /** First-seen order of every box of this process now showing. */
  const serials = new Map<bigint, number>();
  let nextSerial = 1;
  /** The shape a claimed box had, checked again before it is closed. */
  const claimed = new Map<string, string>();

  const keyOf = (box: Win32Box): string => `${box.hwnd}:${box.serial}`;

  /** Every visible TaskDialog of this process, oldest first. Forgets boxes that are gone. */
  const ourBoxes = (): Array<{ box: Win32Box; owner: bigint }> => {
    const pid = win.ownPid();
    const found: Array<{ hwnd: bigint; owner: bigint }> = [];
    for (const hwnd of win.dialogWindows()) {
      if (win.pidOf(hwnd) !== pid || !win.isVisible(hwnd)) continue;
      if (win.childOfClass(hwnd, 'DirectUIHWND') === 0n) continue;
      found.push({ hwnd, owner: win.ownerOf(hwnd) });
    }
    const showing = new Set(found.map((f) => f.hwnd));
    // A window handle seen again after it was gone is a new box.
    for (const hwnd of [...serials.keys()]) if (!showing.has(hwnd)) serials.delete(hwnd);
    // Boxes new to this look are numbered bottom of the Z order first: a box
    // opened later shows above the ones before it.
    for (const f of [...found].reverse()) if (!serials.has(f.hwnd)) serials.set(f.hwnd, nextSerial++);
    return found
      .map((f) => ({ box: { hwnd: f.hwnd, serial: serials.get(f.hwnd) as number }, owner: f.owner }))
      .sort((a, b) => a.box.serial - b.box.serial);
  };

  const shape = (box: Win32Box): SheetShape => {
    const content = win.childOfClass(box.hwnd, 'DirectUIHWND');
    if (content === 0n) throw new Error('the box has no DirectUIHWND');
    const texts: string[] = [];
    const labels: string[] = [];
    for (const child of win.accChildren(content, MSAA_BUDGET_MS)) {
      if (child.role === ROLE_STATICTEXT) texts.push(child.name);
      else if (child.role === ROLE_WINDOW || child.role === ROLE_PUSHBUTTON) labels.push(child.name);
      // Anything else (a checkbox, an expander, a link) is not on a page dialog's
      // box: an extra text keeps it from matching.
      else texts.push(`\u0000role ${child.role}`);
    }
    const buttons = PAGE_BUTTONS_BY_COUNT[labels.length];
    return { texts, buttons: buttons ? [...buttons] : labels };
  };

  const shapeText = (s: SheetShape): string => JSON.stringify(s);

  return {
    list: (host) => {
      const hostHwnd = win.hostOf(host);
      return ourBoxes()
        .filter(({ owner }) => owner === hostHwnd || owner === 0n)
        .map(({ box }) => box);
    },
    key: keyOf,
    shape,
    retain: (box) => {
      claimed.set(keyOf(box), shapeText(shape(box)));
    },
    release: (box) => {
      claimed.delete(keyOf(box));
    },
    endLater: (_host, box) => {
      // Only the box that was claimed, still showing and still the same box.
      const was = claimed.get(keyOf(box));
      if (was === undefined) throw new Error('the box was not claimed');
      if (!ourBoxes().some((b) => keyOf(b.box) === keyOf(box))) return;
      if (shapeText(shape(box)) !== was) throw new Error('the box changed since it was claimed');
      if (!win.postClose(box.hwnd)) throw new Error('PostMessage(WM_CLOSE) failed');
    },
  };
}

// ---------------------------------------------------------------------------
// MSAA: reading a window's client children, with every reference released.
// ---------------------------------------------------------------------------

/** A child of an IAccessible: another object, or a simple element by id. */
export type ComChild<O> = { kind: 'object'; dispatch: O } | { kind: 'element'; id: number };

/** The COM calls the reader makes. A fake counts references in tests. */
export interface ComCalls<O> {
  /** AccessibleObjectFromWindow(OBJID_CLIENT); null when there is none. */
  fromWindow(hwnd: bigint): O | null;
  childCount(acc: O): number;
  /** AccessibleChildren. Every returned object is a reference the caller releases. */
  children(acc: O, count: number): Array<ComChild<O>>;
  /** QueryInterface(IID_IAccessible); null when it isn't one. Doesn't release `dispatch`. */
  asAccessible(dispatch: O): O | null;
  role(acc: O, childId: number): number;
  name(acc: O, childId: number): string;
  release(obj: O): void;
}

/** A box has a handful of children; anything bigger is not a page dialog's. */
const MAX_CHILDREN = 16;

/**
 * The client children of `hwnd`, one level deep: role and name each. Every
 * reference taken is released on every path. Past `budgetMs` (checked after
 * each call) or `MAX_CHILDREN`, the read is abandoned and throws.
 */
export function readAccChildren<O>(com: ComCalls<O>, hwnd: bigint, budgetMs: number, now: () => number): AccChild[] {
  const started = now();
  const within = (what: string): void => {
    if (now() - started > budgetMs) throw new Error(`MSAA read took over ${budgetMs} ms (at ${what})`);
  };
  const root = com.fromWindow(hwnd);
  if (root === null) throw new Error('no MSAA object for the box');
  const held: O[] = [root];
  try {
    const count = com.childCount(root);
    within('childCount');
    if (count > MAX_CHILDREN) throw new Error(`${count} MSAA children`);
    const kids = count > 0 ? com.children(root, count) : [];
    for (const kid of kids) if (kid.kind === 'object') held.push(kid.dispatch);
    within('children');
    const out: AccChild[] = [];
    for (const kid of kids) {
      if (kid.kind === 'element') {
        out.push({ role: com.role(root, kid.id), name: com.name(root, kid.id) });
      } else {
        const acc = com.asAccessible(kid.dispatch);
        if (acc === null) throw new Error('an MSAA child is not an IAccessible');
        held.push(acc);
        out.push({ role: com.role(acc, 0), name: com.name(acc, 0) });
      }
      within('child');
    }
    return out;
  } finally {
    for (const obj of held) com.release(obj);
  }
}

// ---------------------------------------------------------------------------
// The real calls, through the koffi the app already ships.
// ---------------------------------------------------------------------------

interface KoffiFn { (...args: unknown[]): unknown }
interface KoffiLib { func(signature: string): KoffiFn }
interface Koffi {
  load(path: string): KoffiLib;
  struct(name: string, fields: Record<string, unknown>): unknown;
  array(type: string, n: number): unknown;
  proto(signature: string): unknown;
  call(fn: unknown, proto: unknown, ...args: unknown[]): unknown;
  decode(value: unknown, offsetOrType: unknown, type?: unknown, len?: number): unknown;
  alloc(type: unknown, n: number): unknown;
  free(value: unknown): void;
  address(pointer: unknown): bigint;
}

const OBJID_CLIENT = 0xfffffffc;
const GW_OWNER = 4;
const WM_CLOSE = 0x0010;
const VT_I4 = 3;
const VT_DISPATCH = 9;

/** user32 + oleacc through koffi. Throws if unavailable. */
export function loadWin32(): Win32Calls {
  // Runtime require, external to every bundle (its binary sits beside the package).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi') as Koffi;
  const user32 = koffi.load('user32.dll');
  const oleacc = koffi.load('oleacc.dll');
  const oleaut32 = koffi.load('oleaut32.dll');

  const FindWindowExW = user32.func('intptr __stdcall FindWindowExW(intptr parent, intptr after, const char16_t *cls, const char16_t *title)');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr hwnd)');
  const GetWindow = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32 cmd)');
  const PostMessageW = user32.func('bool __stdcall PostMessageW(intptr hwnd, uint32 msg, uintptr wparam, intptr lparam)');

  const GUID = koffi.struct('WmuxGuid', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: koffi.array('uint8', 8) });
  // VARIANT is 24 bytes on x64: vt, three reserved words, then the value.
  const VARIANT = koffi.struct('WmuxVariant', { vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', val: 'uint64', pad: 'uint64' });
  // Named for the protos below, which pass it by value.
  void VARIANT;
  void GUID;
  const VARIANT_PTR = koffi.struct('WmuxVariantPtr', { vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', val: 'void *', pad: 'uint64' });
  const AccessibleObjectFromWindow = oleacc.func('long __stdcall AccessibleObjectFromWindow(intptr hwnd, uint32 id, WmuxGuid *riid, _Out_ void **ppv)');
  const AccessibleChildren = oleacc.func('long __stdcall AccessibleChildren(void *acc, int32 start, int32 count, void *children, _Out_ int32 *obtained)');
  const SysFreeString = oleaut32.func('void __stdcall SysFreeString(void *bstr)');

  const IID_IAccessible = { d1: 0x618736e0, d2: 0x3c3d, d3: 0x11cf, d4: [0x81, 0x0c, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71] };
  const QueryInterface = koffi.proto('long __stdcall WmuxQueryInterface(void *self, WmuxGuid *riid, _Out_ void **ppv)');
  const Release = koffi.proto('uint32 __stdcall WmuxRelease(void *self)');
  const GetChildCount = koffi.proto('long __stdcall WmuxGetAccChildCount(void *self, _Out_ int32 *count)');
  const GetName = koffi.proto('long __stdcall WmuxGetAccName(void *self, WmuxVariant child, _Out_ void **name)');
  const GetRole = koffi.proto('long __stdcall WmuxGetAccRole(void *self, WmuxVariant child, _Out_ WmuxVariant *role)');
  // IAccessible vtable slots (IUnknown 0-2, IDispatch 3-6, then IAccessible).
  const SLOT_QUERY_INTERFACE = 0;
  const SLOT_RELEASE = 2;
  const SLOT_CHILD_COUNT = 8;
  const SLOT_NAME = 10;
  const SLOT_ROLE = 13;

  const method = (obj: unknown, slot: number): unknown => koffi.decode(koffi.decode(obj, 'void *'), slot * 8, 'void *');
  const childVariant = (id: number) => ({ vt: VT_I4, r1: 0, r2: 0, r3: 0, val: BigInt(id), pad: 0n });
  const ok = (hr: unknown, what: string): void => {
    if (Number(hr) < 0) throw new Error(`${what} failed (0x${(Number(hr) >>> 0).toString(16)})`);
  };

  const com: ComCalls<unknown> = {
    fromWindow: (hwnd) => {
      const out: unknown[] = [null];
      const hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, out);
      return Number(hr) >= 0 && out[0] ? out[0] : null;
    },
    childCount: (acc) => {
      const out = [0];
      ok(koffi.call(method(acc, SLOT_CHILD_COUNT), GetChildCount, acc, out), 'get_accChildCount');
      return out[0];
    },
    children: (acc, count) => {
      const buf = koffi.alloc(VARIANT_PTR, count);
      try {
        const got = [0];
        ok(AccessibleChildren(acc, 0, count, buf, got), 'AccessibleChildren');
        if (got[0] === 0) return [];
        const items = koffi.decode(buf, koffi.array(VARIANT_PTR as unknown as string, got[0])) as Array<{ vt: number; val: unknown }>;
        return items.map((item): ComChild<unknown> => {
          if (item.vt === VT_DISPATCH) return { kind: 'object', dispatch: item.val };
          if (item.vt === VT_I4) return { kind: 'element', id: Number(koffi.address(item.val) & 0xffffffffn) };
          // Nothing else is documented for AccessibleChildren; report it as an element no match accepts.
          return { kind: 'element', id: -1 };
        });
      } finally {
        koffi.free(buf);
      }
    },
    asAccessible: (dispatch) => {
      const out: unknown[] = [null];
      const hr = koffi.call(method(dispatch, SLOT_QUERY_INTERFACE), QueryInterface, dispatch, IID_IAccessible, out);
      return Number(hr) >= 0 && out[0] ? out[0] : null;
    },
    role: (acc, childId) => {
      const out: { val?: unknown } = {};
      ok(koffi.call(method(acc, SLOT_ROLE), GetRole, acc, childVariant(childId), out), 'get_accRole');
      return Number(BigInt(out.val as bigint) & 0xffffffffn);
    },
    name: (acc, childId) => {
      const out: unknown[] = [null];
      ok(koffi.call(method(acc, SLOT_NAME), GetName, acc, childVariant(childId), out), 'get_accName');
      if (!out[0]) return '';
      try {
        return String(koffi.decode(out[0], 'char16_t', -1));
      } finally {
        SysFreeString(out[0]);
      }
    },
    release: (obj) => {
      koffi.call(method(obj, SLOT_RELEASE), Release, obj);
    },
  };

  return {
    ownPid: () => process.pid,
    dialogWindows: () => {
      const out: bigint[] = [];
      let after = 0n;
      // Top-level windows of the dialog class, in Z order; bounded in case the list changes under us.
      for (let i = 0; i < 256; i++) {
        after = BigInt(FindWindowExW(0n, after, '#32770', null) as bigint | number);
        if (after === 0n) break;
        out.push(after);
      }
      return out;
    },
    pidOf: (hwnd) => {
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      return pid[0];
    },
    isVisible: (hwnd) => Boolean(IsWindowVisible(hwnd)),
    ownerOf: (hwnd) => BigInt(GetWindow(hwnd, GW_OWNER) as bigint | number),
    childOfClass: (hwnd, className) => BigInt(FindWindowExW(hwnd, 0n, className, null) as bigint | number),
    accChildren: (hwnd, budgetMs) => {
      // It runs on main's thread, inside the box's modal loop: log what each read costs.
      const started = performance.now();
      let outcome = 'failed';
      try {
        const kids = readAccChildren(com, hwnd, budgetMs, () => performance.now());
        outcome = `${kids.length} children`;
        return kids;
      } finally {
        console.log(`[dialog-sheets] MSAA read: ${outcome} in ${(performance.now() - started).toFixed(2)} ms`);
      }
    },
    hostOf: (host) => host.getNativeWindowHandle().readBigUInt64LE(0),
    postClose: (hwnd) => Boolean(PostMessageW(hwnd, WM_CLOSE, 0n, 0n)),
  };
}
