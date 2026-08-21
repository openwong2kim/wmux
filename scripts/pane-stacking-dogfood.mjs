// Live check for #957 — does the pane actually contain its layering, and does
// the terminal context menu actually open outside the pane?
//
// jsdom cannot answer either question: it has no layout, no stacking, and no
// hit testing, so the unit tests can only pin the class name and the parent
// node. This drives the packaged app over CDP and reads the computed style and
// the real hit test.
//
// No OS-level clicking. Every interaction is an event dispatched inside the
// page, so it cannot land in the wrong window.
//
// Usage: node scripts/pane-stacking-dogfood.mjs <cdp-port>
const PORT = process.argv[2];
if (!PORT) {
  console.error('usage: node scripts/pane-stacking-dogfood.mjs <cdp-port>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rendererTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await res.json();
  // The app window, not a devtools page or the daemon's web view.
  return targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
}

let nextId = 1;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(new Error(`ws error: ${e?.message ?? 'unknown'}`)));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}

/** Evaluate in the page and return the parsed value, surfacing page throws. */
async function evalJson(send, expression) {
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify((() => { ${expression} })())`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return JSON.parse(r.result.value);
}

const results = [];
const record = (name, pass, evidence) => {
  results.push({ name, pass, evidence });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(`        ${evidence}`);
};

(async () => {
  const target = await rendererTarget();
  if (!target) throw new Error('no renderer page target on that port');
  console.log(`[setup] attached to ${target.url}`);
  const { send, ready } = connect(target.webSocketDebuggerUrl);
  await ready;
  await send('Runtime.enable');
  await send('Page.enable');

  // Wait for a pane to exist — a fresh instance boots into one.
  let panes = 0;
  for (let i = 0; i < 40; i++) {
    panes = await evalJson(send, `return document.querySelectorAll('[data-wmux-pane-root]').length;`);
    if (panes > 0) break;
    await sleep(500);
  }
  if (!panes) throw new Error('no pane rendered after 20s');
  console.log(`[setup] ${panes} pane(s) on screen`);

  // A first-run instance opens the onboarding modal over the pane. It is app
  // chrome doing exactly what it should, but it owns the hit test, so dismiss
  // it before asking who is on top. Dispatched in-page by text, never by
  // screen coordinates.
  // A first run stacks SEVERAL of these (onboarding, then the auto-update
  // prompt), so dismiss until none is left rather than once.
  for (let i = 0; i < 6; i++) {
    const step = await evalJson(send, `
      const modal = document.querySelector('div.fixed.inset-0');
      if (!modal) return { modal: false };
      const btn = [...modal.querySelectorAll('button')]
        .find((b) => /skip|later|no thanks|not now|dismiss|close/i.test(b.textContent || ''))
        ?? [...modal.querySelectorAll('button')].pop();
      if (!btn) return { modal: true, clicked: false, text: (modal.textContent || '').trim().slice(0, 60) };
      btn.click();
      return { modal: true, clicked: true, label: (btn.textContent || '').trim().slice(0, 40) };
    `);
    if (!step.modal) break;
    if (!step.clicked) { console.log(`[setup] a modal has no dismiss button: ${step.text}`); break; }
    console.log(`[setup] dismissed a first-run modal via "${step.label}"`);
    await sleep(600);
  }

  // ── 1. The pane root actually creates a stacking context ────────────────
  const iso = await evalJson(send, `
    const el = document.querySelector('[data-wmux-pane-root]');
    const cs = getComputedStyle(el);
    return { isolation: cs.isolation, position: cs.position, zIndex: cs.zIndex };
  `);
  record(
    'pane root creates its own stacking context',
    iso.isolation === 'isolate',
    `computed isolation=${iso.isolation} position=${iso.position} zIndex=${iso.zIndex}`,
  );

  // ── 2. A pane-internal z-index no longer outranks app chrome ────────────
  // Probe rather than assert on a specific component: plant an element inside
  // the pane at the old offending z, and a chrome-level element at the overlay
  // baseline, then ask the browser which one is actually on top. Before the
  // isolation this returned the pane's element.
  const stack = await evalJson(send, `
    const pane = document.querySelector('[data-wmux-pane-root]');
    const r = pane.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);

    const inside = document.createElement('div');
    inside.id = 'wmux-probe-inside';
    Object.assign(inside.style, {
      position: 'fixed', left: x - 40 + 'px', top: y - 20 + 'px',
      width: '80px', height: '40px', zIndex: '9999', background: 'red',
    });
    pane.appendChild(inside);

    const chrome = document.createElement('div');
    chrome.id = 'wmux-probe-chrome';
    Object.assign(chrome.style, {
      position: 'fixed', left: x - 40 + 'px', top: y - 20 + 'px',
      width: '80px', height: '40px',
      zIndex: getComputedStyle(document.documentElement).getPropertyValue('--z-overlay').trim() || '50',
      background: 'lime',
    });
    document.body.appendChild(chrome);

    // Order the two probes against EACH OTHER. Asking who is topmost overall
    // answers a different question — any app chrome above both (a first-run
    // modal at --z-modal) would win and tell us nothing.
    const order = document.elementsFromPoint(x, y)
      .map((e) => e.id)
      .filter((id) => id === 'wmux-probe-inside' || id === 'wmux-probe-chrome');
    inside.remove();
    chrome.remove();
    return { winner: order[0] ?? null, order, x, y };
  `);
  record(
    'a pane-internal z-index cannot outrank app chrome',
    stack.winner === 'wmux-probe-chrome',
    `of the two probes the front one is #${stack.winner} (chrome first = contained); order=${JSON.stringify(stack.order)}`,
  );

  // ── 3. Why the context menu had to leave the pane ───────────────────────
  // The menu itself cannot be opened from here: its ONLY trigger is a
  // right-click that hits `a[href]` (useTerminal.ts), and this build renders
  // the terminal on WebGL, where links are painted on `.xterm-link-layer` and
  // no DOM anchor exists — measured on this instance, 0 anchors in the pane.
  // So verify the property the portal exists for instead: an element at
  // `--z-popover-top`, which is what the menu carries, is TRAPPED while it is
  // a pane descendant and free once it is a child of body.
  const portal = await evalJson(send, `
    const pane = document.querySelector('[data-wmux-pane-root]');
    const r = pane.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const css = getComputedStyle(document.documentElement);
    const popoverZ = css.getPropertyValue('--z-popover-top').trim() || '9999';
    const overlayZ = css.getPropertyValue('--z-overlay').trim() || '50';

    const box = (z, bg) => {
      const d = document.createElement('div');
      Object.assign(d.style, {
        position: 'fixed', left: x - 40 + 'px', top: y - 20 + 'px',
        width: '80px', height: '40px', zIndex: z, background: bg,
      });
      return d;
    };

    // Chrome-level element, always on body, always at the overlay baseline.
    const chrome = box(overlayZ, 'lime');
    chrome.id = 'probe-chrome';
    document.body.appendChild(chrome);

    // The menu's z, mounted the OLD way: inside the pane.
    const inPane = box(popoverZ, 'red');
    inPane.id = 'probe-in-pane';
    pane.appendChild(inPane);
    const trappedWinner = document.elementsFromPoint(x, y)
      .map((e) => e.id).filter((id) => id === 'probe-chrome' || id === 'probe-in-pane')[0] ?? null;
    inPane.remove();

    // The menu's z, mounted the NEW way: on body.
    const onBody = box(popoverZ, 'red');
    onBody.id = 'probe-on-body';
    document.body.appendChild(onBody);
    const portalWinner = document.elementsFromPoint(x, y)
      .map((e) => e.id).filter((id) => id === 'probe-chrome' || id === 'probe-on-body')[0] ?? null;
    onBody.remove();
    chrome.remove();

    return { trappedWinner, portalWinner, popoverZ, overlayZ };
  `);
  record(
    'the menu\'s z-index is TRAPPED while it lives inside the pane',
    portal.trappedWinner === 'probe-chrome',
    `z:${portal.popoverZ} inside the pane loses to chrome z:${portal.overlayZ} — winner #${portal.trappedWinner}`,
  );
  record(
    'the same element on document.body is on top, as the portal makes it',
    portal.portalWinner === 'probe-on-body',
    `winner #${portal.portalWinner}`,
  );

  // ── 4. The same probe, with the isolation switched off ──────────────────
  // A containment test that passes on the broken build proves nothing. Drop
  // `isolation` from the pane root in place, re-run the ordering, and put it
  // back: the pane-internal element must win there, which is the bug.
  const baseline = await evalJson(send, `
    const pane = document.querySelector('[data-wmux-pane-root]');
    const before = pane.style.isolation;
    pane.style.isolation = 'auto';                 // beats the class
    const r = pane.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const css = getComputedStyle(document.documentElement);

    const box = (z, id) => {
      const d = document.createElement('div');
      d.id = id;
      Object.assign(d.style, {
        position: 'fixed', left: x - 40 + 'px', top: y - 20 + 'px',
        width: '80px', height: '40px', zIndex: z, background: 'red',
      });
      return d;
    };
    const chrome = box(css.getPropertyValue('--z-overlay').trim() || '50', 'probe-chrome');
    document.body.appendChild(chrome);
    const inPane = box(css.getPropertyValue('--z-popover-top').trim() || '9999', 'probe-in-pane');
    pane.appendChild(inPane);

    const winner = document.elementsFromPoint(x, y)
      .map((e) => e.id).filter((id) => id === 'probe-chrome' || id === 'probe-in-pane')[0] ?? null;

    inPane.remove();
    chrome.remove();
    pane.style.isolation = before;                 // restore
    const restored = getComputedStyle(pane).isolation;
    return { winner, restored };
  `);
  record(
    'without the isolation the pane-internal element wins (the bug reproduces)',
    baseline.winner === 'probe-in-pane' && baseline.restored === 'isolate',
    `winner #${baseline.winner}; isolation restored to ${baseline.restored}`,
  );

  // A picture, so a human can check what the assertions cannot describe.
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = `${process.env.TMPDIR || '/tmp'}/wmux-957-contextmenu.png`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`\n[screenshot] ${out}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('[error]', err?.message ?? err);
  process.exit(1);
});
