// RemoteInboxList render tests (LanLink PR-5, renderer half).
//
// Vitest runs in node env without jsdom — same pattern as FleetCard.test.tsx: the
// list is a stateless view, so renderToStaticMarkup produces the real markup. We
// pin the read-only display contract AND the security crux: an UNTRUSTED off-machine
// message is rendered as a React TEXT CHILD — HTML-escaped, never injected as raw
// markup, never a PTY escape. (The pixel-level "terminal effect = 0" proof for raw
// control chars is the CDP dogfood; here we prove the text-child / no-injection
// boundary that makes that hold.)
//
// RemoteInboxList calls useT() internally (module-singleton store, default en) — no
// DOM, so SSR runs it fine.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import RemoteInboxList from '../RemoteInboxList';
import type { RemoteInboxItem } from '../../../../shared/lanlink';

const noop = () => undefined;

function item(overrides: Partial<RemoteInboxItem> = {}): RemoteInboxItem {
  return {
    recordId: 'r1',
    origin: 'remote',
    peerName: 'Alice',
    text: 'hello',
    seq: 1,
    receivedAt: 1,
    ...overrides,
  };
}

function render(items: RemoteInboxItem[], focusedIdx = 0): string {
  return renderToStaticMarkup(
    createElement(RemoteInboxList, { items, focusedIdx, onDismiss: noop }),
  );
}

describe('RemoteInboxList', () => {
  it('renders peerName, text, and the "remote peer" badge inside a listbox', () => {
    const html = render([item({ peerName: 'Bob', text: 'ping from the other box' })]);
    expect(html).toContain('remote peer');
    expect(html).toContain('Bob');
    expect(html).toContain('ping from the other box');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
  });

  it('renders nothing (empty string) when there are no items', () => {
    expect(render([])).toBe('');
  });

  it('only the focused row is roving-focusable (its card + dismiss button = tabindex 0)', () => {
    const html = render([item({ recordId: 'a' }), item({ recordId: 'b' })], 1);
    // Row b is focused: its card div AND its dismiss button each carry tabindex="0"
    // (dismiss is roving too, per the approvals pattern). Row a contributes the two -1s.
    expect(html.match(/tabindex="0"/g)?.length).toBe(2);
    expect(html.match(/tabindex="-1"/g)?.length).toBe(2);
  });

  it('SECURITY: UNTRUSTED text is HTML-escaped — never raw markup injection', () => {
    const html = render([item({ text: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('SECURITY: control/CSI sequences stay inert text — no synthesized elements', () => {
    // An ESC/CSI color sequence lands inside the <p> text node. It is NOT executed,
    // NOT a PTY escape, and cannot create new DOM elements (no dangerouslySetInnerHTML).
    const html = render([item({ text: 'A[31mRED[0m B' })]);
    expect(html).toContain('RED');
    // The sequence did NOT become a styled <span> or any new element.
    expect(html).not.toContain('<span style="color');
  });
});
