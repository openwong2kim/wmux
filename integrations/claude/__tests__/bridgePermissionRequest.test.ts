/**
 * `PermissionRequest` → `agent.awaiting_input` on the Claude Code bridge.
 *
 * Claude Code fires `PermissionRequest` when it raises its own permission
 * dialog ("Do you want to proceed?"). Measured on 2.1.281 in a scratch PTY: it
 * lands within half a second of the prompt row (once 54 ms after, once 418 ms
 * before), while `Notification`/`permission_prompt` trails by ~6 s. Mapping it
 * makes the pane read "needs you" without depending on the screen detector.
 *
 * The hazard is stdout. For this event, JSON on stdout is a DECISION (allow /
 * deny) that would answer the dialog for the human. So the real bridge runs as
 * a subprocess against a fake daemon socket, and the test asserts both the
 * signal it sends and that it writes nothing to stdout and exits 0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BRIDGE = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');
const ENTRYPOINT_MARKER = '// Run; never throw upward';

let tmp: string;
let hookToKind: Record<string, string>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'wmux-bridge-permreq-'));
  const src = readFileSync(BRIDGE, 'utf8');
  const cut = src.indexOf(ENTRYPOINT_MARKER);
  expect(cut, 'bridge entrypoint marker').toBeGreaterThan(-1);
  const testable = src.slice(0, cut).replace(/^#![^\n]*\n/, '')
    + '\nexport { HOOK_TO_KIND };\n';
  const mod = path.join(tmp, 'claude-under-test.mjs');
  writeFileSync(mod, testable, 'utf8');
  ({ HOOK_TO_KIND: hookToKind } = await import(pathToFileURL(mod).href));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('claude bridge PermissionRequest', () => {
  it('maps PermissionRequest to agent.awaiting_input', () => {
    expect(hookToKind['PermissionRequest']).toBe('agent.awaiting_input');
  });

  it('is registered in the bundled hooks.json at matcher ""', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'integrations/claude/hooks/hooks.json'), 'utf8'),
    ) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    const groups = manifest.hooks['PermissionRequest'];
    expect(groups).toBeDefined();
    expect(groups.some((g) => g.matcher === '' && g.hooks.some((h) => h.command.endsWith('PermissionRequest')))).toBe(true);
  });

  type Captured = { id: unknown; method: string; params: { kind: string; payload: Record<string, unknown> } };

  /** Run the real bridge for one PermissionRequest against a fake daemon socket. */
  async function runBridge(entrypoint: string | undefined): Promise<{ code: number | null; stdout: string; requests: Captured[] }> {
    const home = mkdtempSync(path.join(tmp, 'home-'));
    mkdirSync(path.join(home, '.wmux'), { recursive: true });
    writeFileSync(path.join(home, '.wmux', 'daemon-auth-token'), 'test-token\n', 'utf8');
    const sock = path.join(home, 'd.sock');

    const requests: Captured[] = [];
    const server: Server = createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl));
        requests.push(req);
        conn.write(JSON.stringify({ id: req.id, ok: true, result: { ok: true } }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));

    const payload = {
      session_id: 's-1',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'od -c /etc/hosts | head -1' },
      permission_mode: 'default',
    };
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [BRIDGE, 'PermissionRequest'], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          WMUX_PIPE_NAME: sock,
          WMUX_PTY_ID: 'pty-1',
          ...(entrypoint ? { CLAUDE_CODE_ENTRYPOINT: entrypoint } : {}),
        },
      });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return { ...result, requests };
  }

  // Unix socket fake daemon; the bridge's Windows transport is a named pipe.
  it.skipIf(process.platform === 'win32')('sends awaiting_input, writes nothing to stdout, exits 0', async () => {
    const { code, stdout, requests } = await runBridge('cli');
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('daemon.hooks.signal');
    expect(requests[0].params.kind).toBe('agent.awaiting_input');
    expect(requests[0].params.payload.hook_event_name).toBe('PermissionRequest');
  });

  // Measured on 2.1.281: `claude -p` fires PermissionRequest with entrypoint
  // `sdk-cli`, and no dialog is on any screen. A nested headless run inherits
  // the host pane's WMUX_PTY_ID, so it must not mark that pane.
  it.skipIf(process.platform === 'win32').each(['sdk-cli', undefined])(
    'sends nothing for a headless session (entrypoint %s)',
    async (entrypoint) => {
      const { code, stdout, requests } = await runBridge(entrypoint);
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(requests).toHaveLength(0);
    },
  );
});
