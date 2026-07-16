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
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')) as { version: string };
const SQUIRREL_SETUP_EXE = `wmux-${pkg.version}.Setup.exe`;

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

// node-pty의 spawn-helper(macOS에서 셸을 fork/exec하는 바이너리)는 npm prebuild가
// 실행권한 없이(rw-r--r--) 풀려서, +x를 직접 부여하지 않으면 posix_spawnp가
// 셸을 띄우지 못한다("posix_spawnp failed"). 반드시 코드 서명 "전"에 호출해야
// 한다(서명 후 권한을 바꾸면 서명이 깨진다). root 하위를 재귀 탐색한다.
function chmodSpawnHelpers(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) chmodSpawnHelpers(full);
    else if (entry.name === 'spawn-helper') fs.chmodSync(full, 0o755);
  }
}

// macOS Developer ID signing + notarization은 packagerConfig가 아니라 아래
// postPackage hook의 "맨 끝"에서 직접 수행한다(signMacAppIfConfigured).
//
// 이유(중요): packager의 osxSign/osxNotarize는 postPackage hook보다 "먼저"
// 실행된다. 그런데 postPackage hook은 node-pty를 app.asar과 daemon-bundle로
// 복사해 넣는다 — 즉 packagerConfig에서 서명하면, 그 직후 postPackage가
// 봉인된 리소스를 변경해 서명이 깨진다(`a sealed resource is missing or
// invalid`). 그래서 모든 파일 조작이 끝난 마지막에 서명→노타라이즈→스테이플
// 순서로 처리해야 한다.
//
// Apple 자격증명(APPLE_TEAM_ID/APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD) 3개가
// 모두 있을 때만 동작하고, 없으면 UNSIGNED 빌드를 그대로 만든다(로컬 dev나
// secrets 미설정 CI). Developer ID Application identity는 keychain에서 자동
// 탐색한다. entitlements는 hardened-runtime 예외(RunAsNode + node-pty)를
// 부여한다(build/entitlements.mac.plist).
async function signMacAppIfConfigured(appPath: string): Promise<void> {
  const { APPLE_TEAM_ID, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD } = process.env;
  if (process.platform !== 'darwin') return;
  if (!APPLE_TEAM_ID || !APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD) {
    console.log('[postPackage] Apple 자격증명 없음 — UNSIGNED 빌드로 진행.');
    return;
  }

  const { signAsync } = require('@electron/osx-sign');
  const { notarize } = require('@electron/notarize');

  // 1) inside-out 서명: 모든 헬퍼 .app과 .node 네이티브 바이너리까지 서명한다.
  console.log('[postPackage] 코드 서명 (Developer ID, hardened runtime)...');
  await signAsync({
    app: appPath,
    optionsForFile: () => ({
      hardenedRuntime: true,
      entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist'),
    }),
  });

  // 2) 노타라이즈: notarytool로 제출 후 완료까지 대기(수 분 소요).
  console.log('[postPackage] 노타라이즈 (notarytool, 수 분 소요)...');
  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  // 3) 스테이플: 노타라이즈 티켓을 .app에 부착(오프라인 Gatekeeper 통과용).
  console.log('[postPackage] 스테이플 (xcrun stapler)...');
  require('child_process').execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });

  console.log('[postPackage] macOS 서명 + 노타라이즈 + 스테이플 완료.');
}

const config: ForgeConfig = {
  // node-pty is copied from its shipped prebuilds in postPackage; rebuilding it
  // here only adds a local Visual Studio toolchain dependency.
  rebuildConfig: {
    ignoreModules: ['node-pty'],
  },
  packagerConfig: {
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
    extraResource: ['./dist/mcp-bundle', './dist/daemon-bundle', './dist/cli-bundle', './node_modules/@anthropic-ai/claude-agent-sdk', './assets/icon.ico', './assets/icon.icns', './assets/icon.png', './LICENSE', './THIRD_PARTY_NOTICES', './src/main/pty/shell-hooks'],
    // macOS 서명/노타라이즈는 packagerConfig가 아니라 postPackage hook 끝에서
    // 수행한다(signMacAppIfConfigured 주석 참고). 여기서 서명하면 postPackage의
    // node-pty 복사가 서명을 깨뜨리기 때문이다.
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
      // macOS는 .app 번들이라 리소스가 <app>.app/Contents/Resources에,
      // Windows/Linux는 <output>/resources에 위치한다. .app 이름은
      // productName에 따라 달라지므로 디렉토리에서 직접 찾는다.
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
      // node-pty의 네이티브 자산(prebuilds/ 안의 *.node + spawn-helper)만 asar
      // 밖으로 빼낸다. spawn-helper는 macOS에서 셸을 fork/exec하는 바이너리라
      // asar에 갇히면 실행 불가("posix_spawnp failed")다.
      //
      // 주의: lib/ 같은 JS는 unpack하지 말고 asar "안"에 둬야 한다. node-pty가
      // helperPath를 __dirname 기준으로 만든 뒤 `.replace('app.asar',
      // 'app.asar.unpacked')`로 unpacked 경로를 유도하는데, lib까지 unpack하면
      // __dirname에 이미 'app.asar.unpacked'가 들어가
      // 'app.asar.unpacked.unpacked'(ENOENT)로 망가진다. prebuilds만 unpack하면
      // lib는 가상 app.asar에 남아 replace가 정확히 'app.asar.unpacked'로 변환된다.
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

      // 7. node-pty spawn-helper에 실행권한 부여 — app.asar.unpacked와
      //    daemon-bundle 양쪽 모두. 반드시 서명 "전"에 해야 한다.
      if (process.platform === 'darwin') {
        chmodSpawnHelpers(resourcesDir);
      }

      // 8. macOS 서명 + 노타라이즈 + 스테이플 — 반드시 위의 모든 파일 조작
      //    (asar 재패킹 + daemon-bundle node-pty 복사 + chmod)이 끝난 "뒤"에
      //    수행해야 서명이 깨지지 않는다. darwin이 아니거나 자격증명 없으면 no-op.
      if (appBundle) {
        await signMacAppIfConfigured(path.join(outputPath, appBundle));
      }
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
            name: 'wmux',
            setupExe: SQUIRREL_SETUP_EXE,
            setupIcon: './assets/icon.ico',
            iconUrl: 'https://raw.githubusercontent.com/openwong2kim/wmux/main/assets/icon.ico',
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
              name: 'wmux',
              productName: 'wmux',
              categories: ['Utility', 'Development'],
            },
          }),
          new MakerRpm({
            options: {
              name: 'wmux',
              productName: 'wmux',
              categories: ['Utility', 'Development'],
            },
          }),
          // AppImage: distro-independent single-file portable binary (like the
          // Windows .exe). @reforged/maker-appimage is a third-party maker
          // (no official Forge AppImage maker). Linux-guarded, so Windows/macOS
          // builds never instantiate it.
          new MakerAppImage({
            options: {
              name: 'wmux',
              productName: 'wmux',
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
      // 서명된 빌드에서만 쿠키 암호화를 켠다. macOS os_crypt는 keychain에서 암호화
      // 키를 읽는데, 미서명(로컬 dev/UNSIGNED) 바이너리는 hardened runtime 자격이
      // 없어 keychain 접근이 거부된다(errSecAuthFailed -25293, 매 실행 콘솔 에러).
      // Apple 자격증명 3개가 모두 있는 정식 빌드에서만 활성화한다.
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
