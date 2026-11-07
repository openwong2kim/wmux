// @wmux-lane unit — every user32 and MSAA call goes through a fake; nothing here reaches the OS.
import { describe, expect, it } from 'vitest';
import type { BrowserWindow } from 'electron';
import { createSheetTracker, SHEET_RETRY_WINDOW_MS } from '../dialogSheets';
import {
  createWin32BoxPort,
  MSAA_BUDGET_MS,
  readAccChildren,
  ROLE_STATICTEXT,
  ROLE_WINDOW,
  type AccChild,
  type ComCalls,
  type ComChild,
  type Win32Calls,
} from '../dialogSheets.win32';

// A fake desktop. Electron shows a page's alert and confirm as a TaskDialog: a
// #32770 of our pid with a DirectUIHWND child, whose MSAA children are the
// message and one window per button (labels localized). The first box is owned
// by the tab's window; one opened while another is up is unowned.

const OUR_PID = 4242;

interface FakeBox {
  hwnd: bigint;
  pid: number;
  owner: bigint;
  visible: boolean;
  /** No DirectUIHWND: a classic MessageBox or anything else. */
  classic?: boolean;
  children: AccChild[];
  /** accChildren throws for this box. */
  unreadable?: boolean;
}

const text = (name: string): AccChild => ({ role: ROLE_STATICTEXT, name });
const button = (name: string): AccChild => ({ role: ROLE_WINDOW, name });
const alertKids = (message: string): AccChild[] => [text(message), button('확인')];
const confirmKids = (message: string): AccChild[] => [text(message), button('확인'), button('취소')];

function rig() {
  let nextHwnd = 0x1000n;
  const hosts = new Map<BrowserWindow, bigint>();
  const boxes: FakeBox[] = [];
  const posted: bigint[] = [];
  const timers: Array<() => void> = [];
  const logs: string[] = [];
  let clock = 0;

  const host = (): BrowserWindow => {
    const h = { id: hosts.size + 1 } as unknown as BrowserWindow;
    hosts.set(h, nextHwnd++);
    return h;
  };
  const hwndOf = (h: BrowserWindow): bigint => hosts.get(h) as bigint;
  const find = (hwnd: bigint): FakeBox | undefined => boxes.find((b) => b.hwnd === hwnd);

  const win: Win32Calls = {
    ownPid: () => OUR_PID,
    // Z order: the newest on top.
    dialogWindows: () => [...boxes].reverse().map((b) => b.hwnd),
    pidOf: (hwnd) => find(hwnd)?.pid ?? 0,
    isVisible: (hwnd) => find(hwnd)?.visible ?? false,
    ownerOf: (hwnd) => find(hwnd)?.owner ?? 0n,
    childOfClass: (hwnd, cls) => {
      const box = find(hwnd);
      if (box) return cls === 'DirectUIHWND' && !box.classic ? hwnd + 0x10000n : 0n;
      return 0n;
    },
    accChildren: (content) => {
      const box = find(content - 0x10000n);
      if (!box || box.unreadable) throw new Error('MSAA read failed');
      return box.children.map((c) => ({ ...c }));
    },
    hostOf: hwndOf,
    postClose: (hwnd) => {
      posted.push(hwnd);
      // WM_CLOSE is handled on the box's own loop, a moment later.
      timers.push(() => {
        const i = boxes.findIndex((b) => b.hwnd === hwnd);
        if (i >= 0) boxes.splice(i, 1);
      });
      return true;
    },
  };
  const port = createWin32BoxPort(win);
  const tracker = createSheetTracker<BrowserWindow, ReturnType<typeof port.list>[number]>({
    port: () => port,
    schedule: (fn, ms) => { timers.push(() => { clock += ms; fn(); }); },
    now: () => clock,
    warn: (m) => { logs.push(m); },
  });

  /** A box appears on screen. */
  const show = (box: Partial<FakeBox> & { children: AccChild[] }): FakeBox => {
    const b: FakeBox = { hwnd: nextHwnd++, pid: OUR_PID, owner: 0n, visible: true, ...box };
    boxes.push(b);
    return b;
  };
  /** Run whatever is due: retries and closes. */
  const settle = (): void => {
    for (let i = 0; i < 50 && timers.length; i++) timers.splice(0, timers.length).forEach((t) => t());
  };
  const showing = (b: FakeBox): boolean => boxes.includes(b);
  return { win, port, tracker, host, hwndOf, show, settle, showing, posted, logs, advance: (ms: number) => { clock += ms; } };
}

describe('the Windows box port with the tracker', () => {
  it('rows 1–5: an answered alert or confirm closes its box, and only that box', () => {
    for (const [type, kids] of [['alert', alertKids], ['confirm', confirmKids]] as const) {
      const r = rig();
      const tab = r.host();
      r.tracker.trackOpening('s1', tab, `fixture ${type}`, type);
      // The box shows up ~60–130 ms after the CDP event, owned by the tab's window.
      const box = r.show({ owner: r.hwndOf(tab), children: kids(`fixture ${type}`) });
      r.settle();
      expect(r.logs.some((l) => l.includes('paired'))).toBe(true);
      r.tracker.closeIfStale('s1');
      r.settle();
      expect(r.posted).toEqual([box.hwnd]);
      expect(r.showing(box)).toBe(false);
    }
  });

  it('a stacked alert-then-confirm: the unowned second box is claimed by its own dialog, and each closes on its own answer', () => {
    const r = rig();
    const tab = r.host();
    r.tracker.trackOpening('s1', tab, 'first', 'alert');
    const first = r.show({ owner: r.hwndOf(tab), children: alertKids('first') });
    r.settle();
    // The next dialog opens while the first box is still up: its box has no owner.
    r.tracker.trackOpening('s2', tab, 'second', 'confirm');
    const second = r.show({ owner: 0n, children: confirmKids('second') });
    r.settle();
    r.tracker.closeIfStale('s2');
    r.settle();
    expect(r.posted).toEqual([second.hwnd]);
    expect(r.showing(first)).toBe(true);
    r.tracker.closeIfStale('s1');
    r.settle();
    expect(r.posted).toEqual([second.hwnd, first.hwnd]);
  });

  it('row 7: a dialog nobody answered keeps its box', () => {
    const r = rig();
    const tab = r.host();
    r.tracker.trackOpening('s1', tab, 'no agent', 'alert');
    const box = r.show({ owner: r.hwndOf(tab), children: alertKids('no agent') });
    r.settle();
    r.advance(60_000);
    r.settle();
    expect(r.posted).toEqual([]);
    expect(r.showing(box)).toBe(true);
  });

  it('a box whose MSAA read fails stays', () => {
    const r = rig();
    const tab = r.host();
    r.tracker.trackOpening('s1', tab, 'hello', 'alert');
    const box = r.show({ owner: r.hwndOf(tab), children: alertKids('hello'), unreadable: true });
    r.settle();
    r.advance(SHEET_RETRY_WINDOW_MS + 100);
    r.settle();
    r.tracker.closeIfStale('s1');
    r.settle();
    expect(r.posted).toEqual([]);
    expect(r.showing(box)).toBe(true);
  });

  it('the same text opening on another tab: neither box is closed', () => {
    const r = rig();
    const tab = r.host();
    r.tracker.trackOpening('agent-tab', tab, 'Are you sure?', 'confirm');
    r.tracker.trackOpening('person-tab', tab, 'Are you sure?', 'confirm');
    const a = r.show({ owner: r.hwndOf(tab), children: confirmKids('Are you sure?') });
    const b = r.show({ owner: 0n, children: confirmKids('Are you sure?') });
    r.settle();
    r.tracker.closeIfStale('agent-tab');
    r.settle();
    expect(r.posted).toEqual([]);
    expect(r.showing(a) && r.showing(b)).toBe(true);
  });

  it("one of wmux's own boxes, with the page's text copied, is never closed", () => {
    const r = rig();
    const tab = r.host();
    r.tracker.trackOpening('s1', tab, 'Quit wmux?', 'confirm');
    // wmux's box carries a detail line, or other buttons, or a checkbox.
    const withDetail = r.show({ owner: r.hwndOf(tab), children: [text('Quit wmux?'), text('Sessions keep running.'), button('확인'), button('취소')] });
    const threeButtons = r.show({ owner: 0n, children: [text('Quit wmux?'), button('a'), button('b'), button('c')] });
    const withCheckbox = r.show({ owner: 0n, children: [text('Quit wmux?'), { role: 44, name: "Don't ask again" }, button('확인'), button('취소')] });
    r.settle();
    r.advance(SHEET_RETRY_WINDOW_MS + 100);
    r.settle();
    r.tracker.closeIfStale('s1');
    r.settle();
    expect(r.posted).toEqual([]);
    expect([withDetail, threeButtons, withCheckbox].every(r.showing)).toBe(true);
  });

  it('a box already up before the dialog opened is never claimed', () => {
    const r = rig();
    const tab = r.host();
    const old = r.show({ owner: r.hwndOf(tab), children: alertKids('hello') });
    r.tracker.trackOpening('s0', tab, 'unrelated', 'alert'); // a first look makes `old` known
    r.settle();
    r.tracker.trackOpening('s1', tab, 'hello', 'alert');
    r.settle();
    r.tracker.closeIfStale('s1');
    r.settle();
    expect(r.posted).toEqual([]);
    expect(r.showing(old)).toBe(true);
  });
});

describe('createWin32BoxPort', () => {
  it("lists only this process's visible TaskDialogs owned by the window or by nobody, oldest first", () => {
    const r = rig();
    const tab = r.host();
    const otherWindow = r.host();
    const a = r.show({ owner: r.hwndOf(tab), children: alertKids('a') });
    r.show({ owner: r.hwndOf(tab), children: alertKids('other pid'), pid: 7 });
    r.show({ owner: r.hwndOf(tab), children: alertKids('hidden'), visible: false });
    r.show({ owner: r.hwndOf(tab), children: alertKids('classic'), classic: true });
    r.show({ owner: r.hwndOf(otherWindow), children: alertKids('other window') });
    const b = r.show({ owner: 0n, children: alertKids('b') });
    expect(r.port.list(tab).map((x) => x.hwnd)).toEqual([a.hwnd, b.hwnd]);
  });

  it('reports a page box by button count, never by its localized labels', () => {
    const r = rig();
    const tab = r.host();
    const one = r.show({ owner: 0n, children: alertKids('m') });
    const two = r.show({ owner: 0n, children: confirmKids('m') });
    const [b1, b2] = r.port.list(tab);
    expect(one.hwnd).toBe(b1.hwnd);
    expect(two.hwnd).toBe(b2.hwnd);
    expect(r.port.shape(b1)).toEqual({ texts: ['m'], buttons: ['OK'] });
    expect(r.port.shape(b2)).toEqual({ texts: ['m'], buttons: ['Cancel', 'OK'] });
  });

  it('a window handle reused by a new box is a new key', () => {
    const r = rig();
    const tab = r.host();
    const box = r.show({ owner: 0n, children: alertKids('m') });
    const firstKey = r.port.key(r.port.list(tab)[0]);
    r.port.list(tab);
    // Gone for one look, then the same handle shows another box.
    box.visible = false;
    r.port.list(tab);
    box.visible = true;
    expect(r.port.key(r.port.list(tab)[0])).not.toBe(firstKey);
  });

  it('endLater posts WM_CLOSE only to the claimed box, still showing and unchanged', () => {
    const r = rig();
    const tab = r.host();
    const box = r.show({ owner: 0n, children: alertKids('m') });
    const [listed] = r.port.list(tab);
    expect(() => r.port.endLater(tab, listed)).toThrow('not claimed');
    r.port.retain(listed);
    box.children = alertKids('changed');
    expect(() => r.port.endLater(tab, listed)).toThrow('changed');
    box.children = alertKids('m');
    r.port.endLater(tab, listed);
    expect(r.posted).toEqual([box.hwnd]);
  });
});

// A fake COM: objects are numbers, every reference counted.
function fakeCom(boxes: number) {
  const refs = new Map<number, number>();
  let next = 1;
  const take = (): number => { const o = next++; refs.set(o, 1); return o; };
  const live = () => [...refs.values()].filter((n) => n > 0).length;
  const failOn = new Set<string>();
  let slowFor = 0;
  let clock = 0;
  const kidsOf = new Map<number, Array<{ role: number; name: string }>>();
  const com: ComCalls<number> = {
    fromWindow: () => {
      const o = take();
      const n = boxes % 2 === 0 ? 2 : 3;
      kidsOf.set(o, Array.from({ length: n }, (_, i) => ({ role: i === 0 ? ROLE_STATICTEXT : ROLE_WINDOW, name: `c${i}` })));
      return o;
    },
    childCount: (acc) => kidsOf.get(acc)?.length ?? 0,
    children: (acc): Array<ComChild<number>> => (kidsOf.get(acc) ?? []).map((_, i) => (i === 0 ? { kind: 'element', id: 1 } : { kind: 'object', dispatch: take() })),
    asAccessible: (d) => {
      if (failOn.has('qi')) return null;
      refs.set(d, (refs.get(d) ?? 0) + 1);
      return d;
    },
    role: () => {
      if (failOn.has('role')) throw new Error('get_accRole failed');
      clock += slowFor;
      return ROLE_WINDOW;
    },
    name: () => 'x',
    release: (o) => {
      const n = (refs.get(o) ?? 0) - 1;
      if (n < 0) throw new Error(`over-release of ${o}`);
      refs.set(o, n);
    },
  };
  return { com, live, failOn, setSlow: (ms: number) => { slowFor = ms; }, now: () => clock };
}

describe('readAccChildren', () => {
  it('releases every reference over 100 boxes, on success and on every failure path', () => {
    const f = fakeCom(100);
    let failures = 0;
    for (let i = 0; i < 100; i++) {
      f.failOn.clear();
      f.setSlow(0);
      if (i % 4 === 1) f.failOn.add('qi');
      if (i % 4 === 2) f.failOn.add('role');
      if (i % 4 === 3) f.setSlow(MSAA_BUDGET_MS);
      try {
        readAccChildren(f.com, 1n, MSAA_BUDGET_MS, f.now);
      } catch {
        failures++;
      }
    }
    expect(failures).toBe(75);
    expect(f.live()).toBe(0);
  });

  it('gives up past its budget', () => {
    const f = fakeCom(2);
    f.setSlow(MSAA_BUDGET_MS + 1);
    expect(() => readAccChildren(f.com, 1n, MSAA_BUDGET_MS, f.now)).toThrow(`over ${MSAA_BUDGET_MS} ms`);
    expect(f.live()).toBe(0);
  });
});
