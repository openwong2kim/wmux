// Windows: the box a page dialog leaves, found through user32 and read through
// MSAA (koffi → user32, oleacc). The only file that touches that FFI;
// dialogSheets.ts holds the rules.
//
// Electron shows a page's alert and confirm as a TaskDialog: a top-level
// `#32770` window of this process with a `DirectUIHWND` child, run on
// Electron's own dialog thread. Its message and buttons live in DirectUI, so
// no window text or control id carries them; MSAA does: the DirectUIHWND
// client's children are the message (static text) and one window per button.
// A page dialog's buttons are TaskDialog common buttons, whose labels are the
// system's localized OK and Cancel (user32 MB_GetString); a box whose labels
// are anything else is reported as it is and never matches.
//
// The first box is owned by the tab's window and disables it; a box opened
// while one is up is unowned. Unowned boxes belong to no window, so they are
// given to a window the first time they are seen, and only when that window
// is the one looking for its boxes then; otherwise to none.

import type { BrowserWindow } from 'electron';
import type { SheetPort, SheetShape } from './dialogSheets';

/** A box: its window handle and the order this port first saw it in. */
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
  /** Top-level `#32770` windows, top of the Z order first. Handles as 32-bit values. */
  dialogWindows(): bigint[];
  pidOf(hwnd: bigint): number;
  /** GW_OWNER as a 32-bit value; 0n for none. */
  ownerOf(hwnd: bigint): bigint;
  /** The first child window of a class; 0n for none. */
  childOfClass(hwnd: bigint, className: string): bigint;
  /** The DirectUIHWND client's children through MSAA. Throws when they can't be read in time. */
  accChildren(hwnd: bigint, budgetMs: number): AccChild[];
  /** The system's localized OK and Cancel labels; null when unknown. */
  commonLabels(): { ok: string; cancel: string } | null;
  /** The tab window's handle as a 32-bit value. */
  hostOf(host: BrowserWindow): bigint;
  /** PostMessage(WM_CLOSE). Never SendMessage: the box closes on its own thread. */
  postClose(hwnd: bigint): boolean;
  now(): number;
}

/** MSAA roles a TaskDialog's DirectUI shows. */
export const ROLE_WINDOW = 9;
export const ROLE_STATICTEXT = 41;
export const ROLE_PUSHBUTTON = 43;

/**
 * The whole MSAA read of one box stays under this, or it is abandoned and the
 * box stays: the calls are made from main's thread to the box's thread.
 */
export const MSAA_BUDGET_MS = 50;

/**
 * How long after a look a window counts as looking for its boxes: a little
 * over the tracker's retry window, which is how long an opening keeps looking.
 */
export const LOOKING_MS = 1_500;

/** Window handles are 32-bit values; GetWindow and the native handle may differ in sign extension. */
export const hwnd32 = (value: bigint | number): bigint => BigInt.asUintN(32, BigInt(value));

export function createWin32BoxPort(win: Win32Calls): SheetPort<BrowserWindow, Win32Box> {
  /** First-seen order of every TaskDialog of this process, hidden ones included. */
  const serials = new Map<bigint, number>();
  let nextSerial = 1;
  /** When each window last looked for its boxes. */
  const lookedAt = new Map<bigint, number>();
  /**
   * An unowned box's window, fixed the first time the box is seen: the one
   * window looking then, or null for good when more than one was (or none).
   * A box's window never changes after that, so it neither moves between
   * windows nor drops out of one window's list and comes back as new.
   */
  const unownedWindow = new Map<string, bigint | null>();
  /** Each box's shape from its last look, by key. */
  const shapes = new Map<string, SheetShape>();
  /** The shape each claimed box had when it was claimed, by key. */
  const claimed = new Map<string, SheetShape>();

  const keyOf = (box: Win32Box): string => `${box.hwnd}:${box.serial}`;

  /**
   * Every TaskDialog of this process, oldest first. Hidden ones count too:
   * Windows hides owned popups while the owner is minimized, and a box must not
   * come back as a new one after a restore.
   */
  const ourBoxes = (): Array<{ box: Win32Box; owner: bigint }> => {
    const pid = win.ownPid();
    const found: Array<{ hwnd: bigint; owner: bigint }> = [];
    for (const hwnd of win.dialogWindows()) {
      if (win.pidOf(hwnd) !== pid) continue;
      if (win.childOfClass(hwnd, 'DirectUIHWND') === 0n) continue;
      found.push({ hwnd, owner: win.ownerOf(hwnd) });
    }
    const present = new Set(found.map((f) => f.hwnd));
    // A handle seen again after it was gone is a new box: forget the old one.
    for (const [hwnd, serial] of [...serials]) {
      if (present.has(hwnd)) continue;
      const key = keyOf({ hwnd, serial });
      shapes.delete(key);
      unownedWindow.delete(key);
      claimed.delete(key);
      serials.delete(hwnd);
    }
    // Boxes new to this look are numbered bottom of the Z order first: a box
    // opened later shows above the ones before it.
    for (const f of [...found].reverse()) if (!serials.has(f.hwnd)) serials.set(f.hwnd, nextSerial++);
    return found
      .map((f) => ({ box: { hwnd: f.hwnd, serial: serials.get(f.hwnd) as number }, owner: f.owner }))
      .sort((a, b) => a.box.serial - b.box.serial);
  };

  /** Read a box's shape over MSAA. */
  const readShape = (box: Win32Box): SheetShape => {
    const content = win.childOfClass(box.hwnd, 'DirectUIHWND');
    if (content === 0n) throw new Error('the box has no DirectUIHWND');
    const common = win.commonLabels();
    const texts: string[] = [];
    const buttons: string[] = [];
    for (const child of win.accChildren(content, MSAA_BUDGET_MS)) {
      if (child.role === ROLE_STATICTEXT) texts.push(child.name);
      else if (child.role === ROLE_WINDOW || child.role === ROLE_PUSHBUTTON) {
        // A common button reads as the rules' OK and Cancel; any other label stays itself.
        buttons.push(common && child.name === common.ok ? 'OK' : common && child.name === common.cancel ? 'Cancel' : child.name);
      }
      // Anything else (a checkbox, an expander, a link) is not on a page dialog's
      // box: an extra text keeps it from matching.
      else texts.push(`\u0000role ${child.role}`);
    }
    return { texts, buttons };
  };

  const same = (a: SheetShape, b: SheetShape): boolean => JSON.stringify(a) === JSON.stringify(b);

  return {
    list: (host) => {
      const hostHwnd = win.hostOf(host);
      const now = win.now();
      lookedAt.set(hostHwnd, now);
      for (const [h, t] of [...lookedAt]) if (now - t > 60 * LOOKING_MS) lookedAt.delete(h);
      const looking = [...lookedAt].filter(([, t]) => now - t < LOOKING_MS).map(([h]) => h);
      const boxes = ourBoxes();
      for (const { box, owner } of boxes) {
        const key = keyOf(box);
        if (owner === 0n && !unownedWindow.has(key)) unownedWindow.set(key, looking.length === 1 ? looking[0] : null);
      }
      return boxes
        .filter(({ box, owner }) => owner === hostHwnd || (owner === 0n && unownedWindow.get(keyOf(box)) === hostHwnd))
        .map(({ box }) => box);
    },
    key: keyOf,
    shape: (box) => {
      const shape = readShape(box);
      shapes.set(keyOf(box), shape);
      return shape;
    },
    retain: (box) => {
      const key = keyOf(box);
      claimed.set(key, shapes.get(key) ?? readShape(box));
    },
    release: (box) => {
      claimed.delete(keyOf(box));
    },
    endLater: (_host, box) => {
      // The tracker has just listed it. Close only the box that was claimed, and
      // only while it still reads as it did when it was claimed.
      const was = claimed.get(keyOf(box));
      if (!was) throw new Error('the box was not claimed');
      if (!same(readShape(box), was)) throw new Error('the box changed since it was claimed');
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
  /** The window's client IAccessible; null when there is none or its thread didn't answer in time. */
  fromWindow(hwnd: bigint, timeoutMs: number): O | null;
  /**
   * Whether the box's thread answers a message within the time left. The calls
   * below are COM calls into that thread with no timeout of their own; this is
   * asked before each one, so a thread that stops answering costs at most the
   * call already in flight.
   */
  answering(hwnd: bigint, timeoutMs: number): boolean;
  childCount(acc: O): number;
  /**
   * AccessibleChildren. Every returned object is a reference the caller
   * releases; on a throw, the implementation has released what it took.
   */
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
 * reference taken is released on every path, each release on its own. Past
 * `budgetMs` (checked after each call; the first call itself is bounded by
 * it) or `MAX_CHILDREN`, the read is abandoned and throws.
 */
export function readAccChildren<O>(
  com: ComCalls<O>,
  hwnd: bigint,
  budgetMs: number,
  now: () => number,
  onReleaseError: (err: unknown) => void = () => undefined,
): AccChild[] {
  const started = now();
  const within = (what: string): void => {
    const left = budgetMs - (now() - started);
    if (left <= 0) throw new Error(`MSAA read took over ${budgetMs} ms (at ${what})`);
    if (!com.answering(hwnd, left)) throw new Error(`the box's thread did not answer (at ${what})`);
  };
  const root = com.fromWindow(hwnd, budgetMs);
  if (root === null) throw new Error('no MSAA object for the box, or its thread did not answer in time');
  const held: O[] = [root];
  try {
    within('fromWindow');
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
    for (const obj of held) {
      try {
        com.release(obj);
      } catch (err) {
        onReleaseError(err);
      }
    }
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
  decode(value: unknown, offsetOrType: unknown, typeOrLen?: unknown, len?: number): unknown;
  alloc(type: unknown, n: number): unknown;
  free(value: unknown): void;
  address(pointer: unknown): bigint;
}

/** A LONG: passed sign-extended, as servers compare lParam with it. */
const OBJID_CLIENT = -4;
const WM_NULL = 0x0000;
const GW_OWNER = 4;
const WM_CLOSE = 0x0010;
const WM_GETOBJECT = 0x003d;
const SMTO_ABORTIFHUNG = 0x0002;
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
  const GetWindow = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32 cmd)');
  const PostMessageW = user32.func('bool __stdcall PostMessageW(intptr hwnd, uint32 msg, uintptr wparam, intptr lparam)');
  const SendMessageTimeoutW = user32.func('intptr __stdcall SendMessageTimeoutW(intptr hwnd, uint32 msg, uintptr wparam, intptr lparam, uint32 flags, uint32 timeout, _Out_ uintptr *result)');
  const MB_GetString = user32.func('const char16_t * __stdcall MB_GetString(uint32 button)');

  // Named for the protos below, which pass a VARIANT by value (24 bytes on x64:
  // vt, three reserved words, then the value).
  koffi.struct('WmuxGuid', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: koffi.array('uint8', 8) });
  koffi.struct('WmuxVariant', { vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', val: 'uint64', pad: 'uint64' });
  // The same layout with the value read as a pointer, for AccessibleChildren's output.
  const VARIANT_PTR = koffi.struct('WmuxVariantPtr', { vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', val: 'void *', pad: 'uint64' });
  const ObjectFromLresult = oleacc.func('long __stdcall ObjectFromLresult(uintptr result, WmuxGuid *riid, uintptr wparam, _Out_ void **ppv)');
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
  const isNull = (p: unknown): boolean => !p || koffi.address(p) === 0n;
  const release = (obj: unknown): void => {
    if (!isNull(obj)) koffi.call(method(obj, SLOT_RELEASE), Release, obj);
  };

  const com: ComCalls<unknown> = {
    fromWindow: (hwnd, timeoutMs) => {
      // Not AccessibleObjectFromWindow: its WM_GETOBJECT is an untimed SendMessage
      // to the box's thread. This one gives up if that thread doesn't answer.
      const lresult: bigint[] = [0n];
      const answered = SendMessageTimeoutW(hwnd, WM_GETOBJECT, 0n, OBJID_CLIENT, SMTO_ABORTIFHUNG, timeoutMs, lresult);
      if (!Number(answered) || !lresult[0]) return null;
      const out: unknown[] = [null];
      const hr = ObjectFromLresult(lresult[0], IID_IAccessible, 0n, out);
      return Number(hr) >= 0 && !isNull(out[0]) ? out[0] : null;
    },
    answering: (hwnd, timeoutMs) => {
      const result: bigint[] = [0n];
      return Boolean(Number(SendMessageTimeoutW(hwnd, WM_NULL, 0n, 0n, SMTO_ABORTIFHUNG, Math.max(1, Math.round(timeoutMs)), result)));
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
        const items = koffi.decode(buf, VARIANT_PTR, got[0]) as Array<{ vt: number; val: unknown }>;
        const out: Array<ComChild<unknown>> = [];
        try {
          for (const item of items) {
            if (item.vt === VT_DISPATCH && !isNull(item.val)) out.push({ kind: 'object', dispatch: item.val });
            else if (item.vt === VT_I4) out.push({ kind: 'element', id: isNull(item.val) ? 0 : Number(koffi.address(item.val) & 0xffffffffn) });
            // A null dispatch, or a type AccessibleChildren doesn't document: an element no match accepts.
            else out.push({ kind: 'element', id: -1 });
          }
        } catch (err) {
          // Every dispatch in the array is a reference this call took: give them back.
          for (const item of items) {
            if (item.vt !== VT_DISPATCH) continue;
            try {
              release(item.val);
            } catch {
              // The read fails anyway; the next release is still tried.
            }
          }
          throw err;
        }
        return out;
      } finally {
        koffi.free(buf);
      }
    },
    asAccessible: (dispatch) => {
      const out: unknown[] = [null];
      const hr = koffi.call(method(dispatch, SLOT_QUERY_INTERFACE), QueryInterface, dispatch, IID_IAccessible, out);
      return Number(hr) >= 0 && !isNull(out[0]) ? out[0] : null;
    },
    role: (acc, childId) => {
      const out: { val?: unknown } = {};
      ok(koffi.call(method(acc, SLOT_ROLE), GetRole, acc, childVariant(childId), out), 'get_accRole');
      return Number(BigInt(out.val as bigint) & 0xffffffffn);
    },
    name: (acc, childId) => {
      const out: unknown[] = [null];
      ok(koffi.call(method(acc, SLOT_NAME), GetName, acc, childVariant(childId), out), 'get_accName');
      if (isNull(out[0])) return '';
      try {
        return String(koffi.decode(out[0], 'char16_t', -1));
      } finally {
        SysFreeString(out[0]);
      }
    },
    release,
  };

  let labels: { ok: string; cancel: string } | null | undefined;
  return {
    ownPid: () => process.pid,
    dialogWindows: () => {
      const out: bigint[] = [];
      let after = 0n;
      // Top-level windows of the dialog class, in Z order; bounded in case the list changes under us.
      for (let i = 0; i < 256; i++) {
        after = hwnd32(FindWindowExW(0n, after, '#32770', null) as bigint | number);
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
    ownerOf: (hwnd) => hwnd32(GetWindow(hwnd, GW_OWNER) as bigint | number),
    childOfClass: (hwnd, className) => hwnd32(FindWindowExW(hwnd, 0n, className, null) as bigint | number),
    accChildren: (hwnd, budgetMs) => {
      // Cross-thread COM on main's thread: log what each read costs.
      const started = performance.now();
      let outcome = 'failed';
      try {
        const kids = readAccChildren(com, hwnd, budgetMs, () => performance.now(), (err) => {
          console.warn(`[dialog-sheets] MSAA release failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        outcome = `${kids.length} children`;
        return kids;
      } finally {
        console.log(`[dialog-sheets] MSAA read: ${outcome} in ${(performance.now() - started).toFixed(2)} ms`);
      }
    },
    commonLabels: () => {
      if (labels === undefined) {
        // MB_GetString(0) and (1): the localized OK and Cancel that common buttons show.
        const okLabel = MB_GetString(0);
        const cancelLabel = MB_GetString(1);
        labels = typeof okLabel === 'string' && typeof cancelLabel === 'string' && okLabel && cancelLabel
          ? { ok: okLabel, cancel: cancelLabel }
          : null;
      }
      return labels;
    },
    hostOf: (host) => hwnd32(host.getNativeWindowHandle().readBigUInt64LE(0)),
    postClose: (hwnd) => Boolean(PostMessageW(hwnd, WM_CLOSE, 0n, 0n)),
    now: () => Date.now(),
  };
}
