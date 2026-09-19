// Runs in wmux's Windows Node runtime. The WSL launcher supplies config text
// over stdin; Windows must never interpret a Linux filename as a host path.
// Packaged with smol-toml by scripts/copy-bridge.mjs.
import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';

function hasNotify(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key === 'notify' || hasNotify(child));
}

try {
  const [hook, ...args] = process.argv.slice(2);
  if (hook === '--notification') {
    // Line 1: the validated thread ID. Line 2: the payload reduced to the
    // fields wmux-codex-notify.mjs reads, small enough for a Windows argv.
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    const id = payload['thread-id'];
    if (payload.type !== 'agent-turn-complete' || typeof id !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) process.exit(1);
    const reduced = { type: payload.type, 'thread-id': id };
    if (typeof payload['turn-id'] === 'string') reduced['turn-id'] = payload['turn-id'];
    if (typeof payload.cwd === 'string') reduced.cwd = payload.cwd;
    process.stdout.write(`${id}\n${JSON.stringify(reduced)}`);
    process.exit(0);
  }
  if (hook === '--is-resumable') {
    const record = JSON.parse(readFileSync(0, 'utf8'));
    const meta = record.payload;
    process.exit(record.type === 'session_meta' && (meta?.id ?? meta?.session_id) === args[0]
      && meta.source === 'cli' && (!meta.thread_source || meta.thread_source === 'user') ? 0 : 1);
  }
  const configs = readFileSync(0, 'utf8').split('\0').filter(Boolean);
  // Be conservative about profiles and untrusted project layers: if any could
  // own notify, leave Codex to resolve them. Never replace a user's notifier.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    let override;
    if (arg === '-c' || arg === '--config') override = args[++i] ?? '';
    else if (arg.startsWith('--config=')) override = arg.slice('--config='.length);
    else if (arg.startsWith('-c') && arg.length > 2) override = arg.slice(2);
    if (override !== undefined) {
      // Codex accepts unquoted string values (-c model=o3). Only the key is
      // needed here; parsing its TOML spelling handles quoted/dotted keys too.
      const equal = override.indexOf('=');
      if (equal < 0) process.exit(1);
      configs.push(`${override.slice(0, equal)}=0`);
    }
  }
  if (!hook || configs.some(config => hasNotify(parse(config)))) process.exit(1);
  process.stdout.write(`notify=${JSON.stringify(['/bin/sh', hook])}`);
} catch {
  // Missing/unreadable/malformed configuration is not permission to overwrite
  // it. Print no config contents, and let the original Codex command handle it.
  process.exitCode = 1;
}
