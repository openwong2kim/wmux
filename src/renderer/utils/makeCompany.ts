// Making a company workspace: main makes the seats (names, worktrees, briefs,
// launch lines), then the store adds the workspace. Shared by the New company
// dialog and the review of a folder's company from its wmux.json.

import { generateId } from '../../shared/types';
import type { CompanyPresetSeat } from '../../shared/companyPreset';
import { useStore } from '../stores';
import { showWorkspaces } from './showWorkspaces';

export interface MakeCompanyInput {
  name: string;
  /** Absolute folder the company works in; the usual start folder when absent. */
  folder?: string;
  mission: string;
  standingOrders: string;
  ceo: number;
  tellSeats: boolean;
  /** Trimmed. */
  seats: CompanyPresetSeat[];
}

export type MakeCompanyResult = { ok: true } | { ok: false; error: string };

/**
 * Make the company and bring the Workspaces page forward. Resolves null, with
 * nothing added, when `isOpen()` is false once main has made the seats: a
 * company made after its dialog closed is one the user backed out of.
 */
export async function makeCompany(input: MakeCompanyInput, isOpen: () => boolean): Promise<MakeCompanyResult | null> {
  const id = generateId('ws');
  // Main settles each seat's pane name (it holds every label) and writes the
  // briefs with those names.
  const res = await window.electronAPI?.company?.seatLaunches?.({
    workspaceId: id,
    company: input.name,
    mission: input.mission,
    standingOrders: input.standingOrders,
    ceo: input.ceo,
    tellSeats: input.tellSeats,
    ...(input.folder ? { folder: input.folder } : {}),
    seats: input.seats.map((s) => ({ label: s.label, owns: s.owns, ...(s.agent ? { agent: s.agent } : {}) })),
  }).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
  if (!isOpen()) return null;
  if (!res?.ok) return { ok: false, error: res?.error ?? 'unavailable' };
  const ok = useStore.getState().addCompanyWorkspace({
    id,
    name: input.name,
    ...(input.folder ? { cwd: input.folder } : {}),
    mission: input.mission,
    standingOrders: input.standingOrders,
    ceo: input.ceo,
    seats: input.seats.map((s, i) => {
      const cwd = res.cwds[i];
      return { label: res.labels[i], owns: s.owns, command: res.commands[i] ?? null, ...(cwd ? { cwd } : {}) };
    }),
  });
  if (!ok) return { ok: false, error: 'invalid' };
  showWorkspaces(useStore.getState());
  return { ok: true };
}

/** The folder a wmux.json is in: a company read from it works there. */
export function companyFileFolder(configPath: string): string {
  const i = Math.max(configPath.lastIndexOf('/'), configPath.lastIndexOf('\\'));
  if (i < 0) return configPath;
  // A file at a root keeps the root's separator (`/`, `C:\`).
  return i === 0 || configPath[i - 1] === ':' ? configPath.slice(0, i + 1) : configPath.slice(0, i);
}
