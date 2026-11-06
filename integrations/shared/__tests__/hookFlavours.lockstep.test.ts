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

// The native bridge (core/wmux-native) embeds this file as its flavour table.
const NATIVE_FLAVOURS = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'core', 'wmux-native', 'flavours.json'), 'utf8'),
) as typeof FLAVOURS;

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

  // The Rust table is the whole runtime row, runtime-only fields included
  // (log file, request-id prefix), in the same order: both bridges serve the
  // same CLIs and write the same logs.
  it('the native bridge table equals the Node bridge table', () => {
    expect(NATIVE_FLAVOURS).toEqual(FLAVOURS);
    expect(Object.keys(NATIVE_FLAVOURS)).toEqual(Object.keys(FLAVOURS));
    for (const id of Object.keys(FLAVOURS)) {
      expect(Object.keys(NATIVE_FLAVOURS[id].events), id).toEqual(Object.keys(FLAVOURS[id].events));
    }
  });

  it.each(COMPAT_HOOK_FLAVOUR_IDS)('%s: the native table matches the TS table', (id) => {
    const ts = COMPAT_HOOK_FLAVOURS[id];
    const rt = NATIVE_FLAVOURS[id];
    expect(rt.agent).toBe(ts.agent);
    expect(rt.events).toEqual(ts.events);
    expect(rt.sessionIdFields).toEqual(ts.sessionIdFields);
    expect(rt.cwdFields).toEqual(ts.cwdFields);
    expect(rt.sourceField).toEqual(ts.sourceField);
  });

  // The constants both bridges hard-code, read off the two sources: a change to
  // the Node bridge's timing, retry, idempotency or forwarding rules must be
  // made to the native one too.
  it('the native bridge hard-codes the same rules as the Node bridge', () => {
    const mjs = fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'shared', 'bin', 'wmux-hooks-bridge.mjs'), 'utf8');
    const rs = ['hook.rs', 'rpc.rs']
      .map((f) => fs.readFileSync(path.join(REPO_ROOT, 'core', 'wmux-native', 'src', f), 'utf8'))
      .join('\n');
    const pick = (src: string, re: RegExp): string => {
      const m = src.match(re);
      expect(m, String(re)).not.toBeNull();
      return (m as RegExpMatchArray)[1].replace(/\s+/g, '').replace(/'/g, '"').replace(/,$/, '');
    };
    const pairs: [RegExp, RegExp][] = [
      [/const BRIDGE_VERSION = ('[^']+')/, /const BRIDGE_VERSION: &str = ("[^"]+")/],
      [/const HOOK_TIMEOUT_MS = (\d+)/, /const HOOK_TIMEOUT: Duration = Duration::from_millis\((\d+)\)/],
      [/const MAX_STDIN_BYTES = ([^;]+);/, /const MAX_STDIN_BYTES: usize = ([^;]+);/],
      [/const CONNECT_RETRY_BACKOFFS_MS = \[([^\]]+)\]/, /const CONNECT_RETRY_BACKOFFS_MS: \[u64; \d+\] = \[([^\]]+)\]/],
      [/const TRANSIENT_CONNECT_CODES = new Set\(\[([^\]]+)\]\)/, /const TRANSIENT_CONNECT_CODES: \[&str; \d+\] = \[([^\]]+)\]/],
      [/const IDEMPOTENT_KINDS = new Set\(\[([^\]]+)\]\)/, /const IDEMPOTENT_KINDS: \[&str; \d+\] = \[([^\]]+)\]/],
      [/const FORWARDED_SESSION_SOURCES = new Set\(\[([^\]]+)\]\)/, /const FORWARDED_SESSION_SOURCES: \[&str; \d+\] = \[([^\]]+)\]/],
      // Rust matches the pattern by hand; its doc comment names the one it implements.
      [/const SESSION_ID_RE = (\/[^\n]+\/);/, /\/\/\/ SESSION_ID_RE: (\/[^\n]+\/)/],
    ];
    for (const [fromMjs, fromRs] of pairs) {
      expect(pick(rs, fromRs), String(fromMjs)).toBe(pick(mjs, fromMjs));
    }
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
