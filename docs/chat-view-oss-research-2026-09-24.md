# 범용 챗뷰: 오픈소스 조사 및 구현 방향

조사일: 2026-09-24. 상태: 설계 제안. 패키지 설치 및 런타임 구현은 아직 하지 않았다.

## 코드 출처 원칙

- 사용자 지시: Orca, Herdr 등 경쟁 제품은 공개된 동작·UX 아이디어만 참고한다. 경쟁 제품 소스, 테스트, 스타일, 자산을 복사·번역·변형해 가져오지 않는다. 오픈소스 여부와 무관하다.
- 차용 대상은 범용 UI 라이브러리, 공개 프로토콜, 에이전트 제공자의 공식 연동 SDK다. OpenCode의 앱 UI는 대상이 아니며 공식 SDK/API만 사용한다.
- 가급적 패키지 의존성으로 사용한다. 코드를 직접 포함해야 할 때는 출처 URL, 정확한 버전/커밋, 원본 경로, 변경 내용, LICENSE와 해당 NOTICE를 기록한다.
- 아래 라이선스는 조사한 upstream 기준이다. 실제 도입 시 배포 패키지와 전이 의존성을 고정하고 기존 `npm run licenses`를 통과시킨다. 아직 배포 라이선스 검증 완료를 뜻하지 않는다.

## 조사 결과

| 후보 | 확인한 기능과 라이선스 | 결정 |
| --- | --- | --- |
| assistant-ui | 외부에서 소유하는 메시지·실행 상태를 ExternalStoreRuntime으로 연결. upstream MIT | 기존 의존성을 유지. 대화 UI를 다시 만들지 않는다. |
| ACP TypeScript SDK | JSON-RPC 기반 세션, prompt, 업데이트, 취소, 승인 요청 및 capability 협상. upstream Apache-2.0 | 범용 ACP 어댑터 후보. 지원 에이전트 확대에 사용한다. |
| OpenCode 공식 SDK | typed client, 서버 이벤트 구독, 세션 메시지·중단·diff·승인 API. SDK package 및 upstream MIT | OpenCode 전용 연결의 우선 후보. 앱 구현 코드는 가져오지 않는다. |
| Codex app-server | 공식 앱 연동 인터페이스. 이력·승인·스트리밍, thread/turn 제어, 버전별 TS 스키마 생성 | 공개 프로토콜을 바탕으로 wmux 어댑터를 직접 구현. stdio부터 검증한다. |

근거:

- assistant-ui runtime: https://www.assistant-ui.com/docs/runtimes/custom/external-store
- assistant-ui LICENSE: https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE
- ACP protocol: https://agentclientprotocol.com/protocol/v1/overview
- ACP SDK: https://github.com/agentclientprotocol/typescript-sdk
- ACP SDK LICENSE: https://github.com/agentclientprotocol/typescript-sdk/blob/main/LICENSE
- OpenCode SDK: https://opencode.ai/docs/sdk/
- OpenCode server: https://opencode.ai/docs/server/
- OpenCode ACP: https://opencode.ai/docs/acp/
- OpenCode SDK package metadata: https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/package.json
- OpenCode LICENSE: https://github.com/anomalyco/opencode/blob/dev/LICENSE
- Codex official app-server documentation: https://learn.chatgpt.com/docs/app-server

ACP는 공통 연결 선택지이지 wmux의 내부 데이터 모델 자체로 고정하지 않는다. session/load 등 일부 기능은 선택 사항이다. 에이전트별 고유 기능을 공통 최소 기능에 맞추느라 버리지 않는다. OpenCode는 ACP도 제공하므로 초기 검증 결과에 따라 SDK와 ACP 중 하나를 주 연결로 선택한다. 같은 세션에 두 입력 경로를 동시에 활성화하지 않는다.

Codex 공식 문서는 앱 통합에 app-server, 자동화/CI에는 SDK를 구분해 안내한다. 따라서 TypeScript SDK를 채팅 UI의 기본 제어 경로로 먼저 채택하지 않는다. 문서상 app-server 및 WebSocket 경로의 실험적 제약을 고려해 지원 버전·스키마·기능을 실제 설치본으로 검증해야 한다. 최신 문서가 사용자의 설치 버전과 같다고 가정하지 않는다.

## wmux에서 재사용할 부분

- `package.json`: 이미 `@assistant-ui/react`를 사용한다.
- `src/renderer/components/Chat/ChatView.tsx`: `useExternalStoreRuntime` 연결, 대화별 draft, 중복 전송 방지, 전송 불확실 상태 처리.
- `src/shared/transcript/turnEvents.ts`: renderer와 daemon이 공유하는 정규화 이벤트 모델.
- `src/daemon/transcript/TranscriptProjector.ts`: bounded history reads, 이벤트 투영 및 구독 기반을 검토해 재사용.
- 기존 Claude 파서는 첫 번째 legacy transcript 어댑터로 유지한다.

현재 Claude 전용 제약은 탐색·경로 검증·기록 파싱·전송에 걸쳐 있다. `not-claude` 조건만 지우는 변경은 지원 구현이 아니다. `srcOffset`처럼 파일 기반 기록에만 맞는 참조도 일반 이벤트 저장소의 opaque body handle로 확장하되 기존 경로를 호환한다.

## 제안 구조

```text
assistant-ui + wmux 작업 과정/파일 변경/승인 컴포넌트
                         |
               공통 ChatSessionService
         세션 매핑 / 이벤트 저장 / 전송 상태 / 제어권
                         |
      +------------------+------------------+
      |                  |                  |
Claude transcript   Codex app-server    OpenCode SDK
      |                                     |
      +------------- ACP adapter -----------+
                (추가 에이전트용 경로)
```

프로세스 수명과 연결은 장기 실행 계층에서 관리하고 renderer는 구독만 한다. daemon에 둘지 main을 경유할지는 기존 빌드 경계와 SDK 런타임 요구 사항을 검증해 결정한다.

공통 이벤트에는 session/turn/item 식별자, 메시지 delta, 도구 시작·업데이트·종료, 변경 파일, 승인/질문, 계획, 완료·중단·오류를 둔다. 에이전트가 제공하지 않는 추론이나 경과 시간을 만들어내지 않는다. 원본 이벤트 타입과 제한된 확장 필드를 보존해 새 기능을 추가할 여지를 남긴다.

Capability는 에이전트 이름만으로 하드코딩하지 않는다. 어댑터·설치 버전·연결 모드·실제 세션 상태를 함께 고려해 historyRead, send, cancel, permissions, questions, attachments, modelSelection, resume, liveTerminalAttach, fileDiff, fileUndo를 계산한다. 기록 읽기만 가능한 세션은 읽기 전용 챗뷰로 제공한다.

## 두 종류의 세션을 구분

1. **wmux가 관리하는 새 챗 세션:** 구조화 프로토콜로 시작하고 실제 승인·취소·스트리밍을 연결한다.
2. **이미 실행 중인 CLI 세션:** 신뢰할 수 있는 세션 ID로 기록을 연결한다. 지원되는 연결/인계 경로가 검증되지 않으면 입력은 터미널에서만 한다. 새 백엔드 프로세스를 시작해 같은 대화에 두 실행 주체를 만들지 않는다.

Codex 문서에는 app-server에 CLI TUI를 연결하는 경로가 있으나, 임의의 기존 CLI 프로세스를 그대로 인계할 수 있다는 근거는 아니다. OpenCode도 기존 서버 주소·인증·프로젝트·세션 식별을 확인해야 한다. 두 UI의 제어권 전환과 재연결은 실제 설치 버전으로 따로 검증한다.

## wmux가 직접 구현할 기능

- reconnect snapshot과 live delta를 합칠 때 중복/누락 방지; cursor가 지원되지 않으면 명시적 재동기화.
- 전송 상태를 queued/sent/confirmed/unconfirmed/failed 등으로 구분하고, 응답이 끊겼다는 이유만으로 자동 재전송하지 않기.
- session/turn/request ID에 결합한 승인 카드; 종료된 turn이나 다른 세션에 승인 전달 금지.
- 터미널/챗뷰 입력 제어권과 대화별 draft. 다른 프로그램까지 잠그는 기능은 해당 에이전트가 제공하는 범위만 주장하기.
- 긴 도구 출력의 지연 로딩과 렌더링 제한, 작업 과정 접기 및 진행 시간 표시.
- turn별 변경 파일 출처. 저장소 전체 diff를 마지막 답변의 변경으로 단정하지 않기.
- 파일 되돌리기는 별도 snapshot/patch 기능으로 구현하고 이후 사용자 변경과 충돌하면 중단. 대화 rollback API를 파일 복원으로 취급하지 않기.

## 구현 순서와 완료 조건

1. Claude 기존 동작을 유지하면서 adapter registry, 공통 session ID, capabilities를 분리한다.
2. Codex 새 챗 세션으로 공통 구조를 검증한다: 답변 streaming, 도구 진행, 승인/질문 응답, 취소, 재시작 후 복원.
3. OpenCode 연결을 추가하고 같은 UI와 계약 테스트를 통과시킨다. 이를 통해 공통 모델의 Claude/Codex 종속을 제거한다.
4. ACP 어댑터를 추가해 추가 에이전트를 설정으로 연결할 수 있게 한다. 프로토콜 호환만으로 모든 기능을 지원한다고 표기하지 않는다.
5. 기존 CLI 세션의 읽기·입력·인계 범위를 버전별로 검증하고 지원 범위 안에서 터미널 전환을 제공한다.
6. 첨부 목표 화면의 작업 과정 묶음과 파일 변경 카드를 완성한다. 실행 취소는 변경 이력 검증 이후 활성화한다.

검증에는 합성 fixture와 직접 생성한 테스트 세션을 사용한다. 경쟁 제품의 fixtures/tests는 가져오지 않는다. 각 어댑터에서 순서가 바뀐 이벤트, 재연결, 중단, 오래된 승인, 전송 직후 연결 종료, 대용량 출력, 이력 페이지 경계를 확인한다. 실제 연동은 격리된 테스트 저장소에서 실시하고 기존 사용자 세션을 재사용하지 않는다.

초기 조사에서는 문서·라이선스·패키지 메타데이터만 확인했다. 이후 사용자 승인에 따라 공식 ACP/OpenCode SDK와 wmux 자체 어댑터를 구현하고 실제 Codex·OpenCode·ACP 응답 및 이력 복원을 검증했다. 경쟁 제품 코드는 다운로드하거나 복사하지 않았다. 구현 범위와 남은 검증은 [managed-chat.md](managed-chat.md)에 기록했다.


## Same-terminal implementation correction

The primary requirement is the already-running terminal conversation, not a new
managed process. Default view switching therefore uses native ownership:

- Codex 0.156.1 rollout display events, hook-supplied exact native UUIDs and the
  existing owned TUI relay. Native app-server remains optional for separate
  managed sessions. Reference: https://learn.chatgpt.com/docs/app-server.
- OpenCode 1.18.30 TUI plugin API (MIT package `@opencode-ai/plugin` declarations),
  verified against the installed CLI. `api.route.current`, `api.state.session`,
  `api.state.part`, `api.client` and disposal hooks let wmux read/send inside the
  original TUI. Only official API declarations were consulted; the wmux bridge
  implementation is original. Reference: https://opencode.ai/docs/server/.
  The official server documentation explicitly distinguishes connecting to the
  existing TUI server from starting a new `opencode serve` process.

The plugin has no dependency on competitor application code and imports only
Node built-ins. Future providers must demonstrate the same pane/process/session
ownership before advertising input capability. See `docs/managed-chat.md` for
installation, contract, validation and remaining platform/phone work.


Composer discovery uses the installed Codex 0.156.1 app-server generated protocol
(`skills/list`, `SkillsListEntry`, `SkillMetadata`), not a copied client. Claude
metadata interpretation follows [official skills documentation](https://code.claude.com/docs/en/skills),
including personal/project precedence, plugin namespaces and invocability.
Competitor code was not used. Disk discovery is marked partial rather than
claiming to reproduce runtime-only configuration.
