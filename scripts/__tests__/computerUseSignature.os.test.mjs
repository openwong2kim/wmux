// native/computer-use-macos/check-signature.sh against small helper bundles
// built here: two C programs standing in for the helper and the nested
// agent-desktop binary, signed ad-hoc the way build.sh signs (without
// --release, so no team signature is needed). macOS only: it needs cc,
// codesign and vtool.
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = path.join(ROOT, 'native/computer-use-macos/check-signature.sh');
const HELPER_ID = 'com.electron.wmux.computer-use';
const NESTED_ID = 'com.electron.wmux.agent-desktop';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-sig-'));

/** A Mach-O built for the given minimum macOS. */
function binary(name, minos) {
  const src = path.join(work, `${name}.c`);
  const out = path.join(work, `${name}-${minos}`);
  if (!fs.existsSync(out)) {
    fs.writeFileSync(src, 'int main(void) { return 0; }\n');
    execFileSync('cc', [`-mmacosx-version-min=${minos}`, '-arch', 'arm64', '-o', out, src]);
  }
  return out;
}

const sign = (target, identifier, extra = []) =>
  execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', '--identifier', identifier, ...extra, target], { stdio: 'pipe' });

/** A helper bundle as build.sh lays it out; `before` runs before the bundle is signed. */
function bundle(label, { nestedMinos = '11.0', before, signNested = true } = {}) {
  const app = path.join(work, label, 'wmux Computer Use.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  fs.copyFileSync(binary('helper', '14.0'), path.join(app, 'Contents/MacOS/wmux-computer-use'));
  fs.copyFileSync(binary('nested', nestedMinos), path.join(app, 'Contents/MacOS/agent-desktop'));
  fs.writeFileSync(
    path.join(app, 'Contents/Info.plist'),
    fs.readFileSync(path.join(ROOT, 'native/computer-use-macos/Support/Info.plist'), 'utf8').replace(/__VERSION__/g, '0.0.0'),
  );
  fs.writeFileSync(path.join(app, 'Contents/Resources/AppIcon.icns'), 'icon');
  before?.(app);
  if (signNested) sign(path.join(app, 'Contents/MacOS/agent-desktop'), NESTED_ID);
  sign(app, HELPER_ID);
  return app;
}

const check = (app) => spawnSync('bash', [CHECK, app], { encoding: 'utf8' });

describe.skipIf(process.platform !== 'darwin')('check-signature.sh', () => {
  it('passes a bundle laid out and signed as build.sh does', () => {
    const r = check(bundle('good'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails a nested binary built for a later macOS than the helper supports', () => {
    const r = check(bundle('minos', { nestedMinos: '15.0' }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('agent-desktop requires macOS 15.0');
  });

  it('fails a bundle that ships anything besides the two binaries, the plist and the icon', () => {
    const r = check(bundle('extra', {
      before: (app) => {
        fs.mkdirSync(path.join(app, 'Contents/Resources/skills/agent-desktop'), { recursive: true });
        fs.writeFileSync(path.join(app, 'Contents/Resources/skills/agent-desktop/SKILL.md'), '# vendored\n');
      },
    }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unexpected files in the bundle: ./Contents/Resources/skills/agent-desktop/SKILL.md');
  });

  it('fails a nested binary changed after signing', () => {
    const app = bundle('tampered');
    const nested = path.join(app, 'Contents/MacOS/agent-desktop');
    const bytes = fs.readFileSync(nested);
    // A byte of a code page (the signature blob at the end is not hashed).
    bytes[0x3000] ^= 0xff;
    fs.writeFileSync(nested, bytes);
    expect(check(app).status).not.toBe(0);
    // Verifying the bundle alone does not open the nested binary's pages;
    // --deep does. The runner checks the nested binary itself before every
    // spawn (Runner.swift, ChildGate).
    expect(spawnSync('codesign', ['--verify', '--strict', app]).status).toBe(0);
    expect(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status).not.toBe(0);
  });

  it('fails an unsigned nested binary', () => {
    expect(check(bundle('unsigned', { signNested: false })).status).not.toBe(0);
  });

  it('fails a nested binary signed with entitlements', () => {
    const plist = path.join(work, 'ent.plist');
    fs.writeFileSync(plist, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>\n');
    const r = check(bundle('entitled', {
      signNested: false,
      before: (app) => sign(path.join(app, 'Contents/MacOS/agent-desktop'), NESTED_ID, ['--entitlements', plist]),
    }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('agent-desktop carries entitlements');
  });
});
