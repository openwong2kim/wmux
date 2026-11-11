// Workspace and tab names are addresses: `#backend` and `api.#w1-2` resolve
// through them (paneNameResolver.ts), and two of the same name resolve to
// neither, as ambiguous. So a rename that would make a name ambiguous, or
// read as an automatic pane tag (w1-2), is refused before it is stored.
//
// Names compare normalized: NFC, hidden format and bidi characters dropped,
// whitespace collapsed and trimmed, case-insensitive (the resolver matches
// case-insensitively). A name that carries a zero-width or bidi control
// character is refused outright, so two names that read alike are never two
// different names. PC rail shadows are another computer's workspaces and
// never resolve here, so they never clash.

import type { Workspace } from '../../shared/types';
import { flattenName } from '../../shared/a2aNameSanitize';
import { APP_ACTION_NAME_MAX } from '../../shared/appActions';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { isShadowWorkspaceId } from '../../shared/pcRail';
import { AUTO_NAME_RE } from './paneNameResolver';

export type NameRefusal = 'empty' | 'too-long' | 'hidden-chars' | 'pane-tag' | 'taken';

export const ADDRESSABLE_NAME_MAX = APP_ACTION_NAME_MAX;

/** Zero-width characters, the BOM, and bidi marks, embeddings, overrides and isolates. */
const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u061C]/u;

const MESSAGES: Record<NameRefusal, string> = {
  empty: 'the name is empty',
  'too-long': `the name is longer than ${ADDRESSABLE_NAME_MAX} characters`,
  'hidden-chars': 'the name contains zero-width or text-direction characters',
  'pane-tag': 'the name is an automatic pane tag (w<n>-<n>), which it would shadow',
  taken: 'another one already has this name, so neither would resolve by it',
};

export function nameRefusalMessage(reason: NameRefusal): string {
  return MESSAGES[reason];
}

/** The form two names are compared in. */
export function normalizeAddressableName(name: string): string {
  return flattenName(name.normalize('NFC')).toLowerCase();
}

function shapeRefusal(name: string): NameRefusal | null {
  if (HIDDEN_CHARS.test(name)) return 'hidden-chars';
  const flat = flattenName(name.normalize('NFC'));
  if (!flat) return 'empty';
  if (name.trim().length > ADDRESSABLE_NAME_MAX) return 'too-long';
  // The resolver's own pattern: a whole name that reads as a tag (`w1-2`,
  // `w1-2.3`, `w1-2(claude)`), not one that merely starts like one.
  if (AUTO_NAME_RE.test(flat)) return 'pane-tag';
  return null;
}

type NamedWorkspace = Pick<Workspace, 'id' | 'name'>;

/** Why `name` cannot be workspace `id`'s name, or null. Its own current name is fine. */
export function workspaceNameRefusal(
  workspaces: ReadonlyArray<NamedWorkspace>,
  id: string,
  name: string,
): NameRefusal | null {
  const shape = shapeRefusal(name);
  if (shape) return shape;
  const wanted = normalizeAddressableName(name);
  const taken = workspaces.some(
    (w) => w.id !== id && !isShadowWorkspaceId(w.id) && normalizeAddressableName(w.name) === wanted,
  );
  return taken ? 'taken' : null;
}

/**
 * Why `name` cannot be tab `surfaceId`'s name, or null. A tab name resolves
 * across every workspace (`#name`), so it clashes with another tab's name or
 * another pane's label anywhere. Its own pane's label is not a clash: the
 * resolver reads the two as one target.
 */
export function tabNameRefusal(
  workspaces: ReadonlyArray<Workspace>,
  paneLabel: Record<string, string> | undefined,
  surfaceId: string,
  name: string,
): NameRefusal | null {
  const shape = shapeRefusal(name);
  if (shape) return shape;
  const wanted = normalizeAddressableName(name);
  for (const ws of workspaces) {
    if (isShadowWorkspaceId(ws.id)) continue;
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      const own = leaf.surfaces.some((s) => s.id === surfaceId);
      const label = paneLabel?.[leaf.id] ?? leaf.metadata?.label;
      if (!own && label && normalizeAddressableName(label) === wanted) return 'taken';
      for (const s of leaf.surfaces) {
        if (s.id === surfaceId || !s.userName) continue;
        if (normalizeAddressableName(s.userName) === wanted) return 'taken';
      }
    }
  }
  return null;
}
