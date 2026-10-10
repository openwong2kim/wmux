// Per-account browser memory — the namespace a protected pane's memory lives in.
//
// The memory stores (recorded flows, promoted skills, site memory) were keyed
// by workspace alone. A protected pane drives its own Chrome profile, signed
// into its own account, so what it learned must not reach any other pane, and
// what other panes learned must not reach it. Its memory is keyed by
//
//   workspaceId + the pane's profile + the profile namespace generation
//
// The generation is a random id main assigns durably whenever the pane's
// (workspace, profile) binding changes, and never reuses (ProfileNamespaceStore).
//
// An unprotected pane keeps the bare workspaceId as its key, so legacy keys and
// files are untouched. A namespace key contains `.`, which a workspace id never
// does, so the two can never collide.

import { createHash } from 'node:crypto';

/** Legacy key: the bare workspace id (also the directory name of its files). */
export const LEGACY_MEMORY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** A protected namespace key: `<workspaceId>.p<profile hash>.g<generation>`. */
export const MEMORY_NAMESPACE_KEY_RE = /^[A-Za-z0-9_-]{1,128}\.p[0-9a-f]{16}\.g[0-9a-f]{16}$/;

/** A profile namespace generation: 16 lowercase hex characters. */
export const MEMORY_GENERATION_RE = /^[0-9a-f]{16}$/;

/** Profile names compare case-insensitively everywhere else; so does this. */
export function normalizeMemoryProfile(profile: string): string {
  return profile.trim().toLowerCase();
}

function profileHash(profile: string): string {
  return createHash('sha256').update(normalizeMemoryProfile(profile), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The memory key of a protected pane, or null when any part is unusable. The
 * key is what the stores file records under AND what each record stores as
 * its `workspaceId`, so a record copied between namespaces fails the stores'
 * self-check.
 */
export function memoryNamespaceKey(workspaceId: string, profile: string, generation: string): string | null {
  if (!LEGACY_MEMORY_KEY_RE.test(workspaceId)) return null;
  if (!normalizeMemoryProfile(profile)) return null;
  if (!MEMORY_GENERATION_RE.test(generation)) return null;
  return `${workspaceId}.p${profileHash(profile)}.g${generation}`;
}

/** Whether `key` is a usable memory key (legacy or namespaced) for a file path. */
export function isMemoryKey(key: string): boolean {
  return LEGACY_MEMORY_KEY_RE.test(key) || MEMORY_NAMESPACE_KEY_RE.test(key);
}
