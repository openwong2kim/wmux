import { describe, expect, it } from 'vitest';
import { relayFullIn, relayFullMessage } from '../relayFull';

describe('relayFullIn', () => {
  const full = relayFullMessage(64);

  it('reads the relay refusal as main answers it, with or without the RPC method before it', () => {
    expect(relayFullIn(new Error(`browser.cdp.info: CdpPipeRelay: ${full}`))).toBe(full);
    expect(relayFullIn(`CdpPipeRelay: ${full}`)).toBe(full);
  });

  it('is never fooled by the same text quoted inside another error', () => {
    expect(relayFullIn(new Error(`page.goto: title "CdpPipeRelay: ${full}"`))).toBeNull();
    expect(relayFullIn(new Error(`net error: CdpPipeRelay: ${full}`))).toBeNull();
    expect(relayFullIn(new Error(`browser.cdp.info: ${full}`))).toBeNull();
    expect(relayFullIn(undefined)).toBeNull();
  });
});
