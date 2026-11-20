import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ChromeLauncher, setPipeRelayForTests, setRelayAdmission, type ChromeProtectionPlan } from '../ChromeLauncher';
import { CdpPipeRelay, type RelayGrant } from '../CdpPipeRelay';
import { compileHostPolicy } from '../../../shared/browserHostPolicy';
import { chromeForRuntimeSuite } from '../../../test-utils/runtimeChrome';
import { CHROME_TEARDOWN_TIMEOUT_MS, stopChrome, tempChromeProfile, type TempChromeProfile } from '../../../test-utils/chromeProfile';

// ---------------------------------------------------------------------------
// The script in docs/how-to/drive-chrome-from-a-script.md, run as the doc
// prints it, with a grant piped into its stdin: against a protected profile
// on the debugging pipe with target grants on, the way `wmux browser cdp`
// hands one out. It checks the relay's proof, opens its own tab and reaches
// an https page; a chrome:// URL is refused; and with a wrong proof key it
// stops before using the connection.
// ---------------------------------------------------------------------------

const CHROME = chromeForRuntimeSuite();
const CASE_TIMEOUT_MS = 90_000;
const DOC = path.join(__dirname, '..', '..', '..', '..', 'docs', 'how-to', 'drive-chrome-from-a-script.md');
const REPO_MODULES = path.join(__dirname, '..', '..', '..', '..', 'node_modules');
/** A test certificate already in the repo: Chrome runs with --ignore-certificate-errors, so any will do. */
const CERT_DIR = path.join(__dirname, '..', '..', '..', 'daemon', 'a2aRemote', '__tests__', 'fixtures');

/** The fenced block after the doc's `<!-- drive.mjs -->` marker, verbatim. */
function docScript(): string {
  const text = fs.readFileSync(DOC, 'utf8');
  const marker = text.indexOf('<!-- drive.mjs -->');
  expect(marker).toBeGreaterThan(-1);
  const open = text.indexOf('```js\n', marker);
  const close = text.indexOf('\n```', open + 6);
  return text.slice(open + 6, close + 1);
}

let server: https.Server;
let port = 0;
let relayRoot: string | null = null;
let scriptDir = '';
const rigs: Array<{ launcher: ChromeLauncher; profile: TempChromeProfile }> = [];

beforeAll(async () => {
  const tls = { cert: fs.readFileSync(path.join(CERT_DIR, 'cert-a.pem')), key: fs.readFileSync(path.join(CERT_DIR, 'key-a.pem')) };
  server = https.createServer(tls, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>doc page ${req.url}</title>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  relayRoot = process.platform === 'win32' ? null : fs.mkdtempSync('/tmp/wmux-doc-');
  if (relayRoot) fs.chmodSync(relayRoot, 0o700);
  await setPipeRelayForTests(new CdpPipeRelay({ roots: relayRoot ? [relayRoot] : [] }));
  setRelayAdmission(() => null);
  // The script as the doc prints it, beside a node_modules that resolves playwright-core.
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-drive-doc-'));
  fs.writeFileSync(path.join(scriptDir, 'drive.mjs'), docScript());
  fs.mkdirSync(path.join(scriptDir, 'node_modules'));
  fs.symlinkSync(path.join(REPO_MODULES, 'playwright-core'), path.join(scriptDir, 'node_modules', 'playwright-core'), 'junction');
});

afterEach(async () => {
  for (const { launcher, profile } of rigs.splice(0)) {
    await stopChrome(launcher);
    await profile.remove();
  }
  vi.unstubAllEnvs();
}, CHROME_TEARDOWN_TIMEOUT_MS);

afterAll(async () => {
  server?.close();
  setRelayAdmission(null);
  await setPipeRelayForTests(null);
  if (relayRoot) fs.rmSync(relayRoot, { recursive: true, force: true });
  if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true });
});

const plan: ChromeProtectionPlan = {
  matcher: () => compileHostPolicy({ mode: 'allowlist', allow: ['a.test'], block: [] }),
  resolve: (_host, p) => ({ host: '127.0.0.1', port: p }),
};

async function protectedChrome(): Promise<ChromeLauncher> {
  vi.stubEnv('WMUX_CHROME_TRANSPORT', 'auto');
  vi.stubEnv('WMUX_CDP_TARGET_GRANT', '1');
  vi.stubEnv('WMUX_CHROME_PATH', CHROME as string);
  const profile = tempChromeProfile('wmux-drive-doc-');
  const launcher = new ChromeLauncher(profile.dir, {
    portEnvVar: null,
    profileName: 'drive-doc',
    protection: () => plan,
    extraArgs: ['--headless=new', '--use-mock-keychain', '--password-store=basic', '--ignore-certificate-errors'],
  });
  rigs.push({ launcher, profile });
  expect(await launcher.endpoint()).toEqual({ piped: true });
  return launcher;
}

/** Run the doc's script with `grant` on stdin and `url` as its argument. */
function runScript(grant: RelayGrant, url: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptDir, 'drive.mjs'), url], { cwd: scriptDir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(grant));
  });
}

describe.skipIf(!CHROME)('the drive.mjs script from the doc (real Chrome)', () => {
  it('checks the relay proof, opens its own tab and reaches an https page; chrome:// is refused', { timeout: CASE_TIMEOUT_MS }, async () => {
    const launcher = await protectedChrome();
    const identity = { lane: 'pane-script' as const, workspaceId: 'ws-doc', ptyId: 'pty-doc' };
    expect(launcher.narrowedFor(identity)).toBe(true);

    const ran = await runScript(await launcher.relayGrant(identity), `https://a.test:${port}/hello`);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toBe('doc page /hello');

    const internal = await runScript(await launcher.relayGrant(identity), 'chrome://version');
    expect(internal.code).not.toBe(0);
    expect(internal.stdout).not.toContain('Version');

    const tampered = await launcher.relayGrant(identity);
    const wrongKey = await runScript({ ...tampered, proofKey: Buffer.alloc(32, 7).toString('base64url') }, `https://a.test:${port}/never`);
    expect(wrongKey.code).not.toBe(0);
    expect(wrongKey.stderr).toContain('not the wmux relay');
  });
});
