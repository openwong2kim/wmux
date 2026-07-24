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
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };

  var params = new URLSearchParams(location.search);
  var token = params.get('token') || sessionStorage.getItem('wmux-web-token') || '';
  if (token) sessionStorage.setItem('wmux-web-token', token);
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

  var term = null;
  var es = null;
  var allowInput = false;
  var currentSession = null;
  var sessions = [];
  var attn = {};                 // sessionId → true while it has an unviewed alert
  var criticalCount = 0;         // live unacknowledged critical banners (drives title)
  var BASE_TITLE = document.title;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fleetTimer = null;

  function ensureTerm(cols, rows) {
    if (!term) {
      term = new Terminal({
        cols: cols || 80,
        rows: rows || 24,
        fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
        fontSize: fontSize,
        theme: THEME,
        cursorBlink: false,
        scrollback: 5000,
        disableStdin: !allowInput
      });
      term.open(termHost);
      if (allowInput) term.onData(function (d) { sendInput(d); });
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

  function rescale() {
    if (!term || !term.element) return;
    var natural = term.element.offsetWidth || 1;
    var avail = document.documentElement.clientWidth - 8;
    var s = fitMode ? Math.min(1, avail / natural) : 1;
    scalerEl.style.transform = 'scale(' + s + ')';
    scalerEl.style.width = (natural * s) + 'px';
    scalerEl.style.height = (term.element.offsetHeight * s) + 'px';
  }

  function setFit(on) {
    fitMode = on;
    try { localStorage.setItem('wmux-web-fit', on ? '1' : '0'); } catch (e) { /* private mode */ }
    var btn = $('#kb-fit');
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    rescale();
  }
  window.addEventListener('resize', rescale);
  window.addEventListener('orientationchange', function () { setTimeout(rescale, 200); });

  // SSE is the ONLY endpoint that carries the token in the query string
  // (EventSource cannot set headers). Every other call uses a Bearer header so
  // the token stays out of query strings / URL logs.
  function streamUrl(pathname) {
    var sep = pathname.indexOf('?') >= 0 ? '&' : '?';
    return pathname + sep + 'token=' + encodeURIComponent(token);
  }
  function authHeaders(extra) {
    var h = { Authorization: 'Bearer ' + token };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
    return h;
  }

  function api(pathname) {
    return fetch(pathname, { headers: authHeaders() }).then(function (r) {
      if (r.status === 401) { requireToken(true); throw new Error('unauthorized'); }
      return r;
    });
  }

  /** Show the inline auth form. `stale` marks a rejected token vs a missing one. */
  function requireToken(stale) {
    if (es) { es.close(); es = null; }
    sessions = [];
    currentSession = null;
    switcherEl.disabled = true;
    updateSwitcher(null);
    setConn('error', 'no access');
    showOverlay(
      'auth',
      stale ? 'Access token rejected' : 'Access token required',
      stale
        ? 'The stored token is no longer valid. Tokens rotate every time the server restarts.'
        : 'Paste the token printed by wmux web, or open the full URL that includes it.'
    );
    if (authInput) { authInput.value = ''; setTimeout(function () { authInput.focus(); }, 50); }
  }

  function sendInput(data) {
    if (!allowInput || !currentSession) return;
    fetch('/api/input?session=' + encodeURIComponent(currentSession), {
      method: 'POST',
      body: data,
      headers: authHeaders({ 'Content-Type': 'application/octet-stream' }),
      keepalive: true
    }).catch(function () { /* transient */ });
  }

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

    kbAgentBtn.addEventListener('click', function () {
      var open = kbAgentRow.hasAttribute('hidden');
      if (open) kbAgentRow.removeAttribute('hidden'); else kbAgentRow.setAttribute('hidden', '');
      kbAgentBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      rescale();
    });
  }

  // ── font size ────────────────────────────────────────────────────────────
  var MIN_FONT = 8, MAX_FONT = 22;
  var fontSize = Number(localStorage.getItem('wmux-web-font')) || 13;
  if (!(fontSize >= MIN_FONT && fontSize <= MAX_FONT)) fontSize = 13;

  function applyFont(next) {
    fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, next));
    try { localStorage.setItem('wmux-web-font', String(fontSize)); } catch (e) { /* private mode */ }
    if (term) term.options.fontSize = fontSize;
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

  function labelFor(s) {
    return { agent: s.agent || shortenCwd(s.cwd), cwd: s.agent ? shortenCwd(s.cwd) : '' };
  }

  function updateSwitcher(s) {
    if (!s) {
      swLabel.textContent = 'No pane selected';
      swDot.removeAttribute('data-state');
      return;
    }
    var l = labelFor(s);
    swLabel.innerHTML = '';
    var a = document.createElement('span');
    a.className = 'sw-agent';
    a.textContent = l.agent;
    swLabel.appendChild(a);
    if (l.cwd) {
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
    sessions.forEach(function (s) {
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
      var agent = document.createElement('span');
      agent.className = 'sess-agent';
      agent.textContent = s.agent || shortenCwd(s.cwd);
      var state = document.createElement('span');
      state.className = 'sess-state';
      state.textContent = s.state || '';
      title.appendChild(agent);
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
        if (s.id !== currentSession) connect(s.id);
      });
      li.appendChild(btn);
      sheetList.appendChild(li);
    });
  }

  // ── fleet strip ──────────────────────────────────────────────────────────
  // A glanceable row of every pane. Text-first chips, boxless until active;
  // the current pane gets a steel underline ("where you are"). Hidden entirely
  // below 2 sessions (dead chrome rule).
  function sessionName(s) { return s.agent || shortenCwd(s.cwd); }

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

      var name = document.createElement('span');
      name.className = 'fleet-name';
      name.textContent = sessionName(s);

      var alert = document.createElement('span');
      alert.className = 'fleet-alert';
      alert.setAttribute('aria-hidden', 'true');

      btn.appendChild(dot);
      btn.appendChild(name);
      btn.appendChild(alert);
      btn.addEventListener('click', function () { if (s.id !== currentSession) connect(s.id); });
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
      if (cur) updateSwitcher(cur);
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

  function handleAttention(kind, raw) {
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || !data.sessionId) return;
    var sid = data.sessionId;
    var s = sessions.filter(function (x) { return x.id === sid; })[0];
    var name = s ? sessionName(s) : sid;

    var title, sub;
    if (kind === 'critical') {
      title = 'Approval needed';
      sub = data.action || 'A pane is waiting on you.';
    } else {
      title = data.message || 'Notification';
      sub = '';
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
      if (sid && sid !== currentSession) connect(sid);
    });

    el.appendChild(body);
    el.appendChild(x);
    notifyStack.appendChild(el);

    if (isCritical) { criticalCount += 1; setTitleForCriticals(); }
    var timer = setTimeout(ack, 12000);
  }

  // ── stream ───────────────────────────────────────────────────────────────
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

    es = new EventSource(streamUrl('/api/stream?session=' + encodeURIComponent(sessionId)));
    es.addEventListener('meta', function (e) {
      var m = JSON.parse(e.data);
      ensureTerm(m.cols, m.rows);
    });
    es.addEventListener('snapshot', function (e) {
      if (term) { term.reset(); term.write(b64ToBytes(e.data)); }
      hideOverlay();
      setConn('live', 'live');
    });
    es.addEventListener('data', function (e) {
      if (term) term.write(b64ToBytes(e.data));
    });
    es.addEventListener('exit', function () { setConn('ended', 'ended'); });
    // Fleet-wide attention events — broadcast on EVERY stream, so we hear about
    // pane B while watching pane A.
    es.addEventListener('critical', function (e) { handleAttention('critical', e.data); });
    es.addEventListener('notify', function (e) { handleAttention('notify', e.data); });
    es.onopen = function () { setConn('live', 'live'); };
    es.onerror = function () { setConn('reconnect', 'reconnecting…'); };
  }

  function loadSessions() {
    return api('/api/sessions').then(function (r) { return r.json(); }).then(function (data) {
      sessions = data.sessions || [];
      renderSheet();
      renderFleet();
      startFleetPolling();
      if (!sessions.length) {
        switcherEl.disabled = true;
        updateSwitcher(null);
        setConn('ended', 'no panes');
        showOverlay('empty', 'No live panes', 'Start a session in wmux and it will appear here automatically.');
        return;
      }
      switcherEl.disabled = false;
      connect(sessions[0].id);
    });
  }

  ovRetry.addEventListener('click', function () { init(); });

  if (authForm) {
    authForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var t = (authInput.value || '').trim();
      if (!t) return;
      token = t;
      sessionStorage.setItem('wmux-web-token', token);
      init();
    });
  }

  // ── pairing ────────────────────────────────────────────────────────────────
  // Trade a short single-use code for the real token (GET /api/pair, the only
  // unauthenticated API route). On success store the token and land on '/'.
  function showPairing() {
    showOverlay('pair', 'Pair this device', 'Enter the 6-character code shown by wmux web.');
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
      if (code.length !== 6) { if (pairErr) pairErr.textContent = 'Enter all 6 characters.'; return; }
      fetch('/api/pair?code=' + encodeURIComponent(code)).then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; });
      }).then(function (res) {
        if (res.status === 200 && res.body && res.body.token) {
          sessionStorage.setItem('wmux-web-token', res.body.token);
          // Land on the app root with the token already stored.
          location.replace('/');
          return;
        }
        var msg = 'Pairing failed.';
        if (res.body && res.body.error === 'expired') msg = 'This code has expired. Ask for a new one.';
        else if (res.body && res.body.error === 'too many attempts') msg = 'Too many attempts — the code is locked.';
        else if (res.body && typeof res.body.attemptsLeft === 'number') {
          msg = 'Wrong code — ' + res.body.attemptsLeft + ' attempt' + (res.body.attemptsLeft === 1 ? '' : 's') + ' left.';
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
      return loadSessions();
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
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  // The /pair route always opens the pairing screen (even if a stale token is
  // stored) — the operator explicitly navigated here to key in a code.
  if (location.pathname === '/pair') {
    showPairing();
  } else {
    init();
  }
})();
