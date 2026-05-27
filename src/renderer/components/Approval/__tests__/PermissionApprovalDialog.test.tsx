// Permission approval dialog tests (Phase 2.2 pre-commit 5).
//
// Vitest runs in node env without jsdom — same pattern as
// NotificationPanel.test.tsx: pure helper coverage + `renderToStaticMarkup`
// against the stateless view. The dialog has no internal state, so static
// markup is enough to verify the wording-asymmetry contract.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  groupCapabilities,
  PermissionApprovalDialogView,
  type PermissionApprovalDialogProps,
} from '../PermissionApprovalDialog';

const noop = () => undefined;

function defaultProps(
  overrides: Partial<PermissionApprovalDialogProps> = {},
): PermissionApprovalDialogProps {
  return {
    clientName: 'demo-plugin',
    declaredCapabilities: ['pane.read'],
    onApprove: noop,
    onDeny: noop,
    ...overrides,
  };
}

describe('groupCapabilities', () => {
  it('groups by risk class', () => {
    const groups = groupCapabilities([
      'pane.read',
      'meta.write:custom.foo.*',
      'terminal.read',
    ]);
    const byClass = new Map(groups.map((g) => [g.riskClass, g]));
    expect(byClass.get('pane-lifecycle')?.capabilities.map((c) => c.raw)).toEqual([
      'pane.read',
    ]);
    expect(byClass.get('metadata')?.capabilities.map((c) => c.raw)).toEqual([
      'meta.write:custom.foo.*',
    ]);
    expect(byClass.get('terminal-content')?.capabilities.map((c) => c.raw)).toEqual([
      'terminal.read',
    ]);
  });

  it('puts critical groups before neutral ones (asymmetry visible at a glance)', () => {
    const groups = groupCapabilities([
      'meta.write',
      'pane.read',
      'terminal.read',
      'terminal.send',
    ]);
    // The fixed order is: terminal-content → terminal-input → browser →
    // a2a → metadata → events → pane-lifecycle → workspace → internal.
    // So critical groups (terminal-content, terminal-input) come first.
    expect(groups[0].riskClass).toBe('terminal-content');
    expect(groups[1].riskClass).toBe('terminal-input');
    // Metadata follows after the critical band.
    const metaIdx = groups.findIndex((g) => g.riskClass === 'metadata');
    const paneIdx = groups.findIndex((g) => g.riskClass === 'pane-lifecycle');
    expect(metaIdx).toBeLessThan(paneIdx);
    // Both neutrals come after the critical band.
    expect(metaIdx).toBeGreaterThan(1);
  });

  it('parses path-glob suffixes onto each capability entry', () => {
    const groups = groupCapabilities([
      'meta.write:custom.dash.*',
      'meta.read:custom.dash.*',
    ]);
    const meta = groups.find((g) => g.riskClass === 'metadata');
    expect(meta?.capabilities).toHaveLength(2);
    expect(meta?.capabilities[0].pathGlob).toBe('custom.dash.*');
    expect(meta?.capabilities[1].pathGlob).toBe('custom.dash.*');
  });

  it('skips malformed entries silently (substrate already rejected them at declare-time)', () => {
    const groups = groupCapabilities([
      'pane.read',
      'made.up.capability', // unknown — parser returns ok:false
    ]);
    const total = groups.reduce((acc, g) => acc + g.capabilities.length, 0);
    expect(total).toBe(1);
  });
});

describe('PermissionApprovalDialogView — rendering', () => {
  it('renders the plugin name and at least one capability row', () => {
    const html = renderToStaticMarkup(
      createElement(
        PermissionApprovalDialogView,
        defaultProps({ declaredCapabilities: ['pane.read', 'meta.write'] }),
      ),
    );
    expect(html).toContain('demo-plugin');
    expect(html).toContain('pane.read');
    expect(html).toContain('meta.write');
  });

  it('renders terminal-content copy in bold-critical wording', () => {
    const html = renderToStaticMarkup(
      createElement(
        PermissionApprovalDialogView,
        defaultProps({ declaredCapabilities: ['terminal.read'] }),
      ),
    );
    // Risk-class summary text appears verbatim.
    expect(html).toContain('Can read what is on your screen');
    // Critical severity drives accent-red color (CSS var name appears in the
    // inline style for the section's border or text color).
    expect(html).toMatch(/accent-red/);
  });

  it('renders metadata copy with neutral wording (no scary language)', () => {
    const html = renderToStaticMarkup(
      createElement(
        PermissionApprovalDialogView,
        defaultProps({ declaredCapabilities: ['meta.write'] }),
      ),
    );
    expect(html).toContain('Can label your panes');
    // No accent-red treatment for a pure-metadata dialog.
    expect(html).not.toMatch(/accent-red/);
  });

  it('renders rationale verbatim when provided', () => {
    const html = renderToStaticMarkup(
      createElement(
        PermissionApprovalDialogView,
        defaultProps({
          rationale: 'demo dashboard sample text',
        }),
      ),
    );
    expect(html).toContain('demo dashboard sample text');
  });

  it('skips the rationale block when not provided', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionApprovalDialogView, defaultProps()),
    );
    // No italic rationale block in markup.
    expect(html).not.toMatch(/font-style:\s*italic/);
  });

  it('renders Approve and Deny buttons with the action labels', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionApprovalDialogView, defaultProps()),
    );
    expect(html).toContain('>Approve<');
    expect(html).toContain('>Deny<');
  });

  it('uses critical accent when ANY declared capability is critical', () => {
    const html = renderToStaticMarkup(
      createElement(
        PermissionApprovalDialogView,
        defaultProps({
          declaredCapabilities: ['meta.write', 'terminal.read'],
        }),
      ),
    );
    // Critical present → Approve button styled with accent-red.
    expect(html).toMatch(/accent-red/);
  });
});
