# Progress — macOS Build Pipeline (Phase 1)

## Summary
- **Sprint**: Phase 1 of macOS port (4-week MVP)
- **Phase**: 3 (구현 — Wave 1 진행 중)
- **Branch**: `team/2026-04-26/macos-build-pipeline`
- **Done**: 3/6 (T1, T2, T3) | In Progress: 1 (T4) | Waiting: 2 (T5, T6) | Blocked: 0

## Notes from completed tasks
- T2: `osxNotarize.tool` 필드 제거 (최신 @electron/packager 18+ typings에서 deprecated, notarytool이 기본값)
- T2: `MakerDMG` import에 `// @ts-ignore` 부착 (T6 devDep 추가 전까지)
- T3: plistlib valid 검증 통과, 정확히 3 entitlement

## DAG

```
T1 (fix-node-pty.js Win 가드): []
T2 (forge.config.ts macOS makers + osxSign + osxNotarize): []
T3 (build/entitlements.mac.plist 신규): []
T4 (assets/icon.icns + iconTemplate.png 생성): []
T5 (CI matrix + smoke gate: release.yml + ci.yml): [T2, T3, T4]
T6 (package.json: maker-dmg 의존성 + description 보정): [T2]
```

**의존성 설명:**
- T1, T2, T3, T4는 모두 독립 (병렬 가능)
- T5는 T2(forge config 완료) + T3(entitlements 파일) + T4(아이콘 자산) 완료 후 시작 — CI에서 빌드를 돌리려면 모든 자산 준비됨
- T6은 T2 완료 후 (forge.config.ts에서 어떤 maker 추가했는지 확정 후 package.json의 dependencies 업데이트)

## Parallelization Plan

```
Wave 1 (병렬 4, worktree):
  - T1 (fix-node-pty.js Win 가드)        ← scripts/, 1 파일
  - T2 (forge.config.ts + osxSign)       ← forge.config.ts, 1 파일
  - T3 (entitlements.mac.plist)          ← build/ 신규, 1 파일
  - T4 (icon.icns + iconTemplate.png)    ← assets/ 신규, 자산 생성

Wave 2 (T2 완료 후 병렬 2, worktree):
  - T5 (CI matrix + smoke gate)          ← .github/workflows/, 2 파일
  - T6 (package.json 의존성)              ← package.json, 1 파일
```

**최대 동시 실행**: 4개 (Wave 1). 룰 준수.

## Tasks

### T1. fix-node-pty.js Win 가드
- **파일 (수정)**: `scripts/fix-node-pty.js`
- **요구사항**:
  - 파일 진입부에 `if (process.platform !== 'win32') process.exit(0);` 추가
  - 기존 Windows 패치 로직은 그대로 유지
  - `package.json:postinstall`은 변경하지 않음 (이 스크립트가 그대로 호출되어야 함)
- **검증**: macOS/Linux에서 실행 시 즉시 exit 0, Windows에서 기존 동작 동일
- **Subagent**: backend-developer
- **Worktree**: yes (Wave 1)
- **Status**: Waiting

### T2. forge.config.ts macOS makers + osxSign + osxNotarize
- **파일 (수정)**: `forge.config.ts`
- **요구사항**:
  - `@electron-forge/maker-dmg` import + `MakerDMG` instance 추가 (arm64만)
  - `MakerZIP({}, ['darwin'])`는 유지 (Squirrel.Mac 자동 업데이트용 ZIP)
  - `packagerConfig`에 추가:
    - `appBundleId: 'com.openwong2kim.wmux'`
    - `osxSign`: hardened runtime + entitlements 적용 (entitlements 파일은 T3에서 생성, 경로 `./build/entitlements.mac.plist` 참조)
    - `osxSign.optionsForFile`: `node-pty/build/Release/pty.node`도 동일 entitlements 적용
    - `osxNotarize`: notarytool 기반 (`appleId`, `appleIdPassword`, `teamId`는 환경변수에서 읽기 — `process.env.APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`)
    - 환경변수 미설정 시 (개발 빌드) osxSign/osxNotarize 비활성화 (조건부)
  - `extendInfo`: `LSUIElement: false` (트레이만 띄우려면 true 검토 — 일단 false 유지)
  - 기존 Win 설정 (`MakerSquirrel`, postPackage hook, `RunAsNode` fuse) 모두 그대로 유지
- **검증**:
  - `npm run make -- --platform=darwin --arch=arm64` 명령이 (macOS 머신에서) 정상 실행되는지 (CI에서 검증)
  - `process.env.APPLE_ID` 미설정 시에도 빌드 자체는 성공 (서명만 skip)
  - 기존 Windows 빌드 회귀 없음 (Win 머신에서 `npm run make` 정상)
- **Subagent**: devops-engineer
- **Worktree**: yes (Wave 1)
- **Status**: Waiting

### T3. build/entitlements.mac.plist 신규
- **파일 (신규)**: `build/entitlements.mac.plist`
- **요구사항**:
  - 표준 Apple plist XML 형식
  - 다음 3개 entitlement만 포함 (Eng 리뷰 D2 결정):
    - `com.apple.security.cs.allow-jit` → `<true/>`
    - `com.apple.security.cs.allow-dyld-environment-variables` → `<true/>`
    - `com.apple.security.cs.disable-library-validation` → `<true/>`
  - 다른 entitlement (`cs.allow-unsigned-executable-memory`, `cs.inherit`) 제외
- **검증**:
  - plutil 또는 plistlib로 plist 유효성 확인 (CI smoke check에서)
  - XML 문법 valid
- **Subagent**: general-purpose (단순 plist 작성)
- **Worktree**: yes (Wave 1)
- **Status**: Waiting

### T4. assets/icon.icns + iconTemplate.png 생성
- **파일 (신규)**:
  - `assets/icon.icns` (멀티사이즈 16/32/64/128/256/512/1024)
  - `assets/iconTemplate.png` (16x16) + `assets/iconTemplate@2x.png` (32x32)
  - `scripts/generate-mac-icons.js` (신규, SVG → ICNS/PNG 자동화)
- **요구사항**:
  - 입력: 기존 `assets/icon.svg` (이미 존재)
  - `icon.icns`: macOS .app 번들 아이콘. iconutil 사용 (macOS) 또는 `png2icons` npm 패키지 사용 (cross-platform)
  - `iconTemplate.png`: macOS 트레이용 단색 + 투명 (Apple HIG: black silhouette on transparent, will be auto-tinted by macOS based on theme)
  - `@2x.png`: Retina 대응
  - `scripts/generate-mac-icons.js`: SVG 입력 → 위 파일들 자동 생성. macOS/Linux/Win에서 동작 (cross-platform 라이브러리 사용)
- **검증**:
  - 생성된 .icns가 유효 (file 명령 또는 ImageMagick `identify`)
  - PNG 파일 크기 정확
- **Subagent**: general-purpose
- **Worktree**: yes (Wave 1)
- **Status**: Waiting

### T5. CI matrix + smoke gate
- **파일 (수정)**: `.github/workflows/release.yml`, `.github/workflows/ci.yml`
- **요구사항**:
  - 기존 `runs-on: windows-latest` job을 matrix로 변환:
    ```yaml
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: windows-latest, target: win }
          - { os: macos-14, target: mac-arm64 }  # M1 runner
    ```
  - macOS job 전용 step:
    - `Setup Apple cert`: `CSC_LINK` (base64 인증서) + `CSC_KEY_PASSWORD` → keychain import (apple-actions/import-codesign-certs 액션 또는 수동 `security import`)
    - 환경변수 주입: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (GitHub Secrets에서)
    - `npm run make -- --platform=darwin --arch=arm64`
    - **smoke gate** (필수, CI red on failure):
      - `codesign --verify --deep --strict --verbose=2 "out/wmux-darwin-arm64/wmux.app"`
      - `codesign -dvvv "out/wmux-darwin-arm64/wmux.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node"` → entitlements 적용 확인
      - `spctl -a -t exec -vvv "out/wmux-darwin-arm64/wmux.app"` → "accepted" 검증
      - `xcrun stapler validate "out/wmux-darwin-arm64/wmux.app"` → ticket stapled
  - 릴리즈 step에서 .dmg 업로드 추가 (release.yml만)
  - Windows job은 기존 그대로 유지 (회귀 없음)
- **검증**:
  - `gh workflow run` 또는 PR 푸시 시 CI 통과
  - macOS job: 서명·notarized .dmg 생성 + 4개 smoke check 모두 통과
  - Windows job: 기존 동작 그대로
- **Subagent**: devops-engineer
- **Worktree**: yes (Wave 2)
- **Status**: Waiting (T2, T3, T4)

### T6. package.json 의존성 + 메타데이터
- **파일 (수정)**: `package.json`
- **요구사항**:
  - `@electron-forge/maker-dmg` devDependencies 추가 (T2 forge.config.ts에서 import하는 패키지)
  - `description`/`keywords`에 "Windows" 단독 표현 완화 (예: "tmux-like terminal multiplexer for Windows" → "for Windows and macOS")
  - `os` 필드: `["win32", "darwin"]` 명시 (없으면 추가)
  - `npm install` 실행 후 `package-lock.json` 갱신 commit
- **검증**:
  - `npm install` 무에러
  - `npm run make` (Win에서) 회귀 없음
- **Subagent**: general-purpose
- **Worktree**: yes (Wave 2)
- **Status**: Waiting (T2)

---

## Notes

- TODOS.md modified 상태로 두고 진행 (이전 세션 reminder 추가, 이번 sprint와 연관됨)
- `CHANGELOG.md` / `README.md` 업데이트는 Phase 5 (sprint 마무리)에서 별도 처리
