// The codex bot-worker guard's pure parts: the launch-line allowlist, the
// line main rebuilds, and the rules document. When a codex CLI is installed,
// the rules are also checked by Codex's own `execpolicy check`.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_WORKER_JUSTIFICATION_PREFIX,
  CODEX_WORKER_APPROVED_TOOLS,
  CODEX_WORKER_REFUSED_TOOLS,
  buildCodexWorkerLaunchLine,
  buildCodexWorkerRules,
  codexConnectorRefusal,
  codexWorkerMcpWords,
  codexWorkerToolApprovals,
  codexWorkerWritableRoots,
  codexVersionAtLeastFloor,
  namesCodex,
  parseCodexVersion,
  parseCodexWorkerLine,
} from '../codexWorkerGuard';
import { codexTrustOverride } from '../fanoutPreset';
import { FANOUT_WORKER_DISALLOWED_TOOLS, MODEL_ENV_MARKER } from '../workerLaunch';
import type { Connector } from '../botConnector';

const CWD = '/data/worktrees/abc/feat-x-1234';
const PROMPT = `"$(cat '/data/worktrees/.meta/feat-x-1234/prompt.md')"`;
const TRUST = codexTrustOverride(CWD, 'darwin')!;
const FANOUT_LINE = `codex ${TRUST} -a never -s workspace-write --model gpt-6.1-sol -c model_reasoning_effort=low ${PROMPT}`;

describe('the codex worker launch line: an allowlist', () => {
  it('accepts the fan-out line and keeps model, effort, tool level and prompt', () => {
    expect(parseCodexWorkerLine(FANOUT_LINE, CWD)).toEqual({ model: 'gpt-6.1-sol', effort: 'low', promptArgument: PROMPT });
    expect(parseCodexWorkerLine(`codex ${TRUST} ${PROMPT}`, CWD)).toEqual({ promptArgument: PROMPT });
    const tools = `codex ${TRUST} -c "mcp_servers.wmux.args=['/a/index.js','--core']" ${PROMPT}`;
    expect(parseCodexWorkerLine(tools, CWD)).toEqual({ wmuxTools: { tools: 'core' }, promptArgument: PROMPT });
  });

  it('keeps only the wmux tool level from the line, and writes the server with main\'s own entry', () => {
    const level = (args: string) => parseCodexWorkerLine(`codex ${TRUST} -c "mcp_servers.wmux.args=[${args}]" ${PROMPT}`, CWD)?.wmuxTools;
    expect(level("'/evil.js'")).toEqual({ tools: 'full' });
    expect(level("'/evil.js','--role=Builder'")).toEqual({ tools: 'role', role: 'Builder' });
    expect(level("'/evil.js','--role=Nobody'")).toBeUndefined();
    expect(level("'/evil.js','--core','--x'")).toBeUndefined();
    const parsed = parseCodexWorkerLine(`codex ${TRUST} -c "mcp_servers.wmux.args=['/evil.js','--core']" ${PROMPT}`, CWD)!;
    const built = buildCodexWorkerLaunchLine(parsed, CWD, ['/repo/.git'], { mcpEntry: '/app/mcp/index.js' })!;
    expect(built).toContain(`-c "mcp_servers.wmux.args=['/app/mcp/index.js','--core']"`);
    expect(built).not.toContain('/evil.js');
    expect(buildCodexWorkerLaunchLine(parsed, CWD, ['/repo/.git'])).toBeNull();
  });

  it.each([
    ['a bypass flag', `codex ${TRUST} --yolo ${PROMPT}`],
    ['the bypass flag', `codex ${TRUST} --dangerously-bypass-approvals-and-sandbox ${PROMPT}`],
    ['an extra writable dir', `codex ${TRUST} --add-dir / ${PROMPT}`],
    ['a feature switch', `codex ${TRUST} --enable foo ${PROMPT}`],
    ['a sandbox config override', `codex ${TRUST} -c sandbox_mode=danger-full-access ${PROMPT}`],
    ['an approval config override', `codex ${TRUST} -c approval_policy=never ${PROMPT}`],
    ['another sandbox', `codex ${TRUST} -s danger-full-access ${PROMPT}`],
    ['another approval', `codex ${TRUST} -a on-request ${PROMPT}`],
    ['a duplicate -s', `codex ${TRUST} -s workspace-write -s workspace-write ${PROMPT}`],
    ['a duplicate -a', `codex ${TRUST} -a never -a never ${PROMPT}`],
    ['a subcommand', `codex resume --last`],
    ['exec', `codex exec ${TRUST} ${PROMPT}`],
    ['a profile', `codex ${TRUST} -p other ${PROMPT}`],
    ['no trust override', `codex -a never ${PROMPT}`],
    ['another folder\'s trust', `codex ${codexTrustOverride('/elsewhere', 'darwin')} ${PROMPT}`],
    ['a chained command', `codex ${TRUST} ${PROMPT}; rm -f x`],
    ['a command before', `cd /tmp && codex ${TRUST} ${PROMPT}`],
    ['a flag-shaped model', `codex ${TRUST} --model --yolo ${PROMPT}`],
    ['a substitution in a flag', `codex ${TRUST} --model "$(echo x)" ${PROMPT}`],
    ['no prompt argument', `codex ${TRUST}`],
    ['a launcher path', `/usr/local/bin/codex ${TRUST} ${PROMPT}`],
  ])('refuses %s', (_why, line) => {
    expect(parseCodexWorkerLine(line, CWD)).toBeNull();
  });

  it('reads past wmux\'s own model-env marker, and leaves it out of the rebuilt line', () => {
    const parsed = parseCodexWorkerLine(MODEL_ENV_MARKER + FANOUT_LINE, CWD)!;
    expect(parsed).toEqual(parseCodexWorkerLine(FANOUT_LINE, CWD));
    expect(buildCodexWorkerLaunchLine(parsed, CWD, ['/repo/.git'])!.startsWith('codex ')).toBe(true);
  });

  it('refuses a worktree path it cannot write as one word', () => {
    expect(parseCodexWorkerLine(FANOUT_LINE.replace(CWD, "/a'b"), "/a'b")).toBeNull();
  });

  it('rebuilds the line with main\'s own sandbox, approval, writable roots and network', () => {
    const parsed = parseCodexWorkerLine(FANOUT_LINE, CWD)!;
    const line = buildCodexWorkerLaunchLine(parsed, CWD, ['/repo/.git/worktrees/x', '/repo/.git'])!;
    expect(line).toBe(
      `codex ${TRUST} -a never -s workspace-write -c 'sandbox_workspace_write.writable_roots=["/repo/.git/worktrees/x","/repo/.git"]' ` +
      `-c sandbox_workspace_write.network_access=true --model gpt-6.1-sol -c model_reasoning_effort=low -C '${CWD}' -- ${PROMPT}`,
    );
    expect(buildCodexWorkerLaunchLine(parsed, CWD, [])).toBeNull();
    expect(buildCodexWorkerLaunchLine(parsed, CWD, ['/a$b'])).toBeNull();
  });

  it('approves exactly the wmux tools a Claude bot worker may call, and asks for every other', () => {
    const claudeDenied = (t: string) => FANOUT_WORKER_DISALLOWED_TOOLS.some((r) => (r.endsWith('*') ? `mcp__wmux__${t}`.startsWith(r.slice(0, -1)) : r === `mcp__wmux__${t}`));
    expect(CODEX_WORKER_APPROVED_TOOLS.some(claudeDenied)).toBe(false);
    expect(CODEX_WORKER_REFUSED_TOOLS.every((t) => claudeDenied(t) || t.startsWith('repl_'))).toBe(true);
    for (const t of ['channel_post', 'ledger_update', 'task_push', 'a2a_whoami']) expect(CODEX_WORKER_APPROVED_TOOLS).toContain(t);
    for (const t of ['browser_open', 'browser_hover', 'terminal_send', 'send_message', 'a2a_task_send', 'fanout_start', 'pane_split', 'repl_run', 'repl_reset', 'repl_sessions']) expect(CODEX_WORKER_REFUSED_TOOLS).toContain(t);
    expect(CODEX_WORKER_APPROVED_TOOLS.filter((t) => t.startsWith('repl_'))).toEqual([]);
    const [ask, table] = codexWorkerToolApprovals(['browser_open', 'computer', 'ledger_update', 'bad name']);
    expect(ask).toBe('-c mcp_servers.wmux.default_tools_approval_mode=prompt');
    expect(table).toContain('computer={approval_mode="prompt"}');
    expect(table).toContain('ledger_update={approval_mode="approve"}');
    expect(table).not.toContain('bad name');
    expect(table.match(/browser_open=/g)).toHaveLength(1);
  });

  it('lets a worker write what a commit writes, never the repository config, hooks or info', () => {
    const roots = codexWorkerWritableRoots('/r/.git/worktrees/x', '/r/.git')!;
    expect(roots).toEqual(['/r/.git/worktrees/x', '/r/.git/objects', '/r/.git/refs', '/r/.git/logs', '/r/.git/packed-refs', '/r/.git/packed-refs.lock']);
    expect(roots).not.toContain('/r/.git');
    expect(codexWorkerWritableRoots('/r/.git', '/r/.git/')).toBeNull();
  });

  it('reads back the line it built (a re-fire), and a resume of it', () => {
    const parsed = parseCodexWorkerLine(FANOUT_LINE, CWD)!;
    const built = buildCodexWorkerLaunchLine(parsed, CWD, ['/repo/.git'])!;
    expect(parseCodexWorkerLine(built, CWD)).toEqual(parsed);
    const id = '11111111-2222-3333-4444-555555555555';
    const resume = built.replace(/^codex /, `codex resume ${id} `).replace(/ -- "\$\(cat .*$/, '');
    const back = parseCodexWorkerLine(resume, CWD, { resume: true })!;
    expect(back).toEqual({ model: 'gpt-6.1-sol', effort: 'low', resumeId: id, promptArgument: '' });
    expect(buildCodexWorkerLaunchLine(back, CWD, ['/repo/.git'])).toBe(resume);
    // Only a session line may resume, and only a plausible id; never another folder's -C.
    expect(parseCodexWorkerLine(resume, CWD)).toBeNull();
    expect(parseCodexWorkerLine(resume.replace(id, 'not-a-uuid'), CWD, { resume: true })).toBeNull();
    expect(parseCodexWorkerLine(`${resume} --yolo`, CWD, { resume: true })).toBeNull();
    expect(parseCodexWorkerLine(resume.replace(`-C '${CWD}'`, "-C '/elsewhere'"), CWD, { resume: true })).toBeNull();
    expect(parseCodexWorkerLine(resume.replace("writable_roots=[\"/repo/.git\"]", "writable_roots=[\"/\",\"$HOME\"]"), CWD, { resume: true })).toBeNull();
  });

  it('reads back the tool approvals it added, and no approval of a tool a Claude worker is denied', () => {
    const parsed = parseCodexWorkerLine(FANOUT_LINE, CWD)!;
    const built = buildCodexWorkerLaunchLine(parsed, CWD, ['/repo/.git'], { toolApprovals: { ownerApproved: ['computer', 'browser-extra'] } })!;
    expect(built).toContain(' -c mcp_servers.wmux.default_tools_approval_mode=prompt ');
    expect(parseCodexWorkerLine(built, CWD)).toEqual(parsed);
    // Asking for a tool is always accepted back; approving a denied one never is.
    expect(parseCodexWorkerLine(built.replace('terminal_send={approval_mode="prompt"}', 'terminal_send={approval_mode="approve"}'), CWD)).toBeNull();
    expect(parseCodexWorkerLine(built.replace('computer={approval_mode="prompt"}', 'computer={approval_mode="approve"}'), CWD)).toBeNull();
    expect(parseCodexWorkerLine(built.replace('browser-extra={approval_mode="prompt"}', 'browser-extra={approval_mode="approve"}'), CWD)).toBeNull();
    expect(parseCodexWorkerLine(built.replace('ledger_update={approval_mode="approve"}', 'ledger_update={approval_mode="approve"},ledger_update={approval_mode="approve"}'), CWD)).toBeNull();
    expect(parseCodexWorkerLine(built.replace('default_tools_approval_mode=prompt', 'default_tools_approval_mode=approve'), CWD)).toBeNull();
    const twice = built.replace(' -C ', ' -c mcp_servers.wmux.default_tools_approval_mode=prompt -C ');
    expect(parseCodexWorkerLine(twice, CWD)).toBeNull();
  });

  it('reads the resume chip\'s own lines, and never a fresh launch without its prompt', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(parseCodexWorkerLine(`codex resume ${id}`, CWD, { resume: true })).toEqual({ resumeId: id, promptArgument: '' });
    expect(parseCodexWorkerLine(`codex --model gpt-6.1-sol resume ${id}`, CWD, { resume: true })).toEqual({ model: 'gpt-6.1-sol', resumeId: id, promptArgument: '' });
    expect(parseCodexWorkerLine(`codex resume ${id} resume ${id}`, CWD, { resume: true })).toBeNull();
    expect(parseCodexWorkerLine(`codex ${TRUST}`, CWD, { resume: true })).toBeNull();
    expect(parseCodexWorkerLine(`codex ${TRUST} --`, CWD, { resume: true })).toBeNull();
  });

  it('round-trips the operator\'s wmux tool level, and refuses an unterminated quote or an escape', () => {
    const tools = `codex ${TRUST} -c "mcp_servers.wmux.args=['/a/index.js','--core']" ${PROMPT}`;
    const parsed = parseCodexWorkerLine(tools, CWD)!;
    const built = buildCodexWorkerLaunchLine(parsed, CWD, ['/repo/.git'], { mcpEntry: '/a/index.js' })!;
    expect(parseCodexWorkerLine(built, CWD)).toEqual(parsed);
    expect(parseCodexWorkerLine(`codex ${TRUST} -C '${CWD} ${PROMPT}`, CWD)).toBeNull();
    expect(parseCodexWorkerLine(`codex ${TRUST} --model gpt\\x ${PROMPT}`, CWD)).toBeNull();
  });

  it('names codex anywhere on a line', () => {
    expect(namesCodex('codex resume --last')).toBe(true);
    expect(namesCodex('cd /w && codex')).toBe(true);
    expect(namesCodex('claude --resume x')).toBe(false);
    expect(namesCodex('codex; :')).toBe(true);
    expect(namesCodex('true&&codex')).toBe(true);
    expect(namesCodex('/opt/bin/codex resume')).toBe(true);
    expect(namesCodex('git log --grep codexy')).toBe(false);
  });

  it('reads the version and holds the measured floor', () => {
    expect(parseCodexVersion('codex-cli 0.162.1\n')).toEqual([0, 162, 1]);
    expect(parseCodexVersion('nope')).toBeNull();
    expect(codexVersionAtLeastFloor([0, 162, 1])).toBe(true);
    expect(codexVersionAtLeastFloor([0, 163, 0])).toBe(true);
    expect(codexVersionAtLeastFloor([0, 162, 0])).toBe(false);
    expect(codexVersionAtLeastFloor([0, 99, 9])).toBe(false);
  });
});

describe('the codex worker\'s MCP servers: wmux and its task\'s connections', () => {
  const con = (over: Partial<Connector> = {}): Connector => ({
    id: 'con-0000000a', name: 'gh', transport: 'http',
    remote: { url: 'https://api.example.com/mcp/readonly?x=1&y=2', headers: { 'X-MCP-Readonly': 'true' } },
    secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }],
    tools: { mode: 'all', blocked: ['merge_pull_request'] },
    scope: { kind: 'all' }, offFor: [], enabled: true, createdAt: 1, updatedAt: 1, ...over,
  });
  const files = con({
    id: 'con-0000000b', name: 'files', transport: 'stdio', remote: undefined,
    stdio: { command: '/usr/local/bin/npx', args: ['-y', 'pkg@1.0.0', '/data'], env: { LOG_LEVEL: 'info' } },
    secrets: [{ secret: 'FILES_API_TOKEN', as: 'env' }],
    tools: { mode: 'listed', allowed: ['read_file'] },
  });
  const input = (connectors: Connector[], ownerServers: string[] = ['wmux', 'node_repl', 'openaiDeveloperDocs']) => ({
    ownerServers, connectors, runDir: (c: Connector) => `/d/factory/connector-run/${c.id}`, npmrc: (c: Connector) => `/d/factory/connector-run/${c.id}/npmrc`,
  });

  it('turns apps, plugins and every owner server but wmux off, and writes each connection as one table naming its keys only', () => {
    const words = codexWorkerMcpWords(input([con(), files]))!;
    expect(words.slice(0, 4)).toEqual([
      '-c features.apps=false', '-c features.plugins=false',
      '-c mcp_servers.node_repl.enabled=false', '-c mcp_servers.openaiDeveloperDocs.enabled=false',
    ]);
    expect(words[4]).toBe(`-c 'mcp_servers.gh={"url"="https://api.example.com/mcp/readonly?x=1&y=2","http_headers"={"X-MCP-Readonly"="true"},`
      + `"bearer_token_env_var"="GH_MCP_TOKEN","default_tools_approval_mode"="approve","disabled_tools"=["merge_pull_request"]}'`);
    expect(words[5]).toBe(`-c 'mcp_servers.files={"command"="/usr/bin/env","args"=["-C","/d/factory/connector-run/con-0000000b","/usr/local/bin/npx","-y","pkg@1.0.0","/data"],`
      + `"env"={"LOG_LEVEL"="info","npm_config_userconfig"="/d/factory/connector-run/con-0000000b/npmrc","npm_config_registry"="https://registry.npmjs.org/"},`
      + `"env_vars"=["FILES_API_TOKEN"],"default_tools_approval_mode"="approve","enabled_tools"=["read_file"]}'`);
    // A raw header key goes by name too.
    const raw = codexWorkerMcpWords(input([con({ secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header', header: 'X-Api-Key', scheme: 'raw' }] })]))!;
    expect(raw[4]).toContain('"env_http_headers"={"X-Api-Key"="GH_MCP_TOKEN"}');
    expect(raw[4]).not.toContain('bearer_token_env_var');
    expect(codexWorkerMcpWords(input([], []))).toEqual(['-c features.apps=false', '-c features.plugins=false']);
  });

  it('refuses what it cannot write: an owner server named like a connection or not by a bare key, SSE, Bearer outside Authorization, a quote', () => {
    expect(codexWorkerMcpWords(input([con()], ['gh']))).toBeNull();
    expect(codexWorkerMcpWords(input([], ['my server']))).toBeNull();
    expect(codexWorkerMcpWords(input([con({ transport: 'sse' })]))).toBeNull();
    expect(codexConnectorRefusal(con({ transport: 'sse' }))).toMatch(/SSE/);
    const elsewhere = con({ secrets: [{ secret: 'GH_MCP_TOKEN', as: 'header', header: 'X-Api-Key', scheme: 'bearer' }] });
    expect(codexConnectorRefusal(elsewhere)).toMatch(/Authorization/);
    expect(codexWorkerMcpWords(input([elsewhere]))).toBeNull();
    expect(codexWorkerMcpWords(input([con({ remote: { url: "https://x.dev/it's", headers: {} } })]))).toBeNull();
    expect(codexWorkerMcpWords(input([con({ remote: { url: 'https://x.dev/a\\b', headers: {} } })]))).toBeNull();
    expect(codexConnectorRefusal(con())).toBeNull();
  });

  it('a re-fire reads back the words it added and rebuilds them from its own records; it never takes a wmux table', () => {
    const parsed = parseCodexWorkerLine(FANOUT_LINE, CWD)!;
    const mcpWords = codexWorkerMcpWords(input([con(), files]))!;
    const built = buildCodexWorkerLaunchLine(parsed, CWD, ['/repo/.git'], { mcpWords })!;
    expect(built).toContain(` ${mcpWords.join(' ')} -C '${CWD}' -- `);
    expect(parseCodexWorkerLine(built, CWD)).toEqual(parsed);
    expect(buildCodexWorkerLaunchLine(parseCodexWorkerLine(built, CWD)!, CWD, ['/repo/.git'], { mcpWords })).toBe(built);
    const twice = built.replace(mcpWords[4], `${mcpWords[4]} ${mcpWords[4]}`);
    expect(parseCodexWorkerLine(twice, CWD)).toBeNull();
    const wmux = built.replace(mcpWords[4], `-c 'mcp_servers.wmux={"command"="/bin/sh"}'`);
    expect(parseCodexWorkerLine(wmux, CWD)).toBeNull();
  });
});

describe('the codex worker rules', () => {
  const rules = buildCodexWorkerRules({ repoKey: 'acme/app', cwd: CWD, gitDirs: ['/repo/.git'] });

  it('every rule forbids, and says why in words the model reads', () => {
    const lines = rules.split('\n').filter((l) => l.startsWith('prefix_rule('));
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) {
      expect(l).toContain('decision="forbidden"');
      expect(l).toContain(`justification="${CODEX_WORKER_JUSTIFICATION_PREFIX} `);
    }
    expect(rules).toContain('["git", "push"]');
    expect(rules).toContain('["gh", "api"]');
    expect(rules).toContain('"--repo=acme/app"');
    expect(rules).toContain('"--git-dir=/repo/.git"');
  });

  // Codex's own matcher, when a codex CLI is installed here (not in CI).
  const home = process.env.WMUX_TEST_REAL_HOME ?? os.homedir();
  const codex = [path.join(home, '.local', 'node', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'].find((p) => fs.existsSync(p));
  it.skipIf(!codex)('Codex refuses what the rules name and lets the rest through', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-codex-rules-'));
    try {
      const file = path.join(dir, 'w.rules');
      fs.writeFileSync(file, rules);
      const decide = (cmd: string[]): string => {
        const out = JSON.parse(execFileSync(codex!, ['execpolicy', 'check', '--rules', file, ...cmd], { encoding: 'utf8' })) as { decision?: string };
        return out.decision ?? 'none';
      };
      for (const cmd of [
        ['gh', 'pr', 'merge', '3'], ['gh', '-R', 'o/r', 'pr', 'merge', '3'], ['gh', 'pr', '-R', 'o/r', 'merge'], ['gh', '--repo=acme/app', 'pr', 'merge'],
        ['gh', 'api', 'repos/o/r/pulls/3/merge', '-X', 'PUT'], ['gh', 'issue', 'comment', '4'], ['git', 'push', 'origin', 'wtask/a'],
        ['git', '-C', '/w', 'push'], ['git', '-c', 'x=y', 'push'], ['git', 'config', 'remote.origin.pushurl', 'x'], ['git', 'remote', 'set-url', 'origin', 'x'],
        ['git', '--git-dir=/repo/.git', 'push'], ['git', '--no-pager', 'push'], ['git', '-p', 'push'],
        ['git', 'send-pack', 'x', 'HEAD'], ['git', 'http-push', 'x'], ['git', 'remote', 'add', 'o2', 'x'], ['git', 'config', 'alias.p', 'push'],
      ]) expect(decide(cmd), cmd.join(' ')).toBe('forbidden');
      for (const cmd of [['gh', 'pr', 'view', '3'], ['gh', 'pr', 'create', '--fill'], ['git', 'commit', '-m', 'push it'], ['git', 'status'], ['git', 'remote', '-v']]) {
        expect(decide(cmd), cmd.join(' ')).toBe('none');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
