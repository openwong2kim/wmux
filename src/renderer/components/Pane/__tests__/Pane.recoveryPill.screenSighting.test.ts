/**
 * #2408: hiding the recovery pill is a separate decision from consuming the
 * recovery offer.
 *
 * A recovered pane with no process attribution and no OSC 133 (an SSH remote,
 * a WSL pane without hooks) has only the screen tier to show that its agent
 * was relaunched by hand. That evidence may hide the pill, which destroys
 * nothing, and the pill is back once the agent leaves the screen. Only a hook
 * or a live process consumes the offer (#2389), so the hint and its binding
 * survive the sighting.
 *
 * Each pane runs the daemon's own pieces: a fresh AgentDetector (the
 * respawned shell's), the headless grid the daemon reads the screen from, the
 * sighting predicates, and the consumption rule; then the renderer store and
 * the pill gate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentDetector } from '../../../../main/pty/AgentDetector';
import { generateTextSnapshot } from '../../../../daemon/HeadlessSnapshot';
import { liveRecoveryHint, namedAgentAlive, screenShowsLiveAgent, sightedRecoveredAgent } from '../../../../daemon/recoveryHint';
import { resolveCanonicalAgentIdentity } from '../../../../daemon/canonicalAgent';
import { restoreSeam } from '../../../../shared/restoreSeam';
import { agentDisplayToSlug } from '../../../../shared/agentIdentity';
import { useStore } from '../../../stores';
import { planAutoResume, recoveryAgentLive } from '../Pane';

const SID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CWD = '/home/me/repo';
const COLS = 80;
const ROWS = 24;
const RULE = '─'.repeat(COLS);
const CLAUDE_SPLASH = '\u001b]0;✳ Claude Code\u0007 ▐▛███▜▌   Claude Code v2.1.274\r\n';
// Claude Code's idle composer, as captured (running-turn-screens.json, claude-done).
const CLAUDE_COMPOSER = `${RULE}\r\n❯ \r\n${RULE}\r\n  ⏵⏵ auto mode on (shift+tab to cycle)\r\n`;
const CLAUDE_EXIT_MESSAGE = `Resume this session with:\r\nclaude --resume ${SID}\r\n$ `;

/** One recovered pane on the daemon side: the respawned shell's detector and grid. */
function recoveredPane() {
  const det = new AgentDetector();
  let bytes = restoreSeam(ROWS);
  return {
    feed(data: string) {
      det.feed(data);
      bytes += data;
    },
    /** What `daemon.listSessions` reports as `resumeAgentOnScreen` for this pane. */
    async onScreen(): Promise<boolean> {
      const slug = sightedRecoveredAgent(det.getLastAgent());
      if (!slug) return false;
      const outcome = await generateTextSnapshot({ cols: COLS, rows: ROWS, scrollback: 0, initial: Buffer.from(bytes, 'utf8') });
      if (!outcome.ok) throw new Error(`snapshot failed: ${outcome.reason}`);
      return screenShowsLiveAgent(outcome.rows.map((r) => r.text), slug);
    },
    screenTier() {
      return resolveCanonicalAgentIdentity({ screenSlug: agentDisplayToSlug(det.getLastAgent() ?? '') });
    },
  };
}

/** The daemon's recovery offer for one pane, and its consumption rule on a list read. */
function recoveryOffer(id: string) {
  const hints = new Map<string, string>([[id, 'claude']]);
  const bindings = new Map<string, { sessionId: string }>([[id, { sessionId: SID }]]);
  // No process attribution: the tracker has no identity for the pane.
  const listRead = () => liveRecoveryHint(id, () => namedAgentAlive(undefined), hints, bindings);
  return { hints, bindings, listRead };
}

/** One `pty.list` hydration, as AppLayout runs it. */
function hydrate(sessions: Array<{ id: string; resumeAgent?: 'claude'; resumeAgentOnScreen?: boolean }>) {
  const hints: Record<string, 'claude'> = {};
  const onScreen: Record<string, boolean> = {};
  for (const s of sessions) {
    if (s.resumeAgent) hints[s.id] = s.resumeAgent;
    if (s.resumeAgentOnScreen !== undefined) onScreen[s.id] = s.resumeAgentOnScreen;
  }
  useStore.getState().hydrateResume(hints);
  useStore.getState().hydrateResumeBindings({ A: { agent: 'claude', sessionId: SID, cwd: CWD, ts: 1 } });
  // An SSH-like pane: no OSC 133 and no attributed process, so neither map has it.
  useStore.getState().hydrateCommandRunning({});
  useStore.getState().hydrateAgentAlive({});
  useStore.getState().hydrateResumeAgentOnScreen(onScreen);
}

/** The pill's gate in Pane.tsx: `resumeHint && !resumeAgentLive`. */
function pillShown(ptyId: string): boolean {
  const s = useStore.getState();
  return !!s.resumeHintByPtyId[ptyId] && !recoveryAgentLive({
    agentAlive: s.agentAliveByPtyId[ptyId],
    commandRunning: s.commandRunningByPtyId[ptyId],
    agentOnScreen: s.resumeAgentOnScreenByPtyId[ptyId] === true,
  });
}

describe('recovery pill: a screen-tier sighting hides it and never consumes the offer (#2408)', () => {
  beforeEach(() => {
    useStore.setState((state) => {
      state.resumeConsumedByPtyId = {};
      state.deadPaneRecoveryOfferByPtyId = {};
    });
    hydrate([]);
  });

  it('an SSH-like pane that relaunches Claude by hand hides the pill, and the offer stays', async () => {
    const pane = recoveredPane();
    const offer = recoveryOffer('A');
    pane.feed('$ ssh devbox\r\nme@devbox:~/repo$ claude\r\n');
    expect(await pane.onScreen()).toBe(false);
    pane.feed(CLAUDE_SPLASH + '\r\n' + CLAUDE_COMPOSER);
    // Screen tier only: the daemon's consumption rule does not fire on it.
    expect(pane.screenTier()?.source).toBe('screen');
    expect(await pane.onScreen()).toBe(true);
    expect(offer.listRead()).toBe('claude');

    hydrate([{ id: 'A', resumeAgent: offer.listRead() as 'claude', resumeAgentOnScreen: await pane.onScreen() }]);
    expect(pillShown('A')).toBe(false);
    // Hidden, not consumed: the hint and its binding are still there.
    expect(useStore.getState().resumeHintByPtyId.A).toBe('claude');
    expect(useStore.getState().resumeBindingByPtyId.A?.sessionId).toBe(SID);
    expect(useStore.getState().resumeConsumedByPtyId.A).toBeUndefined();
    expect(offer.hints.get('A')).toBe('claude');
    expect(offer.bindings.get('A')).toEqual({ sessionId: SID });
    // Nor is the resume typed automatically into the running agent.
    expect(planAutoResume({
      enabled: true,
      agent: 'claude',
      binding: { agent: 'claude', sessionId: SID, cwd: CWD },
      paneCwds: [CWD],
      roleBinding: undefined,
      agentSighted: true,
    })).toBeNull();
  });

  it('a sighting not read yet, or gone, shows the pill but types nothing on its own', () => {
    hydrate([{ id: 'A', resumeAgent: 'claude', resumeAgentOnScreen: false }]);
    expect(pillShown('A')).toBe(true);
    const plan = (agentSighted: boolean | undefined) => planAutoResume({
      enabled: true,
      agent: 'claude',
      binding: { agent: 'claude', sessionId: SID, cwd: CWD },
      paneCwds: [CWD],
      roleBinding: undefined,
      agentSighted,
    });
    expect(plan(true)).toBeNull();
    // No sighting reported (an older daemon too): the automatic resume as before.
    expect(plan(undefined)).toBe(`claude --resume ${SID}`);
  });

  it('the pill is back once the banner is gone and the shell prompt is back', async () => {
    const pane = recoveredPane();
    const offer = recoveryOffer('A');
    pane.feed(CLAUDE_SPLASH + '\r\n' + CLAUDE_COMPOSER);
    hydrate([{ id: 'A', resumeAgent: 'claude', resumeAgentOnScreen: await pane.onScreen() }]);
    expect(pillShown('A')).toBe(false);

    // Claude exits: it erases its composer and prints the resume hint, and the
    // remote shell's prompt is back (captured on Claude Code's classic renderer).
    pane.feed('\u001b[4A\r\u001b[J' + CLAUDE_EXIT_MESSAGE);
    expect(await pane.onScreen()).toBe(false);
    hydrate([{ id: 'A', resumeAgent: offer.listRead() as 'claude', resumeAgentOnScreen: await pane.onScreen() }]);
    expect(pillShown('A')).toBe(true);
  });

  it('a fullscreen Claude that exits leaves the alternate screen, and the pill is back', async () => {
    const pane = recoveredPane();
    pane.feed('\u001b[?1049h' + CLAUDE_SPLASH + '\r\n' + CLAUDE_COMPOSER);
    expect(await pane.onScreen()).toBe(true);
    pane.feed('\u001b[?1049l' + CLAUDE_EXIT_MESSAGE);
    expect(await pane.onScreen()).toBe(false);
  });

  it('a draft in the composer still reads as the live agent', async () => {
    const pane = recoveredPane();
    pane.feed(CLAUDE_SPLASH + '\r\n');
    pane.feed(`${RULE}\r\n❯ fix the flaky test in\r\n  src/daemon first\r\n${RULE}\r\n  ⏵⏵ auto mode on (shift+tab to cycle)\r\n`);
    expect(await pane.onScreen()).toBe(true);
  });

  it('a fullscreen agent killed without leaving the alternate screen goes stale once its prompt is gone', async () => {
    const pane = recoveredPane();
    pane.feed('\u001b[?1049h' + CLAUDE_SPLASH + '\r\n' + CLAUDE_COMPOSER);
    expect(await pane.onScreen()).toBe(true);
    // The remote end dropped: no `?1049l`, the shell clears and draws its prompt.
    pane.feed('\u001b[2J\u001b[HConnection to devbox closed.\r\n$ ');
    expect(await pane.onScreen()).toBe(false);
  });

  it('a Claude killed from outside goes stale once the shell prints under its composer', async () => {
    const pane = recoveredPane();
    pane.feed(CLAUDE_SPLASH + '\r\n' + CLAUDE_COMPOSER);
    expect(await pane.onScreen()).toBe(true);
    // No exit frame: the composer stays drawn and the remote shell writes below it.
    pane.feed('Killed\r\nme@devbox:~/repo$ ');
    expect(await pane.onScreen()).toBe(false);
  });

  it('an answer that mentions a dialog shortcut does not hide a live composer', async () => {
    const pane = recoveredPane();
    pane.feed(CLAUDE_SPLASH + '\r\n');
    pane.feed('⏺ Press Esc to cancel the picker, then Enter.\r\n\r\n' + CLAUDE_COMPOSER);
    expect(await pane.onScreen()).toBe(true);
  });

  it('reads a live Codex composer, and not its rows left above a shell prompt', () => {
    const codex = ['• ok', '', '› Ask Codex to do anything', '', '  gpt-5 high · ~/repo', '  ? for shortcuts'];
    expect(screenShowsLiveAgent(codex, 'codex')).toBe(true);
    expect(screenShowsLiveAgent(['› fix the', '  flaky test', '', '  gpt-5 high · ~/repo'], 'codex')).toBe(true);
    expect(screenShowsLiveAgent([...codex, 'me@devbox:~/repo$'], 'codex')).toBe(false);
    expect(screenShowsLiveAgent(['me@devbox:~/repo$ codex'], 'codex')).toBe(false);
  });

  it('reads the captured Claude and Codex dialogs as live, and not once a shell row is under them', () => {
    const dir = resolve(__dirname, '../../../../daemon/approvals/__tests__/fixtures/terminal-prompts');
    const dialogs = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => /(?:^|[\\/])(?:claude|codex)-[^\\/]*\.json$/.test(f));
    expect(dialogs.length).toBeGreaterThan(80);
    for (const file of dialogs) {
      const fixture = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as { tui: string; screen: string[] };
      const slug = fixture.tui.startsWith('codex') ? 'codex' : 'claude';
      expect(screenShowsLiveAgent(fixture.screen, slug), file).toBe(true);
      expect(screenShowsLiveAgent([...fixture.screen, 'Killed', 'me@devbox:~/repo$'], slug), file).toBe(false);
    }
  });

  it('quoted agent text in a different, still-recovering pane keeps that pill', async () => {
    const a = recoveredPane();
    a.feed(CLAUDE_SPLASH + '\r\n' + CLAUDE_COMPOSER);
    // Pane B never relaunched an agent: its shell prints a file quoting
    // Claude's splash, a model table and Codex's banner (the Reddit report).
    const b = recoveredPane();
    b.feed('$ cat compare.md\r\n');
    b.feed(' ▐▛███▜▌   Claude Code v2.1.274\r\n');
    b.feed('│ gemini-2.5-pro │ 63% │\r\n');
    b.feed('│ >_ OpenAI Codex (v0.149.1)            │\r\n');
    b.feed('$ ');
    expect(await b.onScreen()).toBe(false);

    hydrate([
      { id: 'A', resumeAgent: 'claude', resumeAgentOnScreen: await a.onScreen() },
      { id: 'B', resumeAgent: 'claude', resumeAgentOnScreen: await b.onScreen() },
    ]);
    expect(pillShown('A')).toBe(false);
    expect(pillShown('B')).toBe(true);
  });

  it('a process seen dead or a shell back at its prompt outranks the screen read', () => {
    expect(recoveryAgentLive({ agentOnScreen: true })).toBe(true);
    expect(recoveryAgentLive({ agentOnScreen: true, agentAlive: false })).toBe(false);
    expect(recoveryAgentLive({ agentOnScreen: true, commandRunning: false })).toBe(false);
    expect(recoveryAgentLive({ agentOnScreen: false })).toBe(false);
    expect(recoveryAgentLive({})).toBe(false);
    // An older daemon sends no sighting: the gate is today's.
    expect(recoveryAgentLive({ agentAlive: true })).toBe(true);
    expect(recoveryAgentLive({ commandRunning: true })).toBe(true);
  });
});
