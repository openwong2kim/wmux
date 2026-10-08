import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { helperAppBundlePath, permissionMissingHelp, resolveHelperPathFor, type HelperSpec } from '../helperPath';

const spec: HelperSpec = { dir: 'computer-use-windows', exe: 'wmux-computer-use.exe' };
const resourcesPath = path.resolve('/Program Files/wmux/resources');
const appPath = path.resolve('/src/wmux');
const override = path.resolve('/tmp/my-helper.exe');

describe('computer-use helper path', () => {
  it('packaged builds run only the bundled helper, whatever the environment says', () => {
    expect(resolveHelperPathFor({ spec, isPackaged: true, resourcesPath, appPath, env: { WMUX_COMPUTER_HELPER: override } }))
      .toBe(path.join(resourcesPath, 'computer-use-windows', 'wmux-computer-use.exe'));
  });

  it('packaged builds on an OS with no helper stay unsupported even with the override set', () => {
    expect(resolveHelperPathFor({ spec: null, isPackaged: true, resourcesPath, appPath, env: { WMUX_COMPUTER_HELPER: override } }))
      .toBeNull();
  });

  it('dev builds honour an absolute override', () => {
    expect(resolveHelperPathFor({ spec, isPackaged: false, resourcesPath, appPath, env: { WMUX_COMPUTER_HELPER: override } }))
      .toBe(override);
  });

  it('dev builds ignore a bare-name override instead of letting spawn search PATH', () => {
    expect(resolveHelperPathFor({ spec, isPackaged: false, resourcesPath, appPath, env: { WMUX_COMPUTER_HELPER: 'helper.exe' } }))
      .toBe(path.join(appPath, 'native', 'computer-use-windows', 'dist', 'wmux-computer-use.exe'));
  });

  it('dev builds without an override use the helper project output', () => {
    expect(resolveHelperPathFor({ spec, isPackaged: false, resourcesPath, appPath, env: {} }))
      .toBe(path.join(appPath, 'native', 'computer-use-windows', 'dist', 'wmux-computer-use.exe'));
  });
});

describe('helperAppBundlePath / permissionMissingHelp', () => {
  it('finds the .app bundle around the helper binary, and nothing outside one', () => {
    expect(helperAppBundlePath('/Applications/wmux.app/Contents/Resources/computer-use-macos/wmux Computer Use.app/Contents/MacOS/wmux-computer-use'))
      .toBe('/Applications/wmux.app/Contents/Resources/computer-use-macos/wmux Computer Use.app');
    expect(helperAppBundlePath('C:\\wmux\\resources\\computer-use-windows\\wmux-computer-use.exe')).toBeNull();
    expect(helperAppBundlePath(null)).toBeNull();
  });

  it('names the full path and the remove-and-re-add / Reset access fix', () => {
    const text = permissionMissingHelp('/x/wmux Computer Use.app');
    expect(text).toContain('"/x/wmux Computer Use.app"');
    expect(text).toContain('remove it with "−" and add it again');
    expect(text).toContain('Settings › Computer use › Reset access');
  });
});
