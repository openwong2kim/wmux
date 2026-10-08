// Parity for #1904 item 1: every per-agent list that now derives from the
// registry (src/shared/agentIdentity.ts) must produce exactly what its old
// hand-written literal did. The expected values below ARE those literals, copied
// from the pre-change source, so a row edit that changes a derived list for one
// of these agents fails here and has to be made on purpose.
//
// Every assertion is scoped to AGENTS, the ten agents the literals covered, so a
// NEW row (a launch-only agent) needs no edit here.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SLUGS,
  agentHooksFlavour,
  agentRow,
  agentSlugsWith,
} from '../agentIdentity';
import {
  agentSupportsPermissionFlag,
  isPlausibleResumeSessionId,
  resumeGrammarFor,
  resumeOfferForRecovered,
} from '../agentResume';
import { ALL_ACTIVE_PROVIDERS } from '../activeProviders';
import { MCP_TARGETS } from '../mcpTargets';
import { CATALOG_AGENTS } from '../modelCatalog';
import {
  KNOWN_AGENT_STEMS,
  launcherSupportsModelFlag,
  launchRefusesPositionalPrompt,
  promptFlagForLauncher,
} from '../orchestratorRole';
import { FANOUT_EXTRA_AGENT_STEMS } from '../fanoutPreset';
import { mayCarryBody } from '../../daemon/channels/channelWakeWorker';
import { keystrokesForAgent } from '../../daemon/approvals/approvalKeystrokes';
import { isClaudeFamilyAgent } from '../../daemon/approvals/terminalPrompt';
import { resolveAgentSlug } from '../../daemon/AgentProcessTracker';
import { DETECTOR_PROFILE_SLUGS } from '../../main/pty/AgentDetector';

/** The agents the replaced literals covered, in registry order. */
const AGENTS: readonly string[] = [
  'claude', 'codex', 'gemini', 'aider', 'opencode', 'copilot', 'openclaude', 'kiro', 'grok', 'agy',
];
const UUID = '0b6f3c2e-1d4a-4f7b-9c8e-2a1b3c4d5e6f';
/** Slugs that a plain object index would answer from Object.prototype. */
const PROTOTYPE_KEYS = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
const PROBES = [...AGENTS, ...PROTOTYPE_KEYS];
const known = <T extends string>(list: readonly T[]): T[] => list.filter((s) => AGENTS.includes(s));

describe('agent registry rows', () => {
  it('keeps the relative slug order every derived list inherits', () => {
    expect(known(AGENT_SLUGS)).toEqual(AGENTS);
  });

  it('answers undefined for unknown and prototype-named slugs', () => {
    for (const key of [...PROTOTYPE_KEYS, '', 'not-an-agent', undefined, null]) expect(agentRow(key)).toBeUndefined();
  });

  it('names a detector profile exactly for the rows that declare `detect`', () => {
    expect(new Set(agentSlugsWith('detect'))).toEqual(new Set(DETECTOR_PROFILE_SLUGS));
  });

  it('declares the hook dialects agreed with the shared hook path', () => {
    expect(Object.fromEntries(AGENTS.map((s) => [s, agentHooksFlavour(s)]))).toEqual({
      claude: 'claude', codex: 'codex', gemini: 'gemini', aider: undefined, opencode: 'opencode',
      copilot: 'copilot', openclaude: 'openclaude', kiro: 'kiro', grok: undefined, agy: undefined,
    });
  });
});

describe('derived lists match the literals they replaced', () => {
  it('KNOWN_AGENT_STEMS (orchestratorRole)', () => {
    const stems = [...AGENTS.filter((s) => s !== 'kiro'), 'kiro', 'kiro-cli'];
    expect(new Set(stems.filter((s) => KNOWN_AGENT_STEMS.has(s)))).toEqual(new Set([
      'claude', 'codex', 'gemini', 'aider', 'opencode', 'copilot', 'openclaude', 'kiro-cli', 'agy',
    ]));
    expect(KNOWN_AGENT_STEMS.has('grok')).toBe(false);
    expect(FANOUT_EXTRA_AGENT_STEMS.has('grok')).toBe(true);
    expect(known([...FANOUT_EXTRA_AGENT_STEMS])).toEqual(['grok']);
  });

  it('PROMPT_FLAG_BY_STEM / PROMPT_TAKING_FLAGS_BY_STEM (agy only)', () => {
    expect(promptFlagForLauncher('agy')).toBe('-i');
    for (const flag of ['-i', '--prompt-interactive', '-p', '--print']) {
      expect(promptFlagForLauncher(`agy ${flag} x`)).toBeUndefined();
    }
    expect(launchRefusesPositionalPrompt('agy "do it"')).toBe(true);
    for (const stem of PROBES.filter((s) => s !== 'agy')) {
      expect(promptFlagForLauncher(stem)).toBeUndefined();
      expect(launchRefusesPositionalPrompt(`${stem} "do it"`)).toBe(false);
    }
  });

  it('MODEL_FLAG_BY_LAUNCHER (claude, codex, grok, agy)', () => {
    expect([...PROBES, 'kiro-cli'].filter(launcherSupportsModelFlag)).toEqual(['claude', 'codex', 'grok', 'agy']);
  });

  it('RESUME_BY_LAUNCHER (claude, codex)', () => {
    expect(resumeGrammarFor('claude')?.fallback).toBe('--continue');
    expect(resumeGrammarFor('claude')?.withId(UUID)).toBe(`--resume ${UUID}`);
    expect(resumeGrammarFor('codex')?.fallback).toBe('resume --last');
    expect(resumeGrammarFor('codex')?.withId(UUID)).toBe(`resume ${UUID}`);
    // The id is inserted literally, never read as a replacement pattern.
    expect(resumeGrammarFor('claude')?.withId('a$&b')).toBe('--resume a$&b');
    for (const agent of PROBES.filter((s) => s !== 'claude' && s !== 'codex')) {
      expect(resumeGrammarFor(agent)).toBeUndefined();
      expect(resumeOfferForRecovered({ lastDetectedAgent: agent })).toBeUndefined();
    }
    expect(resumeOfferForRecovered({ lastDetectedAgent: 'codex' })).toBe('codex');
  });

  it('agentSupportsPermissionFlag (`agent === "claude"`)', () => {
    expect(PROBES.filter(agentSupportsPermissionFlag)).toEqual(['claude']);
  });

  it('isPlausibleResumeSessionId (a UUID for claude and codex only)', () => {
    for (const agent of ['claude', 'codex']) {
      expect(isPlausibleResumeSessionId(agent, UUID)).toBe(true);
      expect(isPlausibleResumeSessionId(agent, 'rollout-2026-01-01T00-00-00-x')).toBe(false);
    }
    expect(isPlausibleResumeSessionId('opencode', 'ses_abc')).toBe(true);
    expect(isPlausibleResumeSessionId('constructor', 'x')).toBe(true);
  });

  it('MCP_TARGETS (claude, codex, gemini, agy)', () => {
    const home = path.join('h', 'user');
    const targets = MCP_TARGETS.filter((t) => AGENTS.includes(t.id));
    expect(targets.map((t) => ({ ...t, configPath: t.configPath(home) }))).toEqual([
      {
        id: 'claude', displayName: 'Claude Code', format: 'json', configPath: path.join(home, '.claude.json'),
        createIfMissing: true, verified: true, autoRegister: true,
      },
      {
        id: 'codex', displayName: 'Codex CLI', format: 'toml', configPath: path.join(home, '.codex', 'config.toml'),
        createIfMissing: false, verified: true, autoRegister: true,
      },
      {
        id: 'gemini', displayName: 'Gemini CLI', format: 'json', configPath: path.join(home, '.gemini', 'settings.json'),
        createIfMissing: false, verified: false, autoRegister: true,
      },
      {
        id: 'agy', displayName: 'Antigravity CLI', format: 'json',
        configPath: path.join(home, '.gemini', 'config', 'mcp_config.json'),
        createIfMissing: false, verified: false, autoRegister: false,
      },
    ]);
  });

  it('BODY_PREVIEW_AGENTS (channelWakeWorker)', () => {
    expect(new Set(PROBES.filter(mayCarryBody))).toEqual(new Set([
      'claude', 'codex', 'gemini', 'agy', 'aider', 'opencode', 'copilot',
    ]));
    expect(mayCarryBody(undefined)).toBe(false);
  });

  it('KEYSTROKES_BY_AGENT and CLAUDE_FAMILY (claude, openclaude)', () => {
    for (const slug of PROBES) {
      const family = slug === 'claude' || slug === 'openclaude';
      expect(keystrokesForAgent(slug)).toEqual(family ? { approve: '1', deny: '\x1b' } : null);
      expect(isClaudeFamilyAgent(slug)).toBe(family);
    }
    expect(isClaudeFamilyAgent(null)).toBe(false);
  });

  it('QUEUE_AGENTS (chatWire) and the terminal chat capability arrays (nativeChatBridge)', () => {
    expect(known(agentSlugsWith('sendQueue'))).toEqual(['claude', 'codex', 'opencode']);
    const chat = (slug: string) => agentRow(slug)?.terminalChat;
    expect(PROBES.filter((s) => chat(s)?.send)).toEqual(['claude', 'codex']);
    expect(PROBES.filter((s) => chat(s)?.cancel)).toEqual(['claude', 'codex']);
    expect(PROBES.filter((s) => chat(s)?.images)).toEqual(['claude']);
    expect(PROBES.filter((s) => chat(s)?.queue)).toEqual(['claude']);
  });

  it('ALL_ACTIVE_PROVIDERS and CATALOG_AGENTS (claude, codex, agy)', () => {
    expect(known(ALL_ACTIVE_PROVIDERS)).toEqual(['claude', 'codex', 'agy']);
    expect(known(CATALOG_AGENTS)).toEqual(['claude', 'codex', 'agy']);
  });

  it('ALIAS_TO_SLUG / NATIVE_STEM_TO_SLUG (AgentProcessTracker)', () => {
    expect(resolveAgentSlug('npx -y @anthropic-ai/claude-code')).toBe('claude');
    expect(resolveAgentSlug('npx -y claude-code')).toBe('claude');
    expect(resolveAgentSlug('npx -y @google/gemini-cli')).toBe('gemini');
    expect(resolveAgentSlug('npx -y gemini-cli')).toBe('gemini');
    expect(resolveAgentSlug('npx -y kiro-cli')).toBe('kiro');
    expect(resolveAgentSlug('npx -y @acme/claude')).toBeUndefined();
  });

  it('account kinds behind the closed Vendor union', () => {
    const kind = (k: string) => PROBES.filter((s) => agentRow(s)?.accounts === k);
    expect(kind('account-store')).toEqual(['claude', 'codex']);
    expect(kind('agy-service')).toEqual(['agy']);
  });
});
