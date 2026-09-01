import { describe, it, expect } from 'vitest';
import {
  MAX_ARG_BYTES,
  MAX_STEPS_PER_TRACE,
  MAX_TRACES_PER_WORKSPACE,
  QUARANTINE_FAIL_STREAK,
  TRACE_TTL_MS,
  applyRunOutcome,
  applyVariables,
  clampArgValue,
  describeAxis,
  hasUnrecordableStep,
  isQuarantined,
  isReplayableTool,
  isServable,
  isValidTraceName,
  normalizeUrlKey,
  pruneTraces,
  refEntryToAxis,
  refMapShapeHash,
  sanitizeTraceRecord,
  sanitizeTraceStep,
  stripUrlUserinfo,
  traceVariableNames,
  type TraceRecord,
  type TraceStep,
} from '../actionTrace';

const NOW = 1_700_000_000_000;

function step(overrides: Partial<TraceStep> = {}): TraceStep {
  return {
    tool: 'browser_click',
    axis: { kind: 'ref', role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' },
    args: {},
    ...overrides,
  };
}

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: 'tr_1',
    name: 'login',
    urlKey: 'https://example.com/login',
    surfaceShape: 'abc',
    steps: [step()],
    observedCount: 1,
    successCount: 1,
    failCount: 0,
    createdAt: NOW,
    lastUsedAt: NOW,
    ...overrides,
  };
}

describe('normalizeUrlKey', () => {
  it('keeps origin and pathname, drops query and fragment', () => {
    expect(normalizeUrlKey('https://example.com/search?q=cats#top')).toBe('https://example.com/search');
  });

  it('drops userinfo so a credential can never enter a stored key', () => {
    const key = normalizeUrlKey('https://alice:hunter2@example.com/app');
    expect(key).toBe('https://example.com/app');
    expect(key).not.toContain('hunter2');
    expect(key).not.toContain('alice');
  });

  it('normalises a trailing slash so /app and /app/ file together', () => {
    expect(normalizeUrlKey('https://example.com/app/')).toBe(normalizeUrlKey('https://example.com/app'));
  });

  it('keeps the bare root path', () => {
    expect(normalizeUrlKey('https://example.com/')).toBe('https://example.com/');
  });

  it('separates ports and schemes', () => {
    expect(normalizeUrlKey('http://example.com:8080/a')).toBe('http://example.com:8080/a');
    expect(normalizeUrlKey('https://example.com/a')).not.toBe(normalizeUrlKey('http://example.com/a'));
  });

  it('falls back to the trimmed input rather than throwing', () => {
    expect(normalizeUrlKey('  NOT a url  ')).toBe('not a url');
  });
});

describe('stripUrlUserinfo', () => {
  it('removes a credential from the authority and says it had to', () => {
    const out = stripUrlUserinfo('https://alice:hunter2@example.com/app?keep=1');
    expect(out.stripped).toBe(true);
    expect(out.url).not.toContain('hunter2');
    expect(out.url).not.toContain('alice');
    // The query survives — unlike a url KEY, a navigate step has to replay it.
    expect(out.url).toContain('keep=1');
  });

  it('flags a userinfo with no password half too', () => {
    expect(stripUrlUserinfo('https://alice@example.com/app').stripped).toBe(true);
  });

  it('leaves a clean URL untouched and unflagged', () => {
    const out = stripUrlUserinfo('https://example.com/app?q=1');
    expect(out).toEqual({ url: 'https://example.com/app?q=1', stripped: false });
  });

  it('passes an unparseable or non-hierarchical URL straight through', () => {
    expect(stripUrlUserinfo('data:text/html,<p>hi</p>').stripped).toBe(false);
    expect(stripUrlUserinfo('not a url')).toEqual({ url: 'not a url', stripped: false });
  });
});

describe('refMapShapeHash', () => {
  const entry = (role: string, name: string, sameNameIndex = 0, frameKey = '') => ({
    role,
    name,
    sameNameIndex,
    sameNameTotal: 1,
    frameKey,
  });

  it('is invariant under ref renumbering — it never sees a ref number', () => {
    // Same page, refs 12/13 vs 904/905: the input carries no ref at all, which
    // is exactly why a restart cannot invalidate a stored shape.
    const page = [entry('button', 'Sign in'), entry('textbox', 'Email')];
    expect(refMapShapeHash(page)).toBe(refMapShapeHash([...page]));
  });

  it('is invariant under snapshot walk order', () => {
    const a = [entry('button', 'Sign in'), entry('textbox', 'Email')];
    expect(refMapShapeHash(a)).toBe(refMapShapeHash([...a].reverse()));
  });

  it('changes when a real element appears', () => {
    const before = [entry('button', 'Sign in')];
    expect(refMapShapeHash([...before, entry('banner', 'Cookies')])).not.toBe(
      refMapShapeHash(before),
    );
  });

  it('changes when a name changes', () => {
    expect(refMapShapeHash([entry('button', 'Sign in')])).not.toBe(
      refMapShapeHash([entry('button', 'Log in')]),
    );
  });

  it('distinguishes the same element in a different frame', () => {
    expect(refMapShapeHash([entry('button', 'Pay')])).not.toBe(
      refMapShapeHash([entry('button', 'Pay', 0, 'f1')]),
    );
  });

  it('is stable for an empty ref map', () => {
    expect(refMapShapeHash([])).toBe(refMapShapeHash([]));
  });
});

describe('refEntryToAxis', () => {
  it('carries the 4-tuple and the frame key through', () => {
    expect(
      refEntryToAxis({ role: 'link', name: 'Docs', sameNameIndex: 2, sameNameTotal: 5, frameKey: 'f1' }),
    ).toEqual({ kind: 'ref', role: 'link', name: 'Docs', sameNameIndex: 2, sameNameTotal: 5, frameKey: 'f1' });
  });

  it('refuses an entry with no role rather than storing a match-anything axis', () => {
    expect(refEntryToAxis({ role: '', name: 'x', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' })).toBeNull();
    expect(refEntryToAxis(null)).toBeNull();
  });

  it('repairs a non-positive total instead of dropping the ref', () => {
    expect(refEntryToAxis({ role: 'button', name: '', sameNameIndex: 0, sameNameTotal: 0, frameKey: '' }))
      .toMatchObject({ sameNameTotal: 1 });
  });
});

describe('describeAxis', () => {
  it('names the nth-of-N only when the population is larger than one', () => {
    expect(describeAxis({ kind: 'ref', role: 'button', name: 'OK', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' }))
      .toBe('button "OK"');
    expect(describeAxis({ kind: 'ref', role: 'button', name: 'OK', sameNameIndex: 1, sameNameTotal: 3, frameKey: '' }))
      .toBe('button "OK" (#2 of 3)');
  });

  it('renders css and page axes', () => {
    expect(describeAxis({ kind: 'css', selector: '#go' })).toBe('css #go');
    expect(describeAxis({ kind: 'none' })).toBe('page');
  });
});

describe('applyVariables', () => {
  it('substitutes a supplied placeholder', () => {
    const out = applyVariables({ text: '{{email}}' }, { email: 'a@b.c' });
    expect(out.args.text).toBe('a@b.c');
    expect(out.missing).toEqual([]);
  });

  it('reports a missing placeholder instead of typing it literally', () => {
    const out = applyVariables({ text: 'hi {{name}}' }, {});
    expect(out.missing).toEqual(['name']);
    expect(out.args.text).toBe('hi {{name}}');
  });

  it('leaves non-string arguments untouched', () => {
    expect(applyVariables({ submit: true, amount: 3 }, {}).args).toEqual({ submit: true, amount: 3 });
  });

  it('substitutes several placeholders in one value', () => {
    const out = applyVariables({ text: '{{a}}-{{b}}' }, { a: '1', b: '2' });
    expect(out.args.text).toBe('1-2');
  });

  it('lists the placeholders a trace expects, in first-seen order', () => {
    const names = traceVariableNames({
      steps: [step({ args: { text: '{{user}}' } }), step({ args: { text: '{{pass}} {{user}}' } })],
    });
    expect(names).toEqual(['user', 'pass']);
  });
});

describe('clampArgValue', () => {
  it('leaves a short value alone', () => {
    expect(clampArgValue('hello')).toEqual({ value: 'hello', truncated: false });
  });

  it('marks a value it had to cut', () => {
    const out = clampArgValue('x'.repeat(MAX_ARG_BYTES + 10));
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(String(out.value), 'utf8')).toBeLessThanOrEqual(MAX_ARG_BYTES);
  });

  it('does not leave a broken multi-byte character at the cut', () => {
    const out = clampArgValue('가'.repeat(MAX_ARG_BYTES));
    expect(String(out.value)).not.toContain('�');
  });
});

describe('serving rules', () => {
  it('serves a proven trace', () => {
    expect(isServable(trace({ successCount: 2, failCount: 1 }))).toBe(true);
  });

  it('refuses to serve an unproven trace', () => {
    expect(isServable(trace({ successCount: 0, failCount: 0 }))).toBe(false);
  });

  it('refuses to serve a trace that fails at least as often as it works', () => {
    expect(isServable(trace({ successCount: 1, failCount: 1 }))).toBe(false);
  });

  it('refuses to serve a trace with a hole in it', () => {
    const holed = trace({ steps: [step({ unrecordable: 'password' })] });
    expect(hasUnrecordableStep(holed)).toBe(true);
    expect(isServable(holed)).toBe(false);
  });

  it('refuses to serve a quarantined trace', () => {
    const q = trace({ successCount: 5, failCount: 1, consecutiveFailsAtStep: QUARANTINE_FAIL_STREAK });
    expect(isQuarantined(q)).toBe(true);
    expect(isServable(q)).toBe(false);
  });
});

describe('applyRunOutcome', () => {
  it('quarantines only after the SAME step fails twice running', () => {
    const first = applyRunOutcome(trace({ successCount: 3 }), { ok: false, failedStep: 2, now: NOW });
    expect(isQuarantined(first)).toBe(false);
    const second = applyRunOutcome(first, { ok: false, failedStep: 2, now: NOW });
    expect(isQuarantined(second)).toBe(true);
  });

  it('does not quarantine when the failures are at different steps', () => {
    const first = applyRunOutcome(trace({ successCount: 3 }), { ok: false, failedStep: 2, now: NOW });
    const second = applyRunOutcome(first, { ok: false, failedStep: 4, now: NOW });
    expect(isQuarantined(second)).toBe(false);
    expect(second.lastFailStep).toBe(4);
  });

  it('a success clears the streak', () => {
    const failed = applyRunOutcome(trace(), { ok: false, failedStep: 2, now: NOW });
    const healed = applyRunOutcome(failed, { ok: true, now: NOW });
    expect(healed.consecutiveFailsAtStep).toBe(0);
    expect(healed.successCount).toBe(2);
  });
});

describe('pruneTraces', () => {
  it('drops a trace past its TTL even when the workspace is under the cap', () => {
    const stale = trace({ id: 'old', lastUsedAt: NOW - TRACE_TTL_MS - 1 });
    expect(pruneTraces([stale, trace()], NOW).map((t) => t.id)).toEqual(['tr_1']);
  });

  it('keeps the most recently used when over the count cap', () => {
    const many = Array.from({ length: MAX_TRACES_PER_WORKSPACE + 5 }, (_, i) =>
      trace({ id: `t${i}`, name: `n${i}`, lastUsedAt: NOW - i }),
    );
    const kept = pruneTraces(many, NOW);
    expect(kept).toHaveLength(MAX_TRACES_PER_WORKSPACE);
    expect(kept[0].id).toBe('t0');
    expect(kept.map((t) => t.id)).not.toContain(`t${MAX_TRACES_PER_WORKSPACE + 4}`);
  });
});

describe('sanitizeTraceStep', () => {
  it('drops a step naming a tool that is not replayable', () => {
    expect(sanitizeTraceStep({ ...step(), tool: 'browser_evaluate' })).toBeNull();
    expect(isReplayableTool('browser_evaluate')).toBe(false);
  });

  it('drops a ref axis whose index falls outside its own population', () => {
    expect(
      sanitizeTraceStep(step({
        axis: { kind: 'ref', role: 'button', name: 'x', sameNameIndex: 3, sameNameTotal: 2, frameKey: '' },
      })),
    ).toBeNull();
  });

  it('keeps a declared unrecordable reason', () => {
    expect(sanitizeTraceStep(step({ unrecordable: 'password' }))?.unrecordable).toBe('password');
  });

  it('turns a lost drag target into a hole rather than a one-element step', () => {
    const out = sanitizeTraceStep({ ...step({ tool: 'browser_drag' }), target2: { kind: 'bogus' } });
    expect(out?.unrecordable).toBe('unresolved-axis');
  });

  it('drops arguments with unusable keys and non-scalar values', () => {
    const out = sanitizeTraceStep(step({ args: { text: 'ok', 'bad key': 'x', obj: {} } as never }));
    expect(out?.args).toEqual({ text: 'ok' });
  });
});

describe('sanitizeTraceRecord', () => {
  it('accepts a well-formed record', () => {
    expect(sanitizeTraceRecord(trace(), NOW)).toMatchObject({ name: 'login', successCount: 1 });
  });

  it('rejects a record whose every step was unusable', () => {
    expect(sanitizeTraceRecord(trace({ steps: [{ tool: 'nope' } as never] }), NOW)).toBeNull();
  });

  it('rejects a name that could not be safely used as a key or rendered', () => {
    expect(isValidTraceName('__proto__')).toBe(false);
    expect(sanitizeTraceRecord(trace({ name: '__proto__' }), NOW)).toBeNull();
    expect(sanitizeTraceRecord(trace({ name: 'a'.repeat(200) }), NOW)).toBeNull();
  });

  it('caps the step count', () => {
    const long = trace({ steps: Array.from({ length: MAX_STEPS_PER_TRACE + 10 }, () => step()) });
    expect(sanitizeTraceRecord(long, NOW)?.steps).toHaveLength(MAX_STEPS_PER_TRACE);
  });

  it('repairs negative counters instead of trusting them', () => {
    expect(sanitizeTraceRecord(trace({ successCount: -4, failCount: -1 }), NOW)).toMatchObject({
      successCount: 0,
      failCount: 0,
    });
  });
});
