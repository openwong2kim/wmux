# WinMux — Windows Terminal for AI Coding Agents

> cmux의 모든 기능을 Windows 네이티브로 재구현한 AI 에이전트 터미널

**Version:** 1.0  
**Date:** 2026-03-18  
**Author:** 우영 (AI TFT, Kyungshin)  
**Status:** Draft  
**License:** MIT (Open Source)

---

## 1. Executive Summary

WinMux는 cmux(Ghostty 기반 macOS AI 터미널)의 모든 기능을 Windows 네이티브 환경에서 재구현한 오픈소스 터미널이다. Claude Code, Codex, OpenCode, Gemini CLI 등 AI 코딩 에이전트를 병렬 운영하는 개발자를 위해 설계되었다.

Windows 개발자들은 현재 macOS 전용인 cmux를 사용할 수 없고, WSL 없이는 tmux도 쓸 수 없으며, Windows Terminal/PowerShell의 입력 멈춤이나 렌더링 성능 문제를 경험하고 있다. WinMux는 이 공백을 채운다.

### One-liner

> "cmux의 전체 기능을 Windows 네이티브로 가져오고, GPU 렌더링 + PowerShell 통합 + AI 에이전트 제어까지 통합한 터미널"

---

## 2. Problem Statement

### 2.1 Windows 개발자의 현실적 문제

| 문제 | 현재 상황 | 영향 |
|------|----------|------|
| cmux macOS 전용 | Windows 사용자는 접근 불가 | 전체 개발자 60%+ 배제 |
| 터미널 입력 멈춤 | Claude Code가 입력 불가 상태 되어 세션 재시작 필요 | 작업 중단, 컨텍스트 손실 |
| ASCII 렌더링 렉/깜빡임 | Windows Terminal GPU 렌더링 한계 | AI 대량 출력 처리 불가 |
| 에이전트 관제 UI 부재 | 여러 에이전트 상태 파악 불가 | 병렬 작업 효율 저하 |
| 알림 시스템 부재 | 에이전트 완료 여부 확인 불가 | 터미널 계속 주시 |

### 2.2 기존 Windows 터미널 한계

- **Windows Terminal**: 기본 제공이지만 로그 폭발 시 성능 저하, 입력 멈춤 이슈 보고됨
- **Warp**: UI 우수하나 tmux 사용 시 AI 기능 비활성화, Windows 안정성 불완전
- **Hyper/Tabby**: Electron 기반이지만 AI 에이전트 특화 기능 전무
- **WezTerm**: GPU 렌더링 우수하나 에이전트 관제 UI/알림/사이드바 없음
- **Alacritty/Kitty**: 빠르지만 기능 부족, Windows UX 불편

---

## 3. Product Vision

WinMux는 단순한 터미널이 아니라 AI 에이전트 작업 관제 UI이다. cmux의 철학을 그대로 계승한다:

> *"cmux is a primitive, not a solution. It gives you a terminal, a browser, notifications, workspaces, splits, tabs, and a CLI to control all of it."*

WinMux도 동일한 원칙을 따른다. 조합 가능한 프리미티브를 제공하고, 워크플로우는 개발자가 직접 구성한다.

### 3.1 Target Users

- Windows에서 Claude Code, Codex, Gemini CLI 등 AI 코딩 에이전트를 사용하는 개발자
- PowerShell 7 또는 Git Bash 환경의 개발자 (WSL 없이도 동작)
- WSL2 환경에서 병렬 에이전트를 운영하는 개발자
- 다중 에이전트 오케스트레이션이 필요한 파워 유저

---

## 4. Feature Specification (cmux Full Parity)

cmux의 모든 기능을 Windows 네이티브로 재구현하며, Windows 특화 기능을 추가한다.

### 4.1 Workspace & Session Management

**cmux 대응**: Vertical tabs, workspace, sidebar

- 세로 사이드바 (Slack/Discord 스타일) 워크스페이스 목록
- 각 워크스페이스에 Git branch, PR 상태/번호, 작업 디렉토리, listening ports 표시
- 세션 상태 표시: Running(녹색), Idle(노란), Error(빨간), Waiting(파란)
- 최신 알림 텍스트 표시 (cmux 사이드바 동일)
- `Ctrl+1~8` 워크스페이스 빠른 이동, `Ctrl+Shift+R` 이름 변경
- 워크스페이스 드래그앤드드롭 재정렬

### 4.2 Notification System

**cmux 대응**: Notification rings, notification panel, OSC 9/99/777

- **Notification Rings**: 백그라운드 프로세스 알림 시 Pane 주변 파란 링 애니메이션
- **Sidebar 알림 배지**: 읽지 않은 알림 카운트 표시
- **Notification Panel**: `Ctrl+I`로 모든 대기 알림 한곳에서 확인
- `Ctrl+Shift+U`로 최신 읽지 않은 알림으로 점프
- Windows OS 알림 (Toast Notification) 통합
- 작업 표시줄 배지 및 표시
- 커스텀 알림 사운드 선택 가능
- OSC 9/99/777 터미널 시퀀스 자동 감지
- CLI로 알림 트리거: `winmux notify --title "Build Complete" --body "Done"`

### 4.3 Split Panes & Surfaces

**cmux 대응**: Split right/down, pane hierarchy, surface tabs within panes

- 수평(`Ctrl+D`) / 수직(`Ctrl+Shift+D`) 분할
- 4단계 계층 구조: **Window > Workspace > Pane > Surface > Panel**
- Pane 내 복수 Surface(탭) 지원 (cmux 동일 구조)
- 방향키로 Pane 포커스 이동 (`Alt+Ctrl+방향키`)
- `Ctrl+Shift+H`로 포커스된 패널 플래시 강조
- Surface 드래그앤드드롭으로 Pane 간 이동

### 4.4 In-App Browser

**cmux 대응**: Built-in browser with scriptable API (agent-browser port)

- `Ctrl+Shift+L`로 브라우저 패널 열기 (터미널 옆에 분할)
- WebView2 (Chromium) 기반 내장 브라우저
- **Scriptable API**: DOM snapshot, element refs, click, fill, JS evaluate
- 에이전트가 dev server와 직접 상호작용 가능
- DevTools (F12) 통합
- 브라우저 `Ctrl+F` 검색, 뒤로/앞으로 네비게이션
- URL 바 포커스 (`Ctrl+L`)

### 4.5 CLI & Named Pipe API

**cmux 대응**: Unix socket API + CLI (cmux의 핵심 차별화)

Windows 환경에서는 Unix socket 대신 Named Pipe를 사용한다.

**CLI Commands (`winmux`):**

```
# Workspace
winmux new-workspace [--name "project"]
winmux list-workspaces
winmux focus-workspace <id>
winmux close-workspace <id>
winmux current-workspace

# Surface & Pane
winmux new-surface
winmux list-surfaces
winmux focus-surface <id>
winmux close-surface <id>
winmux split --direction right|left|up|down
winmux list-panes
winmux focus-pane <id>

# Input Control
winmux send <text>
winmux send-key <keystroke>
winmux read-screen

# Notifications
winmux notify --title <title> --body <body>

# Browser
winmux browser snapshot
winmux browser click <ref>
winmux browser fill <ref> <text>
winmux browser eval <js>

# Sidebar Metadata
winmux set-status <text>
winmux set-progress <0-100>

# System
winmux identify
winmux capabilities
```

**Named Pipe API** (`\\.\pipe\winmux`):

```json
{"id":"req-1","method":"workspace.list","params":{}}
// Response: {"id":"req-1","ok":true,"result":{"workspaces":[...]}}
```

**환경변수 (자동 설정):**
- `WINMUX_WORKSPACE_ID`
- `WINMUX_SURFACE_ID`
- `WINMUX_SOCKET_PATH`

### 4.6 GPU-Accelerated Terminal Rendering

**cmux 대응**: libghostty 기반 Metal GPU 렌더링

GPU 렌더링은 2단계로 나눠 접근한다. 최종 목표는 cmux/Ghostty급 네이티브 GPU 렌더링이다.

#### Phase 1: xterm.js WebGL (MVP)

| 항목 | 내용 |
|------|------|
| 기술 | Electron + xterm.js WebGL Addon |
| GPU 사용 방식 | Chromium WebGL 컨텍스트를 통한 GPU 가속 |
| 원리 | 글리프를 텍스처 아틀라스로 GPU에 캐싱, 셀 단위 배치 렌더링 |
| 성능 수준 | Canvas 2D 대비 5~10x 향상, Windows Terminal보다 우수 |
| 한계 | Chromium 레이어 오버헤드 존재, Ghostty/WezTerm 네이티브 GPU 대비 약함 |
| 레퍼런스 | VS Code 터미널이 동일 방식 사용 중 |

- ANSI/ASCII 완벽 지원
- CJK IME 완벽 지원 (한국어/중국어/일본어)
- 초당 수천 줄 로그 처리 가능 (Windows Terminal 대비 큰 개선)
- 빠른 개발 속도 (Vibe Coding 친화적)

#### Phase 2: Tauri v2 + wgpu 네이티브 GPU (장기)

| 항목 | 내용 |
|------|------|
| 기술 | Tauri v2 + wgpu (Rust WebGPU 구현체) |
| GPU 사용 방식 | DirectX 12 / Vulkan / Metal 네이티브 API 직접 호출 |
| 원리 | 브라우저 레이어 제거, GPU 파이프라인에서 터미널 직접 렌더링 |
| 성능 수준 | Ghostty/WezTerm급 네이티브 성능 (목표) |
| 장점 | Electron 제거로 메모리 60%+ 절감, CPU 부하 최소화 |
| 난이도 | 높음 — 커스텀 터미널 렌더러 구현 필요 |

- Electron → Tauri v2 마이그레이션 (UI 코드 React 재사용 가능)
- wgpu 크레이트로 DirectX 12/Vulkan 직접 접근
- 커스텀 글리프 래스터라이저 + GPU 텍스처 아틀라스
- Game of Life 60fps, 1GB 로그 파일 스크롤 렉 없음 (목표)

#### GPU 렌더링 단계별 비교

| 항목 | Canvas 2D (기본) | Phase 1 (WebGL) | Phase 2 (wgpu) | cmux (libghostty) |
|------|-----------------|-----------------|----------------|-------------------|
| GPU 사용 | ✗ CPU only | ✓ WebGL 경유 | ✓ 네이티브 | ✓ Metal 네이티브 |
| 중간 레이어 | — | Chromium | 없음 | 없음 |
| 메모리 (탭 10개) | ~300MB | ~250MB | ~100MB (예상) | ~129MB |
| 대량 로그 성능 | 렉 심함 | 양호 | Ghostty급 | Ghostty |
| 개발 난이도 | 쉬움 | 쉬움 | 높음 | 높음 |

### 4.7 Shell Integration (Windows 특화)

cmux에 없는 Windows 전용 기능:

- **PowerShell 7 네이티브 통합** (WSL 없이도 완전 동작)
- Git Bash 지원
- WSL2 직접 연결 (WSL 설치 시)
- cmd.exe 호환
- **ConPTY API 기반 PTY 연결** (입력 멈춤 문제 해결)

### 4.8 AI Agent Hooks Integration

**cmux 대응**: Claude Code hooks, OpenCode hooks

- **Claude Code Hooks**: Stop/PreToolUse/PostToolUse 이벤트 자동 감지
- Codex CLI 통합
- Gemini CLI 통합
- OpenCode 통합
- 커스텀 에이전트 훅 정의 가능 (Plugin 구조)
- 에이전트 완료 시 자동 알림 + 사이드바 상태 업데이트

### 4.9 Session Persistence & Restore

**cmux 대응**: Layout restore, working directory, scrollback

- 앱 재시작 시 레이아웃 복원 (Window/Workspace/Pane 구조)
- 작업 디렉토리 복원
- 터미널 스크롤백 복원 (best effort)
- 브라우저 URL 및 네비게이션 히스토리 복원
- 로그 히스토리 저장

### 4.10 Additional Features

- **Command Palette**: `Ctrl+K` 스타일 빠른 명령 검색
- **Vi Copy Mode**: 터미널 스크롤백 vi 스타일 복사 모드
- 테마 설정 파일 호환 (선택적)
- 자동 업데이트 시스템
- 다국어 UI 지원 (한국어 포함)

---

## 5. Technical Architecture

### 5.1 System Overview

cmux가 Swift/AppKit + libghostty로 구축된 것처럼, WinMux는 Windows 네이티브 기술을 활용한다.

| Layer | Component | Technology | cmux Equivalent |
|-------|-----------|------------|-----------------|
| Frontend UI | Desktop Shell | Electron + React | Swift/AppKit |
| Terminal Engine | GPU Renderer | xterm.js (WebGL) | libghostty |
| PTY Bridge | Process Manager | node-pty (ConPTY) | libghostty PTY |
| Browser Engine | In-App Browser | WebView2 (Chromium) | WebKit |
| IPC Layer | API Server | Named Pipe + JSON | Unix Socket |
| Shell Layer | Shell Integration | PowerShell/Bash/WSL | zsh/bash |

### 5.2 핵심 설계 원칙

- **공식 CLI/SDK 래핑만 허용**: Anthropic ToS 준수를 위해 웹 자동화/세션 탈취 절대 금지
- **Agent Agnostic**: cmux처럼 특정 에이전트에 종속되지 않는 범용 터미널
- **Plugin Architecture**: 에이전트별 훅을 플러그인으로 분리
- **Event Bus**: Agent → Event → UI 반영 구조
- **ConPTY 기반**: Windows 네이티브 PTY로 입력 멈춤 문제 근본 해결

### 5.3 ToS 준수 아키텍처 (밴 방지)

| 구현 방식 | 위험도 | WinMux 적용 |
|-----------|--------|------------|
| 공식 CLI 래핑 (node-pty) | ✅ 낮음 (Safe) | 기본 적용 |
| 공식 API/Agent SDK | ✅ 가장 안전 | 플러그인으로 지원 |
| 웹 UI 자동화 (Playwright 등) | ❌ 매우 높음 (Ban) | 절대 금지 |
| 세션/토큰 탈취 | ❌ 즉시 정지 | 절대 금지 |

### 5.4 프로젝트 구조

```
winmux/
├── src/
│   ├── main/              # Electron main process
│   │   ├── pty/            # node-pty + ConPTY bridge
│   │   ├── ipc/            # Named Pipe server
│   │   ├── session/        # Session persistence
│   │   └── updater/        # Auto-update
│   ├── renderer/           # React UI
│   │   ├── components/
│   │   │   ├── Sidebar/    # Workspace list + status
│   │   │   ├── Terminal/   # xterm.js wrapper
│   │   │   ├── Browser/    # WebView2 wrapper
│   │   │   ├── Notification/ # Ring + Panel + Badge
│   │   │   └── Palette/    # Command palette
│   │   ├── stores/         # Zustand state
│   │   └── hooks/          # Event bus hooks
│   ├── cli/                # winmux CLI tool
│   └── plugins/            # Agent hook plugins
│       ├── claude.ts
│       ├── codex.ts
│       ├── gemini.ts
│       └── opencode.ts
├── assets/
├── scripts/
├── tests/
├── package.json
├── electron-builder.yml
└── README.md
```

---

## 6. UI Specification

### 6.1 Layout Structure

cmux의 UI 구조를 그대로 계승한다:

```
┌──────────────────────────────────────────────────────────────┐
│  Sidebar (240px)  │     Terminal Pane Area      │ Inspector  │
│                   │                             │ (Optional) │
│  Workspace List   │  ┌───────────┬────────────┐ │            │
│  ─────────────    │  │           │            │ │ Log summary│
│  > dev       🔵   │  │  Pane 1   │   Pane 2   │ │ Error track│
│    server    🟢   │  │  [S1][S2] │   [S1]     │ │ Agent stat │
│    logs      🟡   │  │           │            │ │ Progress   │
│                   │  │ Terminal  │  Browser   │ │            │
│  Git: main        │  │           │            │ │            │
│  CWD: ~/project   │  └───────────┴────────────┘ │            │
│  Port: 3000       │                             │            │
│  PR: #42 ✓        │                             │            │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 Keyboard Shortcuts (Windows 매핑)

| cmux (Mac) | WinMux (Win) | 기능 | 카테고리 |
|------------|-------------|------|---------|
| ⌘N | Ctrl+N | New workspace | Workspace |
| ⌘1-8 | Ctrl+1-8 | Jump to workspace | Workspace |
| ⌘9 | Ctrl+9 | Jump to last workspace | Workspace |
| ⌃⌘] | Ctrl+Alt+] | Next workspace | Workspace |
| ⌃⌘[ | Ctrl+Alt+[ | Previous workspace | Workspace |
| ⌘⇧W | Ctrl+Shift+W | Close workspace | Workspace |
| ⌘⇧R | Ctrl+Shift+R | Rename workspace | Workspace |
| ⌘B | Ctrl+B | Toggle sidebar | UI |
| ⌘T | Ctrl+T | New surface | Surface |
| ⌘⇧] | Ctrl+Shift+] | Next surface | Surface |
| ⌘⇧[ | Ctrl+Shift+[ | Previous surface | Surface |
| ⌘W | Ctrl+W | Close surface | Surface |
| ⌘D | Ctrl+D | Split right | Pane |
| ⌘⇧D | Ctrl+Shift+D | Split down | Pane |
| ⌥⌘←→↑↓ | Alt+Ctrl+Arrow | Focus pane directionally | Pane |
| ⌘⇧H | Ctrl+Shift+H | Flash focused panel | Pane |
| ⌘⇧L | Ctrl+Shift+L | Open browser in split | Browser |
| ⌘L | Ctrl+L | Focus address bar | Browser |
| ⌘I | Ctrl+I | Show notifications panel | Notification |
| ⌘⇧U | Ctrl+Shift+U | Jump to latest unread | Notification |
| ⌘F | Ctrl+F | Find | Find |
| ⌘K | Ctrl+K | Command palette / Clear | UI |
| ⌘, | Ctrl+, | Settings | UI |
| ⌘Q | Alt+F4 | Quit | Window |

---

## 7. Technology Stack

### Phase 1 (MVP — Electron)

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Desktop Framework | Electron | Hyper/Tabby 사례 검증, 빠른 UI 개발, Vibe Coding 친화적 |
| Terminal Renderer | xterm.js + **WebGL Addon** | GPU 가속 렌더링, VS Code 동일 엔진, Canvas 2D 대비 5~10x |
| PTY Bridge | node-pty (ConPTY backend) | Windows 네이티브 PTY, 입력 멈춤 해결 |
| Browser | WebView2 (Edge/Chromium) | Windows 10+ 기본 탑재, 경량 |
| IPC | Named Pipe + JSON-RPC | Unix socket의 Windows 대응 |
| Frontend | React + TypeScript + Tailwind | 빠른 UI 개발, 커뮤니티 생태계 |
| State Management | Zustand + EventEmitter | Event Bus 구현 |
| Build | electron-builder | 자동 업데이트, MSI/NSIS 배포 |

### Phase 2 (장기 — Tauri v2 + 네이티브 GPU)

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Desktop Framework | **Tauri v2** | Electron 대비 메모리 60%+ 절감, 네이티브 성능 |
| Terminal Renderer | **wgpu (Rust WebGPU)** | DirectX 12/Vulkan 네이티브 GPU → Ghostty급 성능 |
| PTY Bridge | portable-pty (Rust) | Tauri 네이티브 통합, ConPTY 지원 |
| Browser | WebView2 (Tauri 기본 지원) | 동일 |
| IPC | Named Pipe + JSON-RPC | 동일 (CLI 호환 유지) |
| Frontend | React + TypeScript + Tailwind | **재사용** (Tauri는 웹뷰 기반이므로 UI 코드 이식 가능) |
| State Management | Zustand + EventEmitter | 동일 |
| Build | tauri-bundler | MSI/NSIS + winget 배포 |

---

## 8. Development Roadmap

### Phase 1: Foundation (4주)

**cmux 핵심 기능의 Windows 구현**

- [ ] Electron + xterm.js + node-pty 기본 터미널
- [ ] PowerShell 7 / Git Bash / WSL2 / cmd.exe 셸 선택
- [ ] 사이드바 + 워크스페이스 관리 UI
- [ ] 수평/수직 Pane 분할
- [ ] Surface (Pane 내 탭) 구현
- [ ] Keyboard shortcuts (cmux 매핑)
- [ ] 기본 세션 저장/복원

### Phase 2: Notification & Agent (3주)

**cmux 알림 시스템 완전 구현**

- [ ] Notification rings (페인 주변 파란 링)
- [ ] Sidebar 알림 배지
- [ ] Notification panel (Ctrl+I)
- [ ] OSC 9/99/777 시퀀스 감지
- [ ] Windows Toast Notification 통합
- [ ] Claude Code Hooks 자동 감지
- [ ] Git branch / CWD / listening ports 사이드바 표시

### Phase 3: CLI & API (3주)

**cmux CLI/Socket API의 Windows 대응**

- [ ] winmux CLI 구현 (전체 명령 세트)
- [ ] Named Pipe API 서버
- [ ] JSON-RPC 통신 프로토콜
- [ ] 환경변수 자동 설정 (WINMUX_WORKSPACE_ID 등)
- [ ] Command palette (Ctrl+K)

### Phase 4: Browser & Polish (3주)

**cmux 브라우저 기능 + 마무리**

- [ ] WebView2 내장 브라우저
- [ ] Scriptable browser API (snapshot, click, fill, eval)
- [ ] Vi copy mode
- [ ] 커스텀 알림 사운드
- [ ] 다국어 UI
- [ ] 자동 업데이트 시스템
- [ ] 공개 배포 (GitHub + winget)

### Phase 5: Native GPU Migration (8~12주)

**Electron → Tauri v2 + wgpu 네이티브 GPU 렌더링 (Ghostty급 목표)**

- [ ] Tauri v2 프로젝트 셋업 (React UI 코드 이식)
- [ ] portable-pty (Rust) 기반 PTY 브릿지 교체
- [ ] wgpu 크레이트 기반 커스텀 터미널 렌더러 구현
  - [ ] 글리프 래스터라이저 (fontdue/ab_glyph)
  - [ ] GPU 텍스처 아틀라스 (글리프 캐싱)
  - [ ] 셀 그리드 렌더링 파이프라인 (DirectX 12 / Vulkan)
  - [ ] ANSI 파서 + 컬러/스타일 GPU 적용
- [ ] WebView2 브라우저 Tauri 통합
- [ ] Named Pipe API 서버 Rust 포팅
- [ ] 성능 벤치마크: Ghostty/WezTerm 대비 측정
  - [ ] 대량 로그 출력 FPS (목표: 60fps at 10K lines/sec)
  - [ ] 메모리 사용량 (목표: 탭 10개 기준 ~100MB)
  - [ ] Game of Life 60fps ASCII 렌더링
- [ ] Electron 버전과 기능 패리티 검증
- [ ] MSI/NSIS + winget 배포

### Phase 6: Advanced (Ongoing)

- [ ] 멀티 에이전트 오케스트레이션 플러그인
- [ ] 클라우드 VM 연결
- [ ] iOS/Android 연동 (모바일 모니터링)
- [ ] 팀 협업 기능

---

## 9. Competitive Analysis

| Feature | cmux | WinMux | Win Terminal | Warp | Hyper/Tabby |
|---------|------|--------|-------------|------|-------------|
| Windows 지원 | ✗ | ✓ | ✓ | ✓ | ✓ |
| GPU 렌더링 | ✓ Metal | △ WebGL → ✓ wgpu | △ | ✓ | △ |
| Vertical Sidebar | ✓ | ✓ | ✗ | ✗ | ✗ |
| Notification Ring | ✓ | ✓ | ✗ | ✗ | ✗ |
| Agent Hooks | ✓ | ✓ | ✗ | △ | ✗ |
| CLI/Socket API | ✓ | ✓ | ✗ | ✗ | △ |
| In-App Browser | ✓ | ✓ | ✗ | ✗ | ✗ |
| PowerShell Native | ✗ | ✓ | ✓ | ✓ | ✓ |
| Open Source | AGPL-3.0 | MIT | MIT | ✗ | MIT |

---

## 10. Success Metrics

- MVP 출시 후 3개월 내 GitHub Stars 500+
- Windows Claude Code 사용자 커뮤니티 입소문
- 입력 멈춤(freeze) 발생율 0% (ConPTY 기반)
- Phase 1: ASCII 렌더링 30fps 이상 (xterm.js WebGL)
- Phase 2: ASCII 렌더링 60fps + 1GB 로그 렉 없음 (wgpu 네이티브)
- Phase 2: 메모리 사용량 탭 10개 기준 ~100MB (Ghostty급)
- cmux 기능 패리티 100% 달성

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Electron 성능 한계 (Phase 1) | 메모리 과다, Ghostty 대비 렌더링 약함 | Phase 1에서 xterm.js WebGL로 최대한 확보, Phase 5에서 Tauri + wgpu로 전환 |
| wgpu 커스텀 렌더러 개발 난이도 (Phase 2) | 개발 기간 장기화, Rust 전문성 필요 | Alacritty/WezTerm 오픈소스 렌더러 구조 참고, 단계적 구현 |
| Anthropic ToS 위반 의혹 | 계정 정지 | 공식 CLI 래핑만 허용, 아키텍처 체크리스트 준수 |
| cmux가 Windows 지원 추가 | 프로젝트 차별화 상실 | PowerShell 네이티브 + Windows 특화 UX + 네이티브 GPU로 차별화 |
| ConPTY 호환성 이슈 | 일부 CLI 도구 불안정 | PTY 레이어 추상화, 폴백 메커니즘 구현 |

---

## 12. License & Open Source

WinMux는 MIT 라이센스로 공개한다. cmux의 AGPL-3.0과 달리 코드 재사용에 제약이 없는 MIT를 채택하여 커뮤니티 참여와 기업 도입을 용이하게 한다.

cmux의 코드를 직접 포크/복사하지 않고, 기능과 철학만 참고하여 신규 구현한다. 기술 스택 자체가 완전히 다르므로 (cmux: Swift/AppKit/libghostty vs WinMux Phase 1: Electron/React/xterm.js, Phase 2: Tauri/React/wgpu) 코드 수준 겹침 없음.

---

## Appendix: cmux Feature Mapping Checklist

```
[cmux Feature]                          → [WinMux Implementation]
────────────────────────────────────────────────────────────────
Vertical tabs (sidebar)                 → React Sidebar component
Notification rings (blue ring)          → CSS animation on pane border
Notification panel                      → Slide-over panel (Ctrl+I)
Sidebar notification badge              → Unread count badge
Git branch display                      → git rev-parse integration
PR status/number display                → GitHub API plugin
Working directory display               → CWD tracking per surface
Listening ports display                 → Port scan per workspace
Latest notification text                → Event bus → sidebar update
Split panes (H/V)                       → xterm.js multi-instance layout
Surface tabs within panes               → Tab component per pane
In-app browser                          → WebView2 panel
Browser scriptable API                  → IPC bridge to WebView2
CLI tool (cmux)                         → winmux.exe CLI
Unix socket API                         → Named Pipe API
OSC 9/99/777 detection                  → xterm.js parser hook
Claude Code hooks                       → Plugin: claude.ts
GPU-accelerated rendering               → Phase 1: xterm.js WebGL addon
                                          Phase 2: Tauri v2 + wgpu (Ghostty급)
Session restore                         → JSON state persistence
Vi copy mode                            → xterm.js addon
Command palette                         → Ctrl+K fuzzy search
Custom notification sounds              → Windows audio API
Auto-update (Sparkle)                   → electron-updater
Multi-language UI                       → i18n (ko, en, ja, zh, ...)
Ghostty config compatibility            → Theme import plugin (optional)
CJK IME support                         → ConPTY + xterm.js IME handling
```
