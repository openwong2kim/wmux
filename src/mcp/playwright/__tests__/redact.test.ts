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

  it('leaves an ordinary POST body unchanged', () => {
    const body = '{"query":"select 1","limit":10}';
    expect(redactPasswordParams(body)).toBe(body);
    expect(redactPasswordParams('a=1&b=2')).toBe('a=1&b=2');
  });

  it('is a no-op on empty input', () => {
    expect(redactPasswordParams('')).toBe('');
  });
});

describe('getPasswordFieldBackendIds', () => {
  it('resolves every match to its backendNodeId', async () => {
    // Node ids / backend ids as recorded from Chrome 141 on a real login form.
    const send = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 100 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [7, 9] };
      if (method === 'DOM.describeNode') {
        const { nodeId } = params as { nodeId: number };
        return { node: { backendNodeId: nodeId === 7 ? 22 : 26 } };
      }
      return {};
    });

    const ids = await getPasswordFieldBackendIds({ send });

    expect([...ids].sort((a, b) => a - b)).toEqual([22, 26]);
    expect(send).toHaveBeenCalledWith('DOM.querySelectorAll', {
      nodeId: 100,
      selector: PASSWORD_FIELD_SELECTOR,
    });
  });

  it('fails open with an empty set when the DOM domain is unavailable', async () => {
    const send = vi.fn(async (): Promise<unknown> => {
      throw new Error('detached');
    });
    expect((await getPasswordFieldBackendIds({ send })).size).toBe(0);
  });
});
