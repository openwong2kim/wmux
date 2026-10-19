/**
 * The public report this guards (r/ClaudeAI): a Claude-only user saw the
 * post-restart pill read "resume claude | codex | gemini, seemingly chosen by
 * an RNG", and resume never restored anything.
 *
 * End to end, in the order it happens: Claude runs and its output names Codex
 * and Gemini; Claude exits and the shell prints more of the same; the daemon
 * records the pane's identity from each event (#2397); the daemon restarts
 * and offers the pill from what it persisted (#2389); the renderer turns that
 * offer and the saved binding into the line the click types. The pill must
 * name Claude and resume the exact conversation, also for a name an older
 * build persisted from a screen guess.
 */
import { describe, it, expect } from 'vitest';
import { AgentDetector } from '../../../../main/pty/AgentDetector';
import { agentDisplayToSlug, type AgentSlug } from '../../../../shared/agentIdentity';
import { resumeOfferForRecovered, type ResumeBinding } from '../../../../shared/agentResume';
import { recordPaneIdentity, resolveCanonicalAgentIdentity } from '../../../../daemon/canonicalAgent';
import { planRecoveryPillType } from '../Pane';

const SID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const CWD = '/Users/me/repo';
const CLAUDE_SPLASH = '\u001b]0;✳ Claude Code\u0007 ▐▛███▜▌   Claude Code v2.1.274\r\n';
const CODEX_BANNER = '\u001b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n';
const SHELL_PROMPT_BACK = '\u001b]133;D;0\u0007\u001b]133;A\u0007% ';

type PersistedIdentity = Parameters<typeof recordPaneIdentity>[0];

/**
 * Every agent the screen named, in order, while the pane ran Claude only, and
 * the identity the daemon persisted from it. Each detector event and each
 * process edge resolves the canonical identity and records it, as the
 * daemon's `session:agent` handler and tracker listener do.
 */
function runClaudeOnlyPane(): { named: AgentSlug[]; persisted: PersistedIdentity } {
  const det = new AgentDetector();
  const named: AgentSlug[] = [];
  const persisted: PersistedIdentity = {};
  let proc: { slug: AgentSlug; alive: boolean } | undefined;
  let clock = 0;
  const record = (screenSlug: AgentSlug | undefined) => {
    clock += 100;
    recordPaneIdentity(persisted, resolveCanonicalAgentIdentity({
      ...(proc ? { proc } : {}),
      ...(screenSlug ? { screenSlug } : {}),
    }), clock);
  };
  det.onEvent((e) => {
    const slug = agentDisplayToSlug(e.agent);
    if (slug && named[named.length - 1] !== slug) named.push(slug);
    record(slug);
  });
  det.feed(CLAUDE_SPLASH);
  // The tracker attributes Claude's process.
  proc = { slug: 'claude', alive: true };
  record(agentDisplayToSlug(det.getLastAgent() ?? ''));
  // Claude's replies compare the other agents, in prose and in tables.
  det.feed('⏺ I compared Codex and Gemini on this repo; Gemini CLI was slower.\r\n');
  det.feed('│ Model          │ Score │\r\n');
  det.feed('│ gemini-2.5-pro │ 63%   │\r\n');
  det.feed('│ Codex CLI │ OpenAI │\r\n');
  det.feed('\r\u001b[5C\u001b[1B>_ OpenAI Codex (v0.149.1) and\r');
  expect(det.getLastAgent()).toBe('Claude Code');
  // Claude exits: the tracker's death edge, then the shell echoes a folder
  // named gemini and prints a file that holds the comparison table and the
  // quoted Codex banner row.
  proc = { slug: 'claude', alive: false };
  record(agentDisplayToSlug(det.getLastAgent() ?? ''));
  det.feed(SHELL_PROMPT_BACK + 'ls gemini \r\n');
  det.feed(SHELL_PROMPT_BACK + 'cat compare.md\r\n');
  det.feed('│ gemini-2.5-pro │ 63% │\r\n');
  det.feed(CODEX_BANNER);
  return { named, persisted };
}

function pillLineAfterRestart(persisted: {
  lastDetectedAgent?: string;
  lastDetectedAgentEvidence?: { source: string; at: number };
  resumeBinding: ResumeBinding;
}): { offer: string | undefined; line: string | undefined } {
  // Daemon restart: the recovered pane's offer, from the persisted record.
  const offer = resumeOfferForRecovered(persisted);
  if (!offer) return { offer, line: undefined };
  // Renderer: the exact session only when the binding is this launcher's.
  const binding = persisted.resumeBinding;
  const sessionId = binding.agent === offer && binding.cwd === CWD ? binding.sessionId : undefined;
  const plan = planRecoveryPillType({
    launcher: offer,
    sessionId,
    permFlag: '',
    forceSkip: true,
    resumeStage: 0,
    roleBinding: undefined,
  });
  return { offer, line: plan?.text };
}

describe('Claude-only pane: Codex and Gemini in the output, exit, daemon restart', () => {
  // Claude's hook captured the conversation while it ran.
  const resumeBinding: ResumeBinding = { agent: 'claude', sessionId: SID, cwd: CWD, ts: 250 };

  it('the screen never names Gemini, and names Codex only after Claude exited', () => {
    expect(runClaudeOnlyPane().named).toEqual(['claude', 'codex']);
  });

  it('the daemon keeps the pane named Claude, and the pill resumes the exact conversation', () => {
    const { persisted } = runClaudeOnlyPane();
    expect(persisted.lastDetectedAgent).toBe('claude');
    expect(persisted.lastDetectedAgentEvidence?.source).toBe('process');
    expect(pillLineAfterRestart({ ...persisted, resumeBinding })).toEqual({ offer: 'claude', line: `claude --resume ${SID}` });
  });

  it('a real Codex run after Claude still offers Codex, not the older Claude conversation', () => {
    const { persisted } = runClaudeOnlyPane();
    const meta = { ...persisted, resumeBinding };
    // The user starts Codex in the same pane; the tracker attributes it after
    // Claude's binding was captured. Codex wrote no binding of its own.
    recordPaneIdentity(meta, resolveCanonicalAgentIdentity({ proc: { slug: 'codex', alive: true } }), 10_000);
    expect(meta.lastDetectedAgent).toBe('codex');
    expect(pillLineAfterRestart(meta)).toEqual({ offer: 'codex', line: 'codex resume' });
  });

  it('a name an older build persisted from the screen is repaired by the saved conversation', () => {
    const screenGuess = runClaudeOnlyPane().named.pop();
    const persistedNames = [
      // What an unguarded daemon wrote: the screen's last guess.
      { lastDetectedAgent: screenGuess },
      { lastDetectedAgent: screenGuess, lastDetectedAgentEvidence: { source: 'screen', at: 9_000 } },
      // A Gemini name persisted by an older build.
      { lastDetectedAgent: 'gemini' },
      // No name at all, only the hook's binding.
      {},
    ];
    for (const name of persistedNames) {
      expect(pillLineAfterRestart({ ...name, resumeBinding }), JSON.stringify(name))
        .toEqual({ offer: 'claude', line: `claude --resume ${SID}` });
    }
  });
});
