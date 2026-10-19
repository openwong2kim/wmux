#!/usr/bin/env node
// fake-codex: the `codex` stand-in for stub factory smoke runs.
//
// Answers what main asks the pane's codex before a bot's codex worker
// launches (main/agents/codexWorkerGuard.ts) and then runs the scripted
// worker (fake-claude.mjs), logged as agent "codex":
//
//   codex --version                          → a version at the guard's floor
//   codex --help / codex features list       → what the pane shell's codex
//      wrapper probes for (--no-daemon, daemon_auto_start), as codex-cli
//      0.162.1 answers, so the wrapper keeps the pane's identity
//   codex execpolicy check --rules <f>… <cmd>  → "forbidden" when a rules file
//      holds a wmux rule whose pattern starts with the command's first two
//      words; exit 1 when a file is not rules (as a real codex refuses a file
//      that does not parse). A stand-in, not Codex's matcher.
//
// Anything else is a worker launch.

import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('codex-cli 0.162.1\n');
  process.exit(0);
}
if (argv[0] === '--help') {
  process.stdout.write('Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon\n');
  process.exit(0);
}
if (argv[0] === 'features' && argv[1] === 'list') {
  process.stdout.write('daemon_auto_start                        stable             true\n');
  process.exit(0);
}
if (argv[0] === 'execpolicy' && argv[1] === 'check') {
  const files = [];
  const cmd = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rules') files.push(argv[++i]);
    else cmd.push(argv[i]);
  }
  const matched = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const m = /^prefix_rule\(pattern=\[(.*)\], decision="(\w+)", justification="([^"]*)"\)$/.exec(line);
      if (!m) {
        process.stderr.write(`Error loading rules: ${f}\n`);
        process.exit(1);
      }
      const head = JSON.parse(`[${m[1]}]`);
      const hit = head.length <= cmd.length && head.every((w, k) => (Array.isArray(w) ? w.includes(cmd[k]) : w === cmd[k]));
      if (hit) matched.push({ prefixRuleMatch: { matchedPrefix: cmd.slice(0, head.length), decision: m[2], justification: m[3] } });
    }
  }
  const decision = matched.some((x) => x.prefixRuleMatch.decision === 'forbidden') ? 'forbidden' : undefined;
  process.stdout.write(`${JSON.stringify({ matchedRules: matched, ...(decision ? { decision } : {}) })}\n`);
  process.exit(0);
}
process.env.FACTORY_E2E_WORKER_AGENT = 'codex';
await import('./fake-claude.mjs');
