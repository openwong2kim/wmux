# Decisions Log — macOS Build Pipeline Sprint

**Sprint**: Phase 1 of macOS port (4-week MVP)
**Branch**: `team/2026-04-26/macos-build-pipeline`
**Started**: 2026-04-26
**Plan**: `C:\Users\rizz\.claude\plans\immutable-weaving-torvalds.md` (full 4-phase plan)

---

## Pre-Sprint Decisions (from CEO + Eng review, 2026-04-26)

### D0. macOS 진입 결정
**Background**: Windows v2.7.2 출시 직후. 외부 macOS demand 시그널 없음.
**Chosen**: 진입 진행
**Rationale**: 1차 동기는 본인 사용 ("내가 macOS에서 쓰고 싶어"). PG "make something you yourself want"의 가장 정직한 형태. 외부 demand 검증과 분리해서 판단.
**Impact**: 4주 MVP + 게이트 후 시그널 기반 확장.
**Memory ref**: `project_macos_motivation.md`

### D1. Sprint 스코프
**Background**: 4주 전체를 한 번에 팀모드로 돌리는 건 비현실적.
**Chosen**: Phase 1 (빌드 파이프라인)만 첫 sprint. Phase 2/3은 후속 sprint.
**Rationale**: CI matrix 회귀 안전망 우선. Apple 인증서 + entitlements가 모든 후속 작업의 전제 조건.
**Impact**: 1주 sprint, 5-7 teammate.

### D2. 아키텍처 결정 (Eng 리뷰 확정)
- **entitlements**: 3개만 (`cs.allow-jit`, `cs.allow-dyld-environment-variables`, `cs.disable-library-validation`). `cs.allow-unsigned-executable-memory` + `inherit` 제외.
- **DMG maker**: arm64 우선, x64는 게이트 후
- **Code signing**: osxSign + osxNotarize (notarytool 기반)
- **Smoke gate**: CI에 `codesign --verify --deep --strict` + `spctl` + `stapler validate` 자동 검증

### D3. CI matrix 우선 머지
**Background**: 공격적 병행 확장 = Win 회귀가 게이트 자체 위태롭게 만듦.
**Chosen**: Phase 1.4 (CI matrix)를 가장 먼저 단일 PR로 머지 가능하면 머지.
**Rationale**: 회귀 안전망 = 매일 dogfood의 전제.

### D4. AutoUpdater 결정 보류
**Background**: 현재 AutoUpdater가 Electron 내장 모듈을 안 쓰고 `shell.openExternal` 사용. macOS에서 자동 설치 안 됨.
**Chosen**: Phase 1에서는 결정 안 함. Phase 2 dogfood 후 옵션 A (Electron autoUpdater) vs B (수동 모델 일관) 결정.
**Rationale**: 양쪽 모두 plan 명시. Phase 1 빌드 파이프라인과는 독립.
**Impact**: Phase 1 작업 범위에서 제외.

---

<!-- Sprint 진행 중 발생하는 결정은 아래 추가. 최신 우선. -->

### Template
### [YYYY-MM-DD] D{N}. Decision Title
**Background**: Why this decision is needed
**Chosen**: Option [X]
**Rationale**: Why this option was selected
**Impact**: What changes as a result
