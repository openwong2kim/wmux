import type { AgentSlug } from '../../shared/events';
import type { PaneLeaf, Surface } from '../../shared/types';
import { AGENT_SLUG_SET } from '../../shared/agentIdentity';
import { flattenName } from '../../shared/a2aNameSanitize';
import { getWorkspaceLeafPanes, type WorkspacePaneOwner } from '../../shared/paneUtils';
import { isBareShellTitle } from '../stores/selectors/workspaceAgentRoster';
import { sanitizeA2aName } from './a2aFormat';
import { computePaneAutoName, isAutoNameShape } from './paneNaming';

// Paths, prompts (`user@host:~`, `MINGW64:/c/x`) and executables are where a
// shell or ConPTY titles a terminal, never a name a person typed.
const NOT_A_NAME = /[\\/:@]|\.(exe|cmd|bat|ps1|sh)$/i;
// The most of a `Workspace.<name>` a terminal-specific part may take, so a
// long workspace name always keeps room for itself before the dot.
const TERMINAL_PART_MAX = 60;

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
  const userName = flattenName(surface.userName ?? '');
  if (userName) return userName;
  if (!oscNamesEnabled || !hasAgent) return undefined;
  const flat = flattenName(surface.title ?? '');
  if (!flat) return undefined;
  const name = flat.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+\|\s.*$/, '').trim();
  if (!name || NOT_A_NAME.test(name)) return undefined;
  if (isBareShellTitle(name) || AGENT_SLUG_SET.has(name.toLowerCase()) || isAutoNameShape(name)) return undefined;
  const folder = (surface.cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
  if (folder && name.toLowerCase() === folder.toLowerCase()) return undefined;
  return name;
}

/**
 * `Workspace.<party>`, capped at 100 characters while reserving room for the
 * workspace name before the dot: the party is capped at TERMINAL_PART_MAX and
 * a very long workspace name is truncated BEFORE the dot, so the terminal's
 * name (or coordinate) is never the part that gets cut off and the workspace
 * prefix never disappears. The party is flattened (bidi, controls, escapes)
 * the same way a name is before it is embedded in an A2A envelope.
 */
function joinA2aName(wsName: string, party: string): string {
  const clean = sanitizeA2aName(flattenName(party));
  if (!clean) return sanitizeA2aName(wsName);
  const terminal = truncateTerminal(clean, TERMINAL_PART_MAX);
  const ws = sanitizeA2aName(wsName);
  const room = Math.max(1, 100 - terminal.length - 1);
  return `${ws.slice(0, room)}.${terminal}`;
}

/** Cut a party to `max` characters but keep a trailing `.N` tab number, so
 *  `label.1` and `label.2` never read the same after the cut. */
function truncateTerminal(party: string, max: number): string {
  if (party.length <= max) return party;
  const m = /^(.*)(\.\d+)$/.exec(party);
  if (m) return m[1].slice(0, max - m[2].length) + m[2];
  return party.slice(0, max);
}

/**
 * How an A2A party is named in the message a receiving agent reads:
 * `<workspace>.<name>` (e.g. `Team.release`), so a terminal can tell which
 * terminal of a workspace is talking. The name is, in order: the name the
 * user set through wmux's rename (`userName`), the terminal's own title (only
 * when `oscNamesEnabled` and the terminal runs an agent), the pane's wmux
 * label, else the pane's coordinate with that terminal's agent. In a pane with
 * several terminal tabs the label and the coordinate carry the tab's number,
 * so two tabs never read the same. A terminal's own name is used only while no
 * other terminal of the workspace reads the same final name — its own name or
 * its label/coordinate fallback — so a title cannot pass for another party.
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
    // Accept `own` only while no other terminal reserves the same name — via
    // its own name OR its label/coordinate fallback (a name is taken when it
    // equals either), so a title named like another terminal's `label.N` can
    // never pass for it.
    const matches = (party: string | undefined): boolean =>
      party !== undefined && joinA2aName(ws.name, party).toLowerCase() === ownFull;
    // A pane label is reserved bare too: a labeled pane with several terminal
    // tabs falls back to `label.N`, but the bare label still names that pane.
    const taken = leaves.some((l) => matches(labelOf(l))
      || l.surfaces.some((s) => isTerm(s) && s.ptyId !== ptyId
        && (matches(ownName(s)) || matches(fallbackOf(l, s)))));
    if (!taken) return joinA2aName(ws.name, own);
  }
  return ownSurface ? joinA2aName(ws.name, fallbackOf(leaf, ownSurface)) : ws.name;
}
