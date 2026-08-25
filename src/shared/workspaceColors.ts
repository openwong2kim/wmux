// === Workspace accent colors ===
// A workspace can carry an optional color tag. It is a PURELY VISUAL label:
// it never encodes agent state, git state, or anything the app computes.
// Those signals already own the status dot / git lights / badges, and
// overloading them would make two different meanings share one channel.
//
// Why a fixed id set and not a free-form hex: the sidebar renders on top of
// every theme (dark and light). A user-picked "#111111" is invisible on the
// dark themes and a "#ffff00" is unreadable on the light ones. A curated set
// of mid-tone hues stays legible everywhere and keeps the persisted
// session data trivially validatable — see normalizeWorkspaceColor, which is
// the single load/save boundary that drops anything unknown.
//
// The original eight (red..pink) shipped in #927. The seven below (amber..
// rose) were added afterward once real usage showed eight tags run out fast
// across a dozen-plus workspaces — each new hue was picked and WCAG-checked
// with the same method as the original set (see WORKSPACE_COLOR_HEX), and
// spaced at least ~15° apart in hue from every existing id so no two tags
// read as "the same color" at a glance. A `slate` candidate was dropped for
// landing only 3° from `blue` — visually indistinguishable, not worth the id.

export const WORKSPACE_COLOR_IDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'amber',
  'lime',
  'mint',
  'cyan',
  'indigo',
  'magenta',
  'rose',
] as const;

export type WorkspaceColorId = (typeof WORKSPACE_COLOR_IDS)[number];

/**
 * Mid-tone hues, contrast-checked against both the darkest (#11111b-ish) and
 * the lightest (#eff1f5-ish) bundled theme backgrounds. Kept as literal hex
 * rather than `var(--accent-*)` on purpose: the theme accents are only four
 * (blue/green/yellow/red) and they are re-tinted per theme, so a workspace
 * tagged "green" would silently change identity when the user switches theme.
 * The color tag must be stable — it is the whole point of the feature.
 *
 * Contrast ratios (WCAG relative luminance) against #11111b / #eff1f5, so a
 * future addition can be checked against the same band the existing set
 * lives in rather than picked by eye:
 *
 *   red 5.16/3.21  orange 7.03/2.36  yellow 9.27/1.79  green 6.38/2.60
 *   teal 6.38/2.60 blue 5.62/2.95    purple 4.83/3.43   pink 5.59/2.96
 *   amber 7.35/2.26 lime 8.11/2.04   mint 7.58/2.19     cyan 6.70/2.48
 *   indigo 5.17/3.21 magenta 4.72/3.52 rose 5.30/3.13
 *
 * `amber` sits at hue ~64° (between yellow's 45° and lime's 83°) rather than
 * nearer orange, where the "amber" name might suggest — orange and yellow are
 * only 16° apart, leaving no room to land a third hue within 12° of both.
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
  amber: '#a1a92d',
  lime: '#8ab93c',
  mint: '#3ab98a',
  cyan: '#3ea6c9',
  indigo: '#6f7fe0',
  magenta: '#c34fc9',
  rose: '#d95f86',
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
