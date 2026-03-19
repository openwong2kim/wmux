# Wmux — Windows Terminal for AI Coding Agents

> cmux의 모든 기능을 Windows 네이티브로 재구현한 AI 에이전트 터미널

**Version:** 2.0
**Date:** 2026-03-19
**Author:** 우영 (AI TFT, Kyungshin)
**Status:** Active
**License:** MIT (Open Source)

---

## 1. Executive Summary

Wmux는 cmux(Ghostty 기반 macOS AI 터미널)의 모든 기능을 Windows 네이티브 환경에서 재구현한 오픈소스 터미널이다. Claude Code, Codex, OpenCode, Gemini CLI 등 AI 코딩 에이전트를 병렬 운영하는 개발자를 위해 설계되었다.

Windows 개발자들은 현재 macOS 전용인 cmux를 사용할 수 없고, WSL 없이는 tmux도 쓸 수 없으며, Windows Terminal/PowerShell의 입력 멈춤이나 렌더링 성능 문제를 경험하고 있다. Wmux는 이 공백을 채운다.

### One-liner

> "cmux의 전체 기능을 Windows 네이티브로 가져오고, GPU 렌더링 + PowerShell 통합 + AI 에이전트 조직 관제까지 통합한 터미널"

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

Wmux는 단순한 터미널이 아니라 AI 에이전트 작업 관제 UI이다. cmux의 철학을 그대로 계승한다:

> *"cmux is a primitive, not a solution. It gives you a terminal, a browser, notifications, workspaces, splits, tabs, and a CLI to control all of it."*

Wmux도 동일한 원칙을 따른다. 조합 가능한 프리미티브를 제공하고, 워크플로우는 개발자가 직접 구성한다.

### 3.1 Target Users

- Windows에서 Claude Code, Codex, Gemini CLI 등 AI 코딩 에이전트를 사용하는 개발자
- PowerShell 7 또는 Git Bash 환경의 개발자 (WSL 없이도 동작)
- WSL2 환경에서 병렬 에이전트를 운영하는 개발자
- 다중 에이전트 오케스트레이션이 필요한 파워 유저

---

## 4. Feature Specification (cmux Full Parity + Wmux Exclusive)

cmux의 모든 기능을 Windows 네이티브로 재구현하며, Windows 특화 기능과 Wmux 독자 기능을 추가한다.

### 4.1 Workspace & Session Management

**cmux 대응**: Vertical tabs, workspace, sidebar

- 세로 사이드바 (Slack/Discord 스타일) 워크스페이스 목록
- 각 워크스페이스에 Git branch, PR 상태/번호, 작업 디렉토리, listening ports 표시
- 세션 상태 표시: Running(녹색), Idle(노란), Error(빨간), Waiting(파란)
- 최신 알림 텍스트 표시 (cmux 사이드바 동일)
- `Ctrl+1~8` 워크스페이스 빠른 이동, `Ctrl+Shift+R` 이름 변경
- 워크스페이스 드래그앤드드롭 재정렬
- 미니 사이드바 모드 (Ctrl+B 토글, 48px 아이콘 뷰)

### 4.2 Notification System

**cmux 대응**: Notification rings, notification panel, OSC 9/99/777

- **Notification Rings**: 백그라운드 프로세스 알림 시 Pane 주변 파란 링 애니메이션
- **Sidebar 알림 배지**: 읽지 않은 알림 카운트 표시
- **Notification Panel**: `Ctrl+I`로 모든 대기 알림 한곳에서 확인
- `Ctrl+Shift+U`로 최신 읽지 않은 알림으로 점프
- Windows OS 알림 (Toast Notification) 통합
- 작업 표시줄 배지 및 표시
- 커스텀 알림 사운드 (Web Audio API, 타입별 음정)
- OSC 9/99/777 터미널 시퀀스 자동 감지
- CLI로 알림 트리거: `wmux notify --title "Build Complete" --body "Done"`

### 4.3 Split Panes & Surfaces

**cmux 대응**: Split right/down, pane hierarchy, surface tabs within panes

- 수평(`Ctrl+D`) / 수직(`Ctrl+Shift+D`) 분할
- 4단계 계층 구조: **Window > Workspace > Pane > Surface > Panel**
- Pane 내 복수 Surface(탭) 지원 (cmux 동일 구조)
- 방향키로 Pane 포커스 이동 (`Alt+Ctrl+방향키`)
- `Ctrl+Shift+H`로 포커스된 패널 플래시 강조
- Surface 드래그앤드드롭으로 Pane 간 이동
- 사이드바 Ctrl+클릭으로 멀티 Pane 분할 생성
- 빈 Pane 자동 제거 (마지막 Surface 닫힘 시)

### 4.4 In-App Browser

**cmux 대응**: Built-in browser with scriptable API (agent-browser port)

- `Ctrl+Shift+L`로 브라우저 패널 열기 (터미널 옆에 분할)
- WebView2 (Chromium) 기반 내장 브라우저
- **Scriptable API**: DOM snapshot, element click, fill, JS evaluate, navigate
- 에이전트가 dev server와 직접 상호작용 가능
- DevTools (F12) 통합
- 브라우저 `Ctrl+F` 검색, 뒤로/앞으로 네비게이션
- URL 바 포커스 (`Ctrl+L`)
- WebView sandbox 격리 + 위험 URL 스킴 차단

### 4.5 CLI & Named Pipe API

**cmux 대응**: Unix socket API + CLI (cmux의 핵심 차별화)

Windows 환경에서는 Unix socket 대신 Named Pipe를 사용한다.

**CLI Commands (`wmux`):**

```
# Workspace
wmux new-workspace [--name "project"]
wmux list-workspaces
wmux focus-workspace <id>
wmux close-workspace <id>
wmux current-workspace

# Surface & Pane
wmux new-surface
wmux list-surfaces
wmux focus-surface <id>
wmux close-surface <id>
wmux split --direction right|left|up|down
wmux list-panes
wmux focus-pane <id>

# Input Control
wmux send <text>
wmux send-key <keystroke>
wmux read-screen

# Notifications
wmux notify --title <title> --body <body>

# Browser
wmux browser snapshot
wmux browser click <ref>
wmux browser fill <ref> <text>
wmux browser eval <js>
wmux browser navigate <url>

# Sidebar Metadata
wmux set-status <text>
wmux set-progress <0-100>

# System
wmux identify
wmux capabilities
```

**Named Pipe API** (`\\.\pipe\wmux-{pid}`):

```json
{"id":"req-1","method":"workspace.list","params":{}}
// Response: {"id":"req-1","ok":true,"result":{"workspaces":[...]}}
```

**환경변수 (자동 설정):**
- `WMUX_WORKSPACE_ID`
- `WMUX_SURFACE_ID`
- `WMUX_SOCKET_PATH`

### 4.6 GPU-Accelerated Terminal Rendering

**cmux 대응**: libghostty 기반 Metal GPU 렌더링

#### Phase 1: xterm.js WebGL (MVP) — 구현 완료

| 항목 | 내용 |
|------|------|
| 기술 | Electron + xterm.js WebGL Addon |
| GPU 사용 방식 | Chromium WebGL 컨텍스트를 통한 GPU 가속 |
| 성능 수준 | Canvas 2D 대비 5~10x 향상, Windows Terminal보다 우수 |
| 스크롤백 | 10,000줄 (설정에서 변경 가능) |

#### Phase 2: Tauri v2 + wgpu 네이티브 GPU (장기)

| 항목 | 내용 |
|------|------|
| 기술 | Tauri v2 + wgpu (Rust WebGPU 구현체) |
| GPU 사용 방식 | DirectX 12 / Vulkan / Metal 네이티브 API 직접 호출 |
| 성능 수준 | Ghostty/WezTerm급 네이티브 성능 (목표) |

### 4.7 Shell Integration (Windows 특화)

- **PowerShell 7 네이티브 기본 셸** (WSL 없이도 완전 동작, cd 드라이브 전환 자동)
- Git Bash 지원
- WSL2 직접 연결 (WSL 설치 시)
- cmd.exe 호환
- **ConPTY API 기반 PTY 연결** (입력 멈춤 문제 해결)
- Shell 허용 목록 보안 (powershell, pwsh, cmd, bash, wsl, git-bash, sh)

### 4.8 AI Agent Hooks Integration

**cmux 대응**: Claude Code hooks, OpenCode hooks

- **Claude Code Hooks**: Stop/PreToolUse/PostToolUse 이벤트 자동 감지
- **Codex CLI** 통합 (`codex>` 패턴)
- **Gemini CLI** 통합 (`gemini>` 패턴)
- **OpenCode** 통합 (`opencode>` 패턴)
- **GitHub Copilot CLI** 통합 (`copilot>` 패턴)
- 공통 상태 감지: 완료(✓/Done), 에러(✗/Error), 대기(y/n/Press)
- 에이전트 상태 사이드바 표시 (running🔵, complete🟢, error🔴, waiting🟡)
- 커스텀 에이전트 훅 정의 가능 (Plugin 구조)

### 4.9 Session Persistence & Restore

- 앱 재시작 시 레이아웃 복원 (Window/Workspace/Pane 구조)
- 작업 디렉토리 복원
- 브라우저 URL 복원 (위험 URL 스킴 차단)
- PTY ID 자동 재생성 (이전 세션 PTY는 사라지므로)
- 세션 데이터 스키마 검증 + prototype pollution 방어

### 4.10 Additional Features

- **Command Palette**: `Ctrl+K` 스타일 빠른 명령 검색
- **Vi Copy Mode**: `Ctrl+Shift+X`로 진입, vi 키 바인딩 복사
- **터미널 검색**: `Ctrl+F` (xterm.js search addon)
- **Pane 플래시**: `Ctrl+Shift+H` 활성 Pane 시각적 강조
- **클립보드**: Ctrl+C (선택 시 복사/미선택 시 SIGINT), Ctrl+V (붙여넣기), 우클릭 (붙여넣기)
- **설정 패널**: `Ctrl+,` (General/Appearance/Notifications/Shortcuts/About 5탭)
- 테마 설정 파일 호환 (선택적)
- 자동 업데이트 시스템
- 다국어 UI 지원 (한국어, 영어, 일본어, 중국어)

---

### 4.11 Agent Organization Mode (Wmux 킬러 피쳐)

**cmux에 없음. Wmux 독자 기능.**

OpenClaw의 멀티 에이전트 조직 개념 + Claude Code Agent Teams(공식 `--teammate-mode`) + agency-agents 프리셋 에이전트를 결합하여, GUI에서 AI 에이전트 조직을 구성하고 관제하는 기능이다.

#### 4.11.1 개념

기존 멀티 에이전트 환경의 문제:
- **OpenClaw**: tmux 설정파일 직접 작성 필요, 터미널 텍스트만으로 상태 파악
- **Claude Code Agent Teams**: tmux 기반, 시각적 관제 없음
- **PROJECT CAIO (J.A.R.V.I.S.)**: 텔레그램을 인터페이스로 사용, 단일 사용자 의존

Wmux 해결책:
- **Wmux = 시각적 AI 조직 관제 UI** (텔레그램/tmux 대체)
- 클릭 몇 번으로 팀장/팀원 배치
- 사이드바에서 전체 조직 상태 실시간 관제
- 비개발자도 멀티 에이전트 구성 가능

#### 4.11.2 조직 구조

```
Organization: "My Project"
├── 팀장 (Team Lead)
│   ├── Pane: claude --teammate-mode lead
│   ├── Role: 작업 배분, 결과 취합, 의사결정
│   └── CLAUDE.md: 팀장 페르소나
│
├── 팀원 1: Frontend Developer
│   ├── Pane: claude --teammate-mode
│   ├── Preset: agency-agents/engineering/frontend-developer.md
│   └── Tools: Read, Write, Edit, Bash, Glob, Grep
│
├── 팀원 2: Backend Architect
│   ├── Pane: claude --teammate-mode
│   ├── Preset: agency-agents/engineering/backend-architect.md
│   └── Tools: Read, Write, Edit, Bash, Glob, Grep
│
├── 팀원 3: Security Auditor
│   ├── Pane: claude --teammate-mode
│   ├── Preset: agency-agents/engineering/security-auditor.md
│   └── Tools: Read, Grep, Glob (read-only)
│
└── 팀원 4: QA Engineer
    ├── Pane: claude --teammate-mode
    ├── Preset: agency-agents/engineering/qa-tester.md
    └── Tools: Read, Write, Bash, Glob, Grep
```

#### 4.11.3 통신 체계

| 통신 방향 | 내용 | Wmux UI 표현 |
|-----------|------|-------------|
| Team Lead → Teammate | 작업 배정 + 컨텍스트 | 사이드바 화살표 + 알림 링 |
| Teammate → Team Lead | 상태 업데이트, 완료 보고, 질문 | 알림 배지 + 상태 변경 |
| Teammate ↔ Teammate | 횡적 소통 | 연결선 + 메시지 프리뷰 |

#### 4.11.4 프리셋 에이전트 마켓플레이스

agency-agents (GitHub Stars 31K) 등 오픈소스 에이전트 프리셋을 내장:

**Engineering:** frontend-developer, backend-architect, database-architect, security-auditor, test-automator, deployment-engineer, devops-engineer

**Design:** ui-designer, ux-researcher, design-system-architect

**Product:** product-manager, technical-writer, project-manager

**Marketing:** content-strategist, seo-specialist, social-media-manager

**커스텀 에이전트:** 사용자가 `.claude/agents/*.md` 작성하여 추가 가능

#### 4.11.5 운영 체계

위험도 기반 승인 루프:

| 위험도 | 예시 | 동작 |
|--------|------|------|
| Safe | 파일 읽기, 코드 분석, 검색 | 자동 실행 |
| Review | 파일 수정, 의존성 추가 | 사이드바 알림 후 실행 |
| Critical | 배포, DB 마이그레이션, 삭제 | 승인 다이얼로그 필수 |

#### 4.11.6 Wmux CLI로 조직 관리

```bash
wmux org create "my-project" --lead
wmux org add-member --preset frontend-developer --name "FE팀"
wmux org add-member --preset backend-architect --name "BE팀"
wmux org add-member --preset security-auditor --name "보안팀"
wmux org add-member --agent ./agents/my-custom.md --name "커스텀팀"
wmux org status
wmux org send-lead "프로젝트 전체 코드 리뷰 후 보안 취약점 보고해줘"
wmux org send-member "FE팀" "로그인 페이지 반응형으로 수정해"
```

#### 4.11.7 차별화 포인트

| 항목 | OpenClaw | Claude Agent Teams | PROJECT CAIO | Wmux |
|------|----------|-------------------|-------------|------|
| 인터페이스 | tmux 텍스트 | tmux 텍스트 | 텔레그램 | 네이티브 GUI |
| 에이전트 설정 | 설정파일 직접 작성 | CLI 플래그 | CLAUDE.md | GUI 클릭 + 프리셋 |
| 시각적 관제 | ✗ | ✗ | ✗ | ✓ (사이드바 + 알림 링) |
| 조직 구성 | 가능 (수동) | 가능 (수동) | 가능 (수동) | GUI로 드래그앤드롭 |
| 승인 루프 | ✗ | ✗ | 텔레그램 버튼 | 네이티브 다이얼로그 |
| 비개발자 접근성 | 낮음 | 낮음 | 중간 | 높음 |
| Agent Agnostic | ✓ | Claude 전용 | Claude 전용 | ✓ |

---

### 4.12 Company Mode (Wmux 궁극 피쳐)

**여러 독립 Agent Team을 부서로 묶어 "AI 가상 회사"를 운영하는 모드**

#### 4.12.1 핵심 제약 사항

> **Agent Teams Nesting 불가**: Claude Code 공식 문서에 "Teammate는 자기만의 팀을 spawn할 수 없다"고 명시.

| 제약 | 내용 |
|------|------|
| Nesting 불가 | Teammate가 sub-team spawn 불가 |
| 모델 고정 | 팀 내 전체 에이전트가 동일 모델 필수 |
| 토큰 비용 선형 증가 | 에이전트 수 x 독립 컨텍스트 윈도우 |
| Split Pane 제한 | Agent Teams split-pane 모드는 tmux/iTerm2만 지원 |
| 세션 복구 불가 | /resume 시 teammate 복원 안 됨 |
| 실험 기능 | 2026.03 기준 여전히 experimental |

#### 4.12.2 해결 아키텍처: 하이브리드 접근

**핵심: Agent Teams 중첩 대신, 독립 Agent Team 여러 개 + Wmux IPC 라우팅으로 회사 구조 구현**

```
[Wmux 하이브리드 방식]
CEO (독립 Claude 세션, Wmux Workspace 0)
  | Wmux Named Pipe IPC (wmux send)
부서장 A (독립 Team Lead, Workspace 1) -> 팀원 A1, A2 (Agent Teams Teammate)
부서장 B (독립 Team Lead, Workspace 2) -> 팀원 B1, B2 (Agent Teams Teammate)
부서장 C (독립 Team Lead, Workspace 3) -> 팀원 C1, C2 (Agent Teams Teammate)
```

**통신 레이어 분리:**

| 구간 | 프로토콜 | 담당 |
|------|---------|------|
| 사용자 ↔ CEO | 직접 터미널 입력 | 사용자 |
| CEO → 부서장 | Wmux Named Pipe (`wmux send`) | Wmux IPC Layer |
| 부서장 ↔ 팀원 | Agent Teams Protocol (내장 메시징) | Claude Code 공식 |
| 부서장 ↔ 부서장 | Wmux Named Pipe (`wmux send`) | Wmux IPC Layer |

#### 4.12.3 Company 계층 구조

```
Company: "Kyungshin AI Project"
|
+-- CEO (일반 Claude 세션) <- Workspace 0
|
+-- Engineering (독립 Agent Team) <- Workspace 1
|   +-- CTO (Team Lead)
|   +-- FE Dev, BE Dev, QA (Teammates)
|
+-- Security (독립 Agent Team) <- Workspace 2
|   +-- CISO (Team Lead)
|   +-- Auditor (Teammate)
|
+-- Design (독립 Agent Team) <- Workspace 3
|   +-- CDO (Team Lead)
|   +-- UI Designer (Teammate)
|
+-- Operations (독립 Agent Team) <- Workspace 4
    +-- COO (Team Lead)
    +-- DevOps (Teammate)
```

#### 4.12.4 예상 문제 및 조치

| 문제 | 조치 |
|------|------|
| CEO→부서장 텍스트 주입 시 의미론적 손실 | 구조화된 프롬프트 템플릿 자동 래핑 |
| 토큰 비용 폭발 (13+ 에이전트) | 비용 모니터링 대시보드, Idle 자동 sleep, 소~중규모 권장 |
| Windows에서 Agent Teams split-pane 미지원 | Wmux 자체 split으로 대체, in-process 모드 사용 |
| Teammate 멈춤 | Stuck 감지 (5분 무출력), Nudge/Respawn 버튼 |
| 세션 복구 불가 | Company 구성 JSON 저장, `wmux company restore`로 재생성 |
| 부서 간 파일 충돌 | Git worktree 기반 부서 격리, 명시적 merge |
| 부서 간 통신 지연 | Message Queue + busy 상태 시 큐 저장 |

#### 4.12.5 비용 예측

| Company 규모 | 에이전트 수 | 예상 비용/작업 | Max 플랜 적합성 |
|-------------|-----------|--------------|----------------|
| 소규모 (2부서, 4팀원) | 7 | $5~15 | 여유 |
| 중규모 (3부서, 6팀원) | 10 | $15~30 | 가능 |
| 대규모 (4부서, 8팀원) | 13 | $30~50 | 주의 |
| 최대 (5부서, 15팀원) | 21 | $50~100+ | 일일 한도 초과 가능 |

#### 4.12.6 Company View UI

**Company View 모드 전환**: `Ctrl+Shift+O` (Organization)

사이드바 Company 뷰:
```
Company: Kyungshin AI         cost: ~$12
-------------------------------------------
CEO                       Waiting
+- Engineering            3/3 Active
|  +- CTO (Lead)         Working
|  +- FE Dev             Working  "로그인 수정 중"
|  +- BE Dev             Idle     "API 완료"
+- Security              1/2 Active
|  +- CISO (Lead)        Idle
|  +- Auditor            Working  "스캔 진행 중"
+- Design                Needs Approval
   +- CDO (Lead)         Waiting  CRITICAL
   +- UI Designer        Idle
```

#### 4.12.7 Company CLI

```bash
wmux company create <name>
wmux company create <name> --template <template.json>
wmux company status
wmux company destroy
wmux company save
wmux company restore <config.json>
wmux company add-dept <name> --lead-prompt <prompt>
wmux company remove-dept <name>
wmux company add-member <dept> --preset <agent-preset>
wmux company broadcast <message>
wmux company send-dept <dept> <message>
wmux company send-member <dept> <member> <message>
wmux company worktree-setup
wmux company merge-dept <dept>
```

#### 4.12.8 Company 템플릿

```json
{
  "name": "Full-Stack Project Team",
  "recommended_plan": "Max ($200/mo)",
  "estimated_cost_per_task": "$15-30",
  "ceo": {
    "prompt": "You are the CEO. Coordinate departments and synthesize results."
  },
  "departments": [
    {
      "name": "Engineering",
      "lead_prompt": "You are the CTO.",
      "worktree_branch": "dev/engineering",
      "members": [
        { "preset": "frontend-developer", "name": "FE Dev" },
        { "preset": "backend-architect", "name": "BE Dev" },
        { "preset": "qa-tester", "name": "QA" }
      ]
    },
    {
      "name": "Security",
      "lead_prompt": "You are the CISO.",
      "worktree_branch": "dev/security",
      "members": [
        { "preset": "security-auditor", "name": "Auditor" }
      ]
    }
  ]
}
```

#### 4.12.9 차별화 요약

| 항목 | OpenClaw Office | Claw3D | Wmux Company Mode |
|------|----------------|--------|-------------------|
| 시각화 | 2D 웹 대시보드 | 3D 가상 오피스 | 2D 조직도 + 터미널 통합 |
| 에이전트 실행 | 별도 | 별도 | 내장 (터미널 Pane = 에이전트) |
| 계층 | 팀 (단일) | 팀 (단일) | 회사 (CEO → 독립 부서 Teams) |
| 부서 간 통신 | 수동 | 수동 | Wmux IPC 자동 라우팅 |
| 에이전트 복구 | 없음 | 없음 | Nudge/Respawn 버튼 |
| 비용 모니터링 | 없음 | 없음 | 실시간 토큰 비용 표시 |
| 파일 격리 | 없음 | 없음 | Git worktree 자동 설정 |
| Agent Agnostic | 전용 | 전용 | Claude/Codex/Gemini 혼합 |
| 템플릿 | 없음 | 없음 | JSON 저장/공유/마켓플레이스 |

---

## 5. Technical Architecture

### 5.1 System Overview

| Layer | Component | Technology | cmux Equivalent |
|-------|-----------|------------|-----------------|
| Frontend UI | Desktop Shell | Electron + React | Swift/AppKit |
| Terminal Engine | GPU Renderer | xterm.js (WebGL) | libghostty |
| PTY Bridge | Process Manager | node-pty (ConPTY) | libghostty PTY |
| Browser Engine | In-App Browser | WebView2 (Chromium) | WebKit |
| IPC Layer | API Server | Named Pipe + JSON-RPC | Unix Socket |
| Shell Layer | Shell Integration | PowerShell/Bash/WSL | zsh/bash |

### 5.2 핵심 설계 원칙

- **공식 CLI/SDK 래핑만 허용**: Anthropic ToS 준수를 위해 웹 자동화/세션 탈취 절대 금지
- **Agent Agnostic**: 특정 에이전트에 종속되지 않는 범용 터미널
- **Plugin Architecture**: 에이전트별 훅을 플러그인으로 분리
- **Event Bus**: Agent → Event → UI 반영 구조
- **ConPTY 기반**: Windows 네이티브 PTY로 입력 멈춤 문제 근본 해결

### 5.3 ToS 준수 아키텍처

| 구현 방식 | 위험도 | Wmux 적용 |
|-----------|--------|------------|
| 공식 CLI 래핑 (node-pty) | ✅ Safe | 기본 적용 |
| 공식 API/Agent SDK | ✅ 가장 안전 | 플러그인으로 지원 |
| 웹 UI 자동화 | ❌ Ban | 절대 금지 |
| 세션/토큰 탈취 | ❌ 즉시 정지 | 절대 금지 |

---

## 6. Development Roadmap

### Phase 1: Foundation ✅ 완료

- Electron + xterm.js + node-pty 기본 터미널
- PowerShell 7 / Git Bash / WSL2 / cmd.exe 셸 선택
- 사이드바 + 워크스페이스 관리 UI
- 수평/수직 Pane 분할, Surface 탭
- Keyboard shortcuts (cmux 매핑)
- 기본 세션 저장/복원

### Phase 2: Notification & Agent ✅ 완료

- Notification rings, Sidebar 알림 배지, Panel (Ctrl+I)
- OSC 9/99/777 시퀀스 감지
- Windows Toast Notification 통합
- Claude Code/Cursor/Aider 자동 감지
- Git branch / CWD / listening ports 사이드바 표시

### Phase 3: CLI & API ✅ 완료

- wmux CLI (전체 명령 세트)
- Named Pipe API 서버 + JSON-RPC
- 환경변수 자동 설정
- Command palette (Ctrl+K)

### Phase 4: Browser & Polish ✅ 완료

- WebView2 내장 브라우저 + Scriptable API
- Vi copy mode, 터미널 검색 (Ctrl+F)
- 커스텀 알림 사운드, 다국어 UI
- 설정 패널 (5탭), 드래그앤드롭
- AI Agent Hooks 확장 (7개 에이전트)
- 보안 강화 (CSP, WebView sandbox, 버퍼 제한, URL 스킴 차단)

### Phase 5: Agent Organization Mode (다음)

- 조직(Organization) 데이터 모델
- 조직 생성 UI (팀장 + 팀원 배치)
- Claude Code `--teammate-mode` 자동 실행 통합
- 프리셋 에이전트 브라우저 (agency-agents 카탈로그)
- 위험도 기반 승인 루프
- wmux org CLI 명령 세트

### Phase 6: Company Mode

- CEO → 독립 부서 Teams 하이브리드 아키텍처
- Company View UI (Ctrl+Shift+O)
- 부서 간 Wmux IPC 통신
- Company 템플릿 (JSON 저장/공유)
- Git worktree 부서 격리
- 비용 모니터링 대시보드

### Phase 7: Native GPU Migration (장기)

- Tauri v2 + wgpu 네이티브 GPU 렌더링
- Ghostty/WezTerm급 성능 목표

### Phase 8: Advanced (Ongoing)

- 팀 협업 (WebSocket 기반 원격 세션 공유)
- 클라우드 VM 연결
- iOS/Android 모바일 모니터링
- 에이전트 마켓플레이스

---

## 7. Competitive Analysis

| Feature | cmux | Wmux | Win Terminal | Warp | Hyper/Tabby |
|---------|------|------|-------------|------|-------------|
| Windows 지원 | ✗ | ✓ | ✓ | ✓ | ✓ |
| GPU 렌더링 | ✓ Metal | △ WebGL → ✓ wgpu | △ | ✓ | △ |
| Vertical Sidebar | ✓ | ✓ | ✗ | ✗ | ✗ |
| Notification Ring | ✓ | ✓ | ✗ | ✗ | ✗ |
| Agent Hooks | ✓ | ✓ | ✗ | △ | ✗ |
| CLI/Socket API | ✓ | ✓ | ✗ | ✗ | △ |
| In-App Browser | ✓ | ✓ | ✗ | ✗ | ✗ |
| Agent Organization | ✗ | ✓ | ✗ | ✗ | ✗ |
| Company Mode | ✗ | ✓ | ✗ | ✗ | ✗ |
| PowerShell Native | ✗ | ✓ | ✓ | ✓ | ✓ |
| Open Source | AGPL-3.0 | MIT | MIT | ✗ | MIT |

---

## 8. License

MIT License. cmux의 코드를 직접 포크/복사하지 않고, 기능과 철학만 참고하여 신규 구현.
