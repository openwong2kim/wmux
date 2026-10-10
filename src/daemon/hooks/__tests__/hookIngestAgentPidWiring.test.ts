// Wiring guard: the daemon's HookIngest gets the tracker's agent pid.
//
// Without `agentPidFor` the pid test in HookIngest.foreignProcessReason never
// runs, so a nested headless claude without an entrypoint could speak for its
// host pane. The construction lives inside `startDaemon`, which cannot be built
// in a unit test, so this asserts the source shape (as
// src/daemon/__tests__/agentProcessExitWiring.test.ts does). The behaviour is
// covered in HookIngest.headlessChild.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('HookIngest agentPidFor daemon wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf-8');

  function constructionBody(): string {
    const lines = src.split('\n');
    const startIdx = lines.findIndex((l) => l.includes('new HookIngest({'));
    if (startIdx < 0) throw new Error('HookIngest construction not found');
    const endIdx = lines.findIndex((l, i) => i > startIdx && l === '    });');
    return lines.slice(startIdx, endIdx > 0 ? endIdx : lines.length).join('\n');
  }

  it('passes the tracker pid, next to liveAgentFor', () => {
    const body = constructionBody();
    expect(body).toMatch(/liveAgentFor:/);
    expect(body).toMatch(/agentPidFor: \(id\) => \(agentProcessTracker\.identityFor\(id\)\?\.alive \? agentProcessTracker\.pidFor\(id\) : undefined\)/);
  });
});
