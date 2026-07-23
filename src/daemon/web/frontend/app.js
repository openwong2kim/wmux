/* wmux web frontend — read-only-by-default terminal viewer.
 *
 * Output arrives as SSE (base64-encoded PTY bytes); input (only when the
 * server was started with --allow-input) is POSTed back. The terminal renders
 * at the session's real cols/rows and is CSS-scaled to fit the phone width —
 * we never resize the shared PTY from the web (that would disturb the desktop).
 */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };

  var params = new URLSearchParams(location.search);
  var token = params.get('token') || sessionStorage.getItem('wmux-web-token') || '';
  if (token) sessionStorage.setItem('wmux-web-token', token);

  var statusEl = $('#status');
  var pickerEl = $('#picker');
  var termHost = $('#term');
  var scalerEl = $('#scaler');
  var bannerEl = $('#banner');

  function setStatus(text, kind) {
    statusEl.textContent = text;
    if (kind) statusEl.setAttribute('data-kind', kind);
    else statusEl.removeAttribute('data-kind');
  }

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

  function ensureTerm(cols, rows) {
    if (!term) {
      term = new Terminal({
        cols: cols || 80,
        rows: rows || 24,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
        fontSize: 13,
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

  // Fit-to-width: scale the fixed-size terminal down to the viewport (never up).
  function rescale() {
    if (!term || !term.element) return;
    var natural = term.element.offsetWidth || 1;
    var avail = document.documentElement.clientWidth - 8;
    var s = Math.min(1, avail / natural);
    scalerEl.style.transform = 'scale(' + s + ')';
    scalerEl.style.width = (natural * s) + 'px';
    scalerEl.style.height = (term.element.offsetHeight * s) + 'px';
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
      if (r.status === 401) { promptToken(); throw new Error('unauthorized'); }
      return r;
    });
  }

  function promptToken() {
    var t = window.prompt('Enter wmux web access token');
    if (t) { token = t.trim(); sessionStorage.setItem('wmux-web-token', token); location.reload(); }
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

  function connect(sessionId) {
    if (es) { es.close(); es = null; }
    currentSession = sessionId;
    if (term) term.reset();
    setStatus('connecting…');
    es = new EventSource(streamUrl('/api/stream?session=' + encodeURIComponent(sessionId)));
    es.addEventListener('meta', function (e) {
      var m = JSON.parse(e.data);
      ensureTerm(m.cols, m.rows);
    });
    es.addEventListener('snapshot', function (e) {
      if (term) { term.reset(); term.write(b64ToBytes(e.data)); }
      setStatus('live', 'live');
    });
    es.addEventListener('data', function (e) {
      if (term) term.write(b64ToBytes(e.data));
    });
    es.addEventListener('exit', function () { setStatus('session ended', 'ended'); });
    es.onopen = function () { setStatus('live', 'live'); };
    es.onerror = function () { setStatus('reconnecting…', 'reconnect'); };
  }

  function shortenCwd(cwd) {
    if (!cwd) return '?';
    var parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join('/');
  }

  function loadSessions() {
    return api('/api/sessions').then(function (r) { return r.json(); }).then(function (data) {
      var sessions = data.sessions || [];
      pickerEl.innerHTML = '';
      if (!sessions.length) {
        var empty = document.createElement('option');
        empty.textContent = '(no live panes)';
        pickerEl.appendChild(empty);
        setStatus('no panes');
        return;
      }
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i];
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = (s.agent ? s.agent + ' · ' : '') + shortenCwd(s.cwd) + '  [' + s.state + ']';
        pickerEl.appendChild(o);
      }
      connect(sessions[0].id);
    });
  }

  pickerEl.addEventListener('change', function () {
    if (pickerEl.value) connect(pickerEl.value);
  });

  function init() {
    if (!token) { promptToken(); return; }
    api('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      allowInput = cfg.allowInput === true;
      bannerEl.textContent = allowInput ? 'input enabled' : 'read-only';
      bannerEl.setAttribute('data-mode', allowInput ? 'rw' : 'ro');
      return loadSessions();
    }).catch(function (err) {
      setStatus('error: ' + err.message, 'error');
    });
  }

  // Service worker registers only in a secure context (localhost / HTTPS).
  // Over plain-HTTP tailnet it is skipped — the page still works as a normal
  // web app; only offline caching / Android install prompt are unavailable.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }

  init();
})();
