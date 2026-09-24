import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openCodeTerminalChatIntegration } from '../openCodeTerminalChatIntegration';
function fixture(run: (dir: string, options: Parameters<typeof openCodeTerminalChatIntegration>[0]) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-tui-install-'));
  const sourcePath = path.join(dir, 'source.mjs'); fs.writeFileSync(sourcePath, '// wmux-managed: opencode-terminal-chat\n');
  try { run(dir, { configRoot: dir, startDir: dir, sourcePath, install: true, version: '1.18.30' }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
describe('OpenCode TUI installation', () => {
  it('keeps existing settings and plugins, and is idempotent', () => fixture((dir, options) => {
    fs.writeFileSync(path.join(dir, 'tui.json'), JSON.stringify({ theme: 'mine', plugin: ['other-plugin'] }));
    const result = openCodeTerminalChatIntegration(options); expect(result.state).toBe('current');
    const text = fs.readFileSync(result.configPath, 'utf8');
    expect(JSON.parse(text)).toEqual({ theme: 'mine', plugin: ['other-plugin', result.pluginUrl] });
    expect(openCodeTerminalChatIntegration(options).state).toBe('current');
    expect(fs.readFileSync(result.configPath, 'utf8')).toBe(text);
  }));
  it('never rewrites commented, malformed or conflicting configuration', () => fixture((dir, options) => {
    const file = path.join(dir, 'tui.json'); fs.writeFileSync(file, '{ // keep this comment\n}');
    expect(openCodeTerminalChatIntegration(options).state).toBe('manual-config');
    expect(fs.readFileSync(file, 'utf8')).toContain('// keep');
    fs.writeFileSync(file, '{"theme":"mine"}'); fs.writeFileSync(path.join(dir, 'tui.jsonc'), '{}');
    expect(openCodeTerminalChatIntegration(options).state).toBe('manual-config');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"mine"}');
  }));
  it('does not install an unverified API generation or overwrite a foreign asset', () => fixture((dir, options) => {
    expect(openCodeTerminalChatIntegration({ ...options, version: '1.17.0' }).state).toBe('unsupported-version');
    expect(openCodeTerminalChatIntegration({ ...options, version: '2.0.0' }).state).toBe('unsupported-version');
    expect(fs.existsSync(path.join(dir, 'tui.json'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'wmux-chat-tui.mjs'), '// user-owned');
    expect(openCodeTerminalChatIntegration(options).state).toBe('unavailable');
    expect(fs.readFileSync(path.join(dir, 'wmux-chat-tui.mjs'), 'utf8')).toBe('// user-owned');
  }));
});
