// main's side of a phone message to Moa (`moa.wake`): a factory message goes
// to the HQ bot's taker; anything else answers moa_off (there is no Moa brain).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlePhoneMoaWake, setFactoryPhoneMessageHandler } from '../phoneMessage';

const base = { clientMessageId: 'm-1', text: 'plan today', actor: 'device:d1' };
const queued = { ok: true as const, accepted: true as const, queued: true as const };

afterEach(() => setFactoryPhoneMessageHandler(null));

describe('handlePhoneMoaWake', () => {
  it('rejects a malformed payload (the daemon validated it)', async () => {
    for (const bad of [
      { ...base, clientMessageId: '' },
      { ...base, text: '   ' },
      { ...base, actor: '' },
      { ...base, deviceId: 7 },
      { ...base, mode: 'moa' },
      // A target is both fields, a room and a thread, and only for the factory.
      { ...base, mode: 'factory', workspaceId: 'ws-1' },
      { ...base, mode: 'factory', threadId: 'dm:bot-0000aaaa' },
      { ...base, mode: 'factory', workspaceId: '../x', threadId: 'dm:bot-0000aaaa' },
      { ...base, mode: 'factory', workspaceId: 'ws-1', threadId: 'dm:nobody' },
      { ...base, workspaceId: 'ws-1', threadId: 'dm:bot-0000aaaa' },
    ]) {
      await expect(handlePhoneMoaWake(bad)).rejects.toThrow(/invalid moa\.wake payload/);
    }
  });

  it('answers moa_off for a message that is not for the factory, even with a taker installed', async () => {
    const taker = vi.fn(async () => queued);
    setFactoryPhoneMessageHandler(taker);
    expect(await handlePhoneMoaWake(base)).toEqual({ ok: false, code: 'moa_off' });
    expect(taker).not.toHaveBeenCalled();
  });

  it('answers factory_off with no taker, or when the taker says the factory is off', async () => {
    expect(await handlePhoneMoaWake({ ...base, mode: 'factory' })).toEqual({ ok: false, code: 'factory_off' });
    setFactoryPhoneMessageHandler(async () => null);
    expect(await handlePhoneMoaWake({ ...base, mode: 'factory' })).toEqual({ ok: false, code: 'factory_off' });
  });

  it('hands the taker exactly the validated fields and returns its answer', async () => {
    const taker = vi.fn(async () => queued);
    setFactoryPhoneMessageHandler(taker);
    expect(await handlePhoneMoaWake({ ...base, mode: 'factory', deviceId: 'd1', extra: 'dropped' })).toEqual(queued);
    expect(taker).toHaveBeenCalledWith({ ...base, mode: 'factory', deviceId: 'd1' });
  });

  it('passes a conversation target through', async () => {
    const taker = vi.fn(async () => queued);
    setFactoryPhoneMessageHandler(taker);
    expect(await handlePhoneMoaWake({ ...base, mode: 'factory', workspaceId: 'ws-1', threadId: 'group:grp-0000abcd' })).toEqual(queued);
    expect(taker).toHaveBeenCalledWith({ ...base, mode: 'factory', workspaceId: 'ws-1', threadId: 'group:grp-0000abcd' });
  });

  it('answers only once the taker has finished (its wake is on disk)', async () => {
    let finish: () => void = () => undefined;
    setFactoryPhoneMessageHandler(() => new Promise((resolve) => { finish = () => resolve(queued); }));
    let answered = false;
    const pending = handlePhoneMoaWake({ ...base, mode: 'factory' }).then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 0));
    expect(answered).toBe(false);
    finish();
    expect(await pending).toEqual(queued);
  });

  it('a taker that throws or rejects answers hq_unknown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setFactoryPhoneMessageHandler(() => { throw new Error('store gone'); });
    expect(await handlePhoneMoaWake({ ...base, mode: 'factory' })).toEqual({ ok: false, code: 'hq_unknown' });
    setFactoryPhoneMessageHandler(async () => { throw new Error('store gone'); });
    expect(await handlePhoneMoaWake({ ...base, mode: 'factory' })).toEqual({ ok: false, code: 'hq_unknown' });
  });
});
