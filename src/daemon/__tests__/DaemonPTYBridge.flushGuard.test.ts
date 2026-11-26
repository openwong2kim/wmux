// M3 A1 guard: the bridge analyses each chunk after forwarding it, so every
// way in from outside that reads or changes what that analysis produces must
// run the pending analysis first (flushPendingDetection). Source-shape, like
// paneDeliveryLockWiring.test.ts: a new public member fails here until it
// flushes or is listed below with the reason it need not.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** Public members that need no flush, and why. */
const EXEMPT: Record<string, string> = {
  setupDataForwarding: 'flushes the previous setup itself, then builds the new queue',
  flushPendingDetection: 'the flush itself',
  isMuted: 'the mute flag is set inline, never by the analysis',
  heldOutput: 'muted output is held inline, before the analysis',
  discardHeld: 'muted output is held inline, before the analysis',
  armStartupDa1Reply: 'the startup DA1 answer runs inline, ahead of the queue',
};

/** Public members of a class body: name, and the first statement of the body. */
function publicMembers(src: string, className: string): Array<{ name: string; first: string }> {
  const lines = src.slice(src.indexOf(`export class ${className}`)).split('\n');
  const out: Array<{ name: string; first: string }> = [];
  const sig = /^ {2}(?:async )?(?:get )?([A-Za-z_][A-Za-z0-9_]*)\(/;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '}') break; // the end of the class body
    const m = sig.exec(lines[i]);
    if (!m || /^ {2}(?:private|protected|static|constructor)\b/.test(lines[i])) continue;
    // A one-line member: its body is on the signature line.
    const inline = /\{(.*)\}\s*$/.exec(lines[i]);
    if (inline) { out.push({ name: m[1], first: inline[1].trim() }); continue; }
    // Skip overload signatures; find the line that opens the body.
    let j = i;
    while (j < lines.length && !/\{\s*$/.test(lines[j]) && !/;\s*$/.test(lines[j])) j++;
    if (/;\s*$/.test(lines[j])) continue;
    let k = j + 1;
    while (k < lines.length && /^\s*(\/\/.*)?$/.test(lines[k])) k++;
    out.push({ name: m[1], first: lines[k].trim() });
  }
  return out;
}

describe('the pending output analysis is flushed before every outside read or change', () => {
  it('every public member of DaemonPTYBridge flushes first, or is exempt with a reason', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'DaemonPTYBridge.ts'), 'utf-8');
    const members = publicMembers(src, 'DaemonPTYBridge');
    expect(members.length).toBeGreaterThan(40);
    const missing = members
      .filter((m) => !(m.name in EXEMPT))
      .filter((m) => m.first !== 'this.flushPendingDetection();')
      .map((m) => m.name);
    expect(missing).toEqual([]);
    // Nothing exempt that no longer exists.
    for (const name of Object.keys(EXEMPT)) expect(members.map((m) => m.name)).toContain(name);
  });

  it('the outputModes accessor is among them', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'DaemonPTYBridge.ts'), 'utf-8');
    expect(publicMembers(src, 'DaemonPTYBridge').find((m) => m.name === 'outputModes')?.first).toBe('this.flushPendingDetection();');
  });

  it('every read of PromptEventLog runs its before-read hook first', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'PromptEventLog.ts'), 'utf-8');
    const writes = new Set(['append', 'clear', 'setBeforeRead']);
    const reads = publicMembers(src, 'PromptEventLog').filter((m) => !writes.has(m.name));
    expect(reads.map((m) => m.name).sort()).toEqual(
      ['commandRunningIfKnown', 'exitAfterPrompt', 'isCommandRunning', 'lastCompletedCommandRange', 'recent', 'since', 'size', 'snapshot'],
    );
    expect(reads.filter((m) => m.first !== 'this.beforeRead?.();').map((m) => m.name)).toEqual([]);
  });

  it('the bridge hooks its prompt log to the flush', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'DaemonPTYBridge.ts'), 'utf-8');
    expect(src).toContain('promptLog?.setBeforeRead(() => this.flushPendingDetection());');
  });
});
