// Drift detector: is the wmux Kiro agent still equivalent to kiro_default?
//
// The install ships a wmux-owned agent whose only intended difference from the
// built-in is an empty prompt. That claim is only true for the Kiro version it
// was checked against — a later Kiro can add a field, and our agent would
// silently stop matching. Nothing in CI can catch that (it needs a real
// kiro-cli), so this runs on demand wherever Kiro is installed.
//
// Reads the built-in by materializing it with `kiro-cli agent create --from`,
// which is Kiro's own answer to "what does the default actually contain".
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const KIRO = join(process.env.LOCALAPPDATA ?? '', 'Kiro-Cli', 'kiro-cli.exe');
const dir = mkdtempSync(join(tmpdir(), 'wmux-kiroeq-'));

// Load the real builder rather than restating it, so this compares what ships.
const { buildKiroAgentConfig, INTENDED_DIFFERENCES } = await import(
  pathToFileURL(join(process.cwd(), 'integrations', 'kiro', 'agent', 'wmuxAgent.mjs')).href
);

try {
  const created = spawnSync(KIRO, ['agent', 'create', '--from', 'kiro_default', '--directory', dir, 'probe'], {
    encoding: 'utf8',
  });
  let builtIn;
  try {
    builtIn = JSON.parse(readFileSync(join(dir, 'probe.json'), 'utf8'));
  } catch {
    console.error('could not materialize kiro_default (is kiro-cli installed?):', created.stderr?.slice(0, 300));
    process.exit(2);
  }

  const ours = buildKiroAgentConfig('/bridge.mjs', homedir());

  // Fields we deliberately differ on. Everything else must either match or be
  // absent-with-the-same-effect. The list comes from the module under test, so
  // widening it is a code change someone has to justify.
  const intended = new Set(INTENDED_DIFFERENCES);

  const problems = [];
  for (const [key, value] of Object.entries(builtIn)) {
    if (intended.has(key)) continue;
    const mine = ours[key];
    if (mine === undefined) {
      // Absent is fine only when the built-in's value is itself empty/neutral.
      const neutral = value === null
        || (Array.isArray(value) && value.length === 0)
        || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
      if (!neutral) problems.push(`MISSING  ${key} = ${JSON.stringify(value).slice(0, 160)}`);
      continue;
    }
    if (JSON.stringify(mine) !== JSON.stringify(value)) {
      problems.push(`DIFFERS  ${key}\n    built-in: ${JSON.stringify(value).slice(0, 200)}\n    ours:     ${JSON.stringify(mine).slice(0, 200)}`);
    }
  }
  for (const key of Object.keys(ours)) {
    if (intended.has(key)) continue;
    if (!(key in builtIn)) problems.push(`EXTRA    ${key} — we set something the built-in does not`);
  }

  console.log('built-in keys:', Object.keys(builtIn).join(', '));
  console.log('ours keys:    ', Object.keys(ours).join(', '));
  console.log();
  if (problems.length === 0) {
    console.log('EQUIVALENT — differs only in:', [...intended].join(', '));
  } else {
    console.log(`${problems.length} divergence(s):`);
    for (const p of problems) console.log('  ' + p);
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
