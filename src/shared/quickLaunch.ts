// Global quick launch: the contract between main, Settings and the floating
// composer window, plus the accelerator helpers both sides use.
//
// The accelerator helpers are adapted from MonoCode
// (hardbeat920/monocode@6bd432ca, src/features/quick-composer/model/quickComposerShortcut.ts),
// MIT License, Copyright (c) 2026 Nick. They are rewritten to produce and read
// Electron accelerators instead of tauri-plugin-global-shortcut chords.

import { FANOUT_AGENTS, type FanoutAgentChoice } from './fanoutPreset';
import { ORCH_ROLES } from './orchestratorRole';
import { FANOUT_PROMPT_MAX_BYTES } from './workTask';

export const QUICK_LAUNCH_DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+Space';

/** What Settings › Shortcuts › Quick launch shows, over IPC. */
export interface QuickLaunchSettingsPayload {
  enabled: boolean;
  /** Electron accelerator. */
  accelerator: string;
  /**
   * `held`: registered. `off`: switched off. `unavailable`: wanted, but the OS
   * or another app refused the chord — the shortcut does nothing until it is
   * changed or the other app lets go.
   */
  status: 'off' | 'held' | 'unavailable';
  error?: string;
}

export interface QuickLaunchWorkspace {
  id: string;
  name: string;
  cwd: string;
}

/** One entry of the composer's agent picker. */
export type QuickLaunchAgent =
  | { kind: 'default' }
  | { kind: 'role'; role: string }
  | { kind: 'agent'; agent: string };

/** Everything the composer needs on every show. */
export interface QuickLaunchContext {
  workspaces: QuickLaunchWorkspace[];
  activeWorkspaceId?: string;
  roles: string[];
  agents: { stem: string; label: string }[];
  /** The main window's theme id, so the panel matches it. */
  theme?: string;
  /** Only for the `custom` theme: its colours (CustomThemeColors). */
  customThemeColors?: unknown;
  /** The main window's UI language. */
  locale?: string;
  accelerator: string;
}

export type QuickLaunchCheckout = 'current' | 'worktree';

export interface QuickLaunchRequest {
  prompt: string;
  workspaceId: string;
  agent: QuickLaunchAgent;
  checkout: QuickLaunchCheckout;
}

export type QuickLaunchResult = { ok: true } | { ok: false; error: string };

/** Roles and agents the composer offers: the operator's role vocabulary, then
 *  every fan-out CLI that is verified end to end. */
export function quickLaunchAgentOptions(): Pick<QuickLaunchContext, 'roles' | 'agents'> {
  return {
    roles: [...ORCH_ROLES],
    agents: FANOUT_AGENTS.filter((a) => a.selectable).map((a) => ({ stem: a.stem, label: a.label })),
  };
}

/** The fan-out shape of an agent choice: a role name, an agent row, or neither. */
export function quickLaunchAgentFields(agent: QuickLaunchAgent): { role?: string; agentChoice?: FanoutAgentChoice } {
  if (agent.kind === 'role') return { role: agent.role };
  if (agent.kind === 'agent') return { agentChoice: { agent: agent.agent } };
  return {};
}

/** Defensive parse of a submit from the composer window. */
export function normalizeQuickLaunchRequest(raw: unknown): QuickLaunchRequest | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Invalid request.' };
  const r = raw as Record<string, unknown>;
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
  if (!prompt) return { error: 'Write a prompt first.' };
  if (new TextEncoder().encode(prompt).length > FANOUT_PROMPT_MAX_BYTES) {
    return { error: `The prompt is longer than ${FANOUT_PROMPT_MAX_BYTES / 1024} KB. Shorten it and point to a file instead.` };
  }
  const workspaceId = typeof r.workspaceId === 'string' ? r.workspaceId : '';
  if (!workspaceId) return { error: 'Pick a workspace first.' };
  if (r.checkout !== 'current' && r.checkout !== 'worktree') return { error: 'Pick a checkout.' };
  const a = r.agent as Record<string, unknown> | null | undefined;
  let agent: QuickLaunchAgent;
  if (a?.kind === 'role' && typeof a.role === 'string' && (ORCH_ROLES as readonly string[]).includes(a.role)) {
    agent = { kind: 'role', role: a.role };
  } else if (a?.kind === 'agent' && typeof a.agent === 'string' && FANOUT_AGENTS.some((s) => s.selectable && s.stem === a.agent)) {
    agent = { kind: 'agent', agent: a.agent };
  } else if (a?.kind === 'default') {
    agent = { kind: 'default' };
  } else {
    return { error: 'Pick an agent.' };
  }
  return { prompt, workspaceId, agent, checkout: r.checkout };
}

/**
 * A task title from the prompt's first line. It names the workspace and, for a
 * worktree, the branch — so it carries a time suffix: two launches of the same
 * prompt must not collide on one branch name.
 */
export function quickLaunchTitle(prompt: string, now: Date = new Date()): string {
  const first = prompt.trim().split('\n', 1)[0].replace(/\s+/g, ' ').trim();
  const head = first.length > 40 ? first.slice(0, 40).trimEnd() : first;
  const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
  return `${head || 'quick launch'} ${stamp}`;
}

// ─── Accelerators ─────────────────────────────────────────────────────────────

/** KeyboardEvent.code → Electron accelerator key. */
const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

function keyForCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return Object.prototype.hasOwnProperty.call(CODE_KEYS, code) ? CODE_KEYS[code] : null;
}

const ACCELERATOR_KEYS = new Set<string>(Object.values(CODE_KEYS));
const MODIFIERS = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift'] as const;

/**
 * Whether `value` is an accelerator a global shortcut may use: one supported
 * key and at least one of Command or Control. An OS-wide chord without one
 * would steal plain typing (Shift+A) or Option-composed characters.
 */
export function isGlobalAccelerator(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parts = value.split('+');
  const key = parts.pop();
  if (!key || !(/^[A-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || ACCELERATOR_KEYS.has(key))) return false;
  if (parts.length === 0 || new Set(parts).size !== parts.length) return false;
  if (!parts.every((p) => (MODIFIERS as readonly string[]).includes(p))) return false;
  return parts.some((p) => p === 'CommandOrControl' || p === 'Command' || p === 'Control');
}

/**
 * The accelerator a key press spells, or null while it is still only
 * modifiers or lacks Command/Control. The platform's primary modifier is
 * recorded as CommandOrControl so a setting carries across macOS and Windows.
 */
export function acceleratorFromKeyEvent(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mac: boolean,
): string | null {
  const key = keyForCode(event.code);
  if (!key) return null;
  const primary = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  const parts = [
    primary && 'CommandOrControl',
    other && (mac ? 'Control' : 'Command'),
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
  ].filter((p): p is string => Boolean(p));
  const accelerator = [...parts, key].join('+');
  return isGlobalAccelerator(accelerator) ? accelerator : null;
}

/** An accelerator as the keys a person presses on this OS, spelled like the
 *  Settings keyboard list (displayCombo): `⌘+Shift+Space`, `Ctrl+Shift+Space`. */
export function formatAccelerator(accelerator: string, mac: boolean): string {
  const names: Record<string, string> = mac
    ? { CommandOrControl: '⌘', Command: '⌘', Control: 'Ctrl', Alt: '⌥' }
    : { CommandOrControl: 'Ctrl', Command: 'Win', Control: 'Ctrl' };
  return accelerator
    .split('+')
    .map((p) => names[p] ?? p)
    .join('+');
}
