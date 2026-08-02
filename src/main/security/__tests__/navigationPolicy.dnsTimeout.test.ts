import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DNS_LOOKUP_TIMEOUT_MS,
  validateResolvedNavigationUrl,
} from '../navigationPolicy';
import { TIMEOUT_MS as CLI_RPC_TIMEOUT_MS } from '../../../cli/client';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

/**
 * #756. `browser.navigate` reported `RPC timeout: browser.navigate (10000ms)`
 * for a hostname whose DNS lookup took ~11s and then failed. The guard's
 * lookup was unbounded, so the caller's socket deadline always won the race
 * and named the transport instead of the actual failure.
 *
 * The bug was a RELATIONSHIP between two numbers that never referenced each
 * other, so these tests assert the relationship, not the literals — and they
 * drive a genuinely hostile resolver rather than mocking the wait away, since
 * the wait is the thing under test.
 */
describe('navigation DNS guard is bounded (#756)', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('gives up on a resolver that never answers, instead of waiting forever', async () => {
    vi.useFakeTimers();
    // A resolver that never settles — the exact hostile input that produced
    // the bug. Not a stub of the timeout logic; that runs for real.
    lookupMock.mockImplementation(() => new Promise(() => { /* never settles */ }));

    const pending = validateResolvedNavigationUrl('https://never-answers.example');
    let settled = false;
    void pending.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(DNS_LOOKUP_TIMEOUT_MS - 1);
    expect(settled).toBe(false); // still inside its budget

    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/did not answer within/);
    // The reason must name DNS, so the caller is not sent looking at the pipe.
    expect(result.reason).toMatch(/DNS/);
  });

  it('reports a resolver failure as a DNS failure, not a transport failure', async () => {
    lookupMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND nope.example'));

    const result = await validateResolvedNavigationUrl('https://nope.example');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Failed to resolve hostname');
    expect(result.reason).toContain('ENOTFOUND');
  });

  it('still refuses the destination it could not verify', async () => {
    vi.useFakeTimers();
    lookupMock.mockImplementation(() => new Promise(() => { /* never settles */ }));

    const pending = validateResolvedNavigationUrl('https://unverifiable.example');
    await vi.advanceTimersByTimeAsync(DNS_LOOKUP_TIMEOUT_MS + 1);

    // Fail CLOSED: an unverified host is refused, never allowed through on the
    // grounds that the check merely timed out.
    await expect(pending).resolves.toMatchObject({ valid: false });
  });

  it('leaves a fast lookup completely unaffected', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://fast.example'))
      .resolves.toEqual({ valid: true });
  });

  it('keeps the DNS budget strictly inside the tightest client deadline', () => {
    // THE regression guard. #756 existed because a client deadline sat in
    // front of a longer server-side wait and neither knew about the other.
    // The CLI is the tightest client; if someone lowers it, or raises the DNS
    // budget, this fails here rather than as a misleading timeout in the field.
    expect(DNS_LOOKUP_TIMEOUT_MS).toBeLessThan(CLI_RPC_TIMEOUT_MS);
    // Not merely smaller — enough headroom left for the navigation itself.
    expect(CLI_RPC_TIMEOUT_MS - DNS_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
  });
});
