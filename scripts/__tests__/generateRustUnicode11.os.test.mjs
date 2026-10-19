import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

describe('Rust Unicode table verification', () => {
  it('accepts LF/CRLF checkouts and still rejects changed width data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-unicode-check-'));
    try {
      const script = path.join(dir, 'scripts/generate-rust-unicode11.mjs');
      const addon = path.join(dir, 'node_modules/@xterm/addon-unicode11');
      const table = path.join(dir, 'core/wmux-term/vendor/alacritty_terminal/src/wmux_unicode11.rs');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.mkdirSync(path.dirname(addon), { recursive: true });
      fs.mkdirSync(path.dirname(table), { recursive: true });
      fs.copyFileSync(path.join(root, 'scripts/generate-rust-unicode11.mjs'), script);
      fs.cpSync(path.join(root, 'node_modules/@xterm/addon-unicode11'), addon, { recursive: true });
      const expected = fs.readFileSync(path.join(root, 'core/wmux-term/vendor/alacritty_terminal/src/wmux_unicode11.rs'), 'utf8').replace(/\r\n/g, '\n');
      const check = () => spawnSync(process.execPath, [script, '--check'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
      fs.writeFileSync(table, expected);
      expect(check().status).toBe(0);
      fs.writeFileSync(table, expected.replace(/\n/g, '\r\n'));
      const source = path.join(addon, 'src/UnicodeV11.ts');
      fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
      expect(check().status).toBe(0);
      const corrupted = expected.replace('(0x0, 0x1f, 0)', '(0x0, 0x1f, 2)');
      expect(corrupted).not.toBe(expected);
      fs.writeFileSync(table, corrupted);
      const changed = check();
      expect(changed.status).not.toBe(0);
      expect(changed.stderr).toContain('Rust Unicode table is stale');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
