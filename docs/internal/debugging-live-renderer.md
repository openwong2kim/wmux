# Debugging the running renderer over CDP

Some bugs only exist against real layout and real terminal state: xterm sizes its
scrollbar from the render service's canvas dimensions and the buffer's line
count, so jsdom and unit tests cannot reproduce them at all. This is how to read
live state out of a running Forge Mux instead of inferring it.

Worked example: fmux#13. The scrollbar's dead full-track slider was pinned by a
CSS override, but which of the three competing hypotheses was true could only be
settled by reading `buffer.lines.length`, `rows`, and the Monaco widget's class
list out of live agent panes.

## 1. Find the instance

The main process opens a Chrome DevTools Protocol port on every launch
(`src/main/index.ts`), on a **random port in 18800–18899**:

```js
cdpPort = 18800 + crypto.randomInt(100);
app.commandLine.appendSwitch('remote-debugging-port', cdpPort.toString());
```

It is skipped entirely when `WMUX_DISABLE_CDP=true`. Because the port is
randomised, probe the range rather than assuming one:

```js
await Promise.all(Array.from({ length: 100 }, (_, i) => 18800 + i).map(async (p) => {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(800) });
    if (r.ok) console.log(p, (await r.json()).Browser);
  } catch { /* nothing listening */ }
}));
```

A dev build and an installed build run side by side and each get their own port.
Tell them apart by the renderer target's URL in `/json/list`:

| Build | Target URL |
| --- | --- |
| dev (`npm start`) | `http://127.0.0.1:5173/` |
| packaged | `file:///…/app.asar/.vite/renderer/…` |

Only the dev build reflects your working tree. It is served by Vite, so renderer
edits hot-reload; `location.reload()` via CDP forces a clean remount.

## 2. Connect and evaluate

Node's global `WebSocket` is enough — no CDP client library:

```js
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = targets.find((t) => t.type === 'page' && /5173|app\.asar/.test(t.url));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression, returnByValue: true, awaitPromise: true },
}));
```

`awaitPromise` matters: it lets an expression `await` a write and settle before
reporting, which is how you measure state after output has been parsed.

## 3. Reach the xterm `Terminal` instances

The renderer deliberately does **not** put terminals on `window` —
`terminalRegistry` in `src/renderer/hooks/useTerminal.ts` is module-local. Reach
them through the React fiber instead: take any `__reactFiber$*` key off a
`.xterm` element, walk to the root, then scan each fiber's `memoizedState` hook
chain for terminal-shaped objects (including `.current`, since most are held in
refs).

```js
const grabTerminals = () => {
  let fiber = null, node = document.querySelector('.xterm');
  while (node && !fiber) {
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
    if (key) fiber = node[key];
    node = node.parentElement;
  }
  const seen = new Set(), found = [];
  const isTerm = (o) => o && typeof o === 'object' && typeof o.rows === 'number'
    && o.buffer?.active && typeof o.write === 'function';
  const walk = (f, d) => {
    if (!f || d > 80 || seen.has(f)) return;
    seen.add(f);
    let h = f.memoizedState, n = 0;
    while (h && n++ < 200) {
      const s = h.memoizedState;
      if (isTerm(s)) found.push(s);
      if (s && typeof s === 'object' && isTerm(s.current)) found.push(s.current);
      h = h.next;
    }
    walk(f.child, d + 1); walk(f.sibling, d + 1);
  };
  let root = fiber; while (root.return) root = root.return;
  walk(root, 0);
  return [...new Set(found)];
};
```

Useful internals from there, beyond the public API:

| Path | Tells you |
| --- | --- |
| `t._core._bufferService.buffer` | `lines.length`, `ydisp`, `ybase` — the real scroll geometry |
| `t._core._renderService.dimensions.css` | `canvas.height`, `cell.height` — what xterm feeds the scrollbar |
| `t._core.coreMouseService` | `activeProtocol`, `activeEncoding`, `areMouseEventsActive` |
| `t._core.coreService.decPrivateModes` | `applicationCursorKeys`, `bracketedPasteMode`, … |

Background workspaces mount hidden panes with zero-height containers. Filter on
`element.getBoundingClientRect().height > 0` before concluding anything from a
measurement, or you will read layout from panes that are not laid out.

## 4. Caveats that will cost you time

**`terminal.write()` targets whichever buffer is active.** Any full-screen TUI —
an agent CLI, `vim`, `less` — runs on the *alternate* buffer, which holds no
scrollback. Writing there does not accumulate (the lines scroll straight out of a
`rows`-sized buffer) and it visibly scribbles over the TUI's display until it
repaints. Check `t.buffer.active.type` first. To generate real scrollback, use a
normal-buffer pane.

**Renderer-side writes do not persist.** `terminal.write()` only touches the
in-memory xterm buffer; it never reaches the PTY, so the daemon ring buffers
under `~/.fmux/buffers` and the `userData/scrollback/*.txt` files never see it.
Convenient for probing, and it means such writes need no cleanup — but it also
means they are not a way to exercise the persistence path.

**Prefer driving the real code path over hand-rolling one.** To exercise mouse
or wheel handling, dispatch a synthetic DOM event at `terminal.element` and let
xterm's own listeners encode it, rather than writing escape sequences yourself —
the encoding depends on whatever protocol the hosted app negotiated.
`src/renderer/terminal/altScrollJog.ts` does exactly this in production code.

**Monaco's pointer drags cannot be simulated naively.** The scrollbar's drag uses
`GlobalPointerMoveMonitor`, which relies on `setPointerCapture` and listens on
the captured element, so `pointermove` dispatched at `document` is ignored. Test
the underlying sync instead: drive `setScrollPositionNow({ scrollTop })` and
assert `ydisp` follows, then call `terminal.scrollToLine()` and assert the
slider's inline `top` follows.
