// Lockstep between the installer-side flavour table (TypeScript) and the
// shared bridge's runtime table (a standalone .mjs that cannot import src/).
// Same arrangement as the Codex hooks block (configIO.ts ↔ wmuxHooks.mjs).

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FLAVOURS } from '../bin/wmux-hooks-bridge.mjs';
import {
  COMPAT_HOOK_FLAVOURS,
  COMPAT_HOOK_FLAVOUR_IDS,
  SHARED_HOOKS_BRIDGE_MARKER,
  compatHookFlavourForAgent,
  compatHookShellCommand,
  isCompatHookFlavourId,
} from '../../../src/shared/hooks/hookFlavours';
import { AGENT_SLUGS, isAgentSlug } from '../../../src/shared/agentIdentity';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

describe('hook flavours — TS table ↔ bridge table', () => {
  it('names the same flavours on both sides', () => {
    expect(Object.keys(FLAVOURS).sort()).toEqual([...COMPAT_HOOK_FLAVOUR_IDS].sort());
  });

  it.each(COMPAT_HOOK_FLAVOUR_IDS)('%s: agent, events and field paths match', (id) => {
    const ts = COMPAT_HOOK_FLAVOURS[id];
    const rt = FLAVOURS[id];
    expect(ts.id).toBe(id);
    expect(rt.agent).toBe(ts.agent);
    expect(rt.events).toEqual(ts.events);
    expect(rt.sessionIdFields).toEqual(ts.sessionIdFields);
    expect(rt.cwdFields).toEqual(ts.cwdFields);
    expect(rt.sourceField).toEqual(ts.sourceField);
  });

  // Registering an event the bridge drops spawns a process per occurrence to
  // do nothing (the CODEX_HOOK_EVENTS rule).
  it.each(COMPAT_HOOK_FLAVOUR_IDS)('%s: registers only events the bridge maps', (id) => {
    const install = COMPAT_HOOK_FLAVOURS[id].install;
    if (!install) return;
    for (const event of install.register) {
      expect(Object.keys(COMPAT_HOOK_FLAVOURS[id].events), event).toContain(event);
    }
  });

  it.each(COMPAT_HOOK_FLAVOUR_IDS)('%s: speaks for a registry agent', (id) => {
    expect(isAgentSlug(COMPAT_HOOK_FLAVOURS[id].agent)).toBe(true);
    expect(compatHookFlavourForAgent(COMPAT_HOOK_FLAVOURS[id].agent)).toBe(id);
  });

  it('maps no other registry agent to the shared bridge', () => {
    const served = new Set(COMPAT_HOOK_FLAVOUR_IDS.map((id) => COMPAT_HOOK_FLAVOURS[id].agent));
    for (const slug of AGENT_SLUGS) {
      if (!served.has(slug)) expect(compatHookFlavourForAgent(slug), slug).toBeUndefined();
    }
  });

  // An approval-shaped kind is the only thing that may read as "waiting on a
  // human" (#898); a prompt submit or a tool hook never does.
  it('maps awaiting_input only from approval events', () => {
    for (const id of COMPAT_HOOK_FLAVOUR_IDS) {
      for (const [event, rule] of Object.entries(COMPAT_HOOK_FLAVOURS[id].events)) {
        if (rule.kind !== 'agent.awaiting_input') continue;
        expect(['PermissionRequest', 'Notification'], `${id}:${event}`).toContain(event);
        if (event === 'Notification') expect(rule.when, `${id}:${event}`).toBeDefined();
      }
    }
  });

  it('narrows untrusted flavour ids', () => {
    expect(isCompatHookFlavourId('copilot')).toBe(true);
    for (const bad of ['claude', 'constructor', '__proto__', '', 7]) expect(isCompatHookFlavourId(bad)).toBe(false);
  });

  it('the bridge source carries the shared marker on its first line', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'shared', 'bin', 'wmux-hooks-bridge.mjs'), 'utf8');
    expect(src.split('\n')[0]).toContain(SHARED_HOOKS_BRIDGE_MARKER);
  });

  // The Kiro entry point no longer carries its own copy of the path.
  it('the Kiro bridge delegates to the shared bridge', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'kiro', 'bin', 'wmux-kiro-bridge.mjs'), 'utf8');
    expect(src).toContain("import('./wmux-hooks-bridge.mjs')");
    expect(src).toContain("runHookProcess('kiro'");
    expect(src).not.toContain('createConnection');
  });
});

describe('compatHookShellCommand', () => {
  it('leads with a bare node, never a quoted token (#1882)', () => {
    const cmd = compatHookShellCommand('C:\\Users\\Jane Doe\\.wmux\\hooks\\wmux-hooks-bridge.mjs', 'gemini', 'AfterAgent');
    expect(cmd).toBe('node "C:\\Users\\Jane Doe\\.wmux\\hooks\\wmux-hooks-bridge.mjs" gemini AfterAgent');
  });

  it('refuses a path no single quoting survives in every shell', () => {
    for (const bad of ['C:\\a$b\\x.mjs', 'C:\\a`b\\x.mjs', 'C:\\100%\\x.mjs', 'C:\\a"b\\x.mjs']) {
      expect(compatHookShellCommand(bad, 'gemini', 'AfterAgent'), bad).toBeNull();
    }
  });
});
