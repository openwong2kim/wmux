/**
 * #3280: the install hook relaunches the app through the shell, never as its
 * own child, and not at all when Squirrel's firstrun does (squirrelRelaunch.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FIRSTRUN_RELAUNCH_ENV,
  RELAUNCH_HOOK_DEADLINE_MS,
  RELAUNCH_WAIT_MS,
  hookShouldRelaunch,
  relaunchWaitMs,
  relaunchWithoutInheritance,
} from '../squirrelRelaunch';

const EXE = 'C:\\Users\\u\\AppData\\Local\\wmux\\app-4.16.0\\wmux.exe';

afterEach(() => vi.restoreAllMocks());

describe('hookShouldRelaunch', () => {
  it('relaunches unless the in-app updater said firstrun will', () => {
    expect(hookShouldRelaunch({})).toBe(true);
    expect(hookShouldRelaunch({ [FIRSTRUN_RELAUNCH_ENV]: '0' })).toBe(true);
    expect(hookShouldRelaunch({ [FIRSTRUN_RELAUNCH_ENV]: '1' })).toBe(false);
  });
});

describe('relaunchWaitMs', () => {
  it('waits the full cap early in the hook, and less as Squirrel\'s cancel nears', () => {
    expect(relaunchWaitMs(2_000)).toBe(RELAUNCH_WAIT_MS);
    expect(relaunchWaitMs(RELAUNCH_HOOK_DEADLINE_MS - 2_500)).toBe(2_500);
    expect(relaunchWaitMs(RELAUNCH_HOOK_DEADLINE_MS + 4_000)).toBe(1_000);
  });
});

describe('relaunchWithoutInheritance', () => {
  it('opens the exe through the shell and logs success', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const openPath = vi.fn(async () => '');
    await relaunchWithoutInheritance(EXE, openPath);
    expect(openPath).toHaveBeenCalledWith(EXE);
    expect(log).toHaveBeenCalledWith('[Squirrel] relaunched through the shell');
  });

  it('logs the shell\'s error text before resolving', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await relaunchWithoutInheritance(EXE, async () => 'Access is denied.');
    expect(warn).toHaveBeenCalledWith('[Squirrel] relaunch failed: Access is denied.');
  });

  it('never rejects, even when openPath throws or rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(relaunchWithoutInheritance(EXE, () => { throw new Error('boom'); })).resolves.toBeUndefined();
    await expect(relaunchWithoutInheritance(EXE, () => Promise.reject(new Error('gone')))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[Squirrel] relaunch failed: boom');
    expect(warn).toHaveBeenCalledWith('[Squirrel] relaunch failed: gone');
  });

  it('gives up waiting after the cap, so the hook still exits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await relaunchWithoutInheritance(EXE, () => new Promise<string>(() => undefined), 20);
    expect(warn).toHaveBeenCalledWith('[Squirrel] relaunch failed: no answer from the shell after 20 ms');
  });
});
