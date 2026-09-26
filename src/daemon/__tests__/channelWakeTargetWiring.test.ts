// Wiring guard for the channel wake worker's session snapshot.
//
// `lastDetectedAgent` never clears, so a pane whose agent exited still reads as
// that agent and the worker typed a nudge + Enter into the shell. The fix lives
// in the `listLiveSessions` mapper inside `main()`, which cannot be constructed
// in a unit test; the precedence itself is covered by wakeAgentSlug in
// channelWakeWorker.test.ts. Source-shape assertions, following
// agentStateReaderWiring.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('channel wake worker session snapshot wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  function mapperBody(): string {
    const start = src.indexOf('listLiveSessions: () =>');
    if (start < 0) throw new Error('listLiveSessions mapper not found');
    const end = src.indexOf('attached: meta.state', start);
    if (end < 0) throw new Error('listLiveSessions mapper end not found');
    return src.slice(start, end);
  }

  it('hands the worker the gated slug, never the sticky one', () => {
    const body = mapperBody();
    expect(body).toMatch(/wakeAgentSlug\(\s*meta\.lastDetectedAgent/);
    expect(body).toContain('promptLog.commandRunningIfKnown()');
    expect(body).toContain('agentProcessTracker.identityFor(meta.id)');
    expect(body).not.toMatch(/lastDetectedAgent:\s*meta\.lastDetectedAgent/);
  });
});
