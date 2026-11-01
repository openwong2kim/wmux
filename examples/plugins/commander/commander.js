// Commander: a dependency-free page using only the reviewed plugin bridge.
'use strict';
(() => {
  const page = document.querySelector('#page');
  const host = document.querySelector('#panels');
  const notice = document.querySelector('#notice');
  const panels = Array.from({ length: 3 }, () => ({ path: '', parent: null, entries: [], cursor: 0, marks: new Set(), scroll: 0, sort: 0, revision: 0 }));
  let count = 2, active = 0, colours = false, panes = [], port, serial = 0, modal = null, epoch = 0;
  let prefix = '', prefixTime = 0;
  const pending = new Map();
  const ROW = 26;
  const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
  const button = (text, action, title) => { const b = node('button', text); b.type = 'button'; b.onclick = () => safely(async () => { await action(); if (!modal) page.focus(); }); if (title) b.title = title; return b; };
  async function safely(action) { try { await action(); } catch (e) { notice.textContent = e.message; } }
  function rpc(method, params = {}) {
    if (!port) return Promise.reject(new Error('Bridge unavailable. Reopen Files to retry.'));
    return new Promise((resolve, reject) => {
      const id = String(++serial);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Request timed out.')); }, 30000);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ v: 1, kind: 'request', id, method, params });
    });
  }
  async function checked(method, params) {
    const result = await rpc(method, params);
    if (result?.ok === false || result?.error) throw new Error(result.reason || result.error);
    return result;
  }
  const join = (dir, name) => dir.replace(/[\\/]?$/, dir.includes('\\') ? '\\' : '/') + name;
  const current = () => panels[active];
  const rows = (p) => [{ name: '..', kind: 'dir', parent: true }, ...p.entries];
  const selected = (p) => p.marks.size ? p.entries.filter((e) => p.marks.has(e.name)) : rows(p).filter((e, i) => i === p.cursor && !e.parent);
  function sort(p) {
    p.entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') ||
      (p.sort === 1 ? a.size - b.size : p.sort === 2 ? b.mtimeMs - a.mtimeMs : 0) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  async function load(p, dir = p.path, keep = false) {
    const revision = ++p.revision;
    const result = await checked('fs.list', { path: dir });
    if (revision !== p.revision) return;
    const name = keep ? rows(p)[p.cursor]?.name : null;
    p.path = result.path; p.parent = result.parent; p.entries = result.entries; sort(p);
    p.marks = new Set([...p.marks].filter((n) => keep && p.entries.some((e) => e.name === n)));
    p.cursor = name ? Math.max(0, rows(p).findIndex((e) => e.name === name)) : 0;
    if (!keep) p.scroll = 0;
    p.truncated = result.truncated;
    render();
  }
  async function refresh() { await Promise.all(panels.filter((p) => p.path).map((p) => load(p, p.path, true))); }
  function size(e) {
    if (e.kind === 'dir' || e.parent) return '';
    if (e.size < 1024) return `${e.size} B`;
    const unit = e.size >= 1024 ** 3 ? 3 : e.size >= 1024 ** 2 ? 2 : 1;
    return `${(e.size / 1024 ** unit).toFixed(1)} ${['', 'KB', 'MB', 'GB'][unit]}`;
  }
  function permission(e) {
    if (e.parent) return '';
    return (e.kind === 'dir' ? 'd' : e.kind === 'symlink' ? 'l' : '-') +
      (e.mode === undefined ? '???' : [0o400, 0o200, 0o100].map((bit, i) => e.mode & bit ? 'rwx'[i] : '-').join(''));
  }
  function type(e) {
    if (e.kind === 'dir') return 'dir';
    if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(e.name)) return 'image';
    if (/\.(zip|tar|gz|xz|7z|rar|bz2)$/i.test(e.name)) return 'archive';
    return e.mode & 0o100 || /\.(exe|cmd|bat)$/i.test(e.name) ? 'executable' : '';
  }
  function drawRows(p, list) {
    const entries = rows(p);
    const windowed = entries.length > 2000;
    const start = windowed ? Math.max(0, Math.floor(list.scrollTop / ROW) - 10) : 0;
    const end = windowed ? Math.min(entries.length, start + Math.ceil((list.clientHeight || 600) / ROW) + 20) : entries.length;
    const fragment = document.createDocumentFragment();
    if (start) { const spacer = node('div'); spacer.style.height = `${start * ROW}px`; fragment.append(spacer); }
    for (let i = start; i < end; i++) {
      const e = entries[i];
      const row = node('div', undefined, `row ${type(e)}${p.cursor === i ? ' cursor' : ''}${p.marks.has(e.name) ? ' marked' : ''}`);
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(p.marks.has(e.name)));
      row.setAttribute('aria-label', `${e.name}${p.cursor === i ? ', cursor' : ''}`);
      const date = e.parent ? '' : new Date(e.mtimeMs);
      const pad = (v) => String(v).padStart(2, '0');
      const day = date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : '';
      const time = date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : '';
      for (const [value, cls] of [[e.name, 'name'], [permission(e), 'permissions'], [size(e), 'size'], [day, 'date'], [time, 'time']]) row.append(node('span', value, cls));
      row.onclick = () => { active = panels.indexOf(p); p.cursor = i; page.focus(); render(); };
      row.ondblclick = () => safely(() => open(p)); fragment.append(row);
    }
    if (end < entries.length) { const spacer = node('div'); spacer.style.height = `${(entries.length - end) * ROW}px`; fragment.append(spacer); }
    list.replaceChildren(fragment);
  }
  function render() {
    host.replaceChildren(); page.classList.toggle('colours', colours);
    for (let i = 0; i < count; i++) {
      const p = panels[i];
      const panel = node('section', undefined, `panel${active === i ? ' active' : ''}`);
      panel.setAttribute('aria-label', `Panel ${i + 1}`);
      panel.onpointerdown = () => { if (active !== i) { active = i; for (const [n, section] of [...host.querySelectorAll('.panel')].entries()) section.classList.toggle('active', n === i); } page.focus(); };
      panel.append(node('div', p.path || 'Loading…', 'path'));
      const columns = node('div', undefined, 'columns');
      for (const [text, cls] of [['Name', ''], ['Mode', ''], ['Size', 'size'], ['Date', 'date'], ['Time', 'time']]) columns.append(node('span', text, cls));
      panel.append(columns);
      const list = node('div', undefined, 'rows'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', p.path || 'Files'); list.setAttribute('aria-multiselectable', 'true');
      panel.append(list); host.append(panel); list.scrollTop = p.scroll; drawRows(p, list); list.scrollTop = p.scroll;
      list.onscroll = () => { p.scroll = list.scrollTop; if (p.entries.length > 2000) drawRows(p, list); };
      panel.append(node('div', `${p.entries.length} items · ${p.marks.size} marked · ${['Name', 'Size', 'Date'][p.sort]}${p.truncated ? ' · First 10,000 entries only' : ''}`, 'summary'));
      if (i === 0) host.append(toolbar());
    }
  }
  function toolbar() {
    const bar = node('nav'); bar.id = 'toolbar'; bar.setAttribute('aria-label', 'File operations and layouts');
    bar.append(button('⇄', () => { [panels[0], panels[1]] = [panels[1], panels[0]]; render(); }, 'Swap panels'));
    for (let n = 1; n <= 9; n++) { const b = button(String(n), () => quick(n), `Pane ${n} folder · Alt+${n}`); b.disabled = !panes[n - 1]?.cwd; bar.append(b); }
    const copy = button('▷', () => transfer('copy'), 'Copy to next panel · F5'); copy.disabled = count < 2;
    const move = button('◁', () => transfer('move'), 'Move to next panel · F6'); move.disabled = count < 2;
    bar.append(copy, move);
    for (let n = 1; n <= 3; n++) { const b = button('▯'.repeat(n), () => layout(n), `${n} panels · Ctrl+${n}`); b.setAttribute('aria-pressed', String(count === n)); if (n === 1) b.className = 'layout-start'; bar.append(b); }
    const colour = button('MDIR', () => { colours = !colours; render(); }, 'MDIR colours (optional file type colours)'); colour.setAttribute('aria-pressed', String(colours)); bar.append(colour);
    return bar;
  }
  function layout(n) { count = n; active = Math.min(active, count - 1); render(); }
  async function quick(n) { await getPanes(); if (panes[n - 1]?.cwd) await load(current(), panes[n - 1].cwd); }
  async function getPanes() { const result = await checked('pane.list'); panes = result.panes || []; render(); }
  function cursor(index) {
    const p = current(); p.cursor = Math.max(0, Math.min(p.entries.length, index));
    const list = host.querySelectorAll('.rows')[active]; const height = list?.clientHeight || 500;
    if (p.cursor * ROW < p.scroll) p.scroll = p.cursor * ROW;
    if ((p.cursor + 1) * ROW > p.scroll + height) p.scroll = (p.cursor + 1) * ROW - height;
    render();
  }
  async function open(p = current()) {
    const e = rows(p)[p.cursor];
    if (e.parent) { if (p.parent) await load(p, p.parent); }
    else if (e.kind === 'dir' || e.target === 'dir') await load(p, join(p.path, e.name));
    else await view();
  }
  function dialog(title, content, actions = []) {
    if (modal) throw new Error('Close the current dialog first.');
    const overlay = node('div', undefined, 'overlay'); const box = node('section', undefined, 'dialog');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    const heading = node('h2', title); heading.id = 'dialog-title'; box.setAttribute('aria-labelledby', heading.id);
    const actionBar = node('div', undefined, 'actions'); box.append(heading, ...content, actionBar); overlay.append(box); document.body.append(overlay);
    let resolve; const result = new Promise((r) => { resolve = r; });
    const state = { box, result, close: () => finish(null) };
    function finish(value) { overlay.remove(); modal = null; resolve(value); page.focus(); }
    for (const [label, value] of actions) actionBar.append(button(label, () => finish(value)));
    overlay.onkeydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.close(); }
      if (event.key === 'Tab') {
        const focusable = [...box.querySelectorAll('button:not(:disabled),input,select,pre')];
        const i = focusable.indexOf(document.activeElement); event.preventDefault(); focusable[(i + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
      }
    };
    modal = state; (box.querySelector('input') || box.querySelector('button') || box).focus();
    return state;
  }
  async function ask(title, value = '') {
    const input = node('input'); input.value = value; input.setAttribute('aria-label', title);
    const d = dialog(title, [input], [['Cancel', false], ['OK', true]]);
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); d.box.querySelectorAll('button')[1].click(); } };
    input.select(); return await d.result ? input.value : null;
  }
  async function view() {
    const p = current(), e = rows(p)[p.cursor]; if (!e || e.parent || e.kind === 'dir') return;
    const r = await rpc('fs.readText', { path: join(p.path, e.name), maxBytes: 1048576 });
    const content = r.ok ? r.text : r.reason === 'binary' ? 'Binary file' : `Cannot view: ${r.reason}`;
    const pre = node('pre', content); pre.tabIndex = 0;
    const d = dialog(e.name, [node('p', r.truncated ? 'Too large, first 1 MB shown' : ''), pre], [['Close', true]]); d.box.classList.add('viewer');
  }
  function handBack(event) {
    if (!port || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    port.postMessage({ v: 1, kind: 'key', key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat });
  }
  async function goTo() {
    const p = current(), input = await ask('Go to folder', p.path); if (input === null || !input.trim()) return;
    const value = input.trim();
    // `~` is the home folder; wmux expands it.
    const absolute = value === '~' || /^~[\\/]/.test(value) || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
    try { await load(p, absolute ? value : join(p.path, value)); }
    catch (e) { notice.textContent = `Cannot open ${value}: ${e.message === 'unavailable' ? 'no such folder, or not allowed' : e.message}`; }
  }
  async function rename() {
    const p = current(), e = rows(p)[p.cursor]; if (e.parent) return;
    const name = await ask('Rename', e.name); if (name === null) return;
    await checked('fs.rename', { path: join(p.path, e.name), newName: name }); await refresh();
  }
  async function mkdir() {
    const p = current(), name = await ask('Create folder'); if (name === null) return;
    if (!name || /[\\/\0]/.test(name) || name === '.' || name === '..') throw new Error('Enter a single folder name.');
    await checked('fs.mkdir', { path: join(p.path, name) }); await refresh();
  }
  async function transfer(kind) {
    if (count < 2) return;
    const p = current(), entries = selected(p); if (!entries.length) return;
    const destDir = panels[(active + 1) % count].path;
    const choice = node('select'); choice.setAttribute('aria-label', 'Existing files');
    for (const value of ['skip', 'overwrite']) { const option = node('option', value === 'skip' ? 'Skip existing files' : 'Overwrite existing files'); option.value = value; choice.append(option); }
    const d = dialog(kind === 'copy' ? 'Copy files' : 'Move files', [node('p', `${entries.length} items to\n${destDir}`), choice], [['Cancel', false], ['Continue', true]]);
    if (!await d.result) return;
    await job(`fs.${kind}`, { sources: entries.map((e) => join(p.path, e.name)), destDir, conflict: choice.value });
    p.marks.clear(); render();
  }
  async function trash() {
    const p = current(), entries = selected(p); if (!entries.length) return;
    const d = dialog('Move to Trash', [node('p', `${entries.length} items:\n${entries.map((e) => e.name).join('\n')}`)], [['Cancel', false], ['Move to Trash', true]]);
    if (await d.result) { await job('fs.trash', { paths: entries.map((e) => join(p.path, e.name)) }); p.marks.clear(); render(); }
  }
  async function job(method, params) {
    const result = await checked(method, params);
    const bar = node('progress'); bar.max = 1; bar.value = 0;
    const status = node('p', 'Starting…'), file = node('p'), errors = node('p', '', 'errors');
    const d = dialog('File operation', [bar, status, file, errors]);
    const cancel = button('Cancel', async () => { cancel.disabled = true; try { await checked('fs.job.cancel', { jobId: result.jobId }); } catch (e) { cancel.disabled = false; errors.textContent = e.message; } });
    d.box.querySelector('.actions').append(cancel); cancel.focus(); d.close = () => cancel.click();
    try {
      for (;;) {
        const { job: j } = await checked('fs.job.status', { jobId: result.jobId });
        bar.value = j.totalBytes ? j.doneBytes / j.totalBytes : j.totalItems ? j.doneItems / j.totalItems : 0;
        status.textContent = `${j.state} · ${j.doneItems}/${j.totalItems} items · ${j.doneBytes}/${j.totalBytes} bytes`;
        file.textContent = j.current || ''; errors.textContent = j.errors.map((e) => `${e.path}: ${e.reason}`).join('\n');
        if (j.state !== 'running') break;
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (e) { errors.textContent = e.message; }
    finally {
      const finish = () => { d.box.querySelector('.actions').replaceChildren(); modal = null; d.box.parentElement.remove(); page.focus(); };
      d.close = finish; d.box.querySelector('.actions').replaceChildren(button('Close', finish));
      d.box.querySelector('button').focus(); await refresh();
    }
  }
  async function wildcard(mark) {
    const p = current(), pattern = await ask(mark ? 'Mark wildcard' : 'Unmark wildcard', '*'); if (pattern === null) return;
    const re = new RegExp('^' + pattern.split('').map((c) => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'i');
    for (const e of p.entries) if (re.test(e.name)) { if (mark) p.marks.add(e.name); else p.marks.delete(e.name); } render();
  }
  const commands = { F2: rename, F3: view, F5: () => transfer('copy'), F6: () => transfer('move'), F7: mkdir, F8: trash, F10: goTo };
  for (const [key, label] of [['F2', 'Rename'], ['F3', 'View'], ['F5', 'Copy'], ['F6', 'Move'], ['F7', 'Mkdir'], ['F8', 'Trash'], ['F10', 'Go to']]) document.querySelector('#keys').append(button(`${key} ${label}`, commands[key]));
  page.onkeydown = (event) => {
    if (modal) return;
    const key = event.key, p = current(); let action;
    // event.code, not key: on macOS Option+1 types '¡'.
    const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
    if (event.ctrlKey && digit && digit <= '3') action = () => layout(Number(digit));
    else if (event.altKey && digit) action = () => quick(Number(digit));
    else if (event.ctrlKey && key.toLowerCase() === 'r') action = refresh;
    // A chord this page does not use goes back to wmux, which runs it only
    // when it is a plugin page shortcut (so this page's own key closes it).
    else if (event.ctrlKey || event.metaKey || event.altKey) { handBack(event); return; }
    else if (commands[key]) action = commands[key];
    else if (key === 'Tab') action = () => { active = (active + (event.shiftKey ? count - 1 : 1)) % count; render(); };
    else if (key === 'Enter' || key === 'ArrowRight') action = () => open();
    else if (key === 'Backspace' || key === 'ArrowLeft') action = () => p.parent && load(p, p.parent);
    else if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(key)) action = () => {
      const step = Math.max(1, Math.floor((host.querySelector('.rows')?.clientHeight || 500) / ROW) - 1);
      cursor(key === 'Home' ? 0 : key === 'End' ? p.entries.length : p.cursor + (key.endsWith('Up') ? -1 : 1) * (key.startsWith('Page') ? step : 1));
    };
    else if (key === ' ' || key === 'Insert') action = () => { const e = rows(p)[p.cursor]; if (!e.parent) { if (p.marks.has(e.name)) p.marks.delete(e.name); else p.marks.add(e.name); } cursor(p.cursor + 1); };
    else if (key === '*') action = () => { for (const e of p.entries) { if (p.marks.has(e.name)) p.marks.delete(e.name); else p.marks.add(e.name); } render(); };
    else if (key === '+' || key === '-') action = () => wildcard(key === '+');
    else if (key.toLowerCase() === 's') action = () => { p.sort = (p.sort + 1) % 3; sort(p); cursor(0); };
    else if (key.length === 1 && /[\p{L}\p{N}._]/u.test(key)) action = () => {
      const now = Date.now(); prefix = now - prefixTime < 800 ? prefix + key.toLowerCase() : key.toLowerCase(); prefixTime = now;
      const index = rows(p).findIndex((e) => !e.parent && e.name.toLowerCase().startsWith(prefix)); if (index >= 0) cursor(index);
    };
    if (action) { event.preventDefault(); safely(action); }
  };
  async function initialize(lifetime) {
    await getPanes(); if (lifetime !== epoch) return;
    const dir = (panes.find((p) => p.active) || panes[0])?.cwd || '/';
    await Promise.all(panels.map(async (p) => { try { await load(p, dir); } catch (e) { if (dir === '/') throw e; await load(p, '/'); } }));
    notice.textContent = 'Tab switches panels · Space marks · s sorts · Ctrl+R refreshes'; page.focus();
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.v !== 1 || event.data.kind !== 'init' || !event.ports[0]) return;
    epoch++; port?.close();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Bridge reconnected.')); } pending.clear();
    port = event.ports[0]; port.onmessage = ({ data }) => {
      if (data?.v !== 1) return;
      if (data.kind === 'theme') {
        for (const [name, value] of Object.entries(data.variables || {})) if (/^--[a-z-]+$/.test(name) && typeof value === 'string') document.documentElement.style.setProperty(name, value);
        document.documentElement.style.colorScheme = data.colorScheme === 'light' ? 'light' : 'dark';
      } else if (data.kind === 'response' && pending.has(data.id)) {
        const p = pending.get(data.id); pending.delete(data.id); clearTimeout(p.timer);
        if (data.error) p.reject(new Error(data.error.message)); else p.resolve(data.result);
      }
    };
    port.start(); safely(() => initialize(epoch));
  });
  window.addEventListener('pagehide', () => { port?.close(); for (const p of pending.values()) clearTimeout(p.timer); });
  new ResizeObserver(() => { for (const [i, list] of [...host.querySelectorAll('.rows')].entries()) if (panels[i].entries.length > 2000) drawRows(panels[i], list); }).observe(host);
  render(); page.focus();
})();
