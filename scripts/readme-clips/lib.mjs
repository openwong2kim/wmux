// Shared helpers for the README clip kit: instance paths, the daemon RPC,
// the screencast recorder, the cursor overlay and the frame-timing math.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 'readme1' or '-readme1' -> '-readme1' (node's parseArgs rejects a value starting with '-'). */
export function normSuffix(s) {
  return s && !s.startsWith('-') ? `-${s}` : s;
}

/** Everything an isolated instance owns, derived from its WMUX_DATA_SUFFIX. */
export function instancePaths(suffix) {
  suffix = normSuffix(suffix);
  if (!/^-[A-Za-z0-9_-]+$/.test(suffix || '')) {
    throw new Error(`suffix must look like -readme1, got ${JSON.stringify(suffix)}`);
  }
  const home = os.homedir();
  const userData = path.join(home, 'Library', 'Application Support', `wmux${suffix}`);
  return {
    suffix,
    dataDir: path.join(home, `.wmux${suffix}`),
    appSocket: path.join(home, `.wmux${suffix}.sock`),
    userData,
    chromeProfile: path.join(userData, 'chrome-agent-profile'),
    stateDir: path.join(process.env.READMECLIPS_STATE || path.join(os.tmpdir(), 'readme-clips-state'), suffix),
  };
}

/** The renderer CDP port that launch.sh read from the app log. */
export function readCdpPort(suffix) {
  const file = path.join(instancePaths(suffix).stateDir, 'cdp-port');
  if (!fs.existsSync(file)) throw new Error(`no ${file}; run launch.sh ${suffix} first`);
  return Number(fs.readFileSync(file, 'utf8').trim());
}

/**
 * One newline-framed request to the isolated daemon
 * ({id, token, method, params} -> {id, ok, result|error}).
 */
export function daemonRpc(suffix, method, params = {}, timeoutMs = 20000) {
  const { dataDir } = instancePaths(suffix);
  const pipeFile = path.join(dataDir, 'daemon-pipe');
  const sock = fs.existsSync(pipeFile) ? fs.readFileSync(pipeFile, 'utf8').trim() : path.join(dataDir, 'daemon.sock');
  const token = fs.readFileSync(path.join(dataDir, 'daemon-auth-token'), 'utf8').trim();
  const id = `rc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
    s.on('connect', () => s.write(`${JSON.stringify({ id, token, method, params })}\n`));
    s.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        clearTimeout(t);
        s.end();
        return msg.ok ? resolve(msg.result) : reject(new Error(JSON.stringify(msg.error)));
      }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/** Env for anything spawned against the isolated instance: no caller identity. */
export function scrubbedEnv(suffix) {
  const env = { ...process.env, WMUX_DATA_SUFFIX: normSuffix(suffix) };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC|AI_AGENT)/.test(k)) delete env[k];
  }
  for (const k of ['WMUX_PTY_ID', 'WMUX_WORKSPACE_ID', 'WMUX_SURFACE_ID', 'WMUX_MEMBER_ID', 'WMUX_SOCKET_PATH']) delete env[k];
  return env;
}

/** Run the wmux CLI against the isolated instance only. */
export function wmuxCli(suffix, args) {
  const r = spawnSync('wmux', args, { env: scrubbedEnv(suffix), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wmux ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export function loadPlaywright() {
  // Resolve from the repo (playwright-core is a devDependency), not from this folder.
  const req = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return req('playwright-core');
  } catch {
    throw new Error('playwright-core not found: run `npm ci` in the repo root and call the kit from there');
  }
}

/**
 * Screencast frames arrive only when the page repaints, so an idle screen sends
 * none. Turn the timestamped frames into an ffmpeg concat list in which every
 * frame is held until the next one (and the last one until `endMs`), so the
 * video keeps wall-clock time.
 * frames: [{file, t}] with t in ms, ascending. Returns the concat file text.
 */
export function buildConcatList(frames, endMs) {
  if (frames.length === 0) throw new Error('no frames recorded');
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(endMs, frames[i].t + 1);
    lines.push(`file '${frames[i].file}'`, `duration ${((next - frames[i].t) / 1000).toFixed(3)}`);
  }
  // The concat demuxer ignores the last duration unless the file repeats.
  lines.push(`file '${frames[frames.length - 1].file}'`);
  return `${lines.join('\n')}\n`;
}

/**
 * Pick which incoming frames to write at a capped rate. Returns a function
 * taking a frame time (ms) and returning true when it should be written now.
 * A frame that arrives too soon is kept as pending by the caller and written
 * when the gap has passed or recording stops, so the final state is never lost.
 */
export function rateGate(maxFps) {
  const minGap = 1000 / maxFps;
  let last = -Infinity;
  return (t) => {
    if (t - last >= minGap) { last = t; return true; }
    return false;
  };
}

/**
 * Records one CDP target as a frame sequence plus marks, then encodes an mp4.
 * Used by rec.mjs (the wmux renderer) and rec-chrome.mjs (a dedicated Chrome tab).
 */
export class Recorder {
  constructor(page, outDir, { maxFps = 30, maxWidth = 2560, maxHeight = 1600, quality = 90 } = {}) {
    this.page = page;
    this.outDir = outDir;
    this.framesDir = path.join(outDir, 'frames');
    this.opts = { maxFps, maxWidth, maxHeight, quality };
    this.frames = [];
    this.marks = [];
    this.pending = null;
    this.n = 0;
  }

  async start() {
    fs.mkdirSync(this.framesDir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    const gate = rateGate(this.opts.maxFps);
    this.cdp.on('Page.screencastFrame', (f) => {
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      const t = f.metadata?.timestamp ? f.metadata.timestamp * 1000 : Date.now();
      if (this.t0 === undefined) this.t0 = t;
      const frame = { data: f.data, t };
      if (gate(t)) {
        this.pending = null;
        this.write(frame);
      } else {
        this.pending = frame;
      }
    });
    // Keep focus rings and carets painting while the window is not frontmost.
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: this.opts.quality, maxWidth: this.opts.maxWidth, maxHeight: this.opts.maxHeight,
    });
    this.startedAt = Date.now();
  }

  write(frame) {
    const file = `f${String(++this.n).padStart(6, '0')}.jpg`;
    fs.writeFileSync(path.join(this.framesDir, file), Buffer.from(frame.data, 'base64'));
    this.frames.push({ file, t: frame.t });
  }

  /** Name a moment so export.sh can cut around it. */
  mark(name) {
    const t = Date.now();
    this.marks.push({ name, t });
    console.log(`[mark] ${name} @ ${this.rel(t).toFixed(2)}s`);
  }

  rel(t) {
    return ((t - (this.t0 ?? this.startedAt)) / 1000);
  }

  async stop() {
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    if (this.pending) this.write(this.pending);
    const endMs = Date.now();
    const t0 = this.frames[0]?.t ?? this.startedAt;
    const frames = this.frames.map((f) => ({ file: f.file, t: f.t - t0 }));
    const end = endMs - t0;
    fs.writeFileSync(path.join(this.framesDir, 'list.ffconcat'), buildConcatList(frames, end));
    const marks = this.marks.map((m) => ({ name: m.name, s: +((m.t - t0) / 1000).toFixed(3) }));
    this.duration = end / 1000;
    // t0 = wall-clock ms of video time 0, so two recordings of one take (rec + rec-chrome) can be aligned.
    fs.writeFileSync(path.join(this.outDir, 'marks.json'), `${JSON.stringify({ t0, duration: +this.duration.toFixed(3), marks }, null, 2)}\n`);
    return { frames: frames.length, seconds: end / 1000 };
  }

  /** Constant 30 fps mp4, keyframe every 30 frames (HyperFrames wants dense keyframes). */
  encode(mp4Path) {
    const r = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', path.join(this.framesDir, 'list.ffconcat'), '-t', this.duration.toFixed(3),
      '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-c:v', 'libx264', '-crf', '18', '-g', '30', '-movflags', '+faststart', mp4Path,
    ], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg encode failed');
  }
}

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="28" viewBox="0 0 22 28"><path d="M1.5 1.5v21.2l5.3-5.1 3.6 8.4 3.6-1.5-3.6-8.3h7.4z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/**
 * A drawn cursor for the screencast (CDP frames never contain the OS cursor).
 * Every move animates the overlay and then sends the real Playwright mouse
 * event, so what the clip shows is what the app received.
 */
export class Cursor {
  constructor(page) {
    this.page = page;
    this.x = 40;
    this.y = 40;
  }

  async install() {
    await this.page.evaluate(({ svg, x, y }) => {
      if (document.getElementById('__rc_cursor')) return;
      const c = document.createElement('div');
      c.id = '__rc_cursor';
      c.innerHTML = svg;
      Object.assign(c.style, {
        position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
        transform: `translate(${x}px, ${y}px)`, transitionProperty: 'transform',
        transitionTimingFunction: 'cubic-bezier(.4,0,.2,1)', filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.35))',
      });
      document.documentElement.appendChild(c);
      const r = document.createElement('div');
      r.id = '__rc_ripple';
      Object.assign(r.style, {
        position: 'fixed', left: '0', top: '0', width: '28px', height: '28px', marginLeft: '-14px', marginTop: '-14px',
        borderRadius: '50%', background: 'rgba(255,120,0,.35)', zIndex: '2147483646', pointerEvents: 'none', opacity: '0',
      });
      document.documentElement.appendChild(r);
    }, { svg: CURSOR_SVG, x: this.x, y: this.y });
  }

  async locate(target) {
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const box = await loc.boundingBox();
    if (!box) throw new Error(`no box for ${target}`);
    return { loc, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Glide to the centre of a selector/locator. Takes 300-900 ms by distance unless ms is given. */
  async moveTo(target, { ms } = {}) {
    await this.install();
    const { loc, x, y } = await this.locate(target);
    const dist = Math.hypot(x - this.x, y - this.y);
    const dur = ms ?? Math.round(Math.min(900, Math.max(300, dist * 0.8)));
    await this.page.evaluate(({ x, y, dur }) => {
      const c = document.getElementById('__rc_cursor');
      c.style.transitionDuration = `${dur}ms`;
      c.style.transform = `translate(${x}px, ${y}px)`;
    }, { x, y, dur });
    await sleep(dur);
    await this.page.mouse.move(x, y);
    this.x = x;
    this.y = y;
    return loc;
  }

  async click(target, { ms, pauseMs = 250 } = {}) {
    await this.moveTo(target, { ms });
    await this.page.evaluate(({ x, y }) => {
      const r = document.getElementById('__rc_ripple');
      r.style.transition = 'none';
      r.style.transform = `translate(${x}px, ${y}px) scale(.4)`;
      r.style.opacity = '1';
      requestAnimationFrame(() => {
        r.style.transition = 'transform 350ms ease-out, opacity 350ms ease-out';
        r.style.transform = `translate(${x}px, ${y}px) scale(1.4)`;
        r.style.opacity = '0';
      });
    }, { x: this.x, y: this.y });
    await this.page.mouse.down();
    await this.page.mouse.up();
    await sleep(pauseMs);
  }

  /** Drag from one selector to another with the overlay following (Git page hand-off). */
  async drag(from, to, { steps = 20 } = {}) {
    await this.moveTo(from);
    await this.page.mouse.down();
    const { x, y } = await this.locate(to);
    const sx = this.x;
    const sy = this.y;
    for (let i = 1; i <= steps; i++) {
      const px = sx + ((x - sx) * i) / steps;
      const py = sy + ((y - sy) * i) / steps;
      await this.page.mouse.move(px, py);
      await this.page.evaluate(({ px, py }) => {
        const c = document.getElementById('__rc_cursor');
        c.style.transitionDuration = '0ms';
        c.style.transform = `translate(${px}px, ${py}px)`;
      }, { px, py });
      await sleep(30);
    }
    await this.page.mouse.up();
    this.x = x;
    this.y = y;
  }

  /** Type into whatever has focus, at a readable pace. */
  async type(text, { delay = 45 } = {}) {
    await this.page.keyboard.type(text, { delay });
  }

  async press(key) {
    await this.page.keyboard.press(key);
  }
}
