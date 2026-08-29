import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot } from '../snapshot';
import { REDACTED_PASSWORD } from '../redact';

// Real CDP output, recorded from Chrome 141 against a three-field login form
// whose values were set to 'alice@example.com' / 'hunter2SECRET' /
// 'newpassSECRET'. Two things this dump shows that a hand-written fixture would
// have missed:
//
//   1. `input[type=password]` (node 22) arrives pre-masked as bullets, but
//      `input[type=text autocomplete=new-password]` (node 26) arrives PLAIN.
//   2. Every field's contents appear a SECOND time as a StaticText descendant
//      (nodes 29/31) — Chrome exposing the input's shadow editor text. Masking
//      the node's own `value` and stopping there still leaks.
//
// Backend ids 22 and 26 are what DOM.querySelectorAll(PASSWORD_FIELD_SELECTOR)
// resolved to on the same page.

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  value?: { type: string; value: string };
  childIds?: string[];
  ignored?: boolean;
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'computedString', value });
const value = (v: string) => ({ type: 'string', value: v });

const LOGIN_FORM: CdpNode[] = [
  { nodeId: '13', backendDOMNodeId: 13, role: role('RootWebArea'), name: name(''), childIds: ['14'] },
  { nodeId: '14', backendDOMNodeId: 14, role: role('none'), ignored: true, childIds: ['16'] },
  { nodeId: '16', backendDOMNodeId: 16, role: role('none'), ignored: true, childIds: ['1'] },
  { nodeId: '1', backendDOMNodeId: 1, role: role('form'), name: name(''), childIds: ['18', '22', '26', '28'] },
  { nodeId: '18', backendDOMNodeId: 18, role: role('textbox'), name: name('Username'), value: value('alice@example.com'), childIds: ['20'] },
  { nodeId: '22', backendDOMNodeId: 22, role: role('textbox'), name: name('Password'), value: value('•••••••••••••'), childIds: ['24'] },
  { nodeId: '26', backendDOMNodeId: 26, role: role('textbox'), name: name('New password'), value: value('newpassSECRET'), childIds: ['27'] },
  { nodeId: '28', backendDOMNodeId: 28, role: role('button'), name: name('Sign in'), childIds: ['4'] },
  { nodeId: '20', backendDOMNodeId: 20, role: role('generic'), name: name(''), childIds: ['30'] },
  { nodeId: '24', backendDOMNodeId: 24, role: role('generic'), name: name(''), childIds: ['29'] },
  { nodeId: '27', backendDOMNodeId: 27, role: role('generic'), name: name(''), childIds: ['31'] },
  { nodeId: '4', backendDOMNodeId: 4, role: role('StaticText'), name: name('Sign in'), childIds: [] },
  { nodeId: '30', backendDOMNodeId: 30, role: role('StaticText'), name: name('alice@example.com'), childIds: [] },
  { nodeId: '29', backendDOMNodeId: 29, role: role('StaticText'), name: name('•••••••••••••'), childIds: [] },
  { nodeId: '31', backendDOMNodeId: 31, role: role('StaticText'), name: name('newpassSECRET'), childIds: [] },
];

/** DOM.getSearchResults nodeId -> backendNodeId, as DOM.describeNode reports it. */
const PASSWORD_NODE_IDS: Record<number, number> = { 7: 22, 9: 26 };

/**
 * A fake Page whose CDP session answers both domains the snapshot now uses.
 * `passwordNodeIds` empty models a page with no password field (and, equally,
 * the fail-open path where the DOM query cannot run).
 */
function makePage(nodes: CdpNode[], opts?: { withDomDomain?: boolean }) {
  const withDomDomain = opts?.withDomDomain ?? true;
  const client = {
    send: vi.fn(async (method: string, params?: { nodeId?: number }) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes };
      if (!withDomDomain) return {};
      if (method === 'DOM.performSearch') return { searchId: 'search-1', resultCount: 2 };
      if (method === 'DOM.getSearchResults') return { nodeIds: [7, 9] };
      if (method === 'DOM.describeNode') {
        return { node: { backendNodeId: PASSWORD_NODE_IDS[params?.nodeId ?? -1] } };
      }
      return {};
    }),
    detach: vi.fn(() => Promise.resolve()),
  };
  return {
    context: () => ({ newCDPSession: async () => client }),
    evaluate: vi.fn(async () => ''),
    getByRole: vi.fn(),
    locator: vi.fn(),
  };
}

describe('generateSnapshot — password field values', () => {
  it('redacts the masked type=password field and drops its echoing subtree', async () => {
    const out = await generateSnapshot(makePage(LOGIN_FORM) as never, { format: 'ai' });

    expect(out).toContain(`- textbox "Password" ref="1" value="${REDACTED_PASSWORD}"`);
    // The bullets Chrome hands back are the value's stand-in, and they leak its
    // length; neither the node's value nor its StaticText echo may survive.
    expect(out).not.toContain('•');
  });

  it('redacts a plaintext autocomplete="new-password" field, which Chrome does NOT mask', async () => {
    const out = await generateSnapshot(makePage(LOGIN_FORM) as never, { format: 'ai' });

    expect(out).not.toContain('newpassSECRET');
    expect(out).toContain(`- textbox "New password" ref="2" value="${REDACTED_PASSWORD}"`);
  });

  it('keeps the form fillable: role, label and ref survive on every field', async () => {
    const out = await generateSnapshot(makePage(LOGIN_FORM) as never, { format: 'ai' });

    expect(out).toContain('textbox "Username" ref="0"');
    expect(out).toContain('textbox "Password" ref="1"');
    expect(out).toContain('textbox "New password" ref="2"');
    expect(out).toContain('button "Sign in" ref="3"');
  });

  it('does not over-redact: the username field keeps its value and its text echo', async () => {
    const out = await generateSnapshot(makePage(LOGIN_FORM) as never, { format: 'ai' });

    expect(out).toContain('value="alice@example.com"');
    expect(out).toContain('StaticText "alice@example.com"');
  });

  it('redacts on the aria path too', async () => {
    const out = await generateSnapshot(makePage(LOGIN_FORM) as never, { format: 'aria' });

    expect(out).not.toContain('newpassSECRET');
    expect(out).not.toContain('•');
    expect(out).toContain('alice@example.com');
  });

  it('keeps filter:"interactive" from re-exposing the value', async () => {
    const out = await generateSnapshot(makePage(LOGIN_FORM) as never, {
      format: 'ai',
      filter: 'interactive',
    });

    expect(out).not.toContain('newpassSECRET');
    expect(out).toContain('textbox "New password"');
  });

  it('falls open to Chrome\'s own behaviour when the DOM domain cannot answer', async () => {
    // No redaction set means no extra masking — the same output this path
    // produced before, not a page-wide blackout.
    const out = await generateSnapshot(makePage(LOGIN_FORM, { withDomDomain: false }) as never, {
      format: 'ai',
    });

    expect(out).toContain('value="alice@example.com"');
    expect(out).toContain('textbox "Password"');
  });
});

// ---------------------------------------------------------------------------
// Shadow-root fields (review P2)
// ---------------------------------------------------------------------------
//
// Measured on Chrome 141 with an open shadow root holding
// `<input type="text" autocomplete="new-password">`:
//
//   - Accessibility.getFullAXTree DOES carry the field, value in PLAINTEXT
//     (backendDOMNodeId 32, plus the usual StaticText echo at 44).
//   - DOM.querySelectorAll on the document root returned ONLY the light-DOM
//     field (24) — CSS cannot cross a shadow boundary, so the shadow field was
//     never in the redaction set. That was a live bypass of this whole feature.
//   - DOM.performSearch returned all of 24, 29, 32 (light + shadow) and 2, 14
//     (iframe), in 3 ms.
//
// The same measurement found iframe CONTENT absent from getFullAXTree
// altogether, so the iframe ids are harmless surplus rather than a second fix.

const SHADOW_FORM: CdpNode[] = [
  { nodeId: '13', backendDOMNodeId: 13, role: role('RootWebArea'), name: name(''), childIds: ['1'] },
  { nodeId: '1', backendDOMNodeId: 1, role: role('form'), name: name(''), childIds: ['24', '32'] },
  { nodeId: '24', backendDOMNodeId: 24, role: role('textbox'), name: name('Password'), value: value('••••'), childIds: [] },
  { nodeId: '32', backendDOMNodeId: 32, role: role('textbox'), name: name('Shadow new password'), value: value('SHADOW_NEWPASS_SECRET'), childIds: ['44'] },
  { nodeId: '44', backendDOMNodeId: 44, role: role('StaticText'), name: name('SHADOW_NEWPASS_SECRET'), childIds: [] },
];

/** A CDP session whose search reaches into the shadow root, as Chrome's does. */
function makeShadowPage(shadowReachable: boolean) {
  // nodeId -> backendNodeId. Without shadow reach only the light-DOM field is
  // found, which is exactly what the old querySelectorAll returned.
  const hits: Record<number, number> = shadowReachable ? { 7: 24, 9: 32 } : { 7: 24 };
  const nodeIds = Object.keys(hits).map(Number);
  const client = {
    send: vi.fn(async (method: string, params?: { nodeId?: number }) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: SHADOW_FORM };
      if (method === 'DOM.performSearch') {
        return { searchId: 'search-1', resultCount: nodeIds.length };
      }
      if (method === 'DOM.getSearchResults') return { nodeIds };
      if (method === 'DOM.describeNode') {
        return { node: { backendNodeId: hits[params?.nodeId ?? -1] } };
      }
      return {};
    }),
    detach: vi.fn(() => Promise.resolve()),
  };
  return {
    context: () => ({ newCDPSession: async () => client }),
    evaluate: vi.fn(async () => ''),
    getByRole: vi.fn(),
    locator: vi.fn(),
  };
}

describe('generateSnapshot — password fields inside a shadow root', () => {
  it('redacts a shadow-hosted plaintext field and drops its StaticText echo', async () => {
    const out = await generateSnapshot(makeShadowPage(true) as never, { format: 'ai' });

    expect(out).not.toContain('SHADOW_NEWPASS_SECRET');
    expect(out).toContain(`- textbox "Shadow new password" ref="1" value="${REDACTED_PASSWORD}"`);
  });

  it('pins the bypass: a search that stops at the shadow boundary leaks it', async () => {
    // Not a requirement — a guard on the mechanism. If this ever stops leaking
    // with shadowReachable=false, the resolution no longer depends on crossing
    // the boundary and the test above has stopped proving anything.
    const out = await generateSnapshot(makeShadowPage(false) as never, { format: 'ai' });

    expect(out).toContain('SHADOW_NEWPASS_SECRET');
  });
});

// ---------------------------------------------------------------------------
// The DOM-listing fallthrough
// ---------------------------------------------------------------------------
//
// When the a11y tree collapses to a bare root (a background surface has no
// layout), generateSnapshot falls through to the DOM listing. That listing
// prints the page URL and every link href verbatim, so it gets the same URL
// masking browser_network's listing does.

const ROOT_ONLY: CdpNode[] = [
  { nodeId: '1', backendDOMNodeId: 1, role: role('RootWebArea'), name: name('Login'), childIds: [] },
];

describe('generateSnapshot — DOM-listing fallthrough URLs', () => {
  it('masks credentials in the URL line and in link hrefs', async () => {
    const listing = [
      'Page: Login',
      'URL: https://x.test/login?user=alice&password=hunter2SECRET',
      '',
      'Interactive elements (use ref number for click/fill/type):',
      '  [ref=0] a "Docs" -> https://x.test/docs',
      '  [ref=1] a "Retry" -> https://alice:hunter2SECRET@x.test/retry',
    ].join('\n');

    const page = makePage(ROOT_ONLY);
    page.evaluate = vi.fn(async () => listing);

    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).not.toContain('hunter2SECRET');
    expect(out).toContain(`URL: https://x.test/login?user=alice&password=${REDACTED_PASSWORD}`);
    expect(out).toContain(`https://alice:${REDACTED_PASSWORD}@x.test/retry`);
    // Everything the listing exists to convey is untouched.
    expect(out).toContain('[ref=0] a "Docs" -> https://x.test/docs');
    expect(out).toContain('Page: Login');
  });
});
