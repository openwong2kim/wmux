// The new-package line rides on the approval record and changes nothing else:
// not the risk verdict, not the push a lock screen reads, not the choices.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HookIngest, type HookIngestSession } from '../../hooks/HookIngest';
import { ApprovalRegistry } from '../ApprovalRegistry';
import { coerceApprovalState } from '../approvalStore';
import { approvalHasElevatedRisk } from '../../push/approvalRisk';
import { buildApprovalPushPayload } from '../../push/approvalPushPayload';
import { newPackagesForCommand, type NewPackageNote } from '../installPackageLookup';
import type { AgentSignal } from '../../../shared/hooks/signal-types';
import { waitFor } from '../../../test-utils/waitFor';
import type { ApprovalRequest, TerminalPromptNote } from '../types';

type Lookup = (command: string, cwd: string) => Promise<NewPackageNote[] | undefined>;
const real: Lookup = (c, cwd) => newPackagesForCommand(c, cwd);

/** What the daemon's gate RPC does: read the line first, then create the gate. */
async function gate(ingest: HookIngest, signal: AgentSignal) {
  return ingest.handlePermissionGate(signal, await ingest.gatePackageCheck(signal));
}

let tmpDir: string;
let project: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-new-pkg-wiring-'));
  project = path.join(tmpDir, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { react: '18' } }));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Until each registry's gate record is in (its mutation runs on a chain). */
async function drain(...registries: ApprovalRegistry[]): Promise<void> {
  await waitFor(() => registries.every((r) => r.list().pending.length > 0));
}

function gateSignal(command: string, extra: Record<string, unknown> = {}): AgentSignal {
  return {
    kind: 'agent.awaiting_permission',
    agent: 'claude',
    cwd: project,
    ptyId: 'pty-a',
    payload: { tool_name: 'Bash', tool_input: { command }, ...extra },
    ts: 1_000,
  };
}

function setup(lookup: Lookup | undefined) {
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => [],
    writeToSession: () => true,
    now: () => 5_000,
  });
  const sessions: HookIngestSession[] = [{ id: 'pty-a', cwd: project }];
  const ingest = new HookIngest({
    listLiveSessions: () => sessions,
    emitAgentEvent: () => undefined,
    applyResumeBinding: () => undefined,
    approvals: registry,
    gateConfig: () => ({ gatedTools: ['Bash'] }),
    ...(lookup ? { newPackagesFor: lookup } : {}),
    now: () => 5_000,
  });
  return { registry, ingest, sessions };
}

const pending = (registry: ApprovalRegistry): ApprovalRequest[] => registry.list().pending;

describe('new-package line on a gate', () => {
  it('a gated install of a package the project lacks carries the line', async () => {
    const { registry, ingest } = setup(real);
    await gate(ingest, gateSignal('npm i react react-codeshift'));
    await drain(registry);
    expect(pending(registry)[0].newPackages).toEqual([
      { ecosystem: 'npm', name: 'react-codeshift', checked: 'package.json', via: 'install' },
    ]);
  });

  it('reads the hook\'s own cwd when it names a directory', async () => {
    const seen: string[] = [];
    const { ingest } = setup(async (_c, cwd) => { seen.push(cwd); return undefined; });
    await gate(ingest, gateSignal('npm i x', { cwd: '/elsewhere/dir' }));
    await gate(ingest, gateSignal('npm i x', { cwd: 'relative' }));
    expect(seen).toEqual(['/elsewhere/dir', project]);
  });

  it('no line with the setting off (no lookup), for a known package, or for a WSL pane', async () => {
    const off = setup(undefined);
    await gate(off.ingest, gateSignal('npm i react-codeshift'));
    const known = setup(real);
    await gate(known.ingest, gateSignal('npm i react'));
    const wsl = setup(real);
    wsl.sessions[0] = { ...wsl.sessions[0], wslTarget: { distribution: 'Ubuntu', user: 'u' } };
    await gate(wsl.ingest, gateSignal('npm i react-codeshift'));
    await drain(off.registry, known.registry, wsl.registry);
    for (const r of [off.registry, known.registry, wsl.registry]) {
      expect(pending(r)).toHaveLength(1);
      expect(pending(r)[0].newPackages).toBeUndefined();
    }
  });

  it('a lookup that throws or rejects costs the line, never the gate', async () => {
    for (const lookup of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('boom'))] as Lookup[]) {
      const { registry, ingest } = setup(lookup);
      const r = await gate(ingest, gateSignal('npm i x'));
      await drain(registry);
      expect(r.ok).toBe(true);
      expect(pending(registry)).toHaveLength(1);
      expect(pending(registry)[0].newPackages).toBeUndefined();
    }
  });

  it('reads no file for a call that raises no gate', async () => {
    let calls = 0;
    const { ingest } = setup(async () => { calls += 1; return undefined; });
    expect(await ingest.gatePackageCheck(gateSignal('npm i x', { permission_mode: 'bypassPermissions' }))).toBeUndefined();
    expect(await ingest.gatePackageCheck(gateSignal('npm i x', { tool_name: 'Read' }))).toBeUndefined();
    expect(calls).toBe(0);
    await ingest.gatePackageCheck(gateSignal('npm i x'));
    expect(calls).toBe(1);
  });

  it('a line read for another command or another pane is not put on the gate', async () => {
    const { registry, ingest } = setup(real);
    const check = await ingest.gatePackageCheck(gateSignal('npm i react-codeshift'));
    expect(check?.newPackages).toHaveLength(1);
    ingest.handlePermissionGate(gateSignal('npm i other-thing'), check);
    await drain(registry);
    expect(pending(registry)[0].newPackages).toBeUndefined();
  });

  it('the risk verdict, the push and the choices are the same with and without the line', async () => {
    for (const command of ['npm i react-codeshift', 'npm i react-codeshift && rm -rf /']) {
      const withLine = setup(real);
      const without = setup(undefined);
      await gate(withLine.ingest, gateSignal(command));
      await gate(without.ingest, gateSignal(command));
      await drain(withLine.registry, without.registry);
      const a = pending(withLine.registry)[0];
      const b = pending(without.registry)[0];
      expect(a.newPackages).toBeDefined();
      expect(b.newPackages).toBeUndefined();
      expect(a.risk).toBe(b.risk);
      expect(a.choices).toEqual(b.choices);
      expect(approvalHasElevatedRisk(a)).toBe(approvalHasElevatedRisk(b));
      const strip = (p: ReturnType<typeof buildApprovalPushPayload>) => ({ ...p, approvalId: '', sessionId: '' });
      expect(strip(buildApprovalPushPayload(a))).toEqual(strip(buildApprovalPushPayload(b)));
    }
  });

  it('survives the store round trip, re-validated', () => {
    const state = coerceApprovalState({
      version: 1,
      requests: [{
        id: 'a', sessionId: 's', agent: 'claude', kind: 'awaiting_permission', createdAt: 1, state: 'pending',
        newPackages: [{ ecosystem: 'npm', name: 'x', checked: 'package.json', via: 'install' }, { ecosystem: 'npm', name: '<b>' }],
      }],
    });
    expect(state.requests[0]?.newPackages).toEqual([{ ecosystem: 'npm', name: 'x', checked: 'package.json', via: 'install' }]);
  });
});

describe('new-package line on a Claude permission dialog', () => {
  it('hands the registry the line, still being read, with the command it was read from', async () => {
    const notes: TerminalPromptNote[] = [];
    const sessions: HookIngestSession[] = [{ id: 'pty-a', cwd: project }];
    const ingest = new HookIngest({
      listLiveSessions: () => sessions,
      emitAgentEvent: () => undefined,
      applyResumeBinding: () => undefined,
      approvals: {
        noteHookAwaitingInput: () => undefined,
        noteGateAwaiting: () => 'g',
        expireForSession: () => undefined,
        noteTerminalPrompt: (note) => { notes.push(note); },
      },
      newPackagesFor: real,
      now: () => 5_000,
    });
    ingest.handle({
      kind: 'agent.awaiting_input',
      agent: 'claude',
      cwd: project,
      ptyId: 'pty-a',
      payload: { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pip install x; npm i leftpad' } },
      ts: 1_000,
    });
    const note = notes.at(-1);
    expect(note?.packageCheck).toBeUndefined();
    expect(await note?.packageCheckPending).toEqual({
      command: 'pip install x; npm i leftpad',
      newPackages: [{ ecosystem: 'npm', name: 'leftpad', checked: 'package.json', via: 'install' }],
    });
  });
});
