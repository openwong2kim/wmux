import { afterEach, describe, expect, it } from 'vitest';
import { installScreenReader, screenReaderOn, setScreenReaderOn, subscribeScreenReader } from '../screenReader';

afterEach(() => setScreenReaderOn(false));

function fakeApi(answer: Promise<boolean>) {
  let push: (on: boolean) => void = () => undefined;
  let unsubscribed = false;
  return {
    api: {
      getScreenReader: () => answer,
      onScreenReaderChanged: (cb: (on: boolean) => void) => { push = cb; return () => { unsubscribed = true; }; },
    },
    push: (on: boolean) => push(on),
    unsubscribed: () => unsubscribed,
  };
}

describe('screenReader mirror', () => {
  it('is off until main answers, then follows its changes', async () => {
    const f = fakeApi(Promise.resolve(true));
    const seen: boolean[] = [];
    const off = subscribeScreenReader(() => seen.push(screenReaderOn()));
    expect(screenReaderOn()).toBe(false);
    const uninstall = installScreenReader(f.api);
    await Promise.resolve();
    await Promise.resolve();
    expect(screenReaderOn()).toBe(true);
    f.push(false);
    expect(screenReaderOn()).toBe(false);
    expect(seen).toEqual([true, false]);
    uninstall();
    off();
    expect(f.unsubscribed()).toBe(true);
  });

  it('keeps a change that arrived before the first answer', async () => {
    let answer: (on: boolean) => void = () => undefined;
    const f = fakeApi(new Promise<boolean>((r) => { answer = r; }));
    const uninstall = installScreenReader(f.api);
    f.push(true);
    answer(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(screenReaderOn()).toBe(true);
    uninstall();
  });
});
