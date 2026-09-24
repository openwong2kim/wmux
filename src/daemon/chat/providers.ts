import fs from 'node:fs';
import path from 'node:path';
import { AcpChatAdapter } from './AcpChatAdapter';
import { CodexChatAdapter } from './CodexChatAdapter';
import { OpenCodeChatAdapter } from './OpenCodeChatAdapter';
import { array, record, type ChatProvider } from './adapter';

/** Operator-owned config, never populated from agent output or a repository.
 * No shell interpolation, auto-install, or arbitrary executable IPC. */
export function chatProviders(directory: string): ChatProvider[] {
  const providers: ChatProvider[] = [
    { id: 'codex', name: 'Codex', transport: 'codex', create: () => new CodexChatAdapter() },
    { id: 'opencode', name: 'OpenCode', transport: 'opencode', create: () => new OpenCodeChatAdapter() },
  ];
  const file = path.join(directory, 'chat-providers.json');
  if (!fs.existsSync(file)) return providers;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000) throw new Error('Invalid chat provider configuration');
  const config = record(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (config.version !== 1 || !Array.isArray(config.providers) || config.providers.length > 32) throw new Error('Unsupported chat provider configuration');
  for (const entry of array(config.providers)) {
    const p = record(entry);
    if (typeof p.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(p.id) || providers.some((v) => v.id === p.id) ||
      typeof p.name !== 'string' || p.name.length > 80 || typeof p.command !== 'string' || !path.isAbsolute(p.command) ||
      p.transport !== 'acp' || !Array.isArray(p.args) || p.args.length > 64 || p.args.some((arg: unknown) => typeof arg !== 'string' || arg.length > 4096)) {
      throw new Error('Invalid ACP provider entry');
    }
    const command = p.command; const args = p.args as string[];
    providers.push({ id: p.id, name: p.name, transport: 'acp', create: () => new AcpChatAdapter(command, args) });
  }
  return providers;
}
