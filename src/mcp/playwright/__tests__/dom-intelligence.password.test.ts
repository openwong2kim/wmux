// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  getSmartSnapshotViaEval,
  clearElementCache,
  type IndexedElement,
} from '../dom-intelligence';
import { REDACTED_PASSWORD } from '../redact';

// browser_smart_snapshot's packaged/RPC path reads `el.value` straight off the
// DOM, which is plaintext for EVERY input type — no a11y tree is doing the
// masking here. The script runs against jsdom the same way the selector tests
// execute in-page code.

const LOGIN_FORM =
  '<form>' +
  '<input id="u" name="username" type="text" autocomplete="username">' +
  '<input id="p" name="password" type="password" autocomplete="current-password">' +
  '<input id="p2" name="new_password" type="text" autocomplete="new-password">' +
  '<input id="e" name="empty_password" type="password">' +
  '<button>Sign in</button>' +
  '</form>';

/** Indirect eval → runs in global scope, where jsdom's document lives. */
const evaluate = async (expr: string) => (0, eval)(expr);

async function snapshot() {
  clearElementCache();
  return getSmartSnapshotViaEval(evaluate);
}

function byName(elements: IndexedElement[], needle: string): IndexedElement | undefined {
  return elements.find((e) => e.name === needle);
}

describe('getSmartSnapshotViaEval — password field values', () => {
  it('redacts type=password and autocomplete-marked plaintext fields alike', async () => {
    document.body.innerHTML = LOGIN_FORM;
    (document.getElementById('u') as HTMLInputElement).value = 'alice@example.com';
    (document.getElementById('p') as HTMLInputElement).value = 'hunter2SECRET';
    (document.getElementById('p2') as HTMLInputElement).value = 'newpassSECRET';

    const snap = await snapshot();
    const serialised = JSON.stringify(snap);

    expect(serialised).not.toContain('hunter2SECRET');
    expect(serialised).not.toContain('newpassSECRET');
    expect(byName(snap.elements, 'password')?.value).toBe(REDACTED_PASSWORD);
    expect(byName(snap.elements, 'new_password')?.value).toBe(REDACTED_PASSWORD);
  });

  it('does not over-redact: the username field keeps its value', async () => {
    document.body.innerHTML = LOGIN_FORM;
    (document.getElementById('u') as HTMLInputElement).value = 'alice@example.com';

    const snap = await snapshot();
    expect(byName(snap.elements, 'username')?.value).toBe('alice@example.com');
  });

  it('keeps every field addressable — name, role and ref are untouched', async () => {
    document.body.innerHTML = LOGIN_FORM;
    (document.getElementById('p') as HTMLInputElement).value = 'hunter2SECRET';

    const snap = await snapshot();
    const field = byName(snap.elements, 'password');

    expect(field?.role).toBe('textbox');
    expect(field?.ref).toBe(2);
    expect(snap.elements.map((e) => e.ref)).toEqual([1, 2, 3, 4, 5]);
  });

  it('leaves an empty password field with no value at all, as before', async () => {
    document.body.innerHTML = LOGIN_FORM;

    const snap = await snapshot();
    // "is this field filled" stays honest — an empty field reports no value
    // rather than a redaction marker.
    expect(byName(snap.elements, 'empty_password')).toMatchObject({ role: 'textbox' });
    expect(byName(snap.elements, 'empty_password')?.value).toBeUndefined();
  });
});
