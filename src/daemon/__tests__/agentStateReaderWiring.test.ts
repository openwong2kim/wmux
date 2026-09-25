// Wiring guard for the daemon's canonical agent-state reader.
//
// `readDaemonAgentState` answers `daemon.getAgentName`, `daemon.getAgentState`
// and `/api/workspaces`. A resumed or named Claude session draws no banner, so
// the detector never names it while the hook and process tiers already know
// the agent (#1303). If a missing detector name ever short-circuits the reader
// again, those panes lose their name on every surface at once.
//
// Source-shape assertions, following agentProcessExitWiring.test.ts: the
// reader is a closure inside `registerRpcHandlers`, which cannot be
// constructed in a unit test. The name decision itself is covered in
// canonicalAgent.test.ts (reportedAgentName).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('readDaemonAgentState wiring (#1303)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  function readerBody(): string {
    const lines = src.split('\n');
    const startIdx = lines.findIndex((l) => l.includes('const readDaemonAgentState = (id: string)'));
    if (startIdx < 0) throw new Error('readDaemonAgentState not found');
    const endIdx = lines.findIndex((l, i) => i > startIdx && l === '  };');
    return lines.slice(startIdx, endIdx > 0 ? endIdx : lines.length).join('\n');
  }

  it('consults canonical identity even when the detector has no name', () => {
    const body = readerBody();
    const rawIdx = body.indexOf('const rawName = ');
    const canonicalIdx = body.indexOf('canonicalIdentityFor(agentProcessTracker, id, screenSlug)');
    expect(rawIdx).toBeGreaterThan(-1);
    expect(canonicalIdx).toBeGreaterThan(rawIdx);
    // The only exit before canonical identity is the missing-session guard.
    const between = body.slice(rawIdx, canonicalIdx);
    expect(between.match(/\breturn\b/g)).toHaveLength(1);
    expect(between).toMatch(/if \(!session\) return \{ agentName: null, agentVerified: false, \.\.\.state \};/);
  });

  it('derives the screen slug only from a detector name', () => {
    expect(readerBody()).toMatch(/const screenSlug = rawName \? agentDisplayToSlug\(rawName\) : undefined;/);
  });

  it('reports the name through reportedAgentName with the canonical answer', () => {
    expect(readerBody()).toMatch(
      /return \{\s*agentName: reportedAgentName\(\{ rawName, screenSlug, canonical \}\),\s*agentVerified,\s*\.\.\.state,?\s*\};/,
    );
  });

  it('serves every agent-state caller from the same reader', () => {
    // #1163: the remote roster row must appear exactly when a local one would.
    expect(src).toMatch(/readAgentStateForWeb = readDaemonAgentState;/);
    for (const method of ['daemon.getAgentName', 'daemon.getAgentState']) {
      const at = src.indexOf(`pipeServer.onRpc('${method}'`);
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, src.indexOf('});', at))).toMatch(/return readDaemonAgentState\(id\);/);
    }
  });

  // #1307 — scheduled delivery must require agentVerified and re-check the
  // pane's agent process before each write.
  it('computes agentVerified from provesLiveAgent and the promptLog veto', () => {
    const body = readerBody();
    const canonicalIdx = body.indexOf('canonicalIdentityFor(agentProcessTracker, id, screenSlug)');
    const provesIdx = body.indexOf('provesLiveAgent(agentProcessTracker.identityFor(id), canonical.slug)');
    expect(provesIdx).toBeGreaterThan(canonicalIdx);
    expect(body).toMatch(
      /session\.promptLog\.commandRunningIfKnown\(\) === false/,
    );
    expect(body).toMatch(/const agentVerified =/);
  });

  function promptV2Body(): string {
    const at = src.indexOf("pipeServer.onRpc('daemon.deliverScheduledPromptV2'");
    if (at < 0) throw new Error('daemon.deliverScheduledPromptV2 handler not found');
    const end = src.indexOf('\n  });', at);
    return src.slice(at, end > 0 ? end : src.length);
  }

  it('requires agentVerified before treating the pane as a live agent', () => {
    const body = promptV2Body();
    expect(body).toMatch(/slug && current\.agentVerified/);
  });

  it('wires a fresh pid-liveness dependency after getAgentState and before write', () => {
    const body = promptV2Body();
    const getAgentStateIdx = body.indexOf('getAgentState:');
    const livenessIdx = body.indexOf('isAgentProcessAlive:');
    const writeIdx = body.indexOf('write:');
    expect(getAgentStateIdx).toBeGreaterThan(-1);
    expect(livenessIdx).toBeGreaterThan(getAgentStateIdx);
    expect(writeIdx).toBeGreaterThan(livenessIdx);
    expect(body).toMatch(/agentProcessTracker\.pidFor\(id\)/);
    expect(body).toMatch(/agentProcessTracker\.verifyLive\(id, agentSlug\)/);
    expect(body).toMatch(/ProcessMonitor\.isRunning\(pid\)/);
  });

  it('#1392 — answers no agent / idle once OSC 133 says the shell is back at its prompt', () => {
    const body = readerBody();
    const promptIdx = body.indexOf('const shellAtPrompt = ');
    const guardIdx = body.indexOf('if (shellAtPrompt && !liveProcess) {');
    expect(promptIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(promptIdx);
    // The prompt-return guard must sit AFTER canonical identity (the #1303
    // contract above) and answer idle with no name — the same signal the
    // renderer's #1210 clear uses, so the two readers cannot disagree.
    const canonicalIdx = body.indexOf('canonicalIdentityFor(agentProcessTracker, id, screenSlug)');
    expect(guardIdx).toBeGreaterThan(canonicalIdx);
    const guard = body.slice(guardIdx, body.indexOf('}', guardIdx));
    expect(guard).toMatch(/agentName: null/);
    expect(guard).toMatch(/agentStatus: 'idle'/);
  });
});
