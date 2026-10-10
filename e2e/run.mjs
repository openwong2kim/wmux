// `npm run test:e2e`: build the app, then run e2e/*.e2e.test.mjs with node's
// test runner — under xvfb-run on Linux when there is no display.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ARTIFACTS } from './lib.mjs';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (process.env.WMUX_E2E_SKIP_BUILD !== '1') {
  run('npm', ['run', '-s', 'build:daemon']);
  run('npm', ['run', '-s', 'build:mcp']);
  run('node', ['e2e/build.mjs']);
}
fs.mkdirSync(ARTIFACTS, { recursive: true });
const files = fs.readdirSync(path.join(ROOT, 'e2e')).filter((f) => f.endsWith('.e2e.test.mjs')).map((f) => path.join('e2e', f));
const testArgs = ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files];
if (process.platform === 'linux' && !process.env.DISPLAY) run('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24', 'node', ...testArgs]);
else run('node', testArgs);
