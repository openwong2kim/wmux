import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../index';

// D2 — the store setter that the Settings editor writes through. Upsert +
// normalize + clear; the persisted value always stays clean (session.json is
// hand-editable, so the setter re-normalizes on every write).
describe('setOrchestratorRoleBinding', () => {
  beforeEach(() => {
    useStore.setState({ orchestratorRoleBindings: {} });
  });

  it('upserts a normalized binding for a role', () => {
    useStore.getState().setOrchestratorRoleBinding('Reviewer', { agent: 'Codex.exe', model: '  o3  ' });
    expect(useStore.getState().orchestratorRoleBindings.Reviewer).toEqual({ agent: 'codex', model: 'o3' });
  });

  it('clears a role when the binding normalizes to empty', () => {
    useStore.getState().setOrchestratorRoleBinding('Builder', { agent: 'claude', model: 'sonnet' });
    useStore.getState().setOrchestratorRoleBinding('Builder', { agent: '', model: '', args: '' });
    expect(useStore.getState().orchestratorRoleBindings.Builder).toBeUndefined();
  });

  it('ignores a blank role key', () => {
    useStore.getState().setOrchestratorRoleBinding('   ', { model: 'haiku' });
    expect(Object.keys(useStore.getState().orchestratorRoleBindings)).toHaveLength(0);
  });
});
