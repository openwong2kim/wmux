// Wiring guard for #3391 (agent restart and a recorded exit in delivery
// presence). Source-shape assertions, as paneDeliveryLockWiring.test.ts does:
// the HookIngest and presence deps are built inside the daemon's start-up,
// which a unit test cannot construct. The behaviour is covered in
// deliveryPresence.test.ts, AgentProcessTracker.os.test.ts and HookIngest.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('delivery presence restart wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  it("a startup/resume rebind reaches the tracker's restart mark", () => {
    expect(src).toContain('onAgentRestart: (id) => agentProcessTracker.noteAgentRestart(id),');
  });

  it("presence reads the restart mark and the re-probe's view of the shell's tree from the tracker", () => {
    const at = src.indexOf('const presenceDeps: DeliveryPresenceDeps = {');
    expect(at).toBeGreaterThan(0);
    const deps = src.slice(at, src.indexOf('\n  };', at));
    expect(deps).toContain('restartedSince: (sid) => agentProcessTracker.restartedSince(sid),');
    expect(deps).toContain('noAgentUnderShell: (sid, since) => agentProcessTracker.reprobeSawNoAgent(sid, since),');
    expect(deps).toContain('canReprobe: (sid) => agentProcessTracker.canReprobe(sid),');
  });
});
