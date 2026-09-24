/**
 * #1490 — the fan-out launch line against a REAL PowerShell.
 *
 * FanOutService.test.ts pins the shape of the win32 line; only a real shell
 * shows what the agent's argv actually receives. Windows PowerShell 5.1 split
 * a prompt at quoted text containing a space (it does not escape embedded `"`
 * for a native command line) and read the BOM-less UTF-8 prompt file in the
 * ANSI code page. The line built by buildInitialCommand is run as-is, with a
 * node stand-in for the agent that records its argv, and the prompt must come
 * through byte-for-byte as one argument with the appended worker flags intact.
 *
 * Runs under powershell.exe (5.1), and under pwsh (7.x) in each
 * `$PSNativeCommandArgumentPassing` mode when pwsh is on PATH (the
 * windows-latest runner has it). Skipped everywhere but Windows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildInitialCommand, WORKER_DELIVERY_PREAMBLE } from '../FanOutService';
import { workerLaunchFlags } from '../../../shared/workerLaunch';

const onWindows = process.platform === 'win32';

// A cold PowerShell start on a loaded runner can take several seconds.
const SHELL_TIMEOUT_MS = 60_000;

function findPwsh(): string | null {
  if (!onWindows) return null;
  try {
    const out = execFileSync('where.exe', ['pwsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? null;
  } catch {
    return null;
  }
}

/** The prompts that broke, or could break, the argument. */
const PROMPTS: Record<string, string> = {
  'quoted text with a space, plus the wmux preamble':
    'Fix the "login page" bug.\nThen report back to the owner.\n' + WORKER_DELIVERY_PREAMBLE,
  'every character PowerShell or the C runtime treats specially':
    [
      `Fix the "login page" bug and the 'single' one.`,
      'Keep $var, $(Get-Date), ${env:PATH} and a `backtick` literal.',
      '한글 프롬프트 — em dash, “curly quotes”.',
      'A path C:\\a b\\ and C:\\x\\"quoted\\" and a "" pair and """ three.',
      '&|<>%PATH% ^caret; {braces} [brackets] @at',
      'line ending in a backslash \\',
      'last line ends with a quote "',
    ].join('\n') + '\n',
  // Whitespace only after an odd number of quotes: 5.1 never wraps this value
  // itself, which is where a `\"`-style escape falls apart.
  'an unbalanced leading quote': '"fix everything in one go\\',
  // One backslash-quote: 6+ does not count a quote after a backslash, so an
  // odd number of them is where a `""`-style escape falls apart there.
  'a single backslash before a quote': 'x" y ""z\\"w 한글 — end\\',
  // No whitespace: no binder wraps it, so nothing may be doubled for a wrap.
  'no whitespace at all': 'a"b\\"c\\',
};

const RECORDER = `require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)), 'utf8');\n`;

describe.skipIf(!onWindows)('fan-out launch line in a real PowerShell (#1490)', { timeout: SHELL_TIMEOUT_MS }, () => {
  let dir: string;
  let recorder: string;

  beforeAll(() => {
    // A space and a single quote in the path: the path quoting is part of the line.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux 1490 it's-"));
    recorder = path.join(dir, 'argv.js');
    fs.writeFileSync(recorder, RECORDER, 'utf8');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Run the built line in `shell` with `prelude` in front, return the recorded argv. */
  function launch(shell: string, prelude: string, prompt: string): string[] {
    const promptPath = path.join(dir, 'prompt.md');
    const outPath = path.join(dir, 'argv.json');
    // Written exactly as FanOutService writes it: UTF-8, no BOM.
    fs.writeFileSync(promptPath, prompt, 'utf8');
    fs.rmSync(outPath, { force: true });
    const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
    const agentCmd = `& ${q(process.execPath)} ${q(recorder)} ${q(outPath)}`;
    // The worker flags go after the prompt argument, as applyWorkerPermissionFlags puts them.
    const line = `${buildInitialCommand(agentCmd, promptPath, 'win32')} ${workerLaunchFlags('auto')}`;
    // -EncodedCommand: the line reaches PowerShell as typed, with no second
    // quoting layer between node and the shell.
    const encoded = Buffer.from(prelude + line, 'utf16le').toString('base64');
    execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(fs.readFileSync(outPath, 'utf8')) as string[];
  }

  const expectedFlags = (workerLaunchFlags('auto').match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ''));

  const shells: Array<[string, string, string]> = [
    ['powershell.exe (5.1)', 'powershell.exe', ''],
    // A profile's strict mode must not turn a garbled prompt into no launch at all.
    ['powershell.exe (5.1), strict mode', 'powershell.exe', 'Set-StrictMode -Version Latest; '],
  ];
  const pwsh = findPwsh();
  if (pwsh) {
    for (const mode of ['Windows', 'Standard', 'Legacy']) {
      shells.push([`pwsh, ${mode} argument passing`, pwsh, `$PSNativeCommandArgumentPassing = '${mode}'; `]);
    }
  }

  for (const [shellName, shell, prelude] of shells) {
    for (const [promptName, prompt] of Object.entries(PROMPTS)) {
      it(`${shellName}: ${promptName} arrives as one exact argument`, () => {
        expect(launch(shell, prelude, prompt)).toEqual([prompt, ...expectedFlags]);
      });
    }
  }
});
