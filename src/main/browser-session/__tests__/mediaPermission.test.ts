// Browser panes' sessions refuse camera and microphone; wmux's own window's
// session is left alone.
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ listeners: [] as Array<(ses: unknown) => void>, defaultSession: { name: 'default' } }));

vi.mock('electron', () => ({
  app: { on: (event: string, fn: (ses: unknown) => void) => { if (event === 'session-created') electron.listeners.push(fn); } },
  session: { get defaultSession() { return electron.defaultSession; } },
}));

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
    // Electron 45 reports a screen, window or tab capture as display-capture.
    expect(ask(ses, 'display-capture')).toBe(false);
    expect(ses.handlers.check?.(null, 'display-capture')).toBe(false);
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
