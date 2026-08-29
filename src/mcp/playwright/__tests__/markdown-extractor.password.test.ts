// @vitest-environment jsdom
//
// browser_extract_text / browser_extract_data walk text nodes and a fixed
// attribute set (href/src/alt), never `el.value` — so a filled login form
// carries nothing to leak. That is a property worth pinning rather than
// re-deriving: a future "also serialise input values so the agent can see form
// state" change would silently reopen the path these tests guard.
import { beforeAll, describe, expect, it } from 'vitest';
import { extractMarkdown, extractStructuredData } from '../markdown-extractor';

// jsdom has no layout engine, so getClientRects() is unconditionally empty and
// the extractor's visibility filter would judge every element hidden. Model a
// rendered box, same as markdown-extractor.hidden.test.ts.
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 100, height: 20 }],
  });
});

const LOGIN_PAGE =
  '<h1>Sign in</h1>' +
  '<form>' +
  '<label for="u">Email</label>' +
  '<input id="u" name="username" type="text" autocomplete="username">' +
  '<label for="p">Password</label>' +
  '<input id="p" name="password" type="password" autocomplete="current-password">' +
  '<input id="p2" name="new_password" type="text" autocomplete="new-password">' +
  '<button type="submit">Continue</button>' +
  '</form>';

function fillForm(): void {
  document.body.innerHTML = LOGIN_PAGE;
  (document.getElementById('u') as HTMLInputElement).value = 'alice@example.com';
  (document.getElementById('p') as HTMLInputElement).value = 'hunter2SECRET';
  (document.getElementById('p2') as HTMLInputElement).value = 'newpassSECRET';
}

/** Indirect eval → runs the injected script in the scope holding jsdom's document. */
const evaluate = async (expr: string) => (0, eval)(expr);

/** A Page whose evaluate runs the in-page callback directly, as Playwright does. */
const directPage = {
  evaluate: (fn: (arg: unknown) => unknown, arg: unknown) => Promise.resolve(fn(arg)),
} as never;

const scope = { workspaceId: 'ws-test' } as never;

describe('browser_extract_text does not carry input values', () => {
  it('renders the form labels without any field contents', async () => {
    fillForm();

    const md = await extractMarkdown(evaluate);

    expect(md).toContain('Sign in');
    expect(md).toContain('Password');
    expect(md).not.toContain('hunter2SECRET');
    expect(md).not.toContain('newpassSECRET');
    // Not a password, and still absent — the extractor is text-only by design.
    expect(md).not.toContain('alice@example.com');
  });
});

describe('browser_extract_data does not carry input values', () => {
  it('finds no password in the extracted records', async () => {
    fillForm();

    const rows = await extractStructuredData(directPage, scope, 'the login form', {
      title: 'field label',
      value: 'field value',
    });

    expect(JSON.stringify(rows)).not.toContain('hunter2SECRET');
    expect(JSON.stringify(rows)).not.toContain('newpassSECRET');
  });
});
