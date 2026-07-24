/**
 * D2 SECURITY — the operator's role-assignment path must survive the wire-level
 * lockdown.
 *
 * `pane.setMetadata` now strips `custom['orchestrator.role']` from any
 * non-first-party RPC caller (pane.rpc.ts guardRoleKey). The Fleet dropdown does
 * NOT use that router: it goes renderer → preload → the `metadata:set-role`
 * ipcMain channel, which is unreachable from the external pipe. This test pins
 * that separation — if someone ever routes the dropdown through the RPC, the
 * "operator can still assign roles" guarantee breaks and this fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { registerMetadataHandlers } from '../metadata.handler';
import { metadataStore } from '../../../metadata/MetadataStore';
import { ORCH_ROLE_KEY } from '../../../../shared/orchestratorRole';
import { IPC } from '../../../../shared/constants';
import type { PTYManager } from '../../../pty/PTYManager';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() },
  BrowserWindow: {},
}));

type IpcInvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown;

/** Register the handlers and pull a named channel's handler off the mock. */
function handlerFor(channel: string): IpcInvokeHandler {
  const ptyManager = { get: () => undefined, getAll: () => [] } as unknown as PTYManager;
  registerMetadataHandlers(ptyManager, () => null as BrowserWindow | null, {
    localPtyOwnership: false,
  });
  const call = vi
    .mocked(ipcMain.handle)
    .mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no ipcMain.handle registration for "${channel}"`);
  return call[1] as unknown as IpcInvokeHandler;
}

describe('metadata:set-role — the operator path is unaffected by the RPC guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metadataStore.reset();
  });

  it('writes the orchestrator role through MetadataStore', async () => {
    const setRole = handlerFor(IPC.METADATA_SET_ROLE);
    await setRole({}, 'pane-1', 'ws-1', 'Reviewer');
    expect(metadataStore.get('pane-1').metadata.custom?.[ORCH_ROLE_KEY]).toBe('Reviewer');
  });

  it('reassigns an existing role (the dropdown is authoritative)', async () => {
    const setRole = handlerFor(IPC.METADATA_SET_ROLE);
    await setRole({}, 'pane-1', 'ws-1', 'Reviewer');
    await setRole({}, 'pane-1', 'ws-1', 'Builder');
    expect(metadataStore.get('pane-1').metadata.custom?.[ORCH_ROLE_KEY]).toBe('Builder');
  });

  it('unassigns with the empty-string sentinel', async () => {
    const setRole = handlerFor(IPC.METADATA_SET_ROLE);
    await setRole({}, 'pane-1', 'ws-1', 'Reviewer');
    await setRole({}, 'pane-1', 'ws-1', '');
    // '' is stored (additive merge has no delete-one-key op); readOrchRole
    // normalizes it to "unassigned" on read.
    expect(metadataStore.get('pane-1').metadata.custom?.[ORCH_ROLE_KEY]).toBe('');
  });

  it('merges, so a role write never clobbers the pane label', async () => {
    const setRole = handlerFor(IPC.METADATA_SET_ROLE);
    metadataStore.set('pane-1', { label: 'Backend' }, { workspaceId: 'ws-1' });
    await setRole({}, 'pane-1', 'ws-1', 'Tester');
    const meta = metadataStore.get('pane-1').metadata;
    expect(meta.label).toBe('Backend');
    expect(meta.custom?.[ORCH_ROLE_KEY]).toBe('Tester');
  });
});
