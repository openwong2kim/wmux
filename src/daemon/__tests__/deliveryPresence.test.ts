// @wmux-lane unit
// The platform is an injected value here; no OS call is made, so Windows cannot change the result.
//
// The daemon's answer for a delivery: a verified agent (a tracked process in
// the foreground, or, with nothing attributed, its plain prompt on screen with
// the cursor on it) in plain input mode, else none. The frames are Claude Code
// 2.1.322 and Codex rows as read from a live pane.
import { describe, expect, it } from 'vitest';
import { deliveryPresence, promptGrant, type DeliveryPresenceDeps, type PresenceSession } from '../deliveryPresence';
import type { DeliveryFrame } from '../deliveryComposer';

const RULE = '─'.repeat(57);
/** Claude's plain prompt, empty; the cursor on the prompt row. */
const CLAUDE_PLAIN = ['⏺ ok', '', RULE, '❯\u00a0', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'];
/** Claude in `!` shell mode with nothing typed (Ctrl+C twice after a `!` command). */
const CLAUDE_BANG = ['⏺ ok', '', RULE, '!\u00a0', RULE, '  ! for shell mode'];
const CLAUDE_DRAFT = ['⏺ ok', '', RULE, '❯\u00a0half a thought', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'];
/** A live Claude under tmux: the status line sits at column 0 under the composer. */
const CLAUDE_TMUX = [...CLAUDE_PLAIN, '[0] 0:claude*                         "host" 12:01'];

function frame(rows: string[], cursorRow = rows.findIndex((r) => r.startsWith('❯'))): DeliveryFrame {
  return { rows: Object.assign([...rows], { undimmed: rows }), cursorRow };
}

function deps(over: Partial<DeliveryPresenceDeps> & { s?: Partial<PresenceSession> } = {}): DeliveryPresenceDeps & { probes: number } {
  const d = {
    probes: 0,
    session: (): PresenceSession => ({ shellPid: 10, exec: false, commandRunning: undefined, namedSlug: 'claude', bracketedPaste: true, ...over.s }),
    tracked: () => ({ alive: true, slug: 'claude' as const }),
    probe: async () => { d.probes++; return true; },
    agentRunning: async () => true,
    ownedRoot: async () => false,
    agentPid: () => 42,
    holdsForeground: async () => true as boolean | undefined,
    frame: async (): Promise<DeliveryFrame | null> => frame(CLAUDE_PLAIN),
    platform: 'darwin' as NodeJS.Platform,
    ...over,
  };
  return d;
}

const FULL = { tier: 'process', slug: 'claude', input: 'full', bracketedPaste: true };

describe('deliveryPresence: the process tier', () => {
  it('a tracked agent running in the foreground, its plain prompt empty: the full text, no probe', async () => {
    const d = deps();
    expect(await deliveryPresence(d, 'p', 'claude')).toEqual(FULL);
    expect(d.probes).toBe(0);
  });

  it('an ended tracked agent is none, whatever the screen still shows', async () => {
    expect(await deliveryPresence(deps({ tracked: () => ({ alive: false, slug: 'claude' }) }), 'p', 'claude')).toEqual({ tier: 'none', reason: 'agent-ended' });
  });

  it('reads liveness fresh: a cached-alive agent the process table no longer shows is none', async () => {
    expect(await deliveryPresence(deps({ agentRunning: async () => false }), 'p', undefined)).toEqual({ tier: 'none', reason: 'not-running' });
  });

  it('^Z: an agent behind the shell is not-foreground; an unreadable foreground is its own reason', async () => {
    expect(await deliveryPresence(deps({ holdsForeground: async () => false }), 'p', undefined)).toEqual({ tier: 'none', reason: 'not-foreground' });
    expect(await deliveryPresence(deps({ holdsForeground: async () => undefined }), 'p', undefined)).toEqual({ tier: 'none', reason: 'foreground-unknown' });
  });

  it("`!` shell mode with an empty line is none, even for a verified process", async () => {
    expect(await deliveryPresence(deps({ frame: async () => frame(CLAUDE_BANG, 3) }), 'p', 'claude')).toEqual({ tier: 'none', reason: 'composer-mode' });
  });

  it('a draft holds at the paste; at the Enter the prompt holds our paste and passes', async () => {
    const d = deps({ frame: async () => frame(CLAUDE_DRAFT) });
    expect(await deliveryPresence(d, 'p', 'claude')).toEqual({ tier: 'none', reason: 'composer-busy' });
    // At the Enter a yes also says whether our paste is in the composer.
    expect(await deliveryPresence(d, 'p', 'claude', { phase: 'enter', shownProbe: 'half a thought' })).toEqual({ ...FULL, pasteShown: true });
    expect(await deliveryPresence(d, 'p', 'claude', { phase: 'enter', shownProbe: 'not there' })).toEqual({ ...FULL, pasteShown: false });
  });

  it('Codex on the process tier reads its signature alone (its cursor was not measured)', async () => {
    // The placeholder is dim: the undimmed copy is the bare prompt.
    const codex = (cursorRow: number): DeliveryFrame => ({ rows: Object.assign(['• done', '› Ask Codex to do anything', '  gpt-5 medium · ~/project'], { undimmed: ['• done', '›', '  gpt-5 medium · ~/project'] }), cursorRow });
    const d = deps({ tracked: () => ({ alive: true, slug: 'codex' }), s: { namedSlug: 'codex' }, frame: async () => codex(-1) });
    expect(await deliveryPresence(d, 'p', 'codex')).toEqual({ ...FULL, slug: 'codex' });
  });

  it('a frame that cannot be read is composer-unknown', async () => {
    expect(await deliveryPresence(deps({ frame: async () => null }), 'p', 'claude')).toEqual({ tier: 'none', reason: 'composer-unknown' });
  });

  it('an agent whose plain prompt wmux does not know gets the pointer only', async () => {
    const d = deps({ tracked: () => ({ alive: true, slug: 'gemini' }), s: { namedSlug: 'gemini', bracketedPaste: false } });
    expect(await deliveryPresence(d, 'p', undefined)).toEqual({ tier: 'process', slug: 'gemini', input: 'pointer', bracketedPaste: false });
  });

  it('Windows has no foreground read: a running tracked agent in plain mode is enough there', async () => {
    expect(await deliveryPresence(deps({ platform: 'win32', holdsForeground: async () => false }), 'p', undefined)).toEqual(FULL);
  });

  it('another agent than the one addressed is none', async () => {
    expect(await deliveryPresence(deps(), 'p', 'codex')).toEqual({ tier: 'none', reason: 'other-agent' });
  });

  it('an exec unit counts only when its root is verified to be the agent', async () => {
    const exec = { s: { exec: true }, tracked: () => undefined, probe: async () => true };
    // A supervised command that is not the agent (a REPL, a dev server, `claude; exec zsh`).
    const repl = { frame: async () => frame(['Welcome to Node.js v22', '> '], 1) };
    expect(await deliveryPresence(deps({ ...exec, ...repl, ownedRoot: async () => false }), 'p', undefined)).toEqual({ tier: 'none', reason: 'composer-unknown' });
    expect(await deliveryPresence(deps({ ...exec, ownedRoot: async () => true }), 'p', undefined)).toEqual(FULL);
  });

  it('a gone session is none', async () => {
    expect(await deliveryPresence(deps({ session: () => undefined }), 'p', undefined)).toEqual({ tier: 'none', reason: 'no-session' });
  });
});

describe('deliveryPresence: the screen tier (nothing attributed)', () => {
  const untracked = { tracked: () => undefined };

  it('the plain prompt with the cursor on it is screen-verified', async () => {
    expect(await deliveryPresence(deps(untracked), 'p', undefined)).toEqual({ ...FULL, tier: 'screen' });
  });

  it('under tmux: the status line under a live prompt does not refuse it while the cursor is in the prompt', async () => {
    expect(await deliveryPresence(deps({ ...untracked, frame: async () => frame(CLAUDE_TMUX) }), 'p', undefined)).toEqual({ ...FULL, tier: 'screen' });
  });

  it("a dead agent's leftover frame with an indented shell prompt after it: the cursor is not in the prompt", async () => {
    const rows = [...CLAUDE_PLAIN, '  user@host ~ % '];
    expect(await deliveryPresence(deps({ ...untracked, frame: async () => frame(rows, rows.length - 1) }), 'p', undefined))
      .toEqual({ tier: 'none', reason: 'no-screen-proof' });
  });

  it('a foreground viewer (tail -f) printing a frame: the cursor sits under it, not in the prompt', async () => {
    const rows = [...CLAUDE_PLAIN, ''];
    expect(await deliveryPresence(deps({ ...untracked, frame: async () => frame(rows, rows.length - 1) }), 'p', undefined))
      .toEqual({ tier: 'none', reason: 'no-screen-proof' });
  });

  it('a shell at its prompt, a probe still running, or no nameable agent: none', async () => {
    expect(await deliveryPresence(deps({ ...untracked, s: { commandRunning: false } }), 'p', undefined)).toEqual({ tier: 'none', reason: 'shell-at-prompt' });
    expect(await deliveryPresence(deps({ ...untracked, probe: async () => false }), 'p', undefined)).toEqual({ tier: 'none', reason: 'attribution-pending' });
    expect(await deliveryPresence(deps({ ...untracked, s: { namedSlug: undefined } }), 'p', undefined)).toEqual({ tier: 'none', reason: 'no-screen-proof' });
    // No pointer on the screen tier: an agent wmux cannot read gets nothing there.
    expect(await deliveryPresence(deps({ ...untracked, s: { namedSlug: 'gemini' } }), 'p', undefined)).toEqual({ tier: 'none', reason: 'no-screen-proof' });
  });

  it('Codex is never verified from its screen alone: where it keeps the cursor is not known', async () => {
    // The placeholder is dim: the undimmed copy is the bare prompt.
    const codex = (cursorRow: number): DeliveryFrame => ({ rows: Object.assign(['• done', '› Ask Codex to do anything', '  gpt-5 medium · ~/project'], { undimmed: ['• done', '›', '  gpt-5 medium · ~/project'] }), cursorRow });
    expect(await deliveryPresence(deps({ ...untracked, s: { namedSlug: 'codex' }, frame: async () => codex(1) }), 'p', 'codex'))
      .toEqual({ tier: 'none', reason: 'no-screen-proof' });
  });

  it('`!` mode on the screen tier is composer-mode', async () => {
    expect(await deliveryPresence(deps({ ...untracked, frame: async () => frame(CLAUDE_BANG, 3) }), 'p', undefined)).toEqual({ tier: 'none', reason: 'composer-mode' });
  });
});

describe('deliveryPresence at the Enter', () => {
  it('a refusal says whether the pane still shows the paste, so main takes back only what it typed', async () => {
    const ended = { tracked: () => ({ alive: false, slug: 'claude' as const }) };
    const shown = ['user@host ~ % [wmux] A2A task t-1 is waiting'];
    expect(await deliveryPresence(deps({ ...ended, frame: async () => frame(shown, 0) }), 'p', 'claude', { phase: 'enter', shownProbe: '[wmux] A2A task t-1' }))
      .toEqual({ tier: 'none', reason: 'agent-ended', pasteShown: true });
    expect(await deliveryPresence(deps({ ...ended, frame: async () => frame(['user@host ~ % '], 0) }), 'p', 'claude', { phase: 'enter', shownProbe: '[wmux] A2A task t-1' }))
      .toEqual({ tier: 'none', reason: 'agent-ended', pasteShown: false });
  });
});

describe('promptGrant: a daemon-typed prompt, by its author', () => {
  const POINTER = { tier: 'process', slug: 'gemini', input: 'pointer', bracketedPaste: true } as const;
  it("the owner's prompt and wmux's own line go to an agent with no plain-prompt reader; a peer's text waits", () => {
    expect(promptGrant(POINTER, 'owner')).toBe(true);
    expect(promptGrant(POINTER, 'wmux')).toBe(true);
    expect(promptGrant(POINTER, 'peer')).toBe('busy');
    expect(promptGrant({ ...FULL, tier: 'process', slug: 'claude', input: 'full' } as const, 'peer')).toBe(true);
  });

  it('a refusal is unavailable without an agent, busy while one may take it later', () => {
    expect(promptGrant({ tier: 'none', reason: 'agent-ended' }, 'owner')).toBe('unavailable');
    expect(promptGrant({ tier: 'none', reason: 'composer-busy' }, 'owner')).toBe('busy');
    expect(promptGrant({ tier: 'none', reason: 'foreground-unknown' }, 'wmux')).toBe('busy');
  });
});
