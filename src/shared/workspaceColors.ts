// === Workspace accent colors ===
// A workspace can carry an optional color tag. It is a PURELY VISUAL label:
// it never encodes agent state, git state, or anything the app computes.
// Those signals already own the status dot / git lights / badges, and
// overloading them would make two different meanings share one channel.
//
// Why a fixed id set and not a free-form hex: the sidebar renders on top of
// every theme (dark and light). A user-picked "#111111" is invisible on the
// dark themes and a "#ffff00" is unreadable on the light ones. A curated set
// of eight mid-tone hues stays legible everywhere and keeps the persisted
// session data trivially validatable — see normalizeWorkspaceColor, which is
// the single load/save boundary that drops anything unknown.

export const WORKSPACE_COLOR_IDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
] as const;

export type WorkspaceColorId = (typeof WORKSPACE_COLOR_IDS)[number];

/**
 * Mid-tone hues, contrast-checked against both the darkest (#11111b-ish) and
 * the lightest (#eff1f5-ish) bundled theme backgrounds. Kept as literal hex
 * rather than `var(--accent-*)` on purpose: the theme accents are only four
 * (blue/green/yellow/red) and they are re-tinted per theme, so a workspace
 * tagged "green" would silently change identity when the user switches theme.
 * The color tag must be stable — it is the whole point of the feature.
 */
export const WORKSPACE_COLOR_HEX: Record<WorkspaceColorId, string> = {
  red: '#e05a5a',
  orange: '#e08a3c',
  yellow: '#d9b23c',
  green: '#4fa86a',
  teal: '#3aa6a0',
  blue: '#4a8fe0',
  purple: '#8f6fd6',
  pink: '#d466a8',
};

/** i18n key for a color's human label, e.g. `workspace.color.blue`. */
export function workspaceColorLabelKey(id: WorkspaceColorId): string {
  return `workspace.color.${id}`;
}

/**
 * Load/save boundary. Accepts anything (session JSON is user-editable and
 * older/newer builds may carry ids this build does not know) and returns
 * either a valid id or undefined — never throws, never keeps an unknown value.
 */
export function normalizeWorkspaceColor(value: unknown): WorkspaceColorId | undefined {
  if (typeof value !== 'string') return undefined;
  return (WORKSPACE_COLOR_IDS as readonly string[]).includes(value)
    ? (value as WorkspaceColorId)
    : undefined;
}

/** CSS color for a workspace's tag, or undefined when it carries no tag. */
export function workspaceColorHex(value: unknown): string | undefined {
  const id = normalizeWorkspaceColor(value);
  return id ? WORKSPACE_COLOR_HEX[id] : undefined;
}
