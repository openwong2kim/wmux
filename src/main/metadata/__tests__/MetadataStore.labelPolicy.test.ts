// The pane label policy (src/shared/paneLabelRules.ts) as MetadataStore, the
// single label authority, enforces it for both the UI rename and MCP writes.

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../events/EventBus';
import { MetadataStore } from '../MetadataStore';
import { PaneLabelError, paneLabelShapeError } from '../../../shared/paneLabelRules';

function rejectionCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof PaneLabelError ? err.code : `not-a-label-error: ${String(err)}`;
  }
}

describe('paneLabelShapeError', () => {
  it.each([
    ['backend', null],
    ['api_v2', null],
    ['my-backend', null],
    ['my backend', 'whitespace'],
    ['tab\there', 'whitespace'],
    ['#backend', 'reserved-char'],
    ['me@host', 'reserved-char'],
    ['2fast', 'leading-digit'],
    ['w1-2', 'auto-name'],
    ['W12-3x', 'auto-name'],
    ['w1', null],
    ['worker-1', null],
  ])('%s → %s', (label, expected) => {
    expect(paneLabelShapeError(label)).toBe(expected);
  });
});

describe('MetadataStore label policy', () => {
  let store: MetadataStore;

  beforeEach(() => {
    store = new MetadataStore({ eventBus: new EventBus() });
  });

  it('rejects a malformed label without bumping the version', () => {
    expect(rejectionCode(() => store.set('p-1', { label: 'two words' }))).toBe('whitespace');
    expect(store.get('p-1').version).toBe(0);
  });

  it('rejects a label another pane already uses, trimmed and case-insensitively', () => {
    store.set('p-1', { label: 'Backend' });
    expect(rejectionCode(() => store.set('p-2', { label: '  backend ' }))).toBe('duplicate');
  });

  it('stores the label trimmed, as the policy checked it', () => {
    store.set('p-1', { label: '  backend ' });
    expect(store.get('p-1').metadata.label).toBe('backend');
  });

  it('ignores a label held by a pane that is no longer live', () => {
    store.set('p-gone', { label: 'backend' });
    const live = new Set(['p-1', 'p-2']);
    expect(rejectionCode(() => store.set('p-2', { label: 'backend' }, { livePaneIds: live }))).toBeNull();
  });

  it('counts every labeled entry when the live set is unknown', () => {
    store.set('p-gone', { label: 'backend' });
    expect(rejectionCode(() => store.set('p-2', { label: 'backend' }))).toBe('duplicate');
  });

  it('frees a closed pane label through the onPaneDeleted tombstone', () => {
    store.set('p-1', { label: 'backend' });
    store.onPaneDeleted('p-1');
    expect(rejectionCode(() => store.set('p-2', { label: 'backend' }))).toBeNull();
  });

  it('lets a pane re-set or re-case its own label, and empty still clears', () => {
    store.set('p-1', { label: 'backend' });
    expect(rejectionCode(() => store.set('p-1', { label: 'backend' }))).toBeNull();
    expect(rejectionCode(() => store.set('p-1', { label: 'Backend' }))).toBeNull();
    expect(rejectionCode(() => store.set('p-1', { label: '' }))).toBeNull();
    expect(store.get('p-1').metadata.label).toBe('');
  });

  it('keeps a persisted legacy label that breaks the rules writable as-is', () => {
    store.hydrate({
      schema_version: 1,
      entries: [{ paneId: 'p-1', workspaceId: 'ws-1', metadata: { label: 'my backend' }, version: 3 }],
    });
    // Unrelated writes and re-setting the same legacy label both pass.
    expect(rejectionCode(() => store.set('p-1', { status: 'busy' }))).toBeNull();
    expect(rejectionCode(() => store.set('p-1', { label: 'my backend' }))).toBeNull();
    // A new invalid label is still refused.
    expect(rejectionCode(() => store.set('p-1', { label: 'my frontend' }))).toBe('whitespace');
  });
});
