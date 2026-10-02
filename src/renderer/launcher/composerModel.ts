// Pure pieces of the quick-launch composer, kept DOM-free for unit tests.
//
// The key handling and the remembered-choice fallback follow MonoCode's quick
// composer (hardbeat920/monocode@6bd432ca,
// src/features/quick-composer/ui/QuickComposer.tsx onPromptKeyDown, and
// src/features/quick-composer/model/quickComposer.ts initialQuickProject),
// MIT License, Copyright (c) 2026 Nick.

import type { QuickLaunchAgent, QuickLaunchCheckout, QuickLaunchWorkspace } from '../../shared/quickLaunch';

export type ComposerKeyAction = 'submit' | 'dismiss' | null;

/**
 * Enter starts, Shift+Enter is a newline, Escape dismisses. Nothing fires
 * mid-IME: the Enter that commits a Korean or Japanese composition must not
 * also launch the agent.
 */
export function composerKeyAction(e: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}): ComposerKeyAction {
  // keyCode 229 is the IME "Process" key some platforms send instead of isComposing.
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'Escape') return 'dismiss';
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey) return 'submit';
  return null;
}

/** Encode an agent choice as one <select> value and back. */
export function agentValue(agent: QuickLaunchAgent): string {
  if (agent.kind === 'role') return `role:${agent.role}`;
  if (agent.kind === 'agent') return `agent:${agent.agent}`;
  return 'default';
}

export function parseAgentValue(value: string): QuickLaunchAgent {
  if (value.startsWith('role:')) return { kind: 'role', role: value.slice(5) };
  if (value.startsWith('agent:')) return { kind: 'agent', agent: value.slice(6) };
  return { kind: 'default' };
}

export interface ComposerChoice {
  workspaceId?: string;
  agent: string;
  checkout: QuickLaunchCheckout;
}

/**
 * The workspace to preselect: the last one used while it still exists and has
 * a folder, else the main window's active one, else the first with a folder.
 */
export function initialWorkspace(
  workspaces: QuickLaunchWorkspace[],
  remembered: string | undefined,
  active: string | undefined,
): string | undefined {
  const usable = workspaces.filter((w) => w.cwd);
  return (
    usable.find((w) => w.id === remembered)?.id ??
    usable.find((w) => w.id === active)?.id ??
    usable[0]?.id
  );
}
