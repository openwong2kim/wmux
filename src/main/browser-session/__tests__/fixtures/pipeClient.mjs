// A Playwright client in its own process, for CdpPipeWatchdog.chrome.runtime.test.ts:
// the test stops and resumes this process (SIGSTOP / SIGCONT) or keeps it
// healthy while it works. One command per stdin line; one answer per line:
//   page        open a page and load a data: URL         -> "ok page"
//   eval        evaluate on the first page               -> "ok eval <value>"
//   big <n>     n evaluations each returning ~1 MB       -> "ok big"
//   page+big    page and big 8 at once (frames in flight) -> "ok page+big"
//   chatty <kb> the first page logs <kb> KB to the console every 10 ms, a
//               steady stream of events toward this client -> "ok chatty"
// Page errors and unhandled rejections print "error <message>".
import readline from 'node:readline';
import { chromium } from 'playwright-core';

const say = (line) => process.stdout.write(`${line}\n`);
process.on('unhandledRejection', (err) => say(`error ${err instanceof Error ? err.message : String(err)}`));

const browser = await chromium.connectOverCDP(process.argv[2]);
const context = browser.contexts()[0];
const first = await context.newPage();
first.on('pageerror', (err) => say(`error ${err.message}`));
await first.goto('data:text/html,<title>first</title>');

const openPage = async () => {
  const p = await context.newPage();
  p.on('pageerror', (err) => say(`error ${err.message}`));
  await p.goto('data:text/html,<title>next</title>');
  await p.close();
};
const big = async (n) => {
  for (let i = 0; i < n; i++) await first.evaluate(() => 'x'.repeat(1 << 20));
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [command, arg] = line.trim().split(' ');
  const done = (work, label) => work.then((value) => say(`ok ${label}${value === undefined ? '' : ` ${value}`}`), (err) => say(`error ${err.message}`));
  if (command === 'page') done(openPage(), 'page');
  else if (command === 'eval') done(first.evaluate(() => document.title), 'eval');
  else if (command === 'big') done(big(Number(arg) || 1), 'big');
  else if (command === 'page+big') done(Promise.all([openPage(), big(8)]).then(() => undefined), 'page+big');
  else if (command === 'chatty') done(first.evaluate((kb) => { const line = 'x'.repeat(kb * 1024); setInterval(() => console.log(line), 10); }, Number(arg) || 16), 'chatty');
});
say('ready');
