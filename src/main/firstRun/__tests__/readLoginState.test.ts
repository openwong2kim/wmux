import { describe, expect, it } from 'vitest';
import { AgentSetupDetector, readLoginState, type ProbeResult } from '../AgentSetupDetector';

const result = (over: Partial<ProbeResult>): ProbeResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });

// Only the agent's own definite "signed out" may block a scheduled run; every
// other outcome of the status command is "cannot tell" (null) and lets it run.
describe('readLoginState', () => {
  it('reads Claude as signed out only from loggedIn:false with exit 1', () => {
    expect(readLoginState('claude', result({ code: 1, stdout: '{"loggedIn":false}' }))).toBe(false);
    expect(readLoginState('claude', result({ code: 0, stdout: '{"loggedIn":true}' }))).toBe(true);
    expect(readLoginState('claude', result({ code: 2, stdout: '{"loggedIn":false}' }))).toBeNull();
    expect(readLoginState('claude', result({ code: 1, stdout: 'Error: network' }))).toBeNull();
    expect(readLoginState('claude', result({ code: null, timedOut: true }))).toBeNull();
  });

  it("reads Codex as signed out only from exit 1 with its own signed-out line", () => {
    expect(readLoginState('codex', result({ code: 1, stderr: 'Not logged in' }))).toBe(false);
    expect(readLoginState('codex', result({ code: 0, stdout: 'Logged in using ChatGPT' }))).toBe(true);
    expect(readLoginState('codex', result({ code: 1, stderr: 'error: config is invalid' }))).toBeNull();
    expect(readLoginState('codex', result({ code: 127 }))).toBeNull();
  });

  it('cannot tell for an agent without a status command', () => {
    expect(readLoginState('grok', result({ code: 1 }))).toBeNull();
  });
});

// `codex login status` says "Not logged in" with only an API key in the
// environment or another model provider configured, and Codex runs with
// either: that "signed out" must not refuse anything.
describe('AgentSetupDetector.loginState and credentials the status does not see', () => {
  const signedOutCodex = (files: Record<string, string> = {}) => new AgentSetupDetector({
    resolve: () => '/opt/bin/codex',
    run: async () => ({ code: 1, stdout: '', stderr: 'Not logged in', timedOut: false }),
    homedir: () => '/home/me',
    platform: 'darwin',
    readFile: (p) => files[p] ?? null,
  });

  it('reads Codex as signed out when nothing else would let it run', async () => {
    expect(await signedOutCodex().loginState('codex', { PATH: '/bin' })).toBe(false);
    expect(await signedOutCodex({ '/home/me/.codex/config.toml': 'model = "gpt-5"\n' }).loginState('codex', {})).toBe(false);
  });

  it('cannot tell with an API key in the environment', async () => {
    expect(await signedOutCodex().loginState('codex', { OPENAI_API_KEY: 'sk-x' })).toBeNull();
    expect(await signedOutCodex().loginState('codex', { CODEX_API_KEY: 'k' })).toBeNull();
    expect(await signedOutCodex().loginState('codex', { OPENAI_API_KEY: '  ' })).toBe(false);
  });

  it("cannot tell with another model provider in that account's config", async () => {
    const config = 'model = "llama3"\n  model_provider = "ollama"\n';
    expect(await signedOutCodex({ '/acc/cx/config.toml': config }).loginState('codex', { CODEX_HOME: '/acc/cx' })).toBeNull();
    expect(await signedOutCodex({ '/home/me/.codex/config.toml': config }).loginState('codex', {})).toBeNull();
    // Codex's own provider is its own sign-in, not another credential.
    expect(await signedOutCodex({ '/home/me/.codex/config.toml': 'model_provider = "openai" # default\n' }).loginState('codex', {})).toBe(false);
    // A profile nobody selected is not the provider a launch uses…
    const profiles = '[model_providers.ollama]\nbase_url = "http://localhost:11434/v1"\n\n[profiles.local]\nmodel_provider = "ollama"\n';
    expect(await signedOutCodex({ '/home/me/.codex/config.toml': profiles }).loginState('codex', {})).toBe(false);
    // …but a selected one is, and it wins over the top level.
    const selected = 'profile = "local"\nmodel_provider = "openai"\n' + profiles;
    expect(await signedOutCodex({ '/home/me/.codex/config.toml': selected }).loginState('codex', {})).toBeNull();
    // Another account's folder is not this one's.
    expect(await signedOutCodex({ '/home/me/.codex/config.toml': config }).loginState('codex', { CODEX_HOME: '/acc/cx' })).toBe(false);
  });
});

