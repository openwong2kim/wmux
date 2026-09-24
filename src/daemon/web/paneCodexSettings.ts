import path from 'node:path';
import {agentDisplayToSlug} from '../../shared/agentIdentity';
import { createHash } from 'node:crypto';
import type { ManagedSession } from '../DaemonSessionManager';
import { LiveSettingsError, readCodexLiveSettings, updateCodexLiveSettings } from './codexLiveSettings';
import { connectCodexSettings } from './codexSettingsTransport';
import type { CodexTuiSelection } from './codexTuiSelection';

interface PaneSettingsDependencies {
  session(id: string): ManagedSession | undefined;
  agentName(id: string): string | null | undefined;
  /** Only the owned live relay registry may supply this; no resume-hook fallback. */
  selection(id: string): (CodexTuiSelection & {relayId:string}) | undefined;
  connect?: (options: Parameters<typeof connectCodexSettings>[0]) => Promise<Pick<Awaited<ReturnType<typeof connectCodexSettings>>, 'rpc' | 'close'>>;
}
export interface PaneSettingsChoice { model: string; effort: string; expectedRevision: string }

/** Resolve account scope from the running pane, not its workspace's next-launch profile. */
export async function paneCodexSettings(deps: PaneSettingsDependencies, id: string,
  authorized: () => boolean | Promise<boolean>, choice?: PaneSettingsChoice) {
  const owned = deps.session(id);
  const unavailable = () => { throw new LiveSettingsError('unavailable'); };
  if (!owned) return unavailable();
  const snapshot = () => {
    const current = deps.session(id);
    const agentName = deps.agentName(id);
    if (current !== owned || (agentDisplayToSlug(agentName ?? '') ?? agentName?.toLowerCase()) !== 'codex') return unavailable();
    const meta = current.meta;
    const binding = deps.selection(id);
    if (!['attached','detached'].includes(meta.state) || meta.wslTarget || !meta.incarnationId ||
        !binding || !binding.relayId || binding.relayId.length > 128 ||
        !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !path.isAbsolute(binding.cwd) || binding.cwd.includes('\0') ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.threadId)) return unavailable();
    // The live server response is the cwd authority for a selected/resumed
    // thread. The connector only opens its account socket; it executes no cwd command.
    const codeHome = meta.env.CODEX_HOME;
    if (codeHome !== undefined && (!path.isAbsolute(codeHome) || codeHome.includes('\0'))) return unavailable();
    return {incarnation:meta.incarnationId,pid:meta.pid,threadId:binding.threadId,cwd:binding.cwd,codeHome,relayId:binding.relayId,generation:binding.generation};
  };
  const initial = snapshot();
  // A copied account can contain identical thread UUIDs/settings. Include the
  // pane incarnation and process/account scope in the phone's opaque revision.
  const scope = createHash('sha256').update(JSON.stringify(initial)).digest('hex');
  const prefix = scope + '.';
  if (choice && (!choice.expectedRevision.startsWith(prefix) ||
      !/^[0-9a-f]{64}$/.test(choice.expectedRevision.slice(prefix.length)))) throw new LiveSettingsError('stale');
  const reauthorize = async () => {
    try { return await authorized() === true; }
    catch { return false; }
  };
  const stillOwned = () => {
    try { return JSON.stringify(snapshot()) === JSON.stringify(initial); }
    catch { return false; }
  };
  const permitted = async () => await reauthorize() && stillOwned();
  if (!await permitted()) return unavailable();
  const connection = await (deps.connect ?? connectCodexSettings)({cwd:initial.cwd,codeHome:initial.codeHome});
  try {
    if (!await permitted()) return unavailable();
    // Recheck every boundary: a pane can close, switch thread, or lose authority
    // while model/list or thread/read is in flight.
    const rpc: typeof connection.rpc = async (method, params) => {
      if (!await permitted()) return unavailable();
      const result = await connection.rpc(method,params);
      if (!await permitted()) return unavailable();
      return result;
    };
    const result = choice
      ? await updateCodexLiveSettings(rpc, initial, {...choice,expectedRevision:choice.expectedRevision.slice(prefix.length)}, stillOwned)
      : await readCodexLiveSettings(rpc, initial);
    if (!await permitted()) return unavailable();
    return {...result,revision:prefix + result.revision};
  } finally { connection.close(); }
}
