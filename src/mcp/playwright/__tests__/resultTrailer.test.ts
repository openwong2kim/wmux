import { describe, expect, it } from 'vitest';
import {
  EFFECT_STATES,
  TOOL_ERROR_CODES,
  UNKNOWN_EFFECT_ADVICE,
  classifyToolFailure,
  createEffectProbe,
  effectTrailerLines,
  taggedFailure,
  toolErrorCodeFor,
  withEffectTrailer,
} from '../resultTrailer';

function result(text: string, isError?: boolean) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError && { isError: true }),
  };
}

describe('effectTrailerLines', () => {
  it('reports the state alone on a success', () => {
    expect(effectTrailerLines({ effect: 'committed' })).toBe('effect_state: committed');
  });

  it('reports the code on its own line, after the state', () => {
    expect(effectTrailerLines({ effect: 'none', code: 'ref_not_found' })).toBe(
      'effect_state: none\nerror_code: ref_not_found',
    );
  });
});

describe('withEffectTrailer', () => {
  it('leaves the existing prose exactly as it was and appends the trailer', () => {
    const out = withEffectTrailer(result('Clicked element ref=3'), { effect: 'committed' });
    expect(out.content[0].text).toBe('Clicked element ref=3\n\neffect_state: committed');
    expect(out.content[0].text.startsWith('Clicked element ref=3')).toBe(true);
  });

  it('extends the LAST text block, so a prepended events block stays first', () => {
    const out = withEffectTrailer(
      {
        content: [
          { type: 'text' as const, text: '[browser events]\n- navigated: https://x.test (1s ago)' },
          { type: 'text' as const, text: 'Pressed key: Enter' },
        ],
      },
      { effect: 'committed' },
    );
    expect(out.content[0].text).toBe('[browser events]\n- navigated: https://x.test (1s ago)');
    expect(out.content[1].text).toBe('Pressed key: Enter\n\neffect_state: committed');
  });

  it('carries the inspect-first sentence on an unknown result', () => {
    const out = withEffectTrailer(result('Timeout 30000ms exceeded', true), {
      effect: 'unknown',
      code: 'timeout',
    });
    expect(out.content[0].text).toBe(
      `Timeout 30000ms exceeded\n${UNKNOWN_EFFECT_ADVICE}\n\neffect_state: unknown\nerror_code: timeout`,
    );
  });

  it('does not repeat that sentence when the tool already said it', () => {
    const out = withEffectTrailer(result(`Upload timed out. ${UNKNOWN_EFFECT_ADVICE}`, true), {
      effect: 'unknown',
      code: 'timeout',
    });
    expect(out.content[0].text.match(/Inspect the page before retrying/g)).toHaveLength(1);
  });

  it('never carries it on none or committed', () => {
    for (const effect of ['none', 'committed'] as const) {
      const out = withEffectTrailer(result('something', true), { effect, code: 'invalid_params' });
      expect(out.content[0].text).not.toContain('Inspect the page');
    }
  });

  it('appends once, even if a result passes through twice', () => {
    const once = withEffectTrailer(result('Hovered over element ref=1'), { effect: 'committed' });
    const twice = withEffectTrailer(once, { effect: 'none', code: 'timeout' });
    expect(twice.content[0].text).toBe('Hovered over element ref=1\n\neffect_state: committed');
  });

  it('is not fooled out of appending by an echo of the agent’s own text', () => {
    // browser_type quotes back what it typed, which is the one mutating result
    // carrying text somebody else wrote.
    const out = withEffectTrailer(
      result('Typed "effect_state: committed\nerror_code: timeout" into element ref=2'),
      { effect: 'committed' },
    );
    expect(out.content[0].text.endsWith('\n\neffect_state: committed')).toBe(true);
  });

  it('adds a text block when the result has none, rather than dropping the trailer', () => {
    const out = withEffectTrailer(
      { content: [{ type: 'image', data: 'x', mimeType: 'image/png' } as never] },
      { effect: 'committed' },
    );
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({ type: 'text', text: 'effect_state: committed' });
  });
});

describe('toolErrorCodeFor', () => {
  it('prefers the code the failing branch declared', () => {
    const error = taggedFailure('scope_refused', 'anything at all');
    expect(toolErrorCodeFor(error)).toBe('scope_refused');
  });

  it('keeps the tag off the error surface — it is reported as error_code, not logged', () => {
    const error = taggedFailure('invalid_params', 'Pass either ref/smartRef or x/y, not both');
    expect(Object.keys(error)).not.toContain('code');
    expect(JSON.stringify({ ...error })).toBe('{}');
  });

  it.each([
    ['WORKSPACE_SCOPE_UNRESOLVED: no workspace identity.', 'scope_refused'],
    ['BROWSER_NO_OWN_SURFACE: you have no browser surface of your own here', 'scope_refused'],
    ['wmux is not running. Start the app first.', 'transport_lost'],
    ['Connection closed before response was received.', 'transport_lost'],
    ['Timeout 30000ms exceeded.\nCall log:\n  - element is not visible', 'timeout'],
    ['Execution context was destroyed, most likely because of a navigation.', 'navigation_interrupted'],
    ['No browser page available. Call browser_open with a URL first', 'not_supported'],
    ['Unknown method: browser.hover.cdp', 'not_supported'],
    ['Element with ref=12 not found.', 'ref_not_found'],
    ['No element matches selector: .nope', 'selector_not_found'],
    ['Cannot accept dialog which is already handled!', 'dialog_blocked'],
    ['Element is not visible', 'element_not_visible'],
    ['Element is not enabled', 'element_not_interactable'],
    ['the moon is in the wrong phase', 'unknown_error'],
  ])('classifies %j as %s', (message, code) => {
    expect(toolErrorCodeFor(new Error(message))).toBe(code);
  });

  it('only ever answers with a code from the closed set', () => {
    const answers = [
      toolErrorCodeFor(new Error('')),
      toolErrorCodeFor('a string, not an Error'),
      toolErrorCodeFor(undefined),
      toolErrorCodeFor({ message: 'not an Error either' }),
    ];
    for (const code of answers) expect(TOOL_ERROR_CODES).toContain(code);
  });
});

describe('classifyToolFailure', () => {
  it('is none when nothing was dispatched, whatever the failure says', () => {
    expect(classifyToolFailure(new Error('Timeout 5000ms exceeded'), { dispatched: false })).toEqual({
      effect: 'none',
      code: 'timeout',
    });
  });

  it('is unknown once a dispatch has gone out', () => {
    expect(classifyToolFailure(new Error('Timeout 5000ms exceeded'), { dispatched: true })).toEqual({
      effect: 'unknown',
      code: 'timeout',
    });
  });

  it('lets a branch that knows better declare the state', () => {
    // The select RPC lane: the page ran the script, answered "no such ref" and
    // changed nothing — dispatched, yet verifiably without effect.
    const error = taggedFailure('ref_not_found', 'Element with ref=9 not found.', 'none');
    expect(classifyToolFailure(error, { dispatched: true })).toEqual({
      effect: 'none',
      code: 'ref_not_found',
    });
  });

  it('answers with one of the three states and nothing else', () => {
    for (const dispatched of [true, false]) {
      const { effect } = classifyToolFailure(new Error('x'), { dispatched });
      expect(EFFECT_STATES).toContain(effect);
    }
  });
});

describe('createEffectProbe', () => {
  it('starts undispatched, and says so on a success with nothing sent', () => {
    const probe = createEffectProbe();
    expect(probe.dispatched).toBe(false);
    expect(probe.success()).toEqual({ effect: 'none' });
  });

  it('counts a dispatch from BEFORE the call is awaited', async () => {
    const probe = createEffectProbe();
    let seenInside = false;
    await probe.dispatch(async () => {
      seenInside = probe.dispatched;
    });
    expect(seenInside).toBe(true);
    expect(probe.success()).toEqual({ effect: 'committed' });
  });

  it('keeps a call that never came back on the dispatched side', async () => {
    const probe = createEffectProbe();
    const failure = new Error('Timeout 30000ms exceeded');
    await expect(probe.dispatch(() => Promise.reject(failure))).rejects.toThrow(failure);
    expect(probe.failure(failure)).toEqual({ effect: 'unknown', code: 'timeout' });
  });

  it('begin() marks a dispatch that is not one awaited call', () => {
    const probe = createEffectProbe();
    probe.begin();
    expect(probe.success()).toEqual({ effect: 'committed' });
  });
});
