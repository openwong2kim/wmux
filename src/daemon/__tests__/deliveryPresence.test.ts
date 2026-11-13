// @wmux-lane unit
// The platform is an injected value here; no OS call is made, so Windows cannot change the result.
// The daemon's tiers for a delivery: a tracked agent process in the
// foreground, else (nothing attributed) the agent's composer on the current
// screen, else none. A tracked process that ended always wins over the screen.
import { describe, expect, it } from 'vitest';
import { deliveryPresence, type DeliveryPresenceDeps, type PresenceSession } from '../deliveryPresence';

const COMPOSER = ['⏺ Done.', '', '──────────', '❯ ', '──────────', '  ? for shortcuts'];
const SHELL = ['⏺ Done.', '', '──────────', '❯ ', '──────────', '  ? for shortcuts', 'user@host ~ % '];

function deps(over: Partial<DeliveryPresenceDeps> & { s?: Partial<PresenceSession> } = {}): DeliveryPresenceDeps & { probes: number } {
  const d = {
    probes: 0,
    session: () => ({ shellPid: 10, exec: false, commandRunning: undefined, namedSlug: 'claude' as const, ...over.s }),
    tracked: () => ({ alive: true, slug: 'claude' as const }),
    probe: async () => { d.probes++; },
    agentRunning: async () => true,
    agentPid: () => 42,
    holdsForeground: async () => true,
    screenRows: async () => COMPOSER,
    platform: 'darwin' as NodeJS.Platform,
    ...over,
  };
  return d;
}

describe('deliveryPresence', () => {
  it('a tracked agent running in the foreground is the process tier, with no probe', async () => {
    const d = deps();
    expect(await deliveryPresence(d, 'p', 'claude')).toEqual({ tier: 'process', slug: 'claude' });
    expect(d.probes).toBe(0);
  });

  it('an ended tracked agent is none, whatever the screen still shows', async () => {
    const d = deps({ tracked: () => ({ alive: false, slug: 'claude' }) });
    expect(await deliveryPresence(d, 'p', 'claude')).toEqual({ tier: 'none', reason: 'agent-ended' });
    expect(d.probes).toBe(1);
  });

  it('a stopped agent, or one behind the shell (^Z), is none', async () => {
    expect(await deliveryPresence(deps({ agentRunning: async () => false }), 'p', undefined)).toEqual({ tier: 'none', reason: 'not-running' });
    expect(await deliveryPresence(deps({ holdsForeground: async () => false }), 'p', undefined)).toEqual({ tier: 'none', reason: 'not-foreground' });
    expect(await deliveryPresence(deps({ holdsForeground: async () => undefined }), 'p', undefined)).toEqual({ tier: 'none', reason: 'not-foreground' });
  });

  it('Windows has no foreground read: a running tracked agent is enough there', async () => {
    const d = deps({ platform: 'win32', holdsForeground: async () => false });
    expect(await deliveryPresence(d, 'p', undefined)).toEqual({ tier: 'process', slug: 'claude' });
  });

  it('another agent than the one addressed is none', async () => {
    expect(await deliveryPresence(deps(), 'p', 'codex')).toEqual({ tier: 'none', reason: 'other-agent' });
  });

  it('nothing attributed: the fresh screen decides, the shell prompt and a shell row under the composer refuse', async () => {
    const untracked = { tracked: () => undefined };
    expect(await deliveryPresence(deps(untracked), 'p', undefined)).toEqual({ tier: 'screen', slug: 'claude' });
    expect(await deliveryPresence(deps({ ...untracked, screenRows: async () => SHELL }), 'p', undefined)).toEqual({ tier: 'none', reason: 'no-screen-proof' });
    expect(await deliveryPresence(deps({ ...untracked, s: { commandRunning: false } }), 'p', undefined)).toEqual({ tier: 'none', reason: 'shell-at-prompt' });
    expect(await deliveryPresence(deps({ ...untracked, screenRows: async () => null }), 'p', undefined)).toEqual({ tier: 'none', reason: 'no-screen-proof' });
  });

  it('nothing attributed and no agent the screen can be read for: none', async () => {
    const untracked = { tracked: () => undefined };
    expect(await deliveryPresence(deps({ ...untracked, s: { namedSlug: undefined } }), 'p', undefined)).toEqual({ tier: 'none', reason: 'no-screen-proof' });
    expect(await deliveryPresence(deps({ ...untracked, s: { namedSlug: 'gemini' } }), 'p', undefined)).toEqual({ tier: 'none', reason: 'no-screen-proof' });
  });

  it('an exec unit is its own agent; a gone session is none', async () => {
    expect(await deliveryPresence(deps({ s: { exec: true } }), 'p', undefined)).toEqual({ tier: 'process', slug: 'claude' });
    expect(await deliveryPresence(deps({ session: () => undefined }), 'p', undefined)).toEqual({ tier: 'none', reason: 'no-session' });
  });
});
