import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeCompletionEvidenceWire } from '../../../shared/completionEvidence';

/**
 * §6.M P1 PR-D′ — a2a.task.update completion-evidence wiring guard. useRpcBridge pulls in
 * store/window and cannot be imported in vitest, so handler wiring is locked via source-structure
 * assertions like a2aPaneIdentity tests. Actual normalize boundary contract (malformed→block /
 * recordedBy drop) is verified by driving the pure function the bridge calls directly.
 */
describe('useRpcBridge — a2a.task.update completion evidence wiring (source-structure)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');

  function region(start: string, end: string): string {
    const m = src.match(new RegExp(`${start}[\\s\\S]*?${end}`));
    if (!m) throw new Error(`region ${start} → ${end} not found in useRpcBridge.ts`);
    return m[0];
  }

  it('imports normalizeCompletionEvidenceWire', () => {
    // PR-C adds isVerifiedItem to the same import, so match loosely in named-import list
    // (exact brace matching is fragile to order and companion imports).
    expect(src).toMatch(/import \{[^}]*\bnormalizeCompletionEvidenceWire\b[^}]*\} from '\.\.\/\.\.\/shared\/completionEvidence'/);
  });

  it('wire-normalizes params.evidence before transition; null → completion_evidence_malformed, no transition', () => {
    const block = region("method === 'a2a\\.task\\.update'", "method === 'a2a\\.task\\.cancel'");
    // normalize call
    expect(block).toMatch(/normalizeCompletionEvidenceWire\(params\.evidence\)/);
    // On failure, early return with malformed reason code (transition not applied)
    expect(block).toMatch(/completion_evidence_malformed/);
    // Order invariant: normalize + malformed return before store.updateTaskStatus transition.
    const normalizeIdx = block.indexOf('normalizeCompletionEvidenceWire');
    const malformedIdx = block.indexOf('completion_evidence_malformed');
    const transitionIdx = block.indexOf('store.updateTaskStatus(');
    expect(normalizeIdx).toBeGreaterThan(-1);
    expect(malformedIdx).toBeGreaterThan(normalizeIdx);
    expect(transitionIdx).toBeGreaterThan(malformedIdx);
  });

  it('passes normalized evidence to store.updateTaskStatus', () => {
    const block = region("method === 'a2a\\.task\\.update'", "method === 'a2a\\.task\\.cancel'");
    expect(block).toMatch(/store\.updateTaskStatus\(taskId, nextState, workspaceId, callerAddrUpdate, undefined, evidence\)/);
  });
});

/**
 * §6.M P1 PR-C — locks wiring where emitA2aTaskEvent (primary a2a.task emitter — teardown/channel
 * mention are separate paths) derives verifiedItemCount from task.status.evidence on **terminal
 * transitions (completed/failed)** and passes to publishA2aTask. useRpcBridge cannot be imported,
 * so verified via source-structure assertions (same pattern as wiring test above).
 */
describe('useRpcBridge — emitA2aTaskEvent verifiedItemCount derivation (§6.M PR-C, source-structure)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'useRpcBridge.ts'), 'utf-8');

  it('imports isVerifiedItem from completionEvidence', () => {
    expect(src).toMatch(/import \{[^}]*\bisVerifiedItem\b[^}]*\} from '\.\.\/\.\.\/shared\/completionEvidence'/);
  });

  it('derives from evidence and passes to publishA2aTask on terminal transitions (completed/failed) only', () => {
    const m = src.match(/function emitA2aTaskEvent\([\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const fn = m![0];
    // State gate (Codex+GLM review): derive only on completed/failed — prevent working events
    // carrying grade. Evidence gate alone can let non-terminal transitions carry grade.
    expect(fn).toMatch(/effectiveState === 'completed' \|\| effectiveState === 'failed'/);
    expect(fn).toMatch(/task\.status\.evidence/);
    expect(fn).toMatch(/\.filter\(isVerifiedItem\)\.length/);
    // items guard (?.): treat undefined as absent safely on fallback wire variants.
    expect(fn).toMatch(/evidence\?\.items/);
    // Pass derived count as last arg to publishA2aTask (messagePreview slot undefined).
    expect(fn).toMatch(/publishA2aTask\([\s\S]*undefined,\s*verifiedItemCount\)/);
  });
});

describe('useRpcBridge — normalize boundary contract (pure functions bridge depends on)', () => {
  it('malformed (unknown kind / non-plain) → null ⇒ bridge skips transition', () => {
    expect(normalizeCompletionEvidenceWire({ summary: 's', items: [{ kind: 'vibe', status: 'ok', summary: 'x' }] })).toBeNull();
    expect(normalizeCompletionEvidenceWire('not-an-object')).toBeNull();
  });

  it('valid evidence → normalized to new object; smuggled recordedBy dropped before store', () => {
    const out = normalizeCompletionEvidenceWire({
      summary: 'ok',
      items: [{ kind: 'inspection', status: 'unverified', summary: 'self-reported' }],
      recordedBy: 'ws-forged', // forged server-only stamp attempt
      sneaky: 'x', // unknown key
    });
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('recordedBy');
    expect(out).not.toHaveProperty('sneaky');
    expect(out?.summary).toBe('ok');
    expect(out?.items).toHaveLength(1);
  });
});
