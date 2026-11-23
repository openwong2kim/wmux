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
import type { ApprovalRequest, TerminalPromptNote } from '../types';

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

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
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

function setup(lookup: ((command: string, cwd: string) => NewPackageNote[] | undefined) | undefined) {
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
    const { registry, ingest } = setup((c, cwd) => newPackagesForCommand(c, cwd));
    ingest.handlePermissionGate(gateSignal('npm i react react-codeshift'));
    await drain();
    expect(pending(registry)[0].newPackages).toEqual([
      { ecosystem: 'npm', name: 'react-codeshift', checked: 'package.json', via: 'install' },
    ]);
  });

  it('reads the hook\'s own cwd when it names a directory', async () => {
    const seen: string[] = [];
    const { ingest } = setup((_c, cwd) => { seen.push(cwd); return undefined; });
    ingest.handlePermissionGate(gateSignal('npm i x', { cwd: '/elsewhere/dir' }));
    ingest.handlePermissionGate(gateSignal('npm i x', { cwd: 'relative' }));
    expect(seen).toEqual(['/elsewhere/dir', project]);
  });

  it('no line with the setting off (no lookup), for a known package, or for a WSL pane', async () => {
    const off = setup(undefined);
    off.ingest.handlePermissionGate(gateSignal('npm i react-codeshift'));
    const known = setup((c, cwd) => newPackagesForCommand(c, cwd));
    known.ingest.handlePermissionGate(gateSignal('npm i react'));
    const wsl = setup((c, cwd) => newPackagesForCommand(c, cwd));
    wsl.sessions[0] = { ...wsl.sessions[0], wslTarget: { distribution: 'Ubuntu', user: 'u' } };
    wsl.ingest.handlePermissionGate(gateSignal('npm i react-codeshift'));
    await drain();
    for (const r of [off.registry, known.registry, wsl.registry]) {
      expect(pending(r)).toHaveLength(1);
      expect(pending(r)[0].newPackages).toBeUndefined();
    }
  });

  it('a lookup that throws costs the line, never the gate', async () => {
    const { registry, ingest } = setup(() => { throw new Error('boom'); });
    const r = ingest.handlePermissionGate(gateSignal('npm i x'));
    await drain();
    expect(r.ok).toBe(true);
    expect(pending(registry)).toHaveLength(1);
  });

  it('the risk verdict, the push and the choices are the same with and without the line', async () => {
    for (const command of ['npm i react-codeshift', 'npm i react-codeshift && rm -rf /']) {
      const withLine = setup((c, cwd) => newPackagesForCommand(c, cwd));
      const without = setup(undefined);
      withLine.ingest.handlePermissionGate(gateSignal(command));
      without.ingest.handlePermissionGate(gateSignal(command));
      await drain();
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
  it('hands the registry the line with the command it was read from', () => {
    vi.useFakeTimers();
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
      newPackagesFor: (c, cwd) => newPackagesForCommand(c, cwd),
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
    vi.advanceTimersByTime(10_000);
    expect(notes.at(-1)?.packageCheck).toEqual({
      command: 'pip install x; npm i leftpad',
      newPackages: [{ ecosystem: 'npm', name: 'leftpad', checked: 'package.json', via: 'install' }],
    });
  });
});
