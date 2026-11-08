// A real-Chrome suite's downloads go to a temp folder the profile names, and
// the account's own Downloads folder is only ever read, by file name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountDownloads, pinDownloadDir } from '../chromeDownloads';
import { trackedTempDir } from '../trackedTempDir';

describe('chromeDownloads', () => {
  it('pins the profile\'s default download folder to a new temp dir', () => {
    const profile = trackedTempDir('wmux-pin-profile-');
    const downloads = pinDownloadDir(profile);
    try {
      expect(fs.statSync(downloads).isDirectory()).toBe(true);
      const prefs = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8')) as { download: Record<string, unknown> };
      expect(prefs.download).toEqual({ default_directory: downloads, prompt_for_download: false });
    } finally {
      fs.rmdirSync(downloads);
    }
  });

  it('finds only what Chrome could have saved under the served names, and reads nothing it can\'t', () => {
    const dir = trackedTempDir('wmux-account-downloads-');
    for (const name of ['file.bin', 'file (1).bin', 'file (12).bin.crdownload', 'slow.bin', 'myfile.bin', 'file.bin.txt', 'file(1).bin', 'other.zip']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
    expect([...accountDownloads(['file.bin', 'slow.bin'], dir)].sort()).toEqual(['file (1).bin', 'file (12).bin.crdownload', 'file.bin', 'slow.bin']);
    expect(accountDownloads(['file.bin'], path.join(dir, 'missing')).size).toBe(0);
    // Read only: everything is still there.
    expect(fs.readdirSync(dir)).toHaveLength(8);
  });

  it("by default also reads the test home's Downloads, where a browser on Windows falls back to", () => {
    // os.homedir() is the setup's temp home: writing there never reaches the account.
    const homeDownloads = path.join(os.homedir(), 'Downloads');
    fs.mkdirSync(homeDownloads, { recursive: true });
    const name = `wmux-fallback-${process.pid}-${Date.now()}.bin`;
    fs.writeFileSync(path.join(homeDownloads, name), '');
    try {
      expect(accountDownloads([name]).has(name)).toBe(true);
    } finally {
      fs.rmSync(path.join(homeDownloads, name));
    }
  });
});
