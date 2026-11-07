// #783 — `wmux gate` command: list, add, and remove tools from the permission
// gate. Reads/writes ~/.wmux/config.json directly; the daemon re-reads the gate
// slice per signal (HookIngest.gateConfig is a getter), so changes take effect
// on the next tool call without a daemon restart.

import { failClosedReason, loadConfig, saveConfigOrThrow } from '../../daemon/config';
import { DEFAULT_GATED_TOOLS } from '../../daemon/approvals/gateConfig';

/** Report a gate command that did nothing, and exit non-zero. */
function fail(message: string, jsonMode: boolean, extra: Record<string, unknown> = {}): void {
  if (jsonMode) console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  else console.error(`Error: ${message}`);
  process.exitCode = 1;
}

/**
 * Write the edited config. A config.json that wmux could not use is never
 * written over (see loadConfig), so say so rather than report a change that
 * did not land.
 */
function persist(config: ReturnType<typeof loadConfig>, jsonMode: boolean): boolean {
  try {
    saveConfigOrThrow(config);
    return true;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), jsonMode);
    return false;
  }
}

export function handleGate(action: string, args: string[], jsonMode: boolean): void {
  const config = loadConfig();
  // A stand-in's list is the defaults, not the user's: neither show it as
  // theirs nor answer "already there" from it. Say what is gated meanwhile.
  const standIn = failClosedReason(config);
  if (standIn !== undefined) {
    const enforced = config.gate?.gatedTools ?? [...DEFAULT_GATED_TOOLS];
    fail(
      `${standIn}, so the gate list in it is unknown. Until it is fixed, the default list is gated: ${enforced.join(', ')}. Fix the file, then try again.`,
      jsonMode,
      { enforcedGatedTools: enforced },
    );
    return;
  }
  const gatedTools = config.gate?.gatedTools ?? [...DEFAULT_GATED_TOOLS];

  if (action === '--list' || action === 'list') {
    if (jsonMode) {
      console.log(JSON.stringify({ gatedTools }));
    } else {
      if (gatedTools.length === 0) {
        console.log('Permission gate is EMPTY — every tool passes through.');
        return;
      }
      console.log('Gated tools (high-risk tool calls that prompt the phone):');
      for (const t of gatedTools) console.log(`  ${t}`);
    }
    return;
  }

  if (action === '--add' || action === 'add') {
    const tool = args[0];
    if (!tool) {
      console.error('Error: gate add requires a tool name — e.g. `wmux gate --add WebFetch`');
      process.exit(1);
    }
    if (gatedTools.includes(tool)) {
      if (jsonMode) console.log(JSON.stringify({ ok: true, gatedTools, unchanged: true }));
      else console.log(`"${tool}" is already in the gate list.`);
      return;
    }
    gatedTools.push(tool);
    config.gate = { gatedTools };
    if (!persist(config, jsonMode)) return;
    if (jsonMode) console.log(JSON.stringify({ ok: true, gatedTools }));
    else console.log(`Added "${tool}" to the gate list. Takes effect on the next tool call.`);
    return;
  }

  if (action === '--remove' || action === 'remove') {
    const tool = args[0];
    if (!tool) {
      console.error('Error: gate remove requires a tool name — e.g. `wmux gate --remove Bash`');
      process.exit(1);
    }
    const idx = gatedTools.indexOf(tool);
    if (idx === -1) {
      if (jsonMode) console.log(JSON.stringify({ ok: true, gatedTools, unchanged: true }));
      else console.log(`"${tool}" is not in the gate list.`);
      return;
    }
    gatedTools.splice(idx, 1);
    config.gate = { gatedTools };
    if (!persist(config, jsonMode)) return;
    if (jsonMode) console.log(JSON.stringify({ ok: true, gatedTools }));
    else console.log(`Removed "${tool}" from the gate list. Takes effect on the next tool call.`);
    return;
  }

  console.error(`Unknown gate action: "${action}". Use --list, --add <tool>, or --remove <tool>.`);
  process.exit(1);
}
