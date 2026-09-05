import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// CompletionAlarm daemon wiring guards (source-level, same approach as
// x6ResumeDurability.test.ts: the handlers live inside main() in index.ts and
// cannot be invoked in isolation).
//
// Two contracts this file locks:
//   1. `session:agent` — a `decision:'pending'` (provisional completion window
//      open) must skip ONLY the broadcast. The lastDetectedAgent persistence,
//      the recovered-set deletes, and the resume-chip arm run BEFORE the skip
//      and must stay on the pre-skip path: a held window is not a rejection,
//      and losing the persistence here would drop the post-reboot resume pill
//      for exactly the panes that are mid-turn.
//   2. `session:active` — byte activity feeds `notePaneWorking`, with the
//      detected name falling back to the persisted lastDetectedAgent. This is
//      the only working-evidence feed for UNGOVERNED panes; without the
//      fallback, a text-only turn on an ungoverned pane would leave the gate
//      closed and every completion silently dropped. A governed pane gets a
//      precise prompt-arrival rebuttal from the UserPromptSubmit hook instead.
describe('CompletionAlarm daemon wiring', () => {
  const daemonIndexPath = path.join(__dirname, '..', 'index.ts');
  const src = fs.readFileSync(daemonIndexPath, 'utf-8');

  function handlerBody(event: string): string {
    const lines = src.split('\n');
    const startIdx = lines.findIndex((l) => l.includes(`sessionManager.on('${event}'`));
    if (startIdx < 0) throw new Error(`Handler not found: ${event}`);
    const nextIdx = lines.findIndex((l, i) => i > startIdx && /sessionManager\.on\(/.test(l));
    return lines.slice(startIdx, nextIdx > 0 ? nextIdx : lines.length).join('\n');
  }

  it('session:agent: pending skips only the broadcast — persistence and chip arm run first', () => {
    const body = handlerBody('session:agent');
    const skipIdx = body.indexOf("arbitration.decision === 'pending'");
    expect(skipIdx).toBeGreaterThan(-1);
    // Everything this guard names must appear BEFORE the pending skip.
    expect(body.indexOf('stateWriter.saveImmediate')).toBeLessThan(skipIdx);
    expect(body.indexOf('agentProcessTracker.arm')).toBeLessThan(skipIdx);
    expect(body.indexOf('recoveredAgentShellIds.delete')).toBeLessThan(skipIdx);
    // And the broadcast itself is what the skip guards.
    expect(body.indexOf("type: 'agent.event'")).toBeGreaterThan(skipIdx);
  });

  it('session:active: byte activity feeds notePaneWorking with a lastDetectedAgent fallback', () => {
    const body = handlerBody('session:active');
    expect(body).toMatch(/hookIngest\?\.notePaneWorking\(/);
    // Keyed to ONE slug — a keyless working cue would arm every agent's gate
    // on the pane. Detected name first, persisted slug as the fallback.
    expect(body).toMatch(/agentDisplayToSlug\(payload\.agentName/);
    expect(body).toMatch(/meta\.lastDetectedAgent/);
    // A resize repaint is not work: the alarm feed must skip
    // likelyRepaint-flagged bursts (a refit rebutting a pending completion
    // window would silently kill a real alarm) while the loose status-dot
    // broadcast below the guard keeps running.
    const feedIdx = body.indexOf('notePaneWorking(');
    const repaintGuardIdx = body.indexOf('likelyRepaint');
    expect(repaintGuardIdx).toBeGreaterThan(-1);
    expect(repaintGuardIdx).toBeLessThan(feedIdx);
  });
});
