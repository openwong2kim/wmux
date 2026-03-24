# Progress — Security Hardening

## Summary
- Phase: 3 (구현)
- Done: 0/5 | In Progress: 0 | Waiting: 5 | Blocked: 0

## DAG
- W1-A (PTY 새니타이징): []
- W1-B (URL 검증 SSRF): []
- W1-C (ProcessMonitor 비동기): []
- W1-D (SessionPipe 인증 + DaemonClient 이중 disconnect): []
- W2-A (env 블록리스트 확장 + 세션 정리 + 파일 퍼미션): [W1-A, W1-B, W1-C, W1-D]

## Wave 1 — 병렬 (4 worktrees)

### W1-A: PTY 입력 새니타이징 (T1) — REDESIGNED
- **Status**: waiting
- **Files**: `src/main/pipe/handlers/input.rpc.ts`, `src/main/ipc/handlers/pty.handler.ts`, `src/shared/types.ts`
- **변경사항**: sanitizePtyText 재설계 (NULL+C1만 제거, CR/LF/Tab/ESC 보존) + raw 옵트인

### W1-B: URL 검증 SSRF 차단 (T6)
- **Status**: waiting
- **Files**: `src/main/pipe/handlers/browser.rpc.ts`, `src/mcp/playwright/tools/navigation.ts`
- **변경사항**: RFC1918/169.254.x 차단, localhost 허용, file:// 차단, browser_tabs new도 포함

### W1-C: ProcessMonitor 비동기 전환 (T9)
- **Status**: waiting
- **Files**: `src/daemon/ProcessMonitor.ts`, `src/daemon/__tests__/ProcessMonitor.test.ts`
- **변경사항**: execFileSync → execFile 비동기 + 재진입 방지 플래그

### W1-D: SessionPipe 인증 + DaemonClient 이중 disconnect (T2+T10)
- **Status**: waiting
- **Files**: `src/daemon/SessionPipe.ts`, `src/main/DaemonClient.ts`, `src/daemon/index.ts` (생성자 호출부만)
- **변경사항**: 토큰 핸드셰이크 (구분자 인식 + 5초 타임아웃) + close/error 이중 방어

## Wave 2 — 순차 (Wave 1 병합 후)

### W2-A: env 블록리스트 확장 + 세션 정리 + 파일 퍼미션 (T3+T8+T5)
- **Status**: waiting
- **Files**: `src/daemon/DaemonSessionManager.ts`, `src/daemon/StateWriter.ts`, `src/daemon/RingBuffer.ts`, `src/daemon/index.ts`, `src/daemon/config.ts`, `src/daemon/types.ts`
- **변경사항**:
  - T3: 블록리스트 확장 (*_TOKEN, *_SECRET, *_KEY, *_PASSWORD + 안전 예외)
  - T8: bridge.cleanup() + 주기적 정리 + 세션ID 검증 (/^[a-zA-Z0-9_-]{1,64}$/)
  - T5: mode 0o600 + dir 0o700 + RingBuffer.clear() fill(0) + Windows icacls 주석
