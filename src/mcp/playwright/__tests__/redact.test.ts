import { describe, expect, it, vi } from 'vitest';
import {
  PASSWORD_FIELD_SELECTOR,
  REDACTED_PASSWORD,
  getPasswordFieldBackendIds,
  isPasswordFieldNode,
  redactPasswordParams,
} from '../redact';

describe('isPasswordFieldNode', () => {
  it('recognises type=password', () => {
    expect(isPasswordFieldNode({ type: 'password' })).toBe(true);
    expect(isPasswordFieldNode({ type: 'PASSWORD' })).toBe(true);
  });

  it('recognises a plaintext field carrying a password autocomplete token', () => {
    // The case Chrome does NOT mask in the a11y tree — a "show password"
    // toggle flips type to text and the value goes plain.
    expect(isPasswordFieldNode({ type: 'text', autocomplete: 'current-password' })).toBe(true);
    expect(isPasswordFieldNode({ type: 'text', autocomplete: 'new-password' })).toBe(true);
    // Autocomplete is a token list, so a sectioned value still matches.
    expect(
      isPasswordFieldNode({ type: 'text', autocomplete: 'section-login new-password' }),
    ).toBe(true);
  });

  it('reads the attribute when the property is unavailable', () => {
    const el = { type: 'text', getAttribute: (n: string) => (n === 'autocomplete' ? 'new-password' : null) };
    expect(isPasswordFieldNode(el)).toBe(true);
  });

  it('leaves ordinary fields alone', () => {
    expect(isPasswordFieldNode({ type: 'text', autocomplete: 'username' })).toBe(false);
    expect(isPasswordFieldNode({ type: 'email' })).toBe(false);
    expect(isPasswordFieldNode({ type: 'text' })).toBe(false);
    expect(isPasswordFieldNode(null)).toBe(false);
  });
});

describe('PASSWORD_FIELD_SELECTOR', () => {
  it('covers both the type and the autocomplete shape', () => {
    expect(PASSWORD_FIELD_SELECTOR).toContain('input[type="password"]');
    expect(PASSWORD_FIELD_SELECTOR).toContain('current-password');
    expect(PASSWORD_FIELD_SELECTOR).toContain('new-password');
  });

  it('matches autocomplete case-insensitively, in step with the predicate', () => {
    // An attribute selector is case-SENSITIVE by default, so without the `i`
    // flag autocomplete="New-Password" would slip past the CSS side while
    // isPasswordFieldNode (which lowercases) still caught it.
    expect(PASSWORD_FIELD_SELECTOR).toContain('"current-password" i');
    expect(PASSWORD_FIELD_SELECTOR).toContain('"new-password" i');
    expect(isPasswordFieldNode({ type: 'text', autocomplete: 'New-Password' })).toBe(true);
  });
});

describe('redactPasswordParams — JSON bodies', () => {
  it('masks the value and keeps the key', () => {
    const out = redactPasswordParams('{"username":"alice","password":"hunter2"}');
    expect(out).toBe(`{"username":"alice","password":"${REDACTED_PASSWORD}"}`);
  });

  it('handles whitespace and nesting', () => {
    const out = redactPasswordParams('{ "auth": { "password" : "hunter2" } }');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('"password"');
  });

  it('masks password-family key names', () => {
    const out = redactPasswordParams(
      '{"new_password":"a1","currentPassword":"b2","passwd":"c3","pwd":"d4"}',
    );
    expect(out).not.toMatch(/a1|b2|c3|d4/);
    expect(out).toContain('"new_password"');
    expect(out).toContain('"currentPassword"');
  });

  it('masks the pass_word / pass-word spellings', () => {
    const out = redactPasswordParams('{"pass_word":"s1","pass-word":"s2"}');
    expect(out).not.toMatch(/s1|s2/);
    expect(out).toContain('"pass_word"');
    expect(out).toContain('"pass-word"');
  });

  it('masks a numeric password value', () => {
    // A numeric PIN posted as a JSON number is still a credential.
    const out = redactPasswordParams('{"user":"alice","password":123456}');
    expect(out).toBe(`{"user":"alice","password":"${REDACTED_PASSWORD}"}`);
  });

  it('leaves null and boolean password values alone', () => {
    // They carry no secret, and masking them would erase the "unset" signal.
    const body = '{"password":null,"password_set":false}';
    expect(redactPasswordParams(body)).toBe(body);
  });

  it('does not swallow the rest of the object when the value contains an escaped quote', () => {
    const out = redactPasswordParams('{"password":"he\\"llo","next":"keepme"}');
    expect(out).toContain('"next":"keepme"');
    expect(out).not.toContain('he\\"llo');
  });

  it('leaves unrelated keys untouched', () => {
    const body = '{"passenger":"alice","passport":"X123","user":"bob"}';
    expect(redactPasswordParams(body)).toBe(body);
  });
});

describe('redactPasswordParams — form bodies and query strings', () => {
  it('masks a form-urlencoded password and keeps the username', () => {
    const out = redactPasswordParams('username=alice&password=hunter2&remember=1');
    expect(out).toBe(`username=alice&password=${REDACTED_PASSWORD}&remember=1`);
  });

  it('masks a password in a query string', () => {
    const out = redactPasswordParams('https://x.test/login?user=alice&password=hunter2');
    expect(out).toBe(`https://x.test/login?user=alice&password=${REDACTED_PASSWORD}`);
  });

  it('masks a password that leads the body', () => {
    expect(redactPasswordParams('password=hunter2&u=alice')).toBe(
      `password=${REDACTED_PASSWORD}&u=alice`,
    );
  });

  it('leaves a path segment that merely reads like a password key alone', () => {
    const url = 'https://x.test/account/reset-password?token=abc123';
    expect(redactPasswordParams(url)).toBe(url);
  });

  it('treats whitespace as a key boundary, for prose like console output', () => {
    const out = redactPasswordParams('auth failed for password=hunter2SECRET');
    expect(out).toBe(`auth failed for password=${REDACTED_PASSWORD}`);
  });

  it('still needs an actual key: a bare mention is not an assignment', () => {
    const line = 'Please enter your password to continue (see /reset-password)';
    expect(redactPasswordParams(line)).toBe(line);
  });

  it('leaves an ordinary POST body unchanged', () => {
    const body = '{"query":"select 1","limit":10}';
    expect(redactPasswordParams(body)).toBe(body);
    expect(redactPasswordParams('a=1&b=2')).toBe('a=1&b=2');
  });

  it('is a no-op on empty input', () => {
    expect(redactPasswordParams('')).toBe('');
  });
});

describe('redactPasswordParams — bodies cut by the 256 KB capture cap', () => {
  // The capture truncates BEFORE the tool renders, so a value can arrive with
  // no closing quote for the terminated-value pattern to anchor on.
  const MARKER = ['', '... [truncated 4096 chars]'].join('\n');

  it('masks a JSON value the cut left unterminated, keeping the marker', () => {
    const out = redactPasswordParams(`{"user":"alice","password":"hunter2SEC${MARKER}`);
    expect(out).not.toContain('hunter2SEC');
    expect(out).toBe(`{"user":"alice","password":"${REDACTED_PASSWORD}${MARKER}`);
  });

  it('masks a form value the cut left unterminated', () => {
    const out = redactPasswordParams(`username=alice&password=hunter2SEC${MARKER}`);
    expect(out).not.toContain('hunter2SEC');
    expect(out).toBe(`username=alice&password=${REDACTED_PASSWORD}${MARKER}`);
  });

  it('does not double-fire on a value that IS terminated', () => {
    const out = redactPasswordParams('{"password":"hunter2"}');
    expect(out).toBe(`{"password":"${REDACTED_PASSWORD}"}`);
  });

  it('leaves an unrelated truncated body alone', () => {
    const body = `{"items":[{"id":1,"note":"partial te${MARKER}`;
    expect(redactPasswordParams(body)).toBe(body);
  });
});

describe('redactPasswordParams — URL userinfo', () => {
  it('masks the password and keeps the username', () => {
    const out = redactPasswordParams('https://alice:hunter2SECRET@x.test/dashboard');
    expect(out).toBe(`https://alice:${REDACTED_PASSWORD}@x.test/dashboard`);
  });

  it('leaves a userinfo-less URL alone, port included', () => {
    const url = 'https://x.test:8443/api/items?page=2';
    expect(redactPasswordParams(url)).toBe(url);
  });

  it('leaves a username-only URL alone', () => {
    const url = 'https://alice@x.test/dashboard';
    expect(redactPasswordParams(url)).toBe(url);
  });
});

describe('getPasswordFieldBackendIds', () => {
  /**
   * A CDP fake that models the ordering dependency real Chrome has:
   * DOM.performSearch queries the DOM agent's node map, which stays empty until
   * the document is requested. Verified live — dropping the DOM.getDocument
   * call made the resolver return an empty set on a page full of password
   * fields, so the fake refuses to answer a search that skipped it.
   */
  function makeCdp(hits: Record<number, number>) {
    let documentRequested = false;
    const calls: string[] = [];
    const discarded: string[] = [];
    const nodeIds = Object.keys(hits).map(Number);
    const send = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
      calls.push(method);
      if (method === 'DOM.getDocument') {
        documentRequested = true;
        return { root: { nodeId: 100 } };
      }
      if (method === 'DOM.performSearch') {
        if (!documentRequested) return { searchId: 'search-1', resultCount: 0 };
        return { searchId: 'search-1', resultCount: nodeIds.length };
      }
      if (method === 'DOM.getSearchResults') return { nodeIds };
      if (method === 'DOM.describeNode') {
        const { nodeId } = params as { nodeId: number };
        return { node: { backendNodeId: hits[nodeId] } };
      }
      if (method === 'DOM.discardSearchResults') {
        discarded.push((params as { searchId: string }).searchId);
        return {};
      }
      return {};
    });
    return { send, calls, discarded };
  }

  it('resolves matches across light DOM, shadow roots and iframes', async () => {
    // Backend ids as recorded from Chrome 141 on a page with all three: 24 is
    // the light-DOM field, 29/32 live in an open shadow root, 2/14 in an
    // iframe. A document-root querySelectorAll returned ONLY 24 — CSS cannot
    // cross a shadow boundary — which is the bypass performSearch closes.
    const cdp = makeCdp({ 7: 24, 9: 29, 11: 32, 13: 2, 15: 14 });

    const ids = await getPasswordFieldBackendIds({ send: cdp.send });

    expect([...ids].sort((a, b) => a - b)).toEqual([2, 14, 24, 29, 32]);
    expect(cdp.send).toHaveBeenCalledWith('DOM.performSearch', {
      query: PASSWORD_FIELD_SELECTOR,
      includeUserAgentShadowDOM: false,
    });
  });

  it('requests the document before searching, or the search finds nothing', async () => {
    const cdp = makeCdp({ 7: 24 });

    await getPasswordFieldBackendIds({ send: cdp.send });

    expect(cdp.calls.indexOf('DOM.getDocument')).toBeGreaterThanOrEqual(0);
    expect(cdp.calls.indexOf('DOM.getDocument')).toBeLessThan(
      cdp.calls.indexOf('DOM.performSearch'),
    );
  });

  it('releases the search result set the backend allocated', async () => {
    const cdp = makeCdp({ 7: 24 });
    await getPasswordFieldBackendIds({ send: cdp.send });
    expect(cdp.discarded).toEqual(['search-1']);
  });

  it('makes no follow-up calls when the page has no password field', async () => {
    const cdp = makeCdp({});

    expect((await getPasswordFieldBackendIds({ send: cdp.send })).size).toBe(0);
    expect(cdp.calls).not.toContain('DOM.getSearchResults');
    // An empty search still allocated a result set — release it.
    expect(cdp.discarded).toEqual(['search-1']);
  });

  it('fails open with an empty set when the DOM domain is unavailable', async () => {
    const send = vi.fn(async (): Promise<unknown> => {
      throw new Error('detached');
    });
    expect((await getPasswordFieldBackendIds({ send })).size).toBe(0);
  });
});
