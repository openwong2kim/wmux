import type { AgentSlug } from '../../shared/events';
import type { PaneLeaf, Surface } from '../../shared/types';
import { AGENT_SLUG_SET } from '../../shared/agentIdentity';
import { stripBidi } from '../../shared/a2aSpawnPrompt';
import { getWorkspaceLeafPanes, type WorkspacePaneOwner } from '../../shared/paneUtils';
import { isBareShellTitle } from '../stores/selectors/workspaceAgentRoster';
import { sanitizeA2aName } from './a2aFormat';
import { computePaneAutoName, isAutoNameShape } from './paneNaming';

// C0/C1 controls and DEL: a title could otherwise forge a prompt line. Bidi
// marks are removed separately by stripBidi (which already covers U+061C,
// U+200E, U+200F, U+202A–U+202E and U+2066–U+2069), so this class needs no
// literal bidi characters.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
// Paths, prompts (`user@host:~`, `MINGW64:/c/x`) and executables are where a
// shell or ConPTY titles a terminal, never a name a person typed.
const NOT_A_NAME = /[\\/:@]|\.(exe|cmd|bat|ps1|sh)$/i;

type TitledSurface = Pick<Surface, 'title' | 'cwd' | 'userName'>;

/**
 * The name a terminal may contribute to an A2A party name, or undefined.
 *
 * A name the user set deliberately through wmux's own rename (`userName`) is
 * always the name. Otherwise the title is what the program in the terminal
 * set (OSC 0/2), and it counts only while the operator opted in
 * (`oscNamesEnabled`) and the terminal runs an agent (`hasAgent`) — a plain
 * shell or process title is never a name. There is no one-word rule: the
 * setting is the operator's explicit opt-in to whatever a program writes to
 * that terminal, which wmux cannot tell apart from an agent's `/rename`.
 */
export function terminalManualName(
  surface: TitledSurface,
  hasAgent: boolean,
  oscNamesEnabled: boolean,
): string | undefined {
  const userName = surface.userName?.trim();
  if (userName) return userName;
  if (!oscNamesEnabled || !hasAgent) return undefined;
  const flat = stripBidi(surface.title ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  const name = flat.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+\|\s.*$/, '').trim();
  if (!name || NOT_A_NAME.test(name)) return undefined;
  if (isBareShellTitle(name) || AGENT_SLUG_SET.has(name.toLowerCase()) || isAutoNameShape(name)) return undefined;
  const folder = (surface.cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
  if (folder && name.toLowerCase() === folder.toLowerCase()) return undefined;
  return name;
}

/**
 * `Workspace.<party>`, capped at 100 characters while reserving the whole
 * party for the terminal-specific part: a very long workspace name is
 * truncated BEFORE the dot so the terminal's name (or coordinate) is never
 * the part that gets cut off. The party is flattened (bidi, controls, escapes)
 * the same way a name is before it is embedded in an A2A envelope.
 */
function joinA2aName(wsName: string, party: string): string {
  const clean = sanitizeA2aName(stripBidi(party).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim());
  if (!clean) return sanitizeA2aName(wsName);
  const room = Math.max(0, 100 - clean.length - 1);
  return `${sanitizeA2aName(wsName).slice(0, room)}.${clean}`;
}

/**
 * How an A2A party is named in the message a receiving agent reads:
 * `<workspace>.<name>` (e.g. `Simply.release`), so a terminal can tell which
 * terminal of a workspace is talking. The name is, in order: the name the
 * user set through wmux's rename (`userName`), the terminal's own title (only
 * when `oscNamesEnabled` and the terminal runs an agent), the pane's wmux
 * label, else the pane's coordinate with that terminal's agent. In a pane with
 * several terminal tabs the label and the coordinate carry the tab's number,
 * so two tabs never read the same. A terminal's own name is used only while no
 * other terminal of the workspace reads the same final name (labels and
 * coordinate fallbacks included), so a title cannot pass for another party.
 * Display only: never an address. Falls back to the bare workspace name when
 * the pane is unknown (an unverified sender, a pty that no open pane holds).
 */
export function a2aPartyName(
  ws: WorkspacePaneOwner & { name: string; wsOrdinal?: number },
  paneLabel: Record<string, string> | undefined,
  surfaceAgent: Record<string, { slug?: AgentSlug }> | undefined,
  ptyId?: string,
  oscNamesEnabled = false,
): string {
  if (!ptyId) return ws.name;
  const leaves = getWorkspaceLeafPanes(ws);
  const leaf = leaves.find((l) => l.surfaces.some((s) => s.ptyId === ptyId));
  if (!leaf) return ws.name;

  const isTerm = (s: Surface): boolean => s.surfaceType !== 'browser' && !!s.ptyId;
  const labelOf = (l: PaneLeaf): string | undefined => (paneLabel?.[l.id] ?? l.metadata?.label)?.trim() || undefined;
  const hasAgent = (s: Surface): boolean => !!(s.ptyId && surfaceAgent?.[s.ptyId]?.slug);
  const ownName = (s: Surface): string | undefined => terminalManualName(s, hasAgent(s), oscNamesEnabled);

  // The label/coordinate fallback for a surface: the pane label else the auto
  // coordinate, with the terminal-tab number when the pane holds several
  // terminal tabs (browser/editor tabs do not shift the count).
  const fallbackOf = (l: PaneLeaf, s: Surface): string => {
    const terms = l.surfaces.filter(isTerm);
    const idx = terms.findIndex((t) => t.ptyId === s.ptyId);
    const tab = terms.length > 1 ? `.${idx + 1}` : '';
    const label = labelOf(l);
    const slug = surfaceAgent?.[s.ptyId]?.slug;
    return label
      ? `${label}${tab}`
      : computePaneAutoName(ws.wsOrdinal ?? 0, l.ordinal ?? 0) + tab + (slug ? `(${slug})` : '');
  };

  const ownSurface = leaf.surfaces.find((s) => s.ptyId === ptyId);
  const own = ownSurface ? ownName(ownSurface) : undefined;
  if (own) {
    const ownFull = joinA2aName(ws.name, own).toLowerCase();
    // Accept `own` only while no other terminal's FINAL name (its own name,
    // else its label or coordinate fallback) spells the same, so a title named
    // like another terminal's `label.N` can never pass for it.
    const taken = leaves.some((l) =>
      l.surfaces.some((s) => isTerm(s) && s.ptyId !== ptyId
        && joinA2aName(ws.name, ownName(s) ?? fallbackOf(l, s)).toLowerCase() === ownFull));
    if (!taken) return joinA2aName(ws.name, own);
  }
  return ownSurface ? joinA2aName(ws.name, fallbackOf(leaf, ownSurface)) : ws.name;
}
