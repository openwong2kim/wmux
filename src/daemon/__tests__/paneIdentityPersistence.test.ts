import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AgentDetector } from '../../main/pty/AgentDetector';
import { agentDisplayToSlug, type AgentSlug } from '../../shared/agentIdentity';
import {
  IDENTITY_TTL_MS,
  recordPaneIdentity,
  resolveCanonicalAgentIdentity,
  type CanonicalAgentIdentity,
} from '../canonicalAgent';

// Event-to-persistence: what each daemon event does to the pane's persisted
// `lastDetectedAgent`, the field the post-restart resume pill is named from.
//
// The three daemon sites live inside main() and cannot be booted here, so the
// harness below makes the same calls they make, in the same order: resolve
// the canonical identity from the tracker, hook and screen state at that
// moment, then hand it to recordPaneIdentity. The screen tier is a real
// AgentDetector fed real rows. The last block pins the daemon to this shape.

type Meta = Parameters<typeof recordPaneIdentity>[0];

function pane(initial: Meta = {}) {
  const det = new AgentDetector();
  const events: AgentSlug[] = [];
  det.onEvent((e) => {
    const slug = agentDisplayToSlug(e.agent);
    if (slug) events.push(slug);
  });
  let proc: { slug?: AgentSlug; alive: boolean } | undefined;
  let auth: { slug: AgentSlug; ageMs: number; exact: boolean } | undefined;
  let clock = 1_000;
  let writes = 0;
  const meta: Meta = { ...initial };
  const screenSlug = () => agentDisplayToSlug(det.getLastAgent() ?? '');
  const canonical = (screen?: AgentSlug): CanonicalAgentIdentity | undefined =>
    resolveCanonicalAgentIdentity({
      ...(proc ? { proc } : {}),
      ...(auth ? { auth } : {}),
      ...(screen ? { screenSlug: screen } : {}),
    });
  const record = (c: CanonicalAgentIdentity | undefined) => {
    clock += 1_000;
    if (recordPaneIdentity(meta, c, clock)) writes++;
  };
  return {
    meta,
    get writes() { return writes; },
    /** What the screen tier says right now. */
    screen: screenSlug,
    /** `session:agent`: one write decision per detector event, with its slug. */
    output(text: string) {
      const before = events.length;
      det.feed(text);
      for (const slug of events.slice(before)) record(canonical(slug));
    },
    /** The tracker's launch or death edge (setStateChangeListener). */
    processEdge(next: { slug?: AgentSlug; alive: boolean } | undefined) {
      proc = next;
      record(canonical(screenSlug()));
    },
    /** A resolved hook signal (onAuthorityTouched), after touchAuthority. */
    hook(slug: AgentSlug, opts: { exact?: boolean; ageMs?: number } = {}) {
      auth = { slug, ageMs: opts.ageMs ?? 0, exact: opts.exact ?? true };
      record(canonical(screenSlug()));
    },
  };
}

const CLAUDE_SPLASH = '\u001b]0;✳ Claude Code\u0007 ▐▛███▜▌   Claude Code v2.1.274\r\n';
const CODEX_BANNER = '\u001b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n';
const SHELL_PROMPT_BACK = '\u001b]133;D;0\u0007\u001b]133;A\u0007% ';

describe('pane identity persistence (event to lastDetectedAgent)', () => {
  it('a quoted Codex banner in a live Claude pane does not rename it', () => {
    const p = pane();
    p.output(CLAUDE_SPLASH);
    p.processEdge({ slug: 'claude', alive: true });
    expect(p.meta.lastDetectedAgent).toBe('claude');
    // Claude's reply prints the banner row as a table cell, on a pane whose
    // gate can be taken (exited-and-back shell marks are the detector's
    // own takeover path, the worst case for the screen tier).
    p.output(SHELL_PROMPT_BACK + 'cat notes.md\r\n' + CODEX_BANNER);
    expect(p.screen()).toBe('codex');
    expect(p.meta.lastDetectedAgent).toBe('claude');
  });

  it('a quoted banner with no process attributed cannot rename a hook-named pane', () => {
    const p = pane({ lastDetectedAgent: 'claude', lastDetectedAgentEvidence: { source: 'hook', at: 1 } });
    p.output(CODEX_BANNER);
    expect(p.screen()).toBe('codex');
    expect(p.meta.lastDetectedAgent).toBe('claude');
    expect(p.writes).toBe(0);
  });

  it('residue after the exit edge renames nothing', () => {
    const p = pane();
    p.output(CLAUDE_SPLASH);
    p.processEdge({ slug: 'claude', alive: true });
    // Death edge: the screen still says Claude (sticky), the residue veto
    // answers no identity at all.
    p.processEdge({ slug: 'claude', alive: false });
    expect(p.meta.lastDetectedAgent).toBe('claude');
    // A shell line after the exit that the detector reads as Codex chrome.
    p.output(SHELL_PROMPT_BACK + 'cat banner.txt\r\n' + CODEX_BANNER);
    expect(p.screen()).toBe('codex');
    expect(p.meta.lastDetectedAgent).toBe('claude');
  });

  it('a real Codex launch renames the pane once attribution lands late', () => {
    const p = pane();
    p.output(CLAUDE_SPLASH);
    p.processEdge({ slug: 'claude', alive: true });
    p.processEdge({ slug: 'claude', alive: false });
    p.output(SHELL_PROMPT_BACK + 'codex\r\n' + CODEX_BANNER);
    // The banner arrives before the probe: screen tier, refused.
    expect(p.meta.lastDetectedAgent).toBe('claude');
    p.processEdge({ slug: 'codex', alive: true });
    expect(p.meta.lastDetectedAgent).toBe('codex');
    expect(p.meta.lastDetectedAgentEvidence?.source).toBe('process');
  });

  it('a failed attribution is corrected by the agent\'s exact hook', () => {
    const p = pane();
    p.output(CLAUDE_SPLASH);
    p.processEdge({ slug: 'claude', alive: true });
    p.processEdge({ slug: 'claude', alive: false });
    p.output(SHELL_PROMPT_BACK + 'codex\r\n' + CODEX_BANNER);
    expect(p.meta.lastDetectedAgent).toBe('claude');
    // The probe never attributes Codex; its own hook, routed by ptyId, does.
    p.hook('codex');
    expect(p.meta.lastDetectedAgent).toBe('codex');
    expect(p.meta.lastDetectedAgentEvidence?.source).toBe('hook');
    // Further hook signals are no writes.
    const writes = p.writes;
    p.hook('codex');
    p.hook('codex');
    expect(p.writes).toBe(writes);
  });

  it('a stale, cwd-routed or contradicted hook does not rename the pane', () => {
    const stale = pane({ lastDetectedAgent: 'claude' });
    stale.hook('codex', { ageMs: IDENTITY_TTL_MS + 1 });
    expect(stale.meta.lastDetectedAgent).toBe('claude');

    const neighbour = pane({ lastDetectedAgent: 'claude' });
    neighbour.hook('codex', { exact: false });
    expect(neighbour.meta.lastDetectedAgent).toBe('claude');

    const contradicted = pane({ lastDetectedAgent: 'claude' });
    contradicted.processEdge({ slug: 'claude', alive: true });
    contradicted.hook('codex');
    expect(contradicted.meta.lastDetectedAgent).toBe('claude');
  });

  it('screen-only switches name an unnamed pane once and never rename it', () => {
    const p = pane();
    p.output(CODEX_BANNER);
    expect(p.meta.lastDetectedAgent).toBe('codex');
    expect(p.meta.lastDetectedAgentEvidence?.source).toBe('screen');
    p.output(SHELL_PROMPT_BACK + 'opencode\r\n');
    expect(p.screen()).toBe('opencode');
    expect(p.meta.lastDetectedAgent).toBe('codex');
  });

  it('live evidence upgrades a screen-set name once, without a write per event', () => {
    const p = pane({ lastDetectedAgent: 'codex' });
    p.processEdge({ slug: 'codex', alive: true });
    expect(p.meta.lastDetectedAgentEvidence?.source).toBe('process');
    expect(p.writes).toBe(1);
    p.output(CODEX_BANNER);
    p.processEdge({ slug: 'codex', alive: true });
    expect(p.writes).toBe(1);
  });
});

describe('the evidence stamp against a saved conversation of another agent', () => {
  it('a live same-name agent refreshes a stamp older than the binding, once', () => {
    // Codex was proven at 1000; a Claude binding was captured at 2000 (the
    // spool can deliver one late). A Codex process seen now is newer than
    // both, so the stamp must say so or the pill would offer Claude.
    const p = pane({
      lastDetectedAgent: 'codex',
      lastDetectedAgentEvidence: { source: 'process', at: 1 },
      resumeBinding: { agent: 'claude', ts: 1_500 },
    });
    p.processEdge({ slug: 'codex', alive: true });
    expect(p.meta.lastDetectedAgentEvidence?.source).toBe('process');
    expect(p.meta.lastDetectedAgentEvidence?.at ?? 0).toBeGreaterThan(1_500);
    expect(p.writes).toBe(1);
    p.hook('codex');
    p.processEdge({ slug: 'codex', alive: true });
    expect(p.writes).toBe(1);
  });

  it('a binding stamped ahead of the clock is left to win, with no write per hook', () => {
    // A hook's own timestamp, or a clock step back, can put the binding
    // after `now`. Nothing seen yet is newer than it, and hook signals fire
    // per tool use: no stamp may be invented past it, and none rewritten.
    const p = pane({
      lastDetectedAgent: 'codex',
      lastDetectedAgentEvidence: { source: 'process', at: 1 },
      resumeBinding: { agent: 'claude', ts: 62_000 },
    });
    p.hook('codex');
    p.hook('codex');
    p.processEdge({ slug: 'codex', alive: true });
    expect(p.writes).toBe(0);
    expect(p.meta.lastDetectedAgentEvidence?.at).toBe(1);
  });

  it('a cached hook authority older than the binding cannot outrank it', () => {
    // Codex's hook was last seen 90 s ago (inside IDENTITY_TTL); a Claude
    // binding was captured since. The stamp is when Codex was observed.
    const p = pane({
      lastDetectedAgent: 'codex',
      lastDetectedAgentEvidence: { source: 'hook', at: 1 },
      resumeBinding: { agent: 'claude', ts: 1_500 },
    });
    p.hook('codex', { ageMs: 90_000 });
    expect(p.writes).toBe(0);
    const renamed = pane({ lastDetectedAgent: 'claude', resumeBinding: { agent: 'claude', ts: 1_500 } });
    renamed.hook('codex', { ageMs: 1_000 });
    expect(renamed.meta.lastDetectedAgent).toBe('codex');
    // Observed at 2000 - 1000 = 1000, before the binding.
    expect(renamed.meta.lastDetectedAgentEvidence).toEqual({ source: 'hook', at: 1_000 });
  });

  it('a binding of the same agent, or an older one, needs no refresh', () => {
    const same = pane({
      lastDetectedAgent: 'claude',
      lastDetectedAgentEvidence: { source: 'process', at: 1 },
      resumeBinding: { agent: 'claude', ts: 5_000 },
    });
    same.processEdge({ slug: 'claude', alive: true });
    expect(same.writes).toBe(0);
    const older = pane({
      lastDetectedAgent: 'codex',
      lastDetectedAgentEvidence: { source: 'process', at: 900 },
      resumeBinding: { agent: 'claude', ts: 800 },
    });
    older.processEdge({ slug: 'codex', alive: true });
    expect(older.writes).toBe(0);
  });
});

describe('daemon wiring: every identity site goes through recordPaneIdentity', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  it('no site writes lastDetectedAgent from a canonical identity by hand', () => {
    expect(src).not.toMatch(/lastDetectedAgent = canonical\.slug/);
  });

  it('the detector event, the process edge and the hook signal all record', () => {
    const calls = src.match(/recordPaneIdentity\(managed\.meta, canonical, Date\.now\(\)\)/g) ?? [];
    expect(calls).toHaveLength(3);
    const hookSite = src.slice(src.indexOf('onAuthorityTouched: (sessionId, signal) =>'));
    expect(hookSite.slice(0, 1500)).toMatch(/recordPaneIdentity\(managed\.meta, canonical, Date\.now\(\)\)/);
  });

  it('a recovered pane keeps its evidence with its name across consecutive restarts', () => {
    expect(src.match(/lastDetectedAgentEvidence = (?:persisted|meta|session)\.lastDetectedAgentEvidence/g)).toHaveLength(3);
  });
});
