/** Explicit live smoke test. Uses a temporary workspace, never a user's thread.
 * --prompt performs one small authenticated turn; otherwise only connects.
 * Output contains counts and states, never credentials or provider output. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexChatAdapter } from '../src/daemon/chat/CodexChatAdapter';
import { OpenCodeChatAdapter } from '../src/daemon/chat/OpenCodeChatAdapter';
import { AcpChatAdapter } from '../src/daemon/chat/AcpChatAdapter';
import { deadline } from '../src/daemon/chat/adapter';
import type { TurnEvent } from '../src/shared/transcript/turnEvents';

async function main() {
  const provider = process.argv[2];
  if (!['codex', 'opencode', 'acp-opencode'].includes(provider)) throw new Error('Choose codex, opencode or acp-opencode');
  const create = () => provider === 'codex' ? new CodexChatAdapter() : provider === 'opencode' ? new OpenCodeChatAdapter() : new AcpChatAdapter('opencode', ['acp']);
  let adapter = create();
  const temporaryCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-chat-probe-'));
  // Explicit diagnostic for cwd-dependent startup/response latency. Tools remain denied.
  const cwd = process.argv.includes('--home') ? os.homedir() : temporaryCwd;
  const startedAt = Date.now();
  const events = new Map<string, TurnEvent>();
  let disconnected = false;
  try {
    const id = await deadline(adapter.connect({ cwd, env: process.env,
      emit: (event) => events.set(event.id, event), request: async () => ({}), disconnected: () => { disconnected = true; },
    }), 30_000);
    if (!id || disconnected) throw new Error('Connection did not remain live');
    if (process.argv.includes('--prompt')) {
      await deadline(adapter.prompt('Reply with exactly WMUX_CHAT_OK. Do not use tools or modify any files.', 'probe-request'), 60_000);
      if (![...events.values()].some((event) => event.kind === 'assistant_text' && !event.thinking && event.text.includes('WMUX_CHAT_OK'))) throw new Error('Expected assistant reply was not projected');
    }
    if (process.argv.includes('--resume')) {
      adapter.close(); adapter = create(); disconnected = false; events.clear();
      const restored = await deadline(adapter.connect({ cwd, env: process.env, sessionId: id, emit: (event) => events.set(event.id, event), request: async () => ({}), disconnected: () => {} }), 30_000);
      if (restored !== id || (process.argv.includes('--prompt') && ![...events.values()].some((event) => event.kind === 'assistant_text' && event.text.includes('WMUX_CHAT_OK')))) throw new Error('History was not restored');
    }
    process.stdout.write(JSON.stringify({ provider, cwdKind: process.argv.includes('--home') ? 'home' : 'temporary', elapsedMs: Date.now() - startedAt, connected: true, resumed: process.argv.includes('--resume'), prompt: process.argv.includes('--prompt'), eventCount: events.size, capabilities: adapter.capabilities }) + '\n');
  } finally { adapter.close(); fs.rmSync(temporaryCwd, { recursive: true, force: true }); }
}
main().catch((error: unknown) => { process.stderr.write((error instanceof Error ? error.message : 'Probe failed') + '\n'); process.exitCode = 1; });
