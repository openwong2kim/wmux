import type { AgentSlug } from '../../shared/events';
import type { PaneLeaf, Surface } from '../../shared/types';
import { AGENT_SLUGS } from '../../shared/agentIdentity';
import { getWorkspaceLeafPanes, type WorkspacePaneOwner } from '../../shared/paneUtils';
import { isBareShellTitle } from '../stores/selectors/workspaceAgentRoster';
import { sanitizeA2aName } from './a2aFormat';
import { computePaneAutoName } from './paneNaming';

const AGENT_SLUG_SET: ReadonlySet<string> = new Set(AGENT_SLUGS);
const AUTO_NAME_SHAPE = /^w\d+-\d+/i;
// Paths, prompts (`user@host:~`, `MINGW64:/c/x`) and executables are where a
// shell or ConPTY titles a terminal, never a name a person typed.
const NOT_A_NAME = /[\\/:@]|\.(exe|cmd|bat|ps1|sh)$/i;
// C0/C1 controls and bidi overrides: a title could otherwise forge a prompt
// line or flip how the name reads.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

type TitledSurface = Pick<Surface, 'title' | 'titleLocked' | 'cwd'>;

/**
 * The name a person gave one terminal, read from its tab title, or undefined.
 *
 * A title typed into wmux (Rename tab, `titleLocked`) is the user's as it is.
 * Otherwise the title is what the program in the terminal set (OSC 0/2), and
 * an agent's own rename (Claude Code `/rename`, Codex, Qwen Code) lands there
 * next to titles the agent or shell set on its own. Such a title counts only
 * on a terminal running an agent (`hasAgent`), and only by shape: one word
 * once the agent's status glyph (`✳ `, `◑ `) and a trailing ` | <folder>`
 * are taken off. Several words (an agent's summary of the task), a shell's or
 * agent's name, a path or prompt, the terminal's own folder or a wmux
 * coordinate is not a name.
 */
export function terminalManualName(surface: TitledSurface, hasAgent: boolean): string | undefined {
  const flat = (surface.title ?? '').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  if (surface.titleLocked) return flat;
  if (!hasAgent) return undefined;
  const name = flat.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+\|\s.*$/, '').trim();
  if (!name || /\s/.test(name) || NOT_A_NAME.test(name)) return undefined;
  if (isBareShellTitle(name) || AGENT_SLUG_SET.has(name.toLowerCase()) || AUTO_NAME_SHAPE.test(name)) return undefined;
  const folder = (surface.cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
  if (folder && name.toLowerCase() === folder.toLowerCase()) return undefined;
  return name;
}

/**
 * How an A2A party is named in the message a receiving agent reads:
 * `<workspace>.<name>` (e.g. `Simply.release`), so a terminal can tell which
 * terminal of a workspace is talking. The name is the one the terminal holding
 * `ptyId` was given (terminalManualName), else the pane's wmux label, else the
 * pane's coordinate with that terminal's agent. In a pane with several tabs the
 * label and the coordinate carry the tab's number, so two tabs never read the
 * same. A terminal's own name is used only while no other terminal of the
 * workspace reads the same and no pane label spells it, so a title cannot pass
 * for another party. Display only: never an address. Falls back to the bare
 * workspace name when the pane is unknown (an unverified sender, a pty that no
 * open pane holds).
 */
export function a2aPartyName(
  ws: WorkspacePaneOwner & { name: string; wsOrdinal?: number },
  paneLabel: Record<string, string> | undefined,
  surfaceAgent: Record<string, { slug?: AgentSlug }> | undefined,
  ptyId?: string,
): string {
  if (!ptyId) return ws.name;
  const leaves = getWorkspaceLeafPanes(ws);
  const leaf = leaves.find((l) => l.surfaces.some((s) => s.ptyId === ptyId));
  if (!leaf) return ws.name;
  const labelOf = (l: PaneLeaf): string | undefined => (paneLabel?.[l.id] ?? l.metadata?.label)?.trim() || undefined;
  const ownName = (s: Surface): string | undefined => terminalManualName(s, !!(s.ptyId && surfaceAgent?.[s.ptyId]?.slug));
  const index = leaf.surfaces.findIndex((s) => s.ptyId === ptyId);
  const own = ownName(leaf.surfaces[index]);
  if (own) {
    const key = own.toLowerCase();
    const taken = leaves.some((l) =>
      labelOf(l)?.toLowerCase() === key
      || l.surfaces.some((s) => s.ptyId !== ptyId && ownName(s)?.toLowerCase() === key));
    if (!taken) return sanitizeA2aName(`${ws.name}.${own}`);
  }
  // This terminal's agent, not the pane's active tab: the party may be a
  // background tab.
  const slug = surfaceAgent?.[ptyId]?.slug;
  const tab = leaf.surfaces.length > 1 ? `.${index + 1}` : '';
  const label = labelOf(leaf);
  const name = label
    ? `${label}${tab}`
    : computePaneAutoName(ws.wsOrdinal ?? 0, leaf.ordinal ?? 0) + tab + (slug ? `(${slug})` : '');
  return sanitizeA2aName(`${ws.name}.${name.replace(UNSAFE_CHARS, ' ')}`);
}
