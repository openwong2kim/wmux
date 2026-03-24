# Decisions Log — Security Hardening

## DEC-001: 보안 수정 범위 — Phase 1 (CRITICAL + HIGH 우선)
- **Date**: 2026-03-24
- **Context**: 감사에서 CRITICAL ~11건, HIGH ~14건, MEDIUM ~18건 발견. 전부 한 번에 할지, 우선순위별로 나눌지
- **Decision**: Phase 1에서 CRITICAL + 핵심 HIGH 수정. MEDIUM/LOW는 후속 작업
- **Rationale**: 24/7 에이전트 운영의 즉각적 위험 제거가 최우선. 범위 과다 방지

## DEC-002: 최종 수정 범위 — 8개 태스크 (T4/T7 제외)
- **Date**: 2026-03-24
- **Context**: T1-T10 전부 vs 위험도 높은 T4(CDP)/T7(파일시스템 제한) 분리
- **Decision**: T1-T3, T5-T6, T8-T10 (8개) 이번에 수정. T4(CDP 보안 강화), T7(파일시스템 경로 제한)은 다음 라운드
- **Rationale**: T4/T7은 정책 설계가 핵심이라 실사용 패턴 파악 필요. 나머지 8개로 CRITICAL 8건 + HIGH 4건 해결 가능. T2(SessionPipe 인증)로 로컬 공격 경로도 차단됨

## DEC-003: sanitizePtyText 재설계 — 위험 제어문자만 차단
- **Date**: 2026-03-24
- **Context**: 기존 sanitizePtyText()가 CR(\r), LF(\n)도 제거 → Enter, 멀티라인 붙여넣기 깨짐
- **Decision**: 새니타이저를 재설계. NULL(\x00)과 C1 제어문자(\x80-\x9f)만 제거. CR/LF/Tab/ESC 시퀀스는 보존. `raw: true` 옵트인으로 완전 우회 가능
- **Rationale**: 터미널 멀티플렉서에서 CR/LF는 필수. architect-reviewer FAIL 판정

## DEC-004: 환경변수 — 블록리스트 확장 (허용목록 대신)
- **Date**: 2026-03-24
- **Context**: 허용목록 방식은 GOPATH, JAVA_HOME, CONDA_PREFIX 등 개발 도구 env를 차단 → 에이전트 워크플로우 파괴
- **Decision**: 기존 블록리스트 유지 + 확장. 추가 차단: `*_TOKEN`, `*_SECRET`, `*_KEY`, `*_PASSWORD` 패턴 (SSH_AUTH_SOCK 등 알려진 안전 변수는 예외)
- **Rationale**: architect-reviewer FAIL 판정. 터미널 멀티플렉서의 핵심 기능은 사용자 환경 그대로 전달

## DEC-005: W1-D daemon/index.ts 수정 범위
- **Date**: 2026-03-24
- **Context**: SessionPipe 생성자 변경으로 daemon/index.ts도 수정 필요 → W2-A와 파일 충돌
- **Decision**: W1-D가 daemon/index.ts의 SessionPipe 생성자 호출부만 수정. W2-A는 다른 섹션(env, cleanup, permissions) 수정. 병합 시 충돌 최소화
- **Rationale**: 수정 위치가 명확히 분리되어 충돌 리스크 낮음
