// F26 — source-shape guard: the daemon create path checks a fan-out task
// pane's launch line after writing it (verifyLaunchLine), and only a task
// pane's. The handler is a closure inside registerPtyHandlers, which a unit
// test cannot construct (same pattern as pty.handler.promote.test.ts).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'pty.handler.ts'), 'utf-8');

describe('pty:create launch-line check', () => {
  it('is armed for a bot worker or a fan-out task pane only', () => {
    expect(src).toMatch(/const verifyTaskLine = !!botWorker \|\| !!options\?\.fanoutTaskOf;/);
  });

  it('starts after a write the socket took, once, and re-sends the same line through the same writer', () => {
    const at = src.indexOf('const verifyTaskLine');
    const body = src.slice(at, src.indexOf('onExhausted', at));
    expect(body).toMatch(/const delivered = writeLaunchLine\(cmd\);/);
    expect(body).toMatch(/if \(delivered && verifyTaskLine && !verifying\) \{\s*verifying = true;\s*verifyLaunchLine\(\{/);
    expect(body).toMatch(/daemonClient\.rpc\('daemon\.writeIfUnchanged', \{ sessionId, data: sanitizePtyText\(cmd\) \+ '\\r', expect \}/);
    expect(body).toMatch(/daemonClient\.rpc\('daemon\.readPromptEvents', \{ sessionId, limit: 32 \}, \{ timeoutMs: 2_000 \}\)/);
  });

  it('forgets a pane\'s folder-trust log memory when its session dies or is disposed', () => {
    expect(src).toMatch(/forgetPtyShell\(payload\.sessionId\);\s*forgetFolderTrustPane\(payload\.sessionId\);/);
    expect(src).toMatch(/forgetPtyShell\(id\);\s*forgetFolderTrustPane\(id\);/);
  });

  it('asks about a folder-trust prompt before the startup line, an unreadable screen stopping it too', () => {
    const at = src.indexOf('const verifyTaskLine');
    const body = src.slice(at, src.indexOf('write: (cmd) => {', at));
    expect(body).toContain("beforeWrite: () => folderTrustLaunchHold(daemonClient, sessionId, 'startup line', { refuseUnknown: true, once: true, budgetMs: FOLDER_TRUST_DELIVERY_BUDGET_MS }),");
  });

  it('re-sends only on the daemon\'s process-checked word that nothing runs in the pane', () => {
    const at = src.indexOf('const verifyTaskLine');
    const body = src.slice(at, src.indexOf('onExhausted', at));
    expect(body).toMatch(/daemonClient\.rpc\('daemon\.getLaunchPresence', \{ id: sessionId, probeProcess: true \}/);
    expect(body).toMatch(/return !!res && launchPresenceAllowsResend\(/);
    expect(body).toMatch(/outcome === 'unverified'/);
  });
});
