// @vitest-environment jsdom
//
// The phone grants (conversation access, photo upload) as the mounted toggle
// drives them: a running server is changed in place through setGrants, and a
// Start after a running server sends the grants that server actually had —
// a server started with `wmux web --allow-transcript` must not come back
// from a desktop Stop → Start with the phone Chat view silently off.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WebToggle from '../WebToggle';
import type { WebTerminalInfo } from '../../../../shared/web';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let status: WebTerminalInfo;
const setGrants = vi.fn();
const start = vi.fn();
const stop = vi.fn();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setGrants.mockReset();
  start.mockReset();
  stop.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    web: {
      status: vi.fn(async () => status),
      start,
      stop,
      setGrants,
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountAndOpen(): Promise<void> {
  await act(async () => root.render(createElement(WebToggle)));
  await flush();
  const button = container.querySelector('[data-testid="deck-web-toggle"]') as HTMLButtonElement;
  await act(async () => button.click());
  await flush();
}

function buttonNamed(text: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent === text);
  if (!b) throw new Error(`no button ${text}`);
  return b;
}

function checkbox(labelText: string): HTMLButtonElement {
  const label = Array.from(document.querySelectorAll('label')).find((l) => l.textContent === labelText);
  if (!label) throw new Error(`no label ${labelText}`);
  return document.getElementById((label as HTMLLabelElement).htmlFor) as HTMLButtonElement;
}

const running: WebTerminalInfo = {
  running: true,
  host: '127.0.0.1',
  port: 7681,
  urls: ['http://127.0.0.1:7681/?token=t'],
  allowInput: false,
  allowTranscript: false,
  allowUpload: true,
  allowDangerousLaunch: true,
};

describe('WebToggle phone grants', () => {
  it('applies a grant to the running server and shows what the server reports back', async () => {
    status = running;
    setGrants.mockResolvedValue({ ...running, allowTranscript: true });
    await mountAndOpen();

    const transcript = checkbox('Conversation access');
    expect(transcript.getAttribute('aria-checked')).toBe('false');
    await act(async () => transcript.click());
    await flush();

    expect(setGrants).toHaveBeenCalledWith({ allowTranscript: true });
    expect(start).not.toHaveBeenCalled();
    expect(checkbox('Conversation access').getAttribute('aria-checked')).toBe('true');
    // Upload was not touched and is not sent.
    expect(checkbox('Photo & file upload').getAttribute('aria-checked')).toBe('true');
    // A dangerous-launch ceiling that is on opens its disclosure: never hidden.
    expect(checkbox('Dangerous launch').getAttribute('aria-checked')).toBe('true');
  });

  it('Allow input also applies to the running server in place', async () => {
    status = running;
    setGrants.mockResolvedValue({ ...running, allowInput: true });
    await mountAndOpen();
    await act(async () => checkbox('Allow input').click());
    await flush();
    expect(setGrants).toHaveBeenCalledWith({ allowInput: true });
    expect(checkbox('Allow input').getAttribute('aria-checked')).toBe('true');
  });

  it('a Start after a running server sends the grants that server had', async () => {
    status = { ...running, allowTranscript: true, allowUpload: false };
    stop.mockResolvedValue({ running: false });
    start.mockResolvedValue(status);
    await mountAndOpen();

    await act(async () => buttonNamed('Stop').click());
    await flush();
    await act(async () => buttonNamed('Start').click());
    await flush();

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ allowTranscript: true, allowUpload: false, allowDangerousLaunch: true }),
    );
  });
});
