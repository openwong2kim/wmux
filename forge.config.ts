import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerAppImage } from '@reforged/maker-appimage';
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
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
  productName: string;
  executableName: string;
};
const SQUIRREL_SETUP_EXE = `fmux-${pkg.version}.Setup.exe`;

function copyDirSync(src: string, dest: string, skipFile?: (name: string) => boolean): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory() && skipFile?.(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath, skipFile);
    else fs.copyFileSync(srcPath, destPath);
  }
}

// node-pty's Windows prebuilds ship ~27 MB of MSVC debug symbols (*.pdb) that
// are never loaded at runtime. Exclude them from BOTH packaged copies (app.asar
// + daemon-bundle); they stay in node_modules for local crash symbolization and
// are archived per release tag.
const isDebugSymbol = (name: string): boolean => name.toLowerCase().endsWith('.pdb');

// node-pty ships prebuilt native binaries for every platform/arch under
// prebuilds/<platform>-<arch>/. The Windows ConPTY prebuilds are ~30 MB EACH
// (win32-x64 + win32-arm64 ≈ 58 MB), so shipping the non-target architectures
// bloats both the app.asar.unpacked AND the daemon-bundle copy for binaries the
// build can never load (a win32-x64 build will never dlopen a win32-arm64 or
// darwin .node). Delete every prebuild dir that doesn't match the build target.
//
// Keyed on the ACTUAL packaged platform/arch (not the host) so cross-arch makes
// keep the right one. Defensive: if the target dir is somehow missing we keep
// everything rather than emit a build with no loadable PTY binary.
function pruneForeignPrebuilds(nodePtyDir: string, platform: string, arch: string): void {
  const prebuildsDir = path.join(nodePtyDir, 'prebuilds');
  if (!fs.existsSync(prebuildsDir)) return;
  const keep = `${platform}-${arch}`;
  const entries = fs.readdirSync(prebuildsDir, { withFileTypes: true });
  if (!entries.some((e) => e.isDirectory() && e.name === keep)) {
    console.warn(`[postPackage] node-pty prebuild '${keep}' not found — keeping all prebuilds.`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== keep) {
      fs.rmSync(path.join(prebuildsDir, entry.name), { recursive: true, force: true });
      console.log(`[postPackage] Pruned foreign node-pty prebuild: ${entry.name}`);
    }
  }
}

// node-pty's spawn-helper binary (which fork/execs the shell on macOS) is
// unpacked by npm prebuilds without execute permission (rw-r--r--). Without
// adding +x, posix_spawnp cannot launch the shell ("posix_spawnp failed").
// Call this before code signing; changing permissions afterward breaks signing.
// Recursively scan below root.
function chmodSpawnHelpers(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) chmodSpawnHelpers(full);
    else if (entry.name === 'spawn-helper') fs.chmodSync(full, 0o755);
  }
}

// macOS Developer ID signing and notarization run directly at the very end of
// the postPackage hook (signMacAppIfConfigured), not in packagerConfig.
//
// Important: the packager's osxSign/osxNotarize run before the postPackage
// hook. The hook then copies node-pty into app.asar and daemon-bundle; signing
// in packagerConfig would therefore be followed by changes to sealed resources,
// breaking the signature (a sealed resource is missing or invalid). Sign,
// notarize, and staple only after all file operations are complete.
//
// This runs only when all three Apple credentials
// (APPLE_TEAM_ID/APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD) are present; otherwise
// it leaves an UNSIGNED build (for local development or CI without secrets).
// The Developer ID Application identity is discovered automatically in the
// keychain. Entitlements grant the hardened-runtime exceptions (RunAsNode and
// node-pty) in build/entitlements.mac.plist.
async function signMacAppIfConfigured(appPath: string): Promise<void> {
  const { APPLE_TEAM_ID, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD } = process.env;
  if (process.platform !== 'darwin') return;
  if (!APPLE_TEAM_ID || !APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD) {
    console.log('[postPackage] No Apple credentials — proceeding with UNSIGNED build.');
    return;
  }

  const { signAsync } = require('@electron/osx-sign');
  const { notarize } = require('@electron/notarize');

  // 1) Sign inside out, including every helper .app and native .node binary.
  console.log('[postPackage] Code signing (Developer ID, hardened runtime)...');
  await signAsync({
    app: appPath,
    optionsForFile: () => ({
      hardenedRuntime: true,
      entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist'),
    }),
  });

  // 2) Notarize: submit with notarytool and wait for completion (several minutes).
  console.log('[postPackage] Notarizing (notarytool, may take several minutes)...');
  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  // 3) Staple the notarization ticket to the .app for offline Gatekeeper checks.
  console.log('[postPackage] Stapling (xcrun stapler)...');
  require('child_process').execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });

  console.log('[postPackage] macOS sign + notarize + staple complete.');
}

// Sign + notarize + staple the .dmg container itself, from the postMake hook.
//
// The .app inside is already signed and stapled by signMacAppIfConfigured, which
// is what Gatekeeper checks on launch — so an unsigned .dmg still installs fine.
// Signing the container additionally makes the disk image itself verifiable at
// mount time (`spctl -a -t open --context context:primary-signature`) instead of
// reporting "no usable signature".
//
// Must run in postMake, not postPackage: MakerDMG builds the image after the
// package step, so there is no .dmg to sign yet when the app is signed.
async function signMacDmgIfConfigured(dmgPath: string): Promise<void> {
  const { APPLE_TEAM_ID, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD } = process.env;
  if (process.platform !== 'darwin') return;
  if (!APPLE_TEAM_ID || !APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD) {
    console.log('[postMake] No Apple credentials — leaving the DMG unsigned.');
    return;
  }

  const { execFileSync } = require('child_process');
  const { notarize } = require('@electron/notarize');

  // Resolve the signing identity by its SHA-1 fingerprint, not by name.
  // `find-identity` searches every keychain in the default list — in CI that is
  // the temporary build keychain AND login.keychain-db (release.yml) — so a
  // name match can pick up a stale or foreign-team certificate, and two
  // renewals sharing one common name make `codesign --sign <name>` ambiguous.
  // Require exactly one identity carrying this build's team suffix.
  const identities: string = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  const matches = [...identities.matchAll(/\b([0-9A-F]{40})\s+"(Developer ID Application: [^"]+)"/gi)]
    .filter(([, , name]) => name.includes(`(${APPLE_TEAM_ID})`));
  const fingerprints = new Set(matches.map(([, sha1]) => sha1));
  if (fingerprints.size !== 1) {
    throw new Error(
      `[postMake] Expected exactly one "Developer ID Application" identity for team ${APPLE_TEAM_ID}, found ${fingerprints.size}.`,
    );
  }
  const [sha1] = fingerprints;
  const identityName = matches[0][2];

  // 1) Sign the disk image. --timestamp is required for notarization; --force
  //    lets a re-run re-sign an image left behind by a previous attempt.
  console.log(`[postMake] Signing DMG (${identityName})...`);
  execFileSync('codesign', ['--sign', sha1, '--timestamp', '--force', dmgPath], { stdio: 'inherit' });

  // 2) Notarize the image (a few minutes). This is a separate submission from
  //    the .app's — the ticket is issued per artifact. notarize() staples on
  //    success itself (with retries), so no explicit `xcrun stapler` call.
  console.log('[postMake] Notarizing DMG (notarytool, takes a few minutes)...');
  await notarize({
    appPath: dmgPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[postMake] DMG sign + notarize + staple done.');
}

const config: ForgeConfig = {
  // node-pty is copied from its shipped prebuilds in postPackage; rebuilding it
  // here only adds a local Visual Studio toolchain dependency.
  rebuildConfig: {
    ignoreModules: ['node-pty'],
  },
  packagerConfig: {
    // Package under the slug, not the display name: electron-packager names the
    // output dir `<name>-<platform>-<arch>` and the macOS bundle `<name>.app`,
    // and "Forge Mux" put a SPACE in both. That space reaches every consumer of
    // the build — the perf harness's packaged-app path, the release workflow's
    // word-split `find` over out/make artifacts, Defender exclusions, docs — so
    // the artifact namespace stays `fmux` and the display name is carried by
    // Info.plist (below) and app.setName() in src/main/index.ts instead.
    name: pkg.executableName,
    // macOS: the bundle DIRECTORY is fmux.app, but Finder, the menu bar, and
    // Electron's app.getName() (hence ~/Library/Application Support/<name>) read
    // these keys — so the user-visible name stays "Forge Mux".
    extendInfo: {
      CFBundleName: pkg.productName,
      CFBundleDisplayName: pkg.productName,
    },
    // The binary must be fmux.exe / fmux, not derived from productName
    // ("Forge Mux.exe"): the Windows CLI shim invokes `<app-dir>\fmux.exe`,
    // the AUMID is com.squirrel.fmux.fmux (= com.squirrel.<nupkg>.<exe>), and
    // the macOS shim targets <bundle>/Contents/MacOS/fmux. The bundle/app
    // display name is set separately (see `name`/`extendInfo` above). The value
    // lives in package.json so harness scripts can derive the packaged binary
    // path from the same source (scripts/helpers/packaged-app.mjs).
    executableName: pkg.executableName,
    asar: {
      unpack: '**/node_modules/node-pty/**',
    },
    icon: './assets/icon',
    ignore: (file) => {
      if (!file) return false;
      if (file === '/mcps' || file.startsWith('/mcps/')) return true;
      return !file.startsWith('/.vite');
    },
    // LICENSE + THIRD_PARTY_NOTICES ship to <exe>/resources/ so the MIT
    // "include this notice in all copies" obligation is satisfied for
    // wmux itself and every bundled npm dep. Electron's own LICENSE
    // (covering Chromium / V8 / Node) is emitted automatically by
    // electron-packager next to wmux.exe, so we don't duplicate it here.
    // claude-agent-sdk: the Command Deck brain (main process) loads it from
    // resources/claude-agent-sdk at runtime — the packaged app ships no
    // node_modules, and the SDK must stay unbundled because it locates its
    // sibling files by its own path. 3.8 MB of pure JS, zero runtime deps; the
    // ~240 MB platform binary package is deliberately NOT shipped (the deck
    // targets the user's own claude install via pathToClaudeCodeExecutable).
    // ./dist/daemon-web ships as a sibling of daemon-bundle so the detached
    // daemon resolves terminal.html at `__dirname/../daemon-web` (wmux web).
    extraResource: ['./dist/mcp-bundle', './dist/daemon-bundle', './dist/daemon-web', './dist/cli-bundle', './node_modules/@anthropic-ai/claude-agent-sdk', './assets/icon.ico', './assets/icon.icns', './assets/icon.png', './assets/trayTemplate.png', './assets/trayTemplate@2x.png', './LICENSE', './THIRD_PARTY_NOTICES', './src/main/pty/shell-hooks'],
    // macOS signing/notarization runs at the end of the postPackage hook, not
    // in packagerConfig (see the signMacAppIfConfigured comment). Signing here
    // would be invalidated by the postPackage node-pty copy.
  },
  hooks: {
    postPackage: async (_config, packageResult) => {
      const asar = require('@electron/asar');
      const outputPath = packageResult.outputPaths[0];
      // Build target — prune node-pty prebuilds to this platform/arch only.
      // Use forge's packageResult triple (the actual build target, correct even
      // under cross-compilation). If forge doesn't surface it, skip pruning
      // entirely rather than fall back to the host triple — pruning against the
      // wrong target could delete the only loadable prebuild. A larger build
      // beats a broken one.
      const targetPlatform = (packageResult as { platform?: string }).platform;
      const targetArch = (packageResult as { arch?: string }).arch;
      const canPrune = Boolean(targetPlatform && targetArch);
      if (!canPrune) {
        console.warn('[postPackage] packageResult platform/arch unavailable — skipping node-pty prebuild pruning.');
      }
      // macOS uses an .app bundle, so resources are under
      // <app>.app/Contents/Resources; Windows/Linux use <output>/resources.
      // The .app name depends on productName, so find it directly in the directory.
      const appBundle = process.platform === 'darwin'
        ? fs.readdirSync(outputPath).find((f) => f.endsWith('.app'))
        : undefined;
      const resourcesDir = appBundle
        ? path.join(outputPath, appBundle, 'Contents', 'Resources')
        : path.join(outputPath, 'resources');
      const asarPath = path.join(resourcesDir, 'app.asar');
      const tempDir = path.join(resourcesDir, '_app_tmp');
      const unpackedDir = asarPath + '.unpacked';

      // 1. Extract existing asar
      console.log('[postPackage] Extracting asar...');
      asar.extractAll(asarPath, tempDir);

      // 2. Copy node-pty into extracted app
      const destNodePty = path.join(tempDir, 'node_modules', 'node-pty');
      console.log(`[postPackage] Copying node-pty...`);
      copyDirSync(path.join(__dirname, 'node_modules', 'node-pty'), destNodePty, isDebugSymbol);
      if (canPrune) pruneForeignPrebuilds(destNodePty, targetPlatform!, targetArch!);
      const srcAddonApi = path.join(__dirname, 'node_modules', 'node-addon-api');
      if (fs.existsSync(srcAddonApi)) {
        copyDirSync(srcAddonApi, path.join(tempDir, 'node_modules', 'node-addon-api'));
      }

      // 3. Repack asar with native files unpacked
      console.log('[postPackage] Repacking asar...');
      fs.unlinkSync(asarPath);
      if (fs.existsSync(unpackedDir)) fs.rmSync(unpackedDir, { recursive: true });
      // Unpack only node-pty's native assets (*.node files and spawn-helper in
      // prebuilds/). spawn-helper fork/execs the shell on macOS and cannot run
      // when trapped inside asar ("posix_spawnp failed").
      //
      // Keep JavaScript such as lib/ inside asar. node-pty
      // builds helperPath from __dirname and derives the unpacked path with
      // .replace('app.asar', 'app.asar.unpacked'); unpacking lib too would make
      // __dirname already contain app.asar.unpacked and produce
      // app.asar.unpacked.unpacked (ENOENT). With only prebuilds unpacked, lib
      // remains in the virtual app.asar and the replacement is correct.
      await asar.createPackageWithOptions(tempDir, asarPath, {
        unpack: '**/node_modules/node-pty/prebuilds/**',
      });

      // 3a. Invalidate @electron/asar's in-memory header cache for this archive.
      //
      // @electron/asar memoizes parsed archive headers in a module-level
      // `filesystemCache` keyed by archive path. Step 1's `extractAll(asarPath)`
      // populated that cache with the ORIGINAL (pre-repack) header. The in-place
      // repack above overwrites app.asar on disk but does NOT refresh the cache,
      // so the cached entry now carries stale file offsets.
      //
      // `electron-forge make` runs packaging and the makers in ONE process, and
      // every `require('@electron/asar')` resolves to the same hoisted instance.
      // So the Linux maker-deb / maker-rpm chain (electron-installer-common's
      // readMetadata) later calls `asar.extractFile(asarPath, 'package.json')`
      // against this same stale cache — reading at the old offset, which now
      // lands inside the new archive's data section (bundled JS), and feeding
      // non-JSON bytes to JSON.parse:
      //   "Unexpected token ... is not valid JSON".
      // Windows (Squirrel) and macOS (DMG/ZIP) makers never read app.asar this
      // way, which is why the breakage was Linux-only (issue #159). Dropping the
      // cache entry forces the next reader to re-parse the freshly written header.
      asar.uncache(asarPath);

      // 4. Cleanup temp
      fs.rmSync(tempDir, { recursive: true });
      console.log('[postPackage] Done — node-pty bundled in asar.');

      // 5. Copy node-pty into daemon-bundle/node_modules so the detached daemon process can find it
      const daemonBundleDir = path.join(resourcesDir, 'daemon-bundle');
      if (fs.existsSync(daemonBundleDir)) {
        const daemonNodePty = path.join(daemonBundleDir, 'node_modules', 'node-pty');
        console.log('[postPackage] Copying node-pty for daemon-bundle...');
        copyDirSync(path.join(__dirname, 'node_modules', 'node-pty'), daemonNodePty, isDebugSymbol);
        if (canPrune) pruneForeignPrebuilds(daemonNodePty, targetPlatform!, targetArch!);
        console.log('[postPackage] Done — node-pty available for daemon.');
      }

      // 6. Remove .ps1 files from resources — NuGet 2.8 treats PowerShell files
      //    outside the 'tools' folder as errors, breaking Squirrel nupkg creation.
      //    Squirrel.Windows is the only maker that builds nupkgs, so this cleanup
      //    is meaningless on macOS / Linux and skipped there.
      if (process.platform === 'win32') {
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
      }

      // 7. Grant execute permission to node-pty's spawn-helper in both
      //    app.asar.unpacked and daemon-bundle. Do this before signing.
      if (process.platform === 'darwin') {
        chmodSpawnHelpers(resourcesDir);
      }

      // 8. Sign, notarize, and staple on macOS only after all file operations
      //    above (asar repacking, daemon-bundle node-pty copy, and chmod) finish;
      //    otherwise signing breaks. This is a no-op outside darwin or without credentials.
      if (appBundle) {
        await signMacAppIfConfigured(path.join(outputPath, appBundle));
      }
    },

    // Sign the DMG containers once the makers have produced them. ZIP artifacts
    // are skipped: they are not signable, and the .app they carry is already
    // signed and stapled from postPackage.
    //
    // Never throw. Forge builds every artifact before awaiting this hook, but a
    // rejected `make` fails the release job's build step, so the upload step
    // never runs and the ephemeral runner is discarded with the .dmg AND the
    // perfectly good .zip still on it. A transient Apple outage must not cost
    // the whole macOS release. Downgrade to a loud warning instead: the result
    // is an unsigned container, which is exactly what shipped before this hook
    // existed, and the .app inside is still signed, notarized, and stapled.
    postMake: async (_config, makeResults) => {
      for (const result of makeResults) {
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.dmg')) continue;
          try {
            await signMacDmgIfConfigured(artifact);
          } catch (err) {
            console.warn(`[postMake] WARNING: DMG signing failed for ${path.basename(artifact)} — shipping it unsigned.`);
            console.warn(`[postMake] ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      return makeResults;
    },
  },
  // Makers are filtered by host OS — electron-forge only invokes makers whose
  // platform matches the runtime, but keeping each one inside an explicit
  // `process.platform` guard makes the intent obvious and keeps Windows builds
  // strictly identical to the pre-port behavior. Linux deb/rpm makers and
  // macOS DMG/notarization land in Phases 2–3.
  makers: [
    ...(process.platform === 'win32'
      ? [
          new MakerSquirrel({
            name: 'fmux',
            setupExe: SQUIRREL_SETUP_EXE,
            setupIcon: './assets/icon.ico',
            iconUrl: 'https://raw.githubusercontent.com/skflowne/fmux/main/assets/icon.ico',
          }),
        ]
      : []),
    ...(process.platform === 'darwin'
      // MakerZIP backs the update.electronjs.org/darwin/ discovery feed and the
      // in-app ZIP self-update (Phase E); MakerDMG is the first-install download
      // UX (drag to /Applications). Keep BOTH.
      ? [new MakerZIP({}, ['darwin']), new MakerDMG({}, ['darwin'])]
      : []),
    ...(process.platform === 'linux'
      ? [
          new MakerDeb({
            options: {
              name: 'fmux',
              productName: 'Forge Mux',
              categories: ['Utility', 'Development'],
            },
          }),
          new MakerRpm({
            options: {
              name: 'fmux',
              productName: 'Forge Mux',
              categories: ['Utility', 'Development'],
            },
          }),
          // AppImage: distro-independent single-file portable binary (like the
          // Windows .exe). @reforged/maker-appimage is a third-party maker
          // (no official Forge AppImage maker). Linux-guarded, so Windows/macOS
          // builds never instantiate it.
          new MakerAppImage({
            options: {
              name: 'fmux',
              productName: 'Forge Mux',
              categories: ['Utility', 'Development'],
              icon: './assets/icon.png',
            },
          }),
        ]
      : []),
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
      // Documented in README §6 + docs/SECURITY.md §1.4 — keep in sync.
      [FuseV1Options.RunAsNode]: true,
      // Enable cookie encryption only for signed builds. macOS os_crypt reads
      // its encryption key from the keychain, but unsigned local-dev/UNSIGNED
      // binaries lack hardened-runtime credentials and are denied access
      // (errSecAuthFailed -25293, a console error on every run). Enable this
      // only for official builds with all three Apple credentials.
      [FuseV1Options.EnableCookieEncryption]: Boolean(
        process.env.APPLE_TEAM_ID && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD,
      ),
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // Disabled: postPackage hook repacks asar (for node-pty), which changes the hash.
      // Enabling this causes FATAL integrity check failure at runtime.
      // Documented in docs/SECURITY.md §1.4 — keep in sync.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
