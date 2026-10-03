import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readQuickLaunchConfig, writeQuickLaunchConfig } from '../config';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-quick-launch-')), 'quick-launch.json');

describe('quick launch config', () => {
  it('defaults to on with the default chord when the file is missing or broken', () => {
    const file = tmp();
    expect(readQuickLaunchConfig(file)).toEqual({ enabled: true, accelerator: 'CommandOrControl+Shift+Space' });
    fs.writeFileSync(file, '{not json');
    expect(readQuickLaunchConfig(file).enabled).toBe(true);
  });

  it('round-trips, and falls back to the default chord for a malformed one', () => {
    const file = tmp();
    writeQuickLaunchConfig({ enabled: false, accelerator: 'CommandOrControl+Alt+K' }, file);
    expect(readQuickLaunchConfig(file)).toEqual({ enabled: false, accelerator: 'CommandOrControl+Alt+K' });
    fs.writeFileSync(file, JSON.stringify({ enabled: true, accelerator: 'Shift+A' }));
    expect(readQuickLaunchConfig(file).accelerator).toBe('CommandOrControl+Shift+Space');
  });
});
