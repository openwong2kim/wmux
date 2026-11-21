# Drive a wmux Chrome profile from your own script

A script you run in a wmux pane can drive that pane's Chrome with Playwright,
or with any other CDP client. That Chrome uses the pane's own Chrome profile,
or the workspace's if the pane has none. The script reaches it through wmux's
relay rather than a debugging port. It gets a one-time token from
`wmux browser cdp --json`, which you pipe into the script.

```sh
npm install playwright-core   # once, in the script's folder
wmux browser cdp --json | node drive.mjs https://example.com
```

## Conditions

- **macOS or Linux, for now.** On Windows the command is refused: wmux can't
  verify which process asked.
- **Run it from a wmux pane terminal.** The token is for that pane: wmux checks
  that the process asking runs in the pane, and gives it that pane's Chrome.
  You can't name another profile or workspace.
- **The Chrome backend, with the pane's Chrome on the debugging pipe.** A
  protected profile is always on the pipe. Other profiles are on it when wmux
  is started with `WMUX_CHROME_TRANSPORT=pipe`.
- **Target grants on.** This is opt-in for now: start wmux with
  `WMUX_CDP_TARGET_GRANT=1`. Each script then sees only the tabs it opens, not
  the user's or another agent's.
- **One token at a time per pane, for 30 seconds and one connection.** A new
  `wmux browser cdp` replaces the pane's unused token. The command prints the
  token only into a pipe, never to a terminal: a terminal keeps what it shows.
- **A protected profile reaches web pages only** (`http`, `https`, `data:` and
  blank pages), on the hosts its policy allows.
- **On a protected pane, the same consent as for page scripts first.** When
  wmux asks to run a script on that pane, the user chooses Always on this pane.
- **No token while a tab in the workspace is paused or taken over.** Hand the
  tab back first.

wmux ends the connection when what it was granted on goes away:

- the browser policy changes;
- the pane closes or moves to another workspace;
- the workspace closes;
- the user pauses or takes over a browser tab in the workspace;
- the pane's claim is issued anew.

Ask for a new token then.

## The script

The script reads the grant from stdin, never from its arguments or the
environment, where other processes could read it. Before it sends any
command of its own, it checks that the other end is wmux's relay. The grant carries a
proof key that never goes over the connection. The script sends a fresh nonce
as `Wmux.relayProof`, and the relay must answer with
HMAC-SHA256(key, "wmux-relay-proof/v1" + nonce). If wmux opened a blank tab
for the grant to attach through (`bootstrapTargetId`), the script closes it
once attached. With target grants on there is none.

<!-- drive.mjs -->
```js
// drive.mjs: wmux browser cdp --json | node drive.mjs <url>
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chromium } from 'playwright-core';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const grant = JSON.parse(input);

const browser = await chromium.connectOverCDP(grant.endpoint, { headers: grant.headers });
try {
  // Is this wmux's relay? The script sends nothing of its own until it is.
  const session = await browser.newBrowserCDPSession();
  const nonce = randomBytes(32);
  const { proof } = await session.send('Wmux.relayProof', { nonce: nonce.toString('base64url') });
  const want = createHmac('sha256', Buffer.from(grant.proofKey, 'base64url'))
    .update('wmux-relay-proof/v1').update(nonce).digest();
  const got = Buffer.from(String(proof), 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('not the wmux relay');

  if (grant.bootstrapTargetId) {
    await session.send('Target.closeTarget', { targetId: grant.bootstrapTargetId }).catch(() => {});
  }

  // A tab of the script's own.
  const page = await browser.contexts()[0].newPage();
  await page.goto(process.argv[2]);
  console.log(await page.title());
} finally {
  await browser.close();
}
```

## What the token can and can't do

The token is a capability for the pane it was issued to, so treat it like a
password. It is good for 30 seconds, for one connection, and only for that
pane's Chrome. wmux logs one line per grant, with the pane, the profile,
whether it is protected and the transport. The token and the endpoint are
never logged.

An agent of the same user that can type into another pane's terminal can run
`wmux browser cdp` in that pane and use that pane's Chrome. That is the same
reach the input permission already gives it: anything typed into a pane runs
as that pane.
