// Browser panes' sessions refuse camera and microphone; wmux's own window's
// session is left alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  listeners: [] as Array<(ses: unknown) => void>,
  defaultSession: { name: 'default' } as Record<string, unknown>,
  ready: false,
  toastsAllowed: true,
}));

vi.mock('electron', () => ({
  app: {
    on: (event: string, fn: (ses: unknown) => void) => { if (event === 'session-created') electron.listeners.push(fn); },
    isReady: () => electron.ready,
  },
  session: { get defaultSession() { return electron.defaultSession; } },
}));
vi.mock('../../notification/osToastGate', () => ({ osToastsAllowed: () => electron.toastsAllowed }));

import { denyMediaOutsideMainWindow, denyMediaPermissions } from '../mediaPermission';

function fakeSession() {
  const handlers: { request?: (wc: unknown, p: string, cb: (ok: boolean) => void) => void; check?: (wc: unknown, p: string) => boolean } = {};
  return {
    handlers,
    setPermissionRequestHandler: vi.fn((fn) => { handlers.request = fn; }),
    setPermissionCheckHandler: vi.fn((fn) => { handlers.check = fn; }),
  };
}

const ask = (ses: ReturnType<typeof fakeSession>, permission: string) => {
  let answer: boolean | undefined;
  ses.handlers.request?.(null, permission, (ok) => { answer = ok; });
  return answer;
};

describe('browser panes and media', () => {
  it('a media request and check are refused; other permissions are approved as before', () => {
    const ses = fakeSession();
    denyMediaPermissions(ses as never);
    expect(ask(ses, 'media')).toBe(false);
    expect(ses.handlers.check?.(null, 'media')).toBe(false);
    expect(ask(ses, 'notifications')).toBe(true);
    expect(ask(ses, 'clipboard-sanitized-write')).toBe(true);
    expect(ses.handlers.check?.(null, 'fullscreen')).toBe(true);
  });

  it('every new session but the main window\'s gets the policy', () => {
    denyMediaOutsideMainWindow();
    const browser = fakeSession();
    const main = Object.assign(electron.defaultSession, fakeSession());
    for (const fn of electron.listeners) {
      fn(browser);
      fn(main);
    }
    expect(ask(browser, 'media')).toBe(false);
    expect(main.setPermissionRequestHandler).not.toHaveBeenCalled();
    expect(main.setPermissionCheckHandler).not.toHaveBeenCalled();
  });
});

// #2964: a page's Notification API reaches the same Electron toast setup that
// writes the installed app's Start Menu link.
describe('notifications where OS toasts are not allowed (isolated packaged copy on Windows)', () => {
  beforeEach(() => {
    electron.listeners.length = 0;
    electron.ready = false;
    electron.toastsAllowed = false;
  });
  afterEach(() => {
    electron.toastsAllowed = true;
    electron.defaultSession = { name: 'default' };
  });

  it('browser sessions refuse notifications as well as media; the rest stays approved', () => {
    const ses = fakeSession();
    denyMediaPermissions(ses as never);
    expect(ask(ses, 'notifications')).toBe(false);
    expect(ses.handlers.check?.(null, 'notifications')).toBe(false);
    expect(ask(ses, 'media')).toBe(false);
    expect(ask(ses, 'clipboard-sanitized-write')).toBe(true);
  });

  it("wmux's own window refuses only notifications; it keeps the microphone", () => {
    denyMediaOutsideMainWindow();
    const main = Object.assign(electron.defaultSession, fakeSession()) as unknown as ReturnType<typeof fakeSession>;
    for (const fn of electron.listeners) fn(main);
    expect(ask(main, 'notifications')).toBe(false);
    expect(main.handlers.check?.(null, 'notifications')).toBe(false);
    expect(ask(main, 'media')).toBe(true);
  });

  it('installed after ready, the existing default session is covered too', () => {
    electron.ready = true;
    const main = Object.assign(electron.defaultSession, fakeSession()) as unknown as ReturnType<typeof fakeSession>;
    denyMediaOutsideMainWindow();
    expect(ask(main, 'notifications')).toBe(false);
  });

  it('the installed app (toasts allowed) leaves its own window alone even after ready', () => {
    electron.toastsAllowed = true;
    electron.ready = true;
    const main = Object.assign(electron.defaultSession, fakeSession()) as unknown as ReturnType<typeof fakeSession>;
    denyMediaOutsideMainWindow();
    for (const fn of electron.listeners) fn(main);
    expect(main.setPermissionRequestHandler).not.toHaveBeenCalled();
  });
});
