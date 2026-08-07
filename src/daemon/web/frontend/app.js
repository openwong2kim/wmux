/* wmux web frontend — read-only-by-default terminal viewer.
 *
 * Output arrives as SSE (base64-encoded PTY bytes); input (only when the
 * server was started with --allow-input) is POSTed back. The terminal renders
 * at the session's real cols/rows and is CSS-scaled to fit the phone width —
 * we never resize the shared PTY from the web (that would disturb the desktop).
 *
 * UI shell follows DESIGN.md: a custom session switcher + sheet (not a native
 * <select>), a dot-vocabulary connection chip, and explicit loading / empty /
 * error / auth states instead of a bare status string.
 */
/* global Terminal, wmuxAttentionFormat */ // provided by the inlined bundles
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };

  // Credential storage is localStorage, NOT sessionStorage, and the reason is
  // the home screen. The manifest's start_url is "./", so launching the
  // installed app loads the page with no `?token=` in the URL — it has to find
  // the credential itself or it renders a shell that 401s on every call. iOS
  // evicts an installed PWA's sessionStorage routinely, which made that the
  // normal case rather than an edge one: add to home screen, come back later,
  // dead app. The token cannot ride start_url instead, because the manifest is
  // served unauthenticated and would hand the secret to anyone who fetches it.
  //
  // What this costs: the credential outlives the tab, on a device the operator
  // deliberately paired. That is the intended lifetime — `wmux web --stop` and
  // `--new-token` revoke it server-side, and a per-device credential can be
  // revoked on its own, which is the whole point of pairing one.
  var TOKEN_KEY = 'wmux-web-token';
  function readStoredToken() {
    try {
      var v = localStorage.getItem(TOKEN_KEY);
      if (v) return v;
      // One-time migration: a browser that paired before this change still has
      // its token in sessionStorage, and silently signing it out would look
      // like the bug this fixes.
      var legacy = sessionStorage.getItem(TOKEN_KEY);
      if (legacy) { localStorage.setItem(TOKEN_KEY, legacy); return legacy; }
    } catch (e) { /* private mode — fall through to whatever the URL carries */ }
    return '';
  }
  function storeToken(value) {
    if (!value) return;
    try { localStorage.setItem(TOKEN_KEY, value); } catch (e) { /* private mode */ }
  }

  var params = new URLSearchParams(location.search);
  var token = params.get('token') || readStoredToken() || '';
  storeToken(token);
  // Keep the token out of the visible URL / history once we have stored it.
  if (params.get('token') && window.history && history.replaceState) {
    params.delete('token');
    var rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
  }

  var connEl = $('#conn');
  var connLabel = $('#conn-label');
  var switcherEl = $('#switcher');
  var swDot = $('#sw-dot');
  var swLabel = $('#sw-label');
  var termHost = $('#term');
  var scalerEl = $('#scaler');
  var gridEl = $('#grid');
  var bannerEl = $('#banner');
  var overlayEl = $('#overlay');
  var ovTitle = $('#ov-title');
  var ovBody = $('#ov-body');
  var ovRetry = $('#ov-retry');
  var authForm = $('#ov-auth');
  var authInput = $('#ov-token');
  var sheetEl = $('#sheet');
  var sheetList = $('#sheet-list');
  var sheetCount = $('#sheet-count');
  var fleetEl = $('#fleet');
  var notifyStack = $('#notify-stack');
  var pairForm = $('#ov-pair');
  var codeInput = $('#ov-code');
  var pairErr = $('#ov-pair-err');

  function setConn(kind, label) {
    connEl.setAttribute('data-kind', kind);
    connLabel.textContent = label;
  }

  function showOverlay(kind, title, body) {
    overlayEl.setAttribute('data-show', kind);
    ovTitle.textContent = title;
    ovBody.textContent = body;
  }
  function hideOverlay() { overlayEl.removeAttribute('data-show'); }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // amber-graphite terminal theme (DESIGN.md §"Terminal content owns its ANSI palette")
  var THEME = {
    background: '#151517', foreground: '#EFEEEC', cursor: '#E8A33D', cursorAccent: '#151517',
    selectionBackground: '#33333a',
    black: '#151517', red: '#E08A57', green: '#8FBF7F', yellow: '#E8A33D', blue: '#6E9BC4',
    magenta: '#9E8CFF', cyan: '#5FB6C9', white: '#EFEEEC',
    brightBlack: '#66645F', brightRed: '#E08A57', brightGreen: '#8FBF7F', brightYellow: '#E8A33D',
    brightBlue: '#6E9BC4', brightMagenta: '#9E8CFF', brightCyan: '#5FB6C9', brightWhite: '#FFFFFF'
  };

  var term = null;               // the 1-up terminal (null while split view owns the stage)
  var es = null;                 // the 1-up SSE stream
  var attnEs = null;             // the page-lifetime attention stream (/api/events)
  var tiles = [];                // split-view tiles, each with its OWN stream + terminal
  var allowInput = false;
  var currentSession = null;
  var sessions = [];
  var attn = {};                 // sessionId → true while it has an unviewed alert
  var criticalCount = 0;         // live unacknowledged critical banners (drives title)
  var BASE_TITLE = document.title;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fleetTimer = null;

  function newTerm(cols, rows) {
    return new Terminal({
      cols: cols || 80,
      rows: rows || 24,
      fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: fontSize,
      theme: THEME,
      cursorBlink: false,
      scrollback: 5000,
      disableStdin: !allowInput
    });
  }

  // Tap the terminal to type.
  //
  // iOS only raises the soft keyboard for a focus that happens INSIDE a user
  // gesture. The programmatic term.focus() on session switch is enough on a
  // desktop browser — which is why every test passed — but on a phone it
  // raises nothing, so the pane looked read-only even with input enabled.
  // Attaching to the host (not to xterm's own helper textarea, which sits
  // offscreen and never receives the tap) puts the focus call inside the
  // gesture where iOS wants it.
  function focusFromGesture(t) {
    if (!allowInput || !t) return;
    try { t.focus(); } catch (e) { /* torn down mid-tap */ }
  }
  if (termHost) termHost.addEventListener('click', function () { focusFromGesture(term); });

  // Repaint gate: how many snapshots are currently being fed to the parser.
  //
  // xterm answers device queries ITSELF — DA1 (ESC[c), DSR/CPR (ESC[6n),
  // DECRPM — and delivers those answers through the same onData that carries
  // typing. A replayed snapshot contains whatever queries the pane's app sent,
  // so replaying one made this browser type phantom answers into a live shell.
  // The machine that owns the pane has its own terminal and is the
  // authoritative responder; a viewer must never answer.
  //
  // A count rather than a flag: xterm parses a big write in slices, so a
  // reconnect can start a second repaint while the first is still being
  // consumed, and a flag would let the first callback reopen the gate under it.
  //
  // The eventual root fix is to neutralise the QUERIES rather than filter the
  // answers — either in xterm (parser.registerCsiHandler swallowing DA/DSR/
  // DECRQM) or by having the daemon strip them from the bytes it fans out.
  // Both are bigger than this file.
  var termRepaints = 0;

  /** Replay `bytes` into `t` with the gate held for as long as it parses. */
  function repaint(t, bytes, inc, dec) {
    t.reset();
    inc();
    try {
      t.write(bytes, dec);
    } catch (e) {
      // write() can throw before the callback is ever queued (xterm refuses
      // past its discard watermark). Not releasing here would latch the gate
      // and silently swallow every keystroke for the rest of the page's life.
      dec();
    }
  }

  function ensureTerm(cols, rows) {
    if (!term) {
      term = newTerm(cols, rows);
      term.open(termHost);
      if (allowInput) term.onData(function (d) {
        if (termRepaints > 0) return; // parser reply to a replayed query
        sendInput(d);
      });
    } else if (cols && rows) {
      term.resize(cols, rows);
    }
    rescale();
  }

  // Two viewing modes, because they are in genuine tension on a phone:
  //   fit  — squeeze the whole width in (good for glancing at a wide pane,
  //          but at 100 cols on a 390px screen the text is unreadable)
  //   zoom — render at the chosen font size 1:1 and let the stage scroll
  //          sideways (readable, and stays crisp since we do not CSS-scale)
  // Changing the font size implies zoom mode; "Fit" returns to the overview.
  var fitMode = localStorage.getItem('wmux-web-fit') !== '0';

  /** Scale one terminal into `avail` px of width (fit) or leave it 1:1 (zoom). */
  function scaleInto(scaler, t, avail) {
    if (!t || !t.element) return;
    var natural = t.element.offsetWidth || 1;
    var s = fitMode ? Math.min(1, avail / natural) : 1;
    scaler.style.transform = 'scale(' + s + ')';
    scaler.style.width = (natural * s) + 'px';
    scaler.style.height = (t.element.offsetHeight * s) + 'px';
  }

  function rescale() {
    scaleInto(scalerEl, term, document.documentElement.clientWidth - 8);
    // Split tiles fit into their OWN column, not the viewport.
    tiles.forEach(function (t) { scaleInto(t.scaler, t.term, (t.el.clientWidth || 1) - 8); });
  }

  function setFit(on) {
    fitMode = on;
    try { localStorage.setItem('wmux-web-fit', on ? '1' : '0'); } catch (e) { /* private mode */ }
    var btn = $('#kb-fit');
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    rescale();
  }
  window.addEventListener('resize', function () {
    // A resize can cross the phone threshold, which forces 1-up (and back).
    applyViewMode();
    rescale();
  });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { applyViewMode(); rescale(); }, 200);
  });

  // SSE is the ONLY endpoint that carries a credential in the query string
  // (EventSource cannot set headers). Every other call uses a Bearer header.
  //
  // WHICH credential depends on how this browser authenticated. An operator
  // token rides `?token=` exactly as it always has. A per-device credential
  // never may: it is durable and never expires, and a query string is the one
  // place a secret is guaranteed to be written down (history, proxy logs,
  // Referer). A device uses `?ticket=` instead — a two-minute, device-bound
  // capability that only opens a stream. See ensureStreamTicket.
  function streamUrl(pathname) {
    var sep = pathname.indexOf('?') >= 0 ? '&' : '?';
    if (streamTicket) return pathname + sep + 'ticket=' + encodeURIComponent(streamTicket);
    return pathname + sep + 'token=' + encodeURIComponent(token);
  }
  function authHeaders(extra) {
    var h = { Authorization: 'Bearer ' + token };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    return h;
  }

  // ── stream tickets ─────────────────────────────────────────────────────────
  var streamTicket = '';
  var streamTicketExpiresAt = 0;
  // Latched after one 403: this session authenticates with the operator token,
  // which needs no ticket. Without the latch every reconnect would re-ask.
  var ticketsUnavailable = false;
  // Renew early — a ticket that expired between building the URL and the
  // browser's retry would fail the very reconnect it exists to survive.
  var TICKET_RENEW_MARGIN_MS = 15000;

  function ticketIsFresh() {
    return !!streamTicket && Date.now() < streamTicketExpiresAt - TICKET_RENEW_MARGIN_MS;
  }

  /**
   * Resolve true once a usable ticket is held, false when this session does not
   * use them (operator token) or cannot get one. NEVER rejects: every caller's
   * next move is to open the stream regardless and let the normal error path
   * deal with it, so a failure here must not break the chain.
   */
  function ensureStreamTicket(force) {
    if (ticketsUnavailable) return Promise.resolve(false);
    if (!force && ticketIsFresh()) return Promise.resolve(true);
    return fetch('/api/stream-ticket', { method: 'POST', headers: authHeaders() }).then(function (r) {
      // 403 = the operator token, which opens streams with ?token= directly.
      if (r.status === 403) { ticketsUnavailable = true; return false; }
      if (r.status === 401) {
        return readReason(r).then(function (reason) { requireToken(true, reason); return false; });
      }
      if (r.status !== 200) return false;
      return r.json().then(function (b) {
        if (!b || !b.ticket) return false;
        streamTicket = b.ticket;
        streamTicketExpiresAt = typeof b.expiresAt === 'number' ? b.expiresAt : Date.now() + 60000;
        return true;
      });
    }, function () { return false; });
  }

  /**
   * A stream that ends CLOSED (readyState 2) got a non-200 and will NEVER retry
   * on its own. For a ticketed session that is almost always just an expired
   * ticket, so take a fresh one and rebuild the streams. The attention channel
   * comes back through its own `?since=` cursor, so #600's replay still covers
   * whatever landed while we were away.
   *
   * Rate-limited: four split tiles fail independently, and a genuinely dead
   * server must not become a tight reopen loop.
   */
  var RENEW_MS = 3000;
  var renewAt = 0;
  var renewing = false;
  function renewStreams() {
    // Operator sessions hold no ticket and their URLs never go stale — leave
    // them to EventSource's own retry, exactly as before.
    if (!streamTicket || renewing || Date.now() - renewAt < RENEW_MS) return;
    renewing = true;
    renewAt = Date.now();
    ensureStreamTicket(true).then(function (ok) {
      renewing = false;
      if (!ok) return; // credential is gone; requireToken has already taken over
      if (es) { es.close(); es = null; }
      destroyTiles();
      if (attnEs) { attnEs.close(); attnEs = null; }
      openAttentionStream();
      applyViewMode();
    }, function () { renewing = false; });
  }

  /** The server's 401 `reason` ('revoked' | 'unknown'), or '' if unreadable. */
  function readReason(r) {
    return r.json().then(function (b) { return (b && b.reason) || ''; }, function () { return ''; });
  }

  function api(pathname) {
    return fetch(pathname, { headers: authHeaders() }).then(function (r) {
      if (r.status === 401) {
        return readReason(r).then(function (reason) {
          requireToken(true, reason);
          throw new Error('unauthorized');
        });
      }
      return r;
    });
  }

  // A stream error carries no status: EventSource exposes only `onerror`, and
  // it retries forever either way. So "the daemon is restarting" and "this
  // token has been revoked" look identical from here, and the second one would
  // sit on "reconnecting…" until someone walked to the desktop — the exact
  // failure this app exists to avoid. Probe ONE authenticated route to tell
  // them apart; api() already routes a 401 to the token/pairing screen.
  //
  // Rate-limited because four split tiles all retry independently: at most one
  // probe in flight, and at most one per AUTH_PROBE_MS across all of them.
  var AUTH_PROBE_MS = 5000;
  var authProbeAt = 0;
  var authProbing = false;
  function diagnoseStreamError() {
    if (authProbing || Date.now() - authProbeAt < AUTH_PROBE_MS) return;
    authProbing = true;
    authProbeAt = Date.now();
    // Snapshot the token the probe is actually asking about, and send it by
    // hand rather than through api(). Re-authenticating (auth form or pairing)
    // while this request is in flight would otherwise let the OLD token's 401
    // tear down the session that just came up — the verdict only applies while
    // `token` is still the one we asked with.
    var probed = token;
    var done = function () { authProbing = false; };
    fetch('/api/config', { headers: { Authorization: 'Bearer ' + probed } }).then(function (r) {
      done();
      if (r.status === 401 && token === probed) {
        readReason(r).then(function (reason) {
          if (token === probed) requireToken(true, reason);
        });
      }
      // Anything else: a genuine outage, or a stale verdict about a token we
      // no longer use — the "reconnecting…" the caller set is the right answer.
    }, done);
  }

  /**
   * Show the inline auth form. `stale` marks a rejected credential vs a missing
   * one; `reason` is the server's own verdict ('revoked' | 'unknown').
   *
   * `revoked` earns its own copy because it is the one case with a definite
   * cause and a definite remedy: a human removed this device on purpose, and
   * no amount of retrying will help — only a new pairing code will. Guessing
   * "the server was stopped" at someone whose phone was deliberately cut off
   * is the failure #599's screen could not avoid; now the server says which.
   */
  function requireToken(stale, reason) {
    if (es) { es.close(); es = null; }
    // The ticket was minted for the credential that just got refused; it is
    // dead with it, and holding one would send the next open down the ticket
    // path instead of showing this form.
    streamTicket = '';
    streamTicketExpiresAt = 0;
    ticketsUnavailable = false;
    // The attention stream carries the same rejected token; drop it so the next
    // successful init opens a fresh one (with the stored cursor, so nothing is lost).
    if (attnEs) { attnEs.close(); attnEs = null; }
    // Split tiles hold their OWN streams carrying the stale token; left alive,
    // buildGrid() would happily reuse the dead tiles after re-auth. Tear the
    // grid down so the next successful init starts clean.
    destroyTiles();
    gridEl.setAttribute('hidden', '');
    gridEl.removeAttribute('data-mode');
    scalerEl.style.display = '';
    sessions = [];
    currentSession = null;
    switcherEl.disabled = true;
    updateSwitcher(null);
    setConn('error', 'no access');
    showOverlay(
      'auth',
      reason === 'revoked' ? 'This device was removed' : stale ? 'Access token rejected' : 'Access token required',
      reason === 'revoked'
        ? 'The operator revoked this device from the wmux desktop. Ask them for a new pairing code to connect again.'
        : stale
          ? 'The stored token is no longer valid — the server was stopped, or a new token was issued. A pairing code is the quickest way back in.'
          : 'Paste the token printed by wmux web, or open the full URL that includes it.'
    );
    if (authInput) { authInput.value = ''; setTimeout(function () { authInput.focus(); }, 50); }
  }

  // One in-flight input POST per session at a time. xterm's onData fires per
  // chunk, and parallel fetches carry no ordering guarantee — fast typing or a
  // paste split across requests could reach the PTY out of order. Each link in
  // the chain resolves and is replaced, so the chain never grows.
  var inputChain = {};
  function sendTo(sessionId, data) {
    if (!allowInput || !sessionId) return;
    var prev = inputChain[sessionId] || Promise.resolve();
    inputChain[sessionId] = prev.then(function () {
      return fetch('/api/input?session=' + encodeURIComponent(sessionId), {
        method: 'POST',
        body: data,
        headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
        keepalive: true
      }).then(function (r) {
        // fetch RESOLVES on 401 and 403, so a .catch() alone sees neither.
        // Without this, a stale token or a read-only server made typing do
        // nothing at all and say nothing at all — the keyboard came up, the
        // characters went nowhere, and the page looked broken rather than
        // locked. Dogfooding on a phone is where that showed up.
        if (r.status === 401) {
          return readReason(r).then(function (reason) { requireToken(true, reason); });
        }
        if (r.status === 403) {
          allowInput = false;   // stop firing at a door the server has shut
          setConn('error', 'read-only');
          return;
        }
      }).catch(function () { /* genuinely transient — the stream reconnect reports it */ });
    });
  }

  /** Key bar / single-view input always targets the pane you are focused on. */
  function sendInput(data) { sendTo(currentSession, data); }

  // ── touch key bar ────────────────────────────────────────────────────────
  // A phone keyboard cannot produce Esc, Tab, Ctrl-anything or arrows, which is
  // most of what steering a TUI agent needs. Modifiers follow the convention
  // mobile terminals settled on: one tap arms for the next key, a double tap
  // locks until tapped again.
  var KEYS = [
    { label: 'Esc', seq: '\x1b' },
    { label: 'Tab', seq: '\t' },
    { label: 'Ctrl', mod: 'ctrl' },
    { label: 'Alt', mod: 'alt' },
    { label: '↑', seq: '\x1b[A' },
    { label: '↓', seq: '\x1b[B' },
    { label: '←', seq: '\x1b[D' },
    { label: '→', seq: '\x1b[C' },
    { label: '|', ch: '|' },
    { label: '/', ch: '/' },
    { label: '~', ch: '~' },
    { label: '-', ch: '-' },
    { label: '_', ch: '_' },
    { label: 'Home', seq: '\x1b[H' },
    { label: 'End', seq: '\x1b[F' },
    { label: 'PgUp', seq: '\x1b[5~' },
    { label: 'PgDn', seq: '\x1b[6~' }
  ];

  // Agent-steering shortcuts. These are the keystrokes you actually need when
  // a coding agent is waiting on you and all you have is a phone.
  var AGENT_CMDS = [
    { label: 'Shift+Tab', seq: '\x1b[Z' },
    { label: 'Ctrl+C', seq: '\x03' },
    { label: 'Enter', seq: '\r' },
    { label: 'yes', seq: 'yes\r' },
    { label: 'continue', seq: 'continue\r' },
    { label: '/compact', seq: '/compact\r' },
    { label: '/clear', seq: '/clear\r' },
    { label: '/resume', seq: '/resume\r' }
  ];

  var keybarEl = $('#keybar');
  var kbKeysEl = $('#kb-keys');
  var kbAgentBtn = $('#kb-agent');
  var kbAgentRow = $('#kb-agent-row');
  var mods = { ctrl: 0, alt: 0 };   // 0 = off, 1 = armed, 2 = locked
  var lastModTap = { ctrl: 0, alt: 0 };
  var modButtons = {};

  function renderMods() {
    Object.keys(modButtons).forEach(function (name) {
      var btn = modButtons[name];
      if (mods[name] === 2) { btn.setAttribute('data-locked', '1'); btn.removeAttribute('data-armed'); }
      else if (mods[name] === 1) { btn.setAttribute('data-armed', '1'); btn.removeAttribute('data-locked'); }
      else { btn.removeAttribute('data-armed'); btn.removeAttribute('data-locked'); }
    });
  }

  function tapMod(name) {
    var now = Date.now();
    var isDouble = now - lastModTap[name] < 400;
    lastModTap[name] = now;
    if (isDouble) mods[name] = mods[name] === 2 ? 0 : 2;
    else mods[name] = mods[name] === 0 ? 1 : 0;
    renderMods();
  }

  /** Apply armed/locked modifiers to a plain character, then clear armed ones. */
  function withMods(ch) {
    var out = ch;
    if (mods.ctrl) {
      var code = ch.toUpperCase().charCodeAt(0);
      // Ctrl maps @A-Z[\]^_ onto 0x00-0x1f; anything else passes through.
      if (code >= 64 && code <= 95) out = String.fromCharCode(code & 0x1f);
      else if (ch === ' ') out = '\x00';
    }
    if (mods.alt) out = '\x1b' + out;
    return out;
  }
  function clearArmed() {
    var changed = false;
    ['ctrl', 'alt'].forEach(function (n) { if (mods[n] === 1) { mods[n] = 0; changed = true; } });
    if (changed) renderMods();
  }

  function pressKey(def) {
    if (def.mod) { tapMod(def.mod); return; }
    // Escape sequences are sent verbatim; only plain characters take modifiers.
    var payload = def.ch ? withMods(def.ch) : def.seq;
    sendInput(payload);
    clearArmed();
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function buildKeybar() {
    kbKeysEl.innerHTML = '';
    modButtons = {};
    KEYS.forEach(function (def) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'kb-key';
      b.textContent = def.label;
      if (def.mod) modButtons[def.mod] = b;
      // pointerdown keeps the terminal from losing focus and feels instant.
      b.addEventListener('pointerdown', function (e) { e.preventDefault(); pressKey(def); });
      kbKeysEl.appendChild(b);
    });

    kbAgentRow.innerHTML = '';
    AGENT_CMDS.forEach(function (def) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'kb-cmd';
      b.textContent = def.label;
      b.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        sendInput(def.seq);
        if (navigator.vibrate) navigator.vibrate(8);
      });
      kbAgentRow.appendChild(b);
    });
  }

  // Registered ONCE, not inside buildKeybar(): buildKeybar runs on every
  // successful init() (Retry, re-auth after a token rotation), and stacking a
  // second toggle handler on this persistent button would open-and-close the
  // agent row in the same tap.
  kbAgentBtn.addEventListener('click', function () {
    var open = kbAgentRow.hasAttribute('hidden');
    if (open) kbAgentRow.removeAttribute('hidden'); else kbAgentRow.setAttribute('hidden', '');
    kbAgentBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    rescale();
  });

  // ── font size ────────────────────────────────────────────────────────────
  var MIN_FONT = 8, MAX_FONT = 22;
  var fontSize = Number(localStorage.getItem('wmux-web-font')) || 13;
  if (!(fontSize >= MIN_FONT && fontSize <= MAX_FONT)) fontSize = 13;

  function applyFont(next) {
    fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, next));
    try { localStorage.setItem('wmux-web-font', String(fontSize)); } catch (e) { /* private mode */ }
    if (term) term.options.fontSize = fontSize;
    tiles.forEach(function (t) { if (t.term) t.term.options.fontSize = fontSize; });
    // Resizing the font under fit-to-width is a no-op (the scale just absorbs
    // it), so asking for a size change means leaving fit mode.
    setFit(false);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.kb-zoom[data-zoom]'), function (btn) {
    btn.addEventListener('click', function () { applyFont(fontSize + Number(btn.getAttribute('data-zoom'))); });
  });
  $('#kb-fit').addEventListener('click', function () { setFit(!fitMode); });

  function shortenCwd(cwd) {
    if (!cwd) return 'unknown';
    var parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join('/');
  }

  // ── session labels ────────────────────────────────────────────────────────
  // `s.workspace` is the workspace a pane belongs to, resolved daemon-side from
  // the identity the desktop app stamps into the pane env at spawn.
  //
  // HONEST LIMITATION: that stamp is a SNAPSHOT. Panes started before this
  // feature existed carry no workspace at all (the field is simply absent, and
  // we label by cwd exactly as before — we never invent a workspace), and a
  // workspace RENAMED after a pane spawned keeps showing the name it had then.
  // What to CALL a pane, in one place so it can never be named two different
  // things depending on where you look (switcher, fleet chip, sheet row, split
  // tile). Precedence:
  //   agent — the thing you are supervising, when one was detected;
  //   shell — the short program name the daemon recorded for the pane (`pwsh`),
  //           which is what an agent-less pane actually is;
  //   cwd tail — last resort only, and only when there is no workspace either.
  //           Before `shell` existed this was the fallback for every agent-less
  //           pane, so the row read "Users/rizz" directly above the full
  //           "C:\Users\rizz" — the same string twice, and every plain shell
  //           pane looked identical to every other.
  // `kind` travels with the name so the renderer can voice a shell more quietly
  // than an agent without re-deriving the precedence.
  function labelFor(s) {
    var ws = s.workspace || '';
    var cwd = shortenCwd(s.cwd);
    var name = '';
    var kind = '';
    if (s.agent) { name = s.agent; kind = 'agent'; }
    else if (s.shell) { name = s.shell; kind = 'shell'; }
    else if (!ws) { name = cwd; kind = 'cwd'; }
    return { ws: ws, name: name, kind: kind, cwd: cwd };
  }

  /** Flat one-line form ("Workspace 1 · claude") for notification bodies. */
  function sessionName(s) {
    var l = labelFor(s);
    if (l.ws && l.name) return l.ws + ' · ' + l.name;
    return l.ws || l.name || shortenCwd(s.cwd);
  }

  function sepEl() {
    var el = document.createElement('span');
    el.className = 'lbl-sep';
    el.textContent = '·';
    return el;
  }

  /**
   * Append `Workspace 1 · claude` into `host`, using the given class names.
   * A shell name additionally carries `lbl-shell`, which voices it a step
   * quieter than an agent — same slot, but a shell is only the program the pane
   * is running, not something you are supervising.
   */
  function appendLabel(host, l, wsClass, nameClass) {
    if (l.ws) {
      var w = document.createElement('span');
      w.className = wsClass;
      w.textContent = l.ws;
      host.appendChild(w);
      if (l.name) host.appendChild(sepEl());
    }
    if (l.name) {
      var a = document.createElement('span');
      a.className = l.kind === 'shell' ? nameClass + ' lbl-shell' : nameClass;
      a.textContent = l.name;
      host.appendChild(a);
    }
  }

  function updateSwitcher(s) {
    if (!s) {
      swLabel.textContent = 'No pane selected';
      swDot.removeAttribute('data-state');
      return;
    }
    var l = labelFor(s);
    swLabel.innerHTML = '';
    appendLabel(swLabel, l, 'sw-ws', 'sw-agent');
    // The switcher is the narrowest label on the page. Once a workspace is in
    // it, the cwd is dropped here — "Workspace 1 · claude" fits a phone bar,
    // "Workspace 1 · claude wmux/src" ellipsizes mid-word. The sheet row and the
    // split-view tile headers still carry the path. The `kind` guard covers the
    // pane whose headline IS its cwd tail (never print the path twice).
    if (!l.ws && l.cwd && l.name && l.kind !== 'cwd') {
      var c = document.createElement('span');
      c.className = 'sw-cwd';
      c.textContent = ' ' + l.cwd;
      swLabel.appendChild(c);
    }
    swDot.style.background = s.state === 'running' ? 'var(--amber)' : 'var(--success)';
  }

  // ── session sheet ────────────────────────────────────────────────────────
  function openSheet() {
    if (!sessions.length) return;
    sheetEl.setAttribute('data-open', '');
    switcherEl.setAttribute('aria-expanded', 'true');
  }
  function closeSheet() {
    sheetEl.removeAttribute('data-open');
    switcherEl.setAttribute('aria-expanded', 'false');
  }
  switcherEl.addEventListener('click', function () {
    if (sheetEl.hasAttribute('data-open')) closeSheet(); else openSheet();
  });
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sheetEl.hasAttribute('data-open')) closeSheet();
  });

  /**
   * Bucket the fleet by workspace WITHOUT reordering it. Groups appear in the
   * order their first pane appears in the fleet list, and panes keep their fleet
   * order inside a group, so the sheet and the fleet strip always agree.
   *
   * Panes the daemon reports no workspace for (they spawned before wmux stamped
   * the name into the pane env) collect in a final bucket. It is labelled for
   * what it is — unknown — never given an invented workspace name.
   */
  function groupSessions(list) {
    var groups = [];
    var byName = {};
    list.forEach(function (s) {
      var name = s.workspace || '';
      if (!Object.prototype.hasOwnProperty.call(byName, name)) {
        byName[name] = { name: name, sessions: [] };
        groups.push(byName[name]);
      }
      byName[name].sessions.push(s);
    });
    var named = groups.filter(function (g) { return g.name !== ''; });
    var unknown = groups.filter(function (g) { return g.name === ''; });
    return named.concat(unknown);
  }

  function groupHeader(g) {
    var li = document.createElement('li');
    li.className = 'sess-group';
    var name = document.createElement('span');
    name.className = 'sess-group-name';
    if (g.name) {
      name.textContent = g.name;
    } else {
      name.textContent = 'workspace unknown';
      li.title = 'These panes started before wmux recorded workspace names, so their workspace cannot be resolved.';
    }
    var count = document.createElement('span');
    count.className = 'sess-group-count';
    count.textContent = String(g.sessions.length);
    li.appendChild(name);
    li.appendChild(count);
    return li;
  }

  /**
   * A sheet row's label. Under a NAMED group header the workspace is already on
   * screen, so the row drops the prefix and leads with the pane's own name
   * (agent → shell → cwd tail, see labelFor).
   */
  function rowLabel(s, underNamedGroup) {
    var l = labelFor(s);
    if (!underNamedGroup) return l;
    // Drop the workspace prefix, but never leave the row without a headline:
    // a pane with neither agent nor shell falls back to its cwd tail here.
    if (l.name) return { ws: '', name: l.name, kind: l.kind, cwd: l.cwd };
    return { ws: '', name: l.cwd, kind: 'cwd', cwd: l.cwd };
  }

  function sessionRow(s, underNamedGroup) {
    var li = document.createElement('li');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sess';
    if (s.id === currentSession) btn.setAttribute('aria-current', 'true');

    var dot = document.createElement('span');
    dot.className = 'sess-dot';
    dot.setAttribute('data-state', s.state === 'running' ? 'running' : 'idle');

    var main = document.createElement('span');
    main.className = 'sess-main';
    var title = document.createElement('span');
    title.className = 'sess-title';
    appendLabel(title, rowLabel(s, underNamedGroup), 'sess-ws', 'sess-agent');
    var state = document.createElement('span');
    state.className = 'sess-state';
    state.textContent = s.state || '';
    title.appendChild(state);
    var cwd = document.createElement('span');
    cwd.className = 'sess-cwd';
    cwd.textContent = s.cwd || '';
    main.appendChild(title);
    main.appendChild(cwd);

    btn.appendChild(dot);
    btn.appendChild(main);
    btn.addEventListener('click', function () {
      closeSheet();
      // selectSession, NOT connect: in a split this focuses the pane's tile
      // instead of tearing the grid down.
      if (s.id !== currentSession) selectSession(s.id);
    });
    li.appendChild(btn);
    return li;
  }

  function renderSheet() {
    sheetList.innerHTML = '';
    sheetCount.textContent = sessions.length ? String(sessions.length) : '';
    if (!sessions.length) {
      var li = document.createElement('li');
      li.className = 'sess-empty';
      li.textContent = 'No live panes.';
      sheetList.appendChild(li);
      return;
    }
    var groups = groupSessions(sessions);
    // One group, and it is the unknown bucket: nothing has a workspace name yet
    // (every pane predates the stamp). A single "workspace unknown" header over
    // the whole list would be dead chrome, so render flat — the pre-grouping
    // shape, unchanged.
    var grouped = !(groups.length === 1 && groups[0].name === '');
    if (grouped) sheetList.setAttribute('data-grouped', '');
    else sheetList.removeAttribute('data-grouped');
    groups.forEach(function (g) {
      if (grouped) sheetList.appendChild(groupHeader(g));
      g.sessions.forEach(function (s) {
        sheetList.appendChild(sessionRow(s, grouped && g.name !== ''));
      });
    });
  }

  // ── fleet strip ──────────────────────────────────────────────────────────
  // A glanceable row of every pane. Text-first chips, boxless until active;
  // the current pane gets a steel underline ("where you are"). Hidden entirely
  // below 2 sessions (dead chrome rule).
  function renderFleet() {
    if (!fleetEl) return;
    if (sessions.length < 2) {
      fleetEl.setAttribute('hidden', '');
      fleetEl.innerHTML = '';
      return;
    }
    fleetEl.removeAttribute('hidden');
    fleetEl.innerHTML = '';
    sessions.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fleet-chip';
      if (s.id === currentSession) btn.setAttribute('aria-current', 'true');
      if (attn[s.id]) btn.setAttribute('data-attn', '1');

      var dot = document.createElement('span');
      dot.className = 'fleet-dot';
      // amber = running, green = idle, gray = anything else.
      if (s.state === 'running' || s.state === 'idle') dot.setAttribute('data-state', s.state);

      var alert = document.createElement('span');
      alert.className = 'fleet-alert';
      alert.setAttribute('aria-hidden', 'true');

      btn.appendChild(dot);
      appendLabel(btn, labelFor(s), 'fleet-ws', 'fleet-name');
      btn.appendChild(alert);
      btn.addEventListener('click', function () { if (s.id !== currentSession) selectSession(s.id); });
      fleetEl.appendChild(btn);
    });
  }

  // Poll the session list on a slow cadence and re-render the fleet strip +
  // sheet WITHOUT disturbing the active output stream.
  function refreshSessions() {
    api('/api/sessions').then(function (r) { return r.json(); }).then(function (data) {
      sessions = data.sessions || [];
      renderSheet();
      renderFleet();
      var cur = sessions.filter(function (x) { return x.id === currentSession; })[0];
      if (cur) {
        updateSwitcher(cur);
      } else if (sessions.length) {
        // The watched pane closed between polls. Fall over to the first live
        // pane (same choice as the initial load) instead of staying pinned to
        // a dead stream applyViewMode() would never replace.
        currentSession = sessions[0].id;
        if (es) { es.close(); es = null; }
        updateSwitcher(sessions[0]);
        renderSheet();
        renderFleet();
      }
      // Keep a split in sync with the fleet: refresh tile headers, and rebuild
      // only if the set of panes it should show actually changed (a pane died,
      // a new one appeared). applyViewMode is a no-op otherwise, so the 30s
      // poll never disturbs a live stream.
      applyViewMode();
    }).catch(function () { /* transient; next tick retries */ });
  }
  function startFleetPolling() {
    if (fleetTimer) return;
    fleetTimer = setInterval(refreshSessions, 30000);
  }

  // ── in-app notifications ───────────────────────────────────────────────────
  // Fleet-wide attention events (approval requests, agent notifications) arrive
  // on the SSE stream regardless of which pane it watches. Surface them as a
  // banner and mark the pane's chip until viewed.
  function setTitleForCriticals() {
    document.title = criticalCount > 0 ? '● ' + BASE_TITLE : BASE_TITLE;
  }

  // Attention events are delivered twice on purpose (the pane stream keeps the
  // old tee for one release, /api/events is the durable channel), and the
  // durable channel replays on every reconnect — so the same event can arrive
  // several times. `epoch:id` is the identity that makes that safe. The seen set
  // is bounded by a FIFO of its own keys: an unbounded one is a slow leak on a
  // phone that stays open for days.
  var SEEN_CAP = 200;
  var seenAttention = {};
  var seenOrder = [];
  var CURSOR_KEY = 'wmux-web-attn-cursor';
  var lastAttentionCursor = '';
  try { lastAttentionCursor = sessionStorage.getItem(CURSOR_KEY) || ''; } catch (e) { /* private mode */ }

  function markSeen(key) {
    seenAttention[key] = true;
    seenOrder.push(key);
    while (seenOrder.length > SEEN_CAP) delete seenAttention[seenOrder.shift()];
  }
  function rememberCursor(key) {
    lastAttentionCursor = key;
    // EventSource's own Last-Event-ID covers reconnects within this page; the
    // stored cursor is what survives a RELOAD (it goes out as ?since=).
    try { sessionStorage.setItem(CURSOR_KEY, key); } catch (e) { /* private mode */ }
  }

  // A `reset` frame means the server could not place our cursor (fresh client,
  // or the daemon restarted), so what follows is a full window rather than
  // "what you missed". Rendering a banner per event would bury the screen in
  // alerts the user may have already dealt with, so replayed events only light
  // up their fleet chips and collapse into one summary line.
  var replaying = false;
  var replayCount = 0;
  var replayTimer = null;
  // The last id the server had when it told us to resync. Once we have replayed
  // up to it the backlog is provably over, so the very next event is LIVE.
  var replayUntilId = 0;

  function endReplay() {
    if (replayTimer) clearTimeout(replayTimer);
    replayTimer = null;
    replayUntilId = 0;
    replaying = false;
    if (replayCount > 0) {
      pushNotif({
        kind: 'notify',
        slim: false,
        sessionId: null,
        sessionName: 'Tap a highlighted pane to catch up.',
        title: replayCount + ' event' + (replayCount === 1 ? '' : 's') + ' while you were away',
        sub: ''
      });
    }
    replayCount = 0;
  }
  function beginReplay(headId) {
    replaying = true;
    replayCount = 0;
    replayUntilId = typeof headId === 'number' && headId > 0 ? headId : 0;
    armReplayEnd();
  }
  // Fallback for a server that sent no headId: the backlog can span several
  // network chunks, so its end is not an event we are told about — it is a
  // short quiet period after the last one. With a headId we close the window
  // exactly, so a live event arriving inside 200ms keeps its banner.
  function armReplayEnd() {
    if (replayTimer) clearTimeout(replayTimer);
    replayTimer = setTimeout(endReplay, 200);
  }

  function handleAttention(kind, raw) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || !data.sessionId) return;

    // Events with no id come from a server that predates the attention log —
    // there is nothing to dedup on, so they pass straight through (back-compat).
    if (data.epoch && typeof data.id === 'number') {
      var key = data.epoch + ':' + data.id;
      if (seenAttention[key]) return;
      markSeen(key);
      rememberCursor(key);
    }

    var sid = data.sessionId;
    var s = sessions.filter(function (x) { return x.id === sid; })[0];
    var name = s ? sessionName(s) : sid;

    var f = wmuxAttentionFormat.formatAttention(kind, data);
    var title = f.title;
    var sub = f.sub;

    if (replaying) {
      if (sid !== currentSession) { attn[sid] = true; renderFleet(); }
      replayCount += 1;
      if (replayUntilId && typeof data.id === 'number' && data.id >= replayUntilId) {
        // That was the last event the backlog could contain — close the window
        // now so the next one is treated as live (banner + vibration intact).
        endReplay();
      } else {
        armReplayEnd();
      }
      return;
    }

    // Mark the chip unless it is the pane already in view.
    if (sid !== currentSession) { attn[sid] = true; renderFleet(); }
    if (kind === 'critical' && navigator.vibrate) navigator.vibrate([30, 40, 30]);

    pushNotif({
      kind: kind === 'critical' ? 'critical' : 'notify',
      slim: sid === currentSession,
      sessionId: sid,
      sessionName: name,
      title: title,
      sub: sub
    });
  }

  function pushNotif(n) {
    if (!notifyStack) return;
    var el = document.createElement('div');
    el.className = 'notif';
    el.setAttribute('data-kind', n.kind);
    if (n.slim) el.setAttribute('data-slim', '1');
    if (reduceMotion) el.style.animation = 'none';

    var body = document.createElement('div');
    body.className = 'notif-body';
    var t = document.createElement('div');
    t.className = 'notif-title';
    t.textContent = n.title;
    var sub = document.createElement('div');
    sub.className = 'notif-sub';
    var sess = document.createElement('span');
    sess.className = 'notif-sess';
    sess.textContent = n.sessionName;
    sub.appendChild(sess);
    if (n.sub) { sub.appendChild(document.createTextNode(' · ' + n.sub)); }
    body.appendChild(t);
    body.appendChild(sub);

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'notif-x';
    x.setAttribute('aria-label', 'Dismiss');
    x.innerHTML = '&times;';

    var isCritical = n.kind === 'critical';
    var acked = false;
    function ack() {
      if (acked) return;
      acked = true;
      if (timer) clearTimeout(timer);
      if (isCritical) { criticalCount = Math.max(0, criticalCount - 1); setTitleForCriticals(); }
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    x.addEventListener('click', function (e) { e.stopPropagation(); ack(); });
    el.addEventListener('click', function () {
      var sid = n.sessionId;
      ack();
      if (sid && sid !== currentSession) selectSession(sid);
    });

    el.appendChild(body);
    el.appendChild(x);
    notifyStack.appendChild(el);

    if (isCritical) { criticalCount += 1; setTitleForCriticals(); }
    var timer = setTimeout(ack, 12000);
  }

  // ── stream ───────────────────────────────────────────────────────────────
  // ONE subscription implementation, used by the single-pane view and by every
  // split tile, so stream lifecycle (framing, the fleet-wide attention tee,
  // teardown) can never drift between the two. The caller owns the returned
  // EventSource and MUST close() it.
  //
  // `sink.attention` must be true for EXACTLY ONE open stream: the daemon
  // broadcasts critical/notify to every connected client, so binding it on all
  // four tiles would show four copies of the same alert.
  function openStream(sessionId, sink) {
    var src = new EventSource(streamUrl('/api/stream?session=' + encodeURIComponent(sessionId)));
    src.addEventListener('meta', function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (sink.meta) sink.meta(m);
    });
    src.addEventListener('snapshot', function (e) { if (sink.snapshot) sink.snapshot(b64ToBytes(e.data)); });
    src.addEventListener('data', function (e) { if (sink.data) sink.data(b64ToBytes(e.data)); });
    src.addEventListener('exit', function () { if (sink.exit) sink.exit(); });
    if (sink.attention) {
      src.addEventListener('critical', function (e) { handleAttention('critical', e.data); });
      src.addEventListener('notify', function (e) { handleAttention('notify', e.data); });
    }
    src.onopen = function () { if (sink.open) sink.open(); };
    src.onerror = function () {
      if (sink.error) sink.error();
      // CLOSED means a non-200 and no further retry of its own — for a ticketed
      // session, usually an expired ticket. renewStreams is a no-op otherwise.
      if (src.readyState === 2) renewStreams();
    };
    return src;
  }

  /**
   * The durable attention channel — ONE per page, for the page's whole life.
   *
   * Pane streams come and go with every tap, and attention events that landed
   * while none was open used to be gone for good (#598). This stream is opened
   * once (after the first session list, so a replayed event can resolve a pane
   * name), never re-opened on a pane switch, and carries ids: the browser
   * resends the last one as Last-Event-ID on its automatic retry, so a phone
   * that lost signal resumes exactly where it stopped. `?since=` covers the
   * other case — a full page reload, where the browser has no id to resend.
   */
  function openAttentionStream() {
    if (attnEs) return;
    var path = '/api/events';
    if (lastAttentionCursor) path += '?since=' + encodeURIComponent(lastAttentionCursor);
    attnEs = new EventSource(streamUrl(path));
    attnEs.addEventListener('reset', function (e) {
      var head = 0;
      try { head = JSON.parse(e.data).headId; } catch (err) { head = 0; }
      beginReplay(typeof head === 'number' ? head : 0);
    });
    attnEs.addEventListener('critical', function (e) { handleAttention('critical', e.data); });
    attnEs.addEventListener('notify', function (e) { handleAttention('notify', e.data); });
    // Left to EventSource's own retry, which resends Last-Event-ID for us.
    // MERGE FOLLOW-UP: #596 adds a 401 probe (diagnoseStreamError) for a stream
    // that fails because the token rotated; this stream should use it too once
    // both branches are on main.
    attnEs.onerror = function () {
      // readyState CONNECTING (0) means the browser is retrying by itself and
      // will resend Last-Event-ID — leave it alone. CLOSED (2) means it gave up
      // (a non-200, e.g. a 401 after the token rotated) and will NEVER retry;
      // the handle must be released or the `if (attnEs) return` guard above
      // blocks every future open and the channel is dead for the page's life.
      if (attnEs && attnEs.readyState === 2) {
        attnEs.close();
        attnEs = null;
        // A ticketed session can recover this itself: take a fresh ticket and
        // reopen, and `lastAttentionCursor` replays whatever was missed.
        renewStreams();
      }
    };
  }

  function connect(sessionId) {
    if (es) { es.close(); es = null; }
    currentSession = sessionId;
    if (attn[sessionId]) { delete attn[sessionId]; }
    if (term) term.reset();
    var s = sessions.filter(function (x) { return x.id === sessionId; })[0];
    updateSwitcher(s);
    renderSheet();
    renderFleet();
    setConn('connecting', 'connecting…');
    showOverlay('loading', 'Attaching to pane', 'Loading scrollback and live output.');

    es = openStream(sessionId, {
      attention: true,
      meta: function (m) { ensureTerm(m.cols, m.rows); },
      snapshot: function (bytes) {
        if (term) {
          repaint(term, bytes,
            function () { termRepaints += 1; },
            function () { termRepaints = Math.max(0, termRepaints - 1); });
        }
        hideOverlay();
        setConn('live', 'live');
      },
      data: function (bytes) { if (term) term.write(bytes); },
      exit: function () { setConn('ended', 'ended'); },
      open: function () { setConn('live', 'live'); },
      error: function () { setConn('reconnect', 'reconnecting…'); diagnoseStreamError(); }
    });
  }

  // ── split view (1 / 2 / 4 panes) ─────────────────────────────────────────
  // Below this viewport width a split is not offered at all: two 80-column
  // terminals side by side on a 390px phone are a smear at every font size the
  // zoom control can reach, so the buttons are hidden (CSS) AND the stored
  // preference is force-collapsed to 1-up (here) — a narrow window must never
  // be able to land in a layout the user cannot read.
  var SPLIT_MIN_WIDTH = 700;
  var VIEW_MODES = [1, 2, 4];
  var viewMode = Number(localStorage.getItem('wmux-web-view')) || 1;
  if (VIEW_MODES.indexOf(viewMode) < 0) viewMode = 1;

  function splitAllowed() { return document.documentElement.clientWidth >= SPLIT_MIN_WIDTH; }
  function effectiveMode() { return splitAllowed() ? viewMode : 1; }
  function tileFor(sessionId) {
    return tiles.filter(function (t) { return t.sessionId === sessionId; })[0] || null;
  }

  /**
   * Which panes a split shows: the current one first, then its OWN workspace's
   * panes in fleet order, and only then everything else.
   *
   * Filling straight from the global fleet order looked like a bug: picking a
   * pane in Workspace 1 left a Workspace 2 pane sitting beside it, so the split
   * silently mixed two contexts. A split is for watching one thing from several
   * angles, so it stays inside the chosen workspace while that workspace still
   * has panes to give, and spills over only to avoid leaving a tile empty.
   */
  function pickSessions(n) {
    var out = [];
    var cur = sessions.filter(function (x) { return x.id === currentSession; })[0];
    if (cur) out.push(cur);
    var seen = function (s) { return out.some(function (o) { return o.id === s.id; }); };
    // `workspace` is absent for panes that predate the env stamp; treat all of
    // those as one bucket rather than matching them against everything.
    var sameWs = function (s) {
      return cur ? (s.workspace || '') === (cur.workspace || '') : true;
    };
    for (var i = 0; i < sessions.length && out.length < n; i++) {
      if (sameWs(sessions[i]) && !seen(sessions[i])) out.push(sessions[i]);
    }
    for (var j = 0; j < sessions.length && out.length < n; j++) {
      if (!seen(sessions[j])) out.push(sessions[j]);
    }
    return out;
  }

  /** Close every tile's stream, dispose its terminal, drop its DOM. */
  function destroyTiles() {
    tiles.forEach(function (t) {
      if (t.es) { t.es.close(); t.es = null; }
      try { t.term.dispose(); } catch (e) { /* already torn down */ }
      t.term = null;
      if (t.el.parentNode) t.el.parentNode.removeChild(t.el);
    });
    tiles = [];
  }

  /** (Re)fill a tile header: status dot + workspace/agent label + cwd. */
  function renderTileHead(t) {
    var s = sessions.filter(function (x) { return x.id === t.sessionId; })[0] || { id: t.sessionId };
    t.head.innerHTML = '';
    var dot = document.createElement('span');
    dot.className = 'tile-dot';
    if (s.state === 'running' || s.state === 'idle') dot.setAttribute('data-state', s.state);
    t.head.appendChild(dot);
    appendLabel(t.head, labelFor(s), 'tile-ws', 'tile-name');
    var cwd = document.createElement('span');
    cwd.className = 'tile-cwd';
    cwd.textContent = shortenCwd(s.cwd);
    t.head.appendChild(cwd);
    if (t.ended) {
      var end = document.createElement('span');
      end.className = 'tile-end';
      end.textContent = 'ended';
      t.head.appendChild(end);
      t.el.setAttribute('data-ended', '1');
    }
  }

  function makeTile(s, isAttentionSource) {
    var el = document.createElement('div');
    el.className = 'tile';
    var head = document.createElement('div');
    head.className = 'tile-head';
    var body = document.createElement('div');
    body.className = 'tile-body';
    var scaler = document.createElement('div');
    scaler.className = 'tile-scaler';
    var host = document.createElement('div');
    scaler.appendChild(host);
    body.appendChild(scaler);
    el.appendChild(head);
    el.appendChild(body);
    // Attach BEFORE term.open(): xterm measures its container on open, and a
    // detached node measures as 0 and renders nothing.
    gridEl.appendChild(el);

    var tile = { sessionId: s.id, term: null, es: null, el: el, head: head, scaler: scaler, ended: false, repaints: 0 };
    tile.term = newTerm(s.cols, s.rows);
    tile.term.open(host);
    // Same reason as the single-pane host: on iOS the keyboard only comes up
    // for a focus made inside a user gesture.
    host.addEventListener('click', function () { focusFromGesture(tile.term); });
    if (allowInput) {
      // Typing into a tile targets THAT tile's pane — and tapping it already
      // made it the focused one, so "input goes to the focused tile" holds.
      //
      // Deliberately does NOT move focus: xterm's onData also carries the
      // terminal's AUTOMATIC replies (DSR cursor reports, device attributes)
      // that a TUI provokes on its own. Focusing here made every tile yank
      // focus back on each reply, which pinned the page to whichever pane
      // chattered most (caught in live dogfood — a tap looked like it did
      // nothing). Focus moves on an explicit tap only.
      tile.term.onData(function (d) {
        if (tile.repaints > 0) return; // parser reply to a replayed query
        sendTo(tile.sessionId, d);
      });
    }
    renderTileHead(tile);
    el.addEventListener('pointerdown', function () { focusTile(tile); });

    tile.es = openStream(s.id, {
      attention: isAttentionSource,
      meta: function (m) {
        if (tile.term && m.cols && m.rows) tile.term.resize(m.cols, m.rows);
        rescale();
      },
      snapshot: function (bytes) {
        if (tile.term) {
          repaint(tile.term, bytes,
            function () { tile.repaints += 1; },
            function () { tile.repaints = Math.max(0, tile.repaints - 1); });
        }
        rescale();
        if (tile.sessionId === currentSession) setConn('live', 'live');
      },
      data: function (bytes) { if (tile.term) tile.term.write(bytes); },
      exit: function () {
        tile.ended = true;
        renderTileHead(tile);
        if (tile.sessionId === currentSession) setConn('ended', 'ended');
      },
      open: function () { if (tile.sessionId === currentSession) setConn('live', 'live'); },
      error: function () {
        if (tile.sessionId === currentSession) setConn('reconnect', 'reconnecting…');
        diagnoseStreamError();
      }
    });
    tiles.push(tile);
    return tile;
  }

  function focusTile(t) {
    if (!t) return;
    tiles.forEach(function (x) {
      if (x === t) x.el.setAttribute('data-focus', '1');
      else x.el.removeAttribute('data-focus');
    });
    if (currentSession !== t.sessionId) {
      currentSession = t.sessionId;
      if (attn[currentSession]) delete attn[currentSession];
      var s = sessions.filter(function (x) { return x.id === currentSession; })[0];
      updateSwitcher(s);
      renderSheet();
      renderFleet();
      setConn(t.ended ? 'ended' : 'live', t.ended ? 'ended' : 'live');
    }
    if (allowInput && t.term) t.term.focus();
  }

  function showSingle() {
    destroyTiles();
    gridEl.setAttribute('hidden', '');
    gridEl.removeAttribute('data-mode');
    scalerEl.style.display = '';
    if (currentSession && !es) connect(currentSession);
    rescale();
  }

  function buildGrid(mode) {
    var picked = pickSessions(mode);
    // One live pane is not a split — a 2-up grid would be a tile plus a dead
    // cell. Stay 1-up until there is something to compare it with.
    if (picked.length < 2) { showSingle(); return; }

    // Compare the SET, not the order: pickSessions puts the focused pane first,
    // so an order-sensitive check would rebuild the whole grid (and reflash every
    // stream) on the first poll after a tap, shuffling tiles under the user's
    // finger. Panes only move when the fleet itself changes.
    var want = picked.map(function (s) { return s.id; }).sort().join(',');
    var have = tiles.map(function (t) { return t.sessionId; }).sort().join(',');
    if (have === want) {
      // Same panes on screen: refresh labels/status only.
      tiles.forEach(renderTileHead);
      return;
    }

    destroyTiles();
    // The 1-up stream and terminal must not survive behind the grid — that is
    // exactly how a "hidden" viewer keeps a stream open forever.
    if (es) { es.close(); es = null; }
    if (term) { try { term.dispose(); } catch (e) { /* ignore */ } term = null; }
    scalerEl.style.display = 'none';
    hideOverlay();
    gridEl.removeAttribute('hidden');
    gridEl.setAttribute('data-mode', String(picked.length));
    picked.forEach(function (s, i) { makeTile(s, i === 0); });
    focusTile(tileFor(currentSession) || tiles[0]);
    rescale();
  }

  function updateViewButtons() {
    var mode = effectiveMode();
    Array.prototype.forEach.call(document.querySelectorAll('.kb-view'), function (btn) {
      btn.setAttribute('aria-pressed', Number(btn.getAttribute('data-view')) === mode ? 'true' : 'false');
    });
  }

  function applyViewMode() {
    if (!sessions.length) return;   // the empty-state overlay owns the stage
    updateViewButtons();
    if (effectiveMode() === 1) showSingle();
    else buildGrid(effectiveMode());
  }

  Array.prototype.forEach.call(document.querySelectorAll('.kb-view'), function (btn) {
    btn.addEventListener('click', function () {
      var next = Number(btn.getAttribute('data-view'));
      if (VIEW_MODES.indexOf(next) < 0) return;
      viewMode = next;
      try { localStorage.setItem('wmux-web-view', String(next)); } catch (e) { /* private mode */ }
      applyViewMode();
    });
  });

  /**
   * Switch which pane the page is centred on. In a split that means focusing
   * the tile if it is already up, or rebuilding the grid around it if not.
   */
  function selectSession(sessionId) {
    if (sessionId === currentSession && tileFor(sessionId)) return;
    if (effectiveMode() > 1 && tiles.length) {
      var t = tileFor(sessionId);
      if (t) { focusTile(t); return; }
      currentSession = sessionId;
      if (attn[sessionId]) delete attn[sessionId];
      buildGrid(effectiveMode());
      var s = sessions.filter(function (x) { return x.id === sessionId; })[0];
      updateSwitcher(s);
      renderSheet();
      renderFleet();
      return;
    }
    connect(sessionId);
  }

  // Dogfood hook: the split view's real risk is a leaked stream or terminal, so
  // expose the counts a driver can assert on after switching modes.
  window.__wmuxWeb = function () {
    return {
      mode: effectiveMode(),
      stored: viewMode,
      tiles: tiles.length,
      streams: (es ? 1 : 0) + tiles.filter(function (t) { return !!t.es; }).length,
      terms: (term ? 1 : 0) + tiles.filter(function (t) { return !!t.term; }).length,
      xtermNodes: document.querySelectorAll('.xterm').length,
      focused: currentSession
    };
  };

  function loadSessions() {
    return api('/api/sessions').then(function (r) { return r.json(); }).then(function (data) {
      sessions = data.sessions || [];
      renderSheet();
      renderFleet();
      startFleetPolling();
      // After the fleet is known, so a replayed event can be labelled with its
      // pane's name instead of a raw session id.
      openAttentionStream();
      if (!sessions.length) {
        switcherEl.disabled = true;
        updateSwitcher(null);
        setConn('ended', 'no panes');
        showOverlay('empty', 'No live panes', 'Start a session in wmux and it will appear here automatically.');
        return;
      }
      switcherEl.disabled = false;
      if (!currentSession || !sessions.filter(function (x) { return x.id === currentSession; })[0]) {
        currentSession = sessions[0].id;
      }
      applyViewMode();
    });
  }

  ovRetry.addEventListener('click', function () { init(); });

  if (authForm) {
    authForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var t = (authInput.value || '').trim();
      if (!t) return;
      token = t;
      storeToken(token);
      init();
    });
  }

  // ── pairing ────────────────────────────────────────────────────────────────
  // Trade a short single-use code for the real token (GET /api/pair, the only
  // unauthenticated API route). On success store the token and land on '/'.
  function showPairing() {
    showOverlay('pair', 'Pair this device', 'Enter the 8-character code shown by wmux web.');
    setConn('error', 'no access');
    if (pairErr) pairErr.textContent = '';
    if (codeInput) { codeInput.value = ''; setTimeout(function () { codeInput.focus(); }, 50); }
  }
  function showTokenForm() {
    requireToken(false);
  }

  var toPair = $('#ov-to-pair');
  var toToken = $('#ov-to-token');
  if (toPair) toPair.addEventListener('click', function () { showPairing(); });
  if (toToken) toToken.addEventListener('click', function () { showTokenForm(); });

  if (pairForm) {
    pairForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = (codeInput.value || '').trim().toUpperCase();
      if (pairErr) pairErr.textContent = '';
      if (code.length !== 8) { if (pairErr) pairErr.textContent = 'Enter all 8 characters.'; return; }
      fetch('/api/pair?code=' + encodeURIComponent(code)).then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      }).then(function (res) {
        if (res.status === 200 && res.body && res.body.token) {
          storeToken(res.body.token);
          // Land on the app root with the token already stored.
          location.replace('/');
          return;
        }
        var msg = 'Pairing failed.';
        if (res.body && res.body.error === 'expired') msg = 'This code has expired. Ask for a new one.';
        else if (res.body && res.body.error === 'too many attempts') msg = 'Too many attempts — the code is locked.';
        else if (res.body && typeof res.body.attemptsLeft === 'number') {
          msg = 'Wrong code — ' + res.body.attemptsLeft + ' attempt' + (res.body.attemptsLeft === 1 ? '' : 's') + ' left.';
        } else if (res.body && typeof res.body.detail === 'string' && res.body.detail) {
          // The server refuses some pairings on purpose — minting a durable
          // device secret over a plaintext bind, most of all — and sends back
          // the way out with it. Dropping that on the floor turns a refusal
          // that explains itself into a dead end, which is exactly what it
          // looked like in dogfooding.
          msg = res.body.detail;
        }
        if (pairErr) pairErr.textContent = msg;
      }).catch(function () {
        if (pairErr) pairErr.textContent = 'Could not reach the server.';
      });
    });
  }

  function init() {
    if (!token) { requireToken(false); return; }
    setConn('connecting', 'connecting…');
    showOverlay('loading', 'Connecting to wmux', 'Attaching to the daemon and loading live panes.');
    api('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      allowInput = cfg.allowInput === true;
      bannerEl.textContent = allowInput ? 'input enabled' : 'read-only';
      bannerEl.setAttribute('data-mode', allowInput ? 'rw' : 'ro');
      // The bar is always available for zoom; the keys only when input is on
      // (a read-only viewer showing dead keys would be a lie).
      keybarEl.removeAttribute('hidden');
      $('#kb-fit').setAttribute('aria-pressed', fitMode ? 'true' : 'false');
      if (allowInput) {
        buildKeybar();
      } else {
        kbKeysEl.innerHTML = '';
        kbAgentBtn.setAttribute('hidden', '');
      }
      // Before any stream opens: a device credential cannot ride a query string,
      // so without a ticket in hand the first EventSource would 401. A no-op
      // for an operator-token session, which needs none.
      return ensureStreamTicket(false).then(function () { return loadSessions(); });
    }).catch(function (err) {
      if (err && err.message === 'unauthorized') return; // auth form already shown
      setConn('error', 'error');
      showOverlay('error', 'Cannot reach the daemon', 'The wmux web server did not respond. Check that it is still running.');
    });
  }

  // Service worker registers only in a secure context (localhost / HTTPS).
  // Over plain-HTTP tailnet it is skipped — the page still works as a normal
  // web app; only offline caching / Android install prompt are unavailable.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* registration is best-effort */ });
  }

  // The /pair route always opens the pairing screen (even if a stale token is
  // stored) — the operator explicitly navigated here to key in a code.
  if (location.pathname === '/pair') {
    showPairing();
    // A scanned QR arrives as /pair?code=ABCD2345. Strip the code from the
    // address bar FIRST, before anything can fail: a code left parked in
    // history is the one write-down surface still open after the server's
    // Referrer-Policy: no-referrer, and it stays live for ten minutes if the
    // visitor closes the tab instead of finishing.
    var scanned = pairQuery.readPairCode(location.search);
    var cleaned = pairQuery.urlWithoutCode(location.pathname, location.search);
    if (cleaned && history.replaceState) {
      try { history.replaceState(null, '', cleaned); } catch (e) { /* non-fatal */ }
    }
    // Junk lands on the manual form rather than burning one of five attempts.
    if (scanned && codeInput && pairForm) {
      codeInput.value = scanned;
      pairForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  } else {
    init();
  }
})();
