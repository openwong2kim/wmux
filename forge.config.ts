import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import * as fs from 'fs';
import * as path from 'path';

// Read version from package.json so MakerSquirrel.setupExe emits a
// deterministic filename that matches chocolateyInstall.ps1's download
// URL and the winget-releaser regex in .github/workflows/release.yml.
// Without this override electron-winstaller defaults to
// `wmux-{version} Setup.exe` (space), which 404s the Choco install and
// fails the `\.Setup\.exe$` regex — silently, because winget-releaser
// runs with continue-on-error.
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')) as { version: string };
const SQUIRREL_SETUP_EXE = `wmux-${pkg.version}.Setup.exe`;

// macOS code-signing + notarization gates.
//   macSignEnabled     — sign only (CI=true + Apple ID + Team ID + darwin host).
//                        Restricting to CI prevents local devs who happen to
//                        have APPLE_ID exported from triggering an unintended
//                        5-15 minute notarize on `npm start` / `npm run package`.
//   macNotarizeEnabled — additionally requires APPLE_APP_SPECIFIC_PASSWORD and
//                        WMUX_SKIP_NOTARIZE != 'true'. ci.yml sets the skip
//                        flag (sign-only ~1-2 min); release.yml leaves it
//                        unset for full notarization on tagged builds.
const macSignEnabled =
  process.env.CI === 'true' &&
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_TEAM_ID &&
  process.platform === 'darwin';
const macNotarizeEnabled =
  macSignEnabled &&
  process.env.WMUX_SKIP_NOTARIZE !== 'true' &&
  !!process.env.APPLE_APP_SPECIFIC_PASSWORD;

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/node_modules/node-pty/**',
    },
    icon: './assets/icon',
    extraResource: ['./dist/mcp-bundle', './dist/daemon-bundle', './assets/icon.ico', './THIRD_PARTY_NOTICES', './src/main/pty/shell-hooks'],
    appBundleId: 'com.openwong2kim.wmux',
    // Sign on CI macOS jobs (see macSignEnabled above). Local dev/Windows
    // builds skip silently.
    ...(macSignEnabled ? {
      osxSign: {
        // Optional. If unset, electron-osx-sign auto-discovers the first
        // 'Developer ID Application' identity from the keychain.
        identity: process.env.APPLE_SIGNING_IDENTITY,
        optionsForFile: (_filePath: string) => {
          // Apply the same hardened-runtime entitlements to the .app and
          // every nested binary (incl. node-pty native bindings).
          return {
            entitlements: './build/entitlements.mac.plist',
            'hardened-runtime': true,
          };
        },
      },
    } : {}),
    // Notarize only on tagged release builds (release.yml). ci.yml sets
    // WMUX_SKIP_NOTARIZE=true for sign-only PR/push validation.
    // @electron/packager 18+ uses notarytool by default; the legacy
    // `tool: 'notarytool'` field was removed from the type.
    ...(macNotarizeEnabled ? {
      osxNotarize: {
        appleId: process.env.APPLE_ID!,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD!,
        teamId: process.env.APPLE_TEAM_ID!,
      },
    } : {}),
    extendInfo: {
      // false = show in Dock + menu bar. Flip to true if we ever ship a
      // pure-tray edition (would also need to drop the main window).
      LSUIElement: false,
      NSHighResolutionCapable: true,
    },
  },
  hooks: {
    postPackage: async (_config, packageResult) => {
      const asar = require('@electron/asar');
      const outputPath = packageResult.outputPaths[0];
      const asarPath = path.join(outputPath, 'resources', 'app.asar');
      const tempDir = path.join(outputPath, 'resources', '_app_tmp');
      const unpackedDir = asarPath + '.unpacked';

      // 1. Extract existing asar
      console.log('[postPackage] Extracting asar...');
      asar.extractAll(asarPath, tempDir);

      // 2. Copy node-pty into extracted app
      const destNodePty = path.join(tempDir, 'node_modules', 'node-pty');
      console.log(`[postPackage] Copying node-pty...`);
      copyDirSync(path.join(__dirname, 'node_modules', 'node-pty'), destNodePty);
      const srcAddonApi = path.join(__dirname, 'node_modules', 'node-addon-api');
      if (fs.existsSync(srcAddonApi)) {
        copyDirSync(srcAddonApi, path.join(tempDir, 'node_modules', 'node-addon-api'));
      }

      // 3. Repack asar with native files unpacked
      console.log('[postPackage] Repacking asar...');
      fs.unlinkSync(asarPath);
      if (fs.existsSync(unpackedDir)) fs.rmSync(unpackedDir, { recursive: true });
      await asar.createPackageWithOptions(tempDir, asarPath, {
        unpack: '*.node',
      });

      // 4. Cleanup temp
      fs.rmSync(tempDir, { recursive: true });
      console.log('[postPackage] Done — node-pty bundled in asar.');

      // 5. Copy node-pty into daemon-bundle/node_modules so the detached daemon process can find it
      const daemonBundleDir = path.join(outputPath, 'resources', 'daemon-bundle');
      if (fs.existsSync(daemonBundleDir)) {
        const daemonNodePty = path.join(daemonBundleDir, 'node_modules', 'node-pty');
        console.log('[postPackage] Copying node-pty for daemon-bundle...');
        copyDirSync(path.join(__dirname, 'node_modules', 'node-pty'), daemonNodePty);
        console.log('[postPackage] Done — node-pty available for daemon.');
      }

      // 6. Remove .ps1 files from resources — NuGet 2.8 treats PowerShell files
      //    outside the 'tools' folder as errors, breaking Squirrel nupkg creation.
      const resourcesDir = path.join(outputPath, 'resources');
      const removePsFiles = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          // Preserve .ps1 files in shell-hooks — they are runtime hook scripts, not NuGet tools
          if (entry.isDirectory()) {
            if (entry.name === 'shell-hooks') continue;
            removePsFiles(full);
          }
          else if (entry.name.endsWith('.ps1')) {
            fs.unlinkSync(full);
            console.log(`[postPackage] Removed ${path.relative(outputPath, full)}`);
          }
        }
      };
      removePsFiles(resourcesDir);
    },
  },
  makers: [
    new MakerSquirrel({
      name: 'wmux',
      setupExe: SQUIRREL_SETUP_EXE,
      setupIcon: './assets/icon.ico',
      iconUrl: 'https://raw.githubusercontent.com/openwong2kim/wmux/main/assets/icon.ico',
    }),
    // Squirrel.Mac auto-update consumes the .zip. Keep alongside DMG.
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      icon: './assets/icon.icns', // produced by T4
      // TODO(2026-Q3): arm64 is hardcoded intentionally. If x64 (Intel) or a
      //   universal fat binary is added, switch to `wmux-${pkg.version}-${process.arch}`
      //   (or `-universal`) AND update release.yml's DMG glob/asset names.
      //   Do not auto-derive from process.arch silently — release naming is a
      //   distribution contract (winget/choco/Sparkle feed assumptions).
      name: `wmux-${pkg.version}-arm64`,
      format: 'ULFO', // Apple-recommended LZFSE compression
    }, ['darwin']), // arm64-only this sprint; x64 in a follow-up
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      // Required: daemon process uses ELECTRON_RUN_AS_NODE=1 to spawn
      // a detached Node.js process from wmux.exe. Acceptable for a terminal
      // multiplexer that already executes arbitrary shell commands.
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // Disabled: postPackage hook repacks asar (for node-pty), which changes the hash.
      // Enabling this causes FATAL integrity check failure at runtime.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
