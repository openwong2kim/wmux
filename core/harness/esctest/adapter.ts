// E0 하니스 M3 — esctest PTY 어댑터 (스펙: engine-core-decision-2026-07-09.md §5-3)
//
// esctest2(GPL-2.0, vendor/ — 무수정 실행)를 PTY 자식으로 스폰하고, 그 프로세스가
// 방출하는 질의·시퀀스 바이트를 피검체(@xterm/headless)에 feed한 뒤, 피검체의 응답을
// PTY master에 되쓴다. 어댑터는 **바이트 라우팅만** 한다 — 질의 응답은 피검체에서 산출.
//
// ── I/O 모델(vendor escio.py 사용법 확인, 로직 미독해) ────────────────────────
//   - esctest.escio.Init(): tty.setraw(stdin) — esctest의 stdin이 PTY여야 raw 설정 성공.
//   - esctest.escio.Write(s): sys.stdout.write — 질의/시퀀스가 PTY master로 흘러나온다.
//   - esctest.escio.ReadCSI/ReadOSC/ReadDCS: sys.stdin.read(1) 블로킹 — 응답을 기다린다.
//   ⇒ node-pty로 python3 esctest.py를 스폰(자식=PTY slave). master.onData = esctest가 쓴
//     바이트 → 피검체 feed. 피검체 응답(term.onData) → master.write = esctest stdin으로 되씀.
//
// ── 응답 라우팅 규율(§5-3) ───────────────────────────────────────────────────
//   (a) xterm.js 자체 방출(CPR·DA·DA2·XTERM_WINOPS 등): term.onData 콜백 바이트를
//       **무가공**으로 master에 되쓴다. 어댑터는 형식을 만들지 않는다.
//   (b) DECRQCRA(xterm.js 미구현): 어댑터 브리지가 **피검체 그리드 스냅샷에서 체크섬을
//       계산**해 DCS 응답을 만든다. 그리드가 판정 대상이므로 검증력 유지. 브리지 사용
//       사실을 리포트에 기록. — 체크섬 알고리즘은 DEC STD 070 / xterm ctlseqs에서 도출
//       (vendor 소스의 체크섬 로직 미참조 — 클린룸 규율. computeRectChecksum 참조).

// NOTE (unicode-graphemes swap): like differ.ts, this subject stays pinned to Unicode 11 on
// purpose — the product (renderer + HeadlessSnapshot) now measures with
// @xterm/addon-unicode-graphemes ('15-graphemes'), but the conformance harness is the
// differential baseline, not a mirror of what ships. `report.json` records the subject as
// "xterm.js@6 (+Unicode11)" for the same reason. Do not "fix" this to match the product.

import { spawn, type IPty } from 'node-pty';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { existsSync } from 'node:fs';
import path from 'node:path';
// 어댑터는 요청 파서(tryParse*)를 라우팅 루프에서, 응답 빌더/체크섬(computeRectChecksum·
// buildDecrqcraReply·buildWinopsSizeReply)을 XtermBridge 내부에서 쓴다.
import {
  computeRectChecksum,
  buildDecrqcraReply,
  buildWinopsSizeReply,
  tryParseDecrqcra,
  tryParseWinopsSizeQuery,
  tryParseWinopsResize,
} from './decrqcra';
import type { EsctestCaseResult, EsctestReport, DecrqcraBridgeUse } from './report-types';

/**
 * vendor 경로(fetch-esctest.sh가 여기에 클론). 기본은 이 파일 옆 vendor/이지만,
 * WMUX_ESCTEST_VENDOR 환경변수로 오버라이드할 수 있다(번들 실행·CI 위치 커스터마이즈).
 */
export const VENDOR_ROOT = process.env.WMUX_ESCTEST_VENDOR
  ? path.resolve(process.env.WMUX_ESCTEST_VENDOR)
  : path.join(__dirname, 'vendor');
export const ESCTEST_DIR = path.join(VENDOR_ROOT, 'esctest');
export const ESCTEST_ENTRY = path.join(ESCTEST_DIR, 'esctest.py');

/** vendor가 페치됐는지(부재 시 테스트는 명시 skip). */
export function esctestVendorPresent(): boolean {
  return existsSync(ESCTEST_ENTRY);
}

export interface EsctestRunOptions {
  /**
   * 실행할 테스트 선택. esctest는 --include=정규식을 full_name(예: "CUPTests.test_CUP_...")에
   * `re.search`로 매칭한다. 파일명(예: 'cup')을 주면 어댑터가 case-insensitive 플래그((?i))를
   * 붙여 클래스명 대문자(CUPTests)에 매칭시킨다 — esctest 정규식은 case-sensitive라 소문자
   * 파일명이 대문자 클래스에 안 맞는 함정을 여기서 흡수한다. 이미 (?i)로 시작하면 그대로 쓴다.
   */
  readonly include: string;
  /** 초기 grid geometry. esctest 다수 케이스는 80x25 가정. */
  readonly cols?: number;
  readonly rows?: number;
  /** 응답 타임아웃(초). esctest --timeout으로 전달(기본 1은 CI에서 빠듯 → 3). */
  readonly timeoutSec?: number;
  /** VT 레벨(DECRQCRA는 VT4 필요). 기본 4. */
  readonly maxVtLevel?: number;
  /** 전체 실행 워치독(ms). 무응답 데드락 방어. */
  readonly hardTimeoutMs?: number;
  /** python3 실행 파일. 기본 'python3'. */
  readonly python?: string;
}

/**
 * 피검체 브리지. xterm.js 그리드를 들고, DECRQCRA 질의가 오면 스냅샷에서 체크섬을 낸다.
 * xterm.js가 스스로 방출하는 응답(CPR/DA…)은 이 클래스가 건드리지 않는다(무가공 라우팅).
 */
class XtermBridge {
  readonly term: Terminal;
  private readonly bridgeUses: DecrqcraBridgeUse[] = [];
  private winopsBridgeCount = 0;

  constructor(cols: number, rows: number) {
    // scrollback 0 — 뷰포트 상태만 검증(differ.ts와 동일 정책).
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
    // 기준선 폭 모델 = Unicode 11 고정(본체 renderer 정렬 — differ.ts와 동일).
    this.term.loadAddon(new Unicode11Addon() as never);
    this.term.unicode.activeVersion = '11';
  }

  /** DECRQCRA 브리지 사용 기록(리포트 필드). */
  get decrqcraBridgeUses(): readonly DecrqcraBridgeUse[] {
    return this.bridgeUses;
  }

  /** WINOPS 크기 리포트 브리지 사용 횟수(리포트 필드 — 결정 문서 §5-3 미포착 경로). */
  get winopsBridgeUses(): number {
    return this.winopsBridgeCount;
  }

  /**
   * DECRQCRA 요청 1건을 처리해 응답 바이트를 만든다. 피검체 그리드 스냅샷에서 체크섬 계산.
   * rect(top,left,bottom,right)는 1-based 화면 좌표. Pid는 요청 그대로 에코.
   */
  handleDecrqcra(pid: number, top: number, left: number, bottom: number, right: number): Uint8Array {
    const checksum = computeRectChecksum(this.term, top, left, bottom, right);
    this.bridgeUses.push({ pid, rect: { top, left, bottom, right }, checksum });
    return buildDecrqcraReply(pid, checksum);
  }

  /**
   * WINOPS 크기 리포트(CSI 18 t / CSI 19 t)에 응답한다. xterm.js가 침묵하는 경로 —
   * 어댑터가 현재 grid geometry(term.cols/rows)로 응답한다. reportCode 8=18t, 9=19t.
   */
  handleWinopsSize(reportCode: 8 | 9): Uint8Array {
    this.winopsBridgeCount += 1;
    return buildWinopsSizeReply(reportCode, this.term.rows, this.term.cols);
  }

  /**
   * WINOPS 문자 resize(CSI 8;rows;cols t)를 피검체 그리드에 반영한다(리뷰 반영 —
   * 이걸 안 하면 이후 CSI 18 t가 초기 geometry로 고정돼 브리지 신선도가 깨진다).
   */
  applyWinopsResize(rows: number, cols: number): void {
    this.term.resize(cols, rows);
  }
}

/**
 * esctest 1개 파일(include)을 무수정 실행하고 판정을 수집한다.
 *
 * 동작:
 *  1) node-pty로 python3 esctest.py를 스폰(자식=PTY slave). CWD=vendor esctest 디렉토리
 *     (esctest는 상대 import·tests 디렉토리를 그 위치에서 찾는다).
 *  2) master.onData: esctest가 쓴 바이트를 버퍼에 모으며, DECRQCRA 요청이면 가로채 브리지로
 *     응답하고, 그 외 바이트는 전부 피검체(term)에 feed한다. 피검체가 자체 응답을 방출하면
 *     (term.onData) 그 바이트를 master에 되쓴다(무가공).
 *  3) esctest 종료(onExit) 또는 하드 타임아웃까지 대기 → exit code + stdout 로그 파싱.
 *
 * DECRQCRA 가로채기 이유: xterm.js는 DECRQCRA 미구현이라 term에 그대로 feed하면 응답이 없어
 * esctest가 timeout으로 실패한다. §5-3대로 "그리드 스냅샷에서 체크섬 계산 브리지"를 명시 사용해
 * 그리드 검증력을 유지한다. CPR/DA 등은 xterm.js가 방출하므로 가로채지 않는다.
 */
export async function runEsctestCase(opts: EsctestRunOptions): Promise<EsctestCaseResult> {
  if (!esctestVendorPresent()) {
    throw new Error(
      `[esctest-adapter] vendor 부재: ${ESCTEST_ENTRY} — 먼저 bash core/harness/esctest/fetch-esctest.sh`,
    );
  }
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 25;
  const timeoutSec = opts.timeoutSec ?? 3;
  const maxVtLevel = opts.maxVtLevel ?? 4;
  const hardTimeoutMs = opts.hardTimeoutMs ?? 30000;
  const python = opts.python ?? 'python3';

  const bridge = new XtermBridge(cols, rows);

  // esctest 인자(vendor README 사용법): --expected-terminal=xterm(어서션 방언),
  // --include=정규식(파일 선택), --max-vt-level, --timeout(응답 대기), --no-print-logs를
  // 끄고(로그를 stdout에 남겨 파싱), --logfile은 임시로.
  // include 정규화: 소문자 파일명이 대문자 클래스명(CUPTests)에 매칭되도록 (?i) 부여.
  // 이미 (?i) 등 인라인 플래그로 시작하면 존중한다.
  const includeArg = opts.include.startsWith('(?') ? opts.include : `(?i)${opts.include}`;
  const args = [
    ESCTEST_ENTRY,
    '--expected-terminal=xterm',
    `--include=${includeArg}`,
    `--max-vt-level=${maxVtLevel}`,
    `--timeout=${timeoutSec}`,
    '--force', // assertion 실패해도 완주(케이스별 판정을 로그에서 수집).
    '--v=2',
  ];

  let child: IPty;
  try {
    child = spawn(python, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: ESCTEST_DIR,
      env: { ...process.env } as { [key: string]: string },
    });
  } catch (e) {
    throw new Error(`[esctest-adapter] python3 esctest 스폰 실패: ${String(e)}`);
  }

  // 피검체가 자체 방출하는 응답(CPR·DA…)을 master로 되쓴다(무가공 라우팅).
  const writeBackToEsctest = (data: string): void => {
    try {
      child.write(data);
    } catch {
      /* 종료 경합 시 write 실패는 무시(onExit가 결과를 확정). */
    }
  };
  bridge.term.onData(writeBackToEsctest);

  // esctest stdout 전체(로그 파싱용)를 모은다.
  let stdoutLog = '';
  // DECRQCRA 요청 프레이밍이 청크 경계에 걸릴 수 있어 미소비 바이트를 이월한다.
  let pending = '';

  const onDataFromEsctest = (chunk: string): void => {
    stdoutLog += chunk;
    // esctest가 쓴 바이트에서 DECRQCRA 요청만 가로채고, 나머지는 피검체에 feed.
    // DECRQCRA 요청 형식: CSI Pid ; Pp ; top ; left ; bottom ; right * y
    // (tryParseDecrqcra가 pending+chunk에서 완결 요청을 찾아 소비 범위를 알려준다.)
    pending += chunk;
    let feedable = '';
    let idx = 0;
    // feedable을 피검체에 반영하고 비운다(브리지 응답 직전 그리드 최신화에 쓴다).
    const flushFeed = (): void => {
      if (feedable.length > 0) {
        bridge.term.write(feedable);
        feedable = '';
      }
    };
    while (idx < pending.length) {
      // ① DECRQCRA(xterm.js 미구현 — 그리드 체크섬 브리지).
      const dec = tryParseDecrqcra(pending, idx);
      if (dec === 'incomplete') break; // 완결 대기 — 이월.
      if (dec !== null) {
        flushFeed(); // 체크섬 전 그리드 최신화.
        const reply = bridge.handleDecrqcra(dec.pid, dec.top, dec.left, dec.bottom, dec.right);
        writeBackToEsctest(Buffer.from(reply).toString('binary'));
        idx = dec.end;
        continue;
      }
      // ② WINOPS 크기 리포트(xterm.js 침묵 — geometry 브리지).
      const win = tryParseWinopsSizeQuery(pending, idx);
      if (win === 'incomplete') break; // 완결 대기 — 이월.
      if (win !== null) {
        flushFeed(); // geometry는 term.cols/rows에서 읽으므로 앞선 resize 반영 후.
        const reply = bridge.handleWinopsSize(win.reportCode);
        writeBackToEsctest(Buffer.from(reply).toString('binary'));
        idx = win.end;
        continue;
      }
      // ③ WINOPS 문자 resize(CSI 8;r;c t) — 피검체+PTY에 반영해 이후 크기 질의 신선도 보장
      //    (리뷰 반영). 시퀀스 자체도 피검체에 feed(무해 — xterm.js는 무시).
      const rsz = tryParseWinopsResize(pending, idx);
      if (rsz === 'incomplete') break;
      if (rsz !== null) {
        flushFeed();
        bridge.applyWinopsResize(rsz.rows, rsz.cols);
        try {
          child.resize(rsz.cols, rsz.rows);
        } catch {
          /* 종료 경합 시 무시. */
        }
        idx = rsz.end;
        continue;
      }
      // ④ 가로챌 질의 아님 → 피검체로 흘려보낼 1바이트.
      feedable += pending[idx];
      idx += 1;
    }
    // 소비되지 않은 꼬리는 이월(가로챌 요청 시작 가능성). 방어(리뷰 반영): 미완결 CSI가
    // 비정상적으로 길면(현실 CSI 상한을 훨씬 넘는 4KiB) 가로챌 요청이 아니라고 판정하고
    // 선두 1바이트를 피검체로 강제 배출해 재파싱 — 무한 누적·O(n²) 재파싱 폭주 차단.
    pending = pending.slice(idx);
    while (pending.length > 4096) {
      bridge.term.write(pending[0]);
      pending = pending.slice(1);
      const again = tryParseDecrqcra(pending, 0);
      if (again !== 'incomplete') break;
    }
    flushFeed();
  };
  child.onData(onDataFromEsctest);

  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    child.onExit(({ exitCode, signal }) => resolve({ exitCode, signal }));
  });

  // 하드 워치독: 무응답 데드락 방어. 타임아웃 시 kill → 유예 후 SIGKILL 에스컬레이션
  // (리뷰 반영 — 자식이 기본 신호를 무시해도 반환 보장), exited 자체도 race로 캡.
  let timedOut = false;
  let killEscalation: ReturnType<typeof setTimeout> | undefined;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      /* 이미 종료됐으면 무시. */
    }
    killEscalation = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 무시. */
      }
    }, 2000);
  }, hardTimeoutMs);

  // SIGKILL조차 onExit를 못 만드는 극단 경합 대비 — 함수는 어떤 경우에도 반환한다.
  const { exitCode, signal } = await Promise.race([
    exited,
    new Promise<{ exitCode: number; signal?: number }>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve({ exitCode: -1 });
      }, hardTimeoutMs + 5000),
    ),
  ]);
  clearTimeout(watchdog);
  if (killEscalation) clearTimeout(killEscalation);

  bridge.term.dispose();

  // 라이브 디버깅: 커밋 산출물(report.json)에는 로그를 싣지 않으므로(리뷰 반영 — GPL 유래
  // 텍스트 배제) 필요 시 env로 stderr에 전량 방출한다.
  if (process.env.WMUX_ESCTEST_DEBUG_LOG) {
    process.stderr.write(`\n===== esctest stdout (include=${opts.include}) =====\n${stdoutLog}\n`);
  }

  const cases = parseEsctestLog(stdoutLog);
  const passCount = cases.filter((c) => c.status === 'pass').length;
  const failCount = cases.filter((c) => c.status === 'fail').length;
  const errorCount = cases.filter((c) => c.status === 'error').length;
  const knownBugCount = cases.filter((c) => c.status === 'known-bug').length;
  const skippedCount = cases.filter((c) => c.status === 'skipped').length;
  // esctest 자체 요약 라인 — 파서 집계의 독립 대조 기준(리뷰 반영).
  // 대조식: esctest는 skip을 "passed"에 셈(실측) → pass+skipped == passed.
  const esctestSummary = parseEsctestSummary(stdoutLog);
  const reconciled =
    !timedOut &&
    exitCode === 0 &&
    esctestSummary !== null &&
    passCount + skippedCount === esctestSummary.passed &&
    knownBugCount === esctestSummary.knownBugs &&
    failCount === esctestSummary.failed;
  return {
    include: opts.include,
    exitCode,
    signal,
    timedOut,
    cases,
    passCount,
    failCount,
    errorCount,
    knownBugCount,
    skippedCount,
    decrqcraBridgeUses: bridge.decrqcraBridgeUses.length,
    winopsBridgeUses: bridge.winopsBridgeUses,
    esctestSummary,
    reconciled,
    // rawLogTail은 커밋 산출물에서 제거됐다(리뷰 반영 — GPL 유래 로그 텍스트를 report.json에
    // 싣지 않는다). 라이브 디버깅은 WMUX_ESCTEST_DEBUG_LOG=1로 stdout 전량을 stderr에 흘린다.
  };
}

/**
 * esctest 최종 요약 라인 파싱: "*** N tests passed, M known bugs, K tests failed ***"
 * (vendor 실측 포맷 — 출력 사용법만, GPL 로직 미독해).
 */
export function parseEsctestSummary(
  log: string,
): { passed: number; knownBugs: number; failed: number } | null {
  const m = log.match(/\*\*\*\s*(\d+) tests passed, (\d+) known bugs?, (\d+) tests? failed\s*\*\*\*/);
  if (!m) return null;
  return { passed: Number(m[1]), knownBugs: Number(m[2]), failed: Number(m[3]) };
}

/**
 * esctest stdout 로그에서 케이스별 판정을 파싱한다. vendor 실측 포맷(esctest.py RunTest):
 *   - 케이스 시작:  "Run test: <ClassName.test_name>"
 *   - 통과:         "Passed."
 *   - known-bug 예상 실패: "Fails as expected: ..."  → pass로 집계(esctest 관점 정상)
 *   - 능력 부재 skip:      "Skipped because terminal lacks requisite capability: ..."
 *   - 실패:         "*** TEST <name> FAILED:"  (이후 traceback)
 * 이 파서는 esctest의 **출력 사용법**만 쓴다(GPL 로직 미독해).
 *
 * 상태 우선순위: 케이스 블록 안에서 먼저 만나는 확정 신호(Passed/FAILED/Skipped/Fails as
 * expected)로 마감한다. FAILED 뒤 traceback의 "Timeout waiting to read"는 별도 error가 아니라
 * 그 케이스 실패의 원인으로 본다(이중 계상 방지).
 */
export function parseEsctestLog(log: string): EsctestCaseResult['cases'] {
  const cases: { name: string; status: 'pass' | 'fail' | 'error' | 'known-bug' | 'skipped' }[] = [];
  const lines = log.split(/\r?\n/);
  const startRe = /Run test:\s*(\S+)/;
  const failRe = /\*\*\*\s*TEST\s+(\S+)\s+FAILED/;
  let currentName: string | null = null;
  let settled = false; // 현재 케이스가 확정 신호를 받았는지.

  const settle = (name: string, status: 'pass' | 'fail' | 'error' | 'known-bug' | 'skipped'): void => {
    cases.push({ name, status });
    settled = true;
  };

  for (const line of lines) {
    const start = line.match(startRe);
    if (start) {
      // 직전 케이스가 신호 없이 다음 케이스로 넘어갔으면(비정상 중단) error로 마감.
      if (currentName && !settled) settle(currentName, 'error');
      currentName = start[1];
      settled = false;
      continue;
    }
    const fail = line.match(failRe);
    if (fail) {
      // FAILED는 케이스 시작 없이도 나올 수 있는 완전한 신호(이름 포함).
      settle(fail[1], 'fail');
      currentName = null;
      continue;
    }
    if (!currentName || settled) continue;
    if (/^Passed\.\s*$/.test(line)) {
      settle(currentName, 'pass');
    } else if (/^Fails as expected:/.test(line)) {
      // known-bug 예상 실패 — esctest 관점 정상이나 pass와 분리 집계(리뷰 반영: 순도 감사).
      settle(currentName, 'known-bug');
    } else if (/^Skipped because terminal lacks requisite capability:/.test(line)) {
      // 능력 부재 skip — 검증되지 않음. pass 합산 금지, 별도 상태(리뷰 반영).
      settle(currentName, 'skipped');
    }
  }
  // 마지막 케이스가 미확정으로 끝났으면 error로 마감(무응답 데드락 등).
  if (currentName && !settled) settle(currentName, 'error');
  return cases;
}

/** 여러 include 실행을 하나의 리포트로 묶는다(report.json 산출). */
export function buildReport(caseResults: readonly EsctestCaseResult[]): EsctestReport {
  const sum = (f: (c: EsctestCaseResult) => number): number =>
    caseResults.reduce((s, c) => s + f(c), 0);
  return {
    subject: 'xterm.js@6 (+Unicode11)',
    generatedAt: new Date().toISOString(),
    esctestPin: '664be3cf2c1e3f06bc93a8bafb48a0db83c607db',
    results: [...caseResults],
    totals: {
      pass: sum((c) => c.passCount),
      fail: sum((c) => c.failCount),
      error: sum((c) => c.errorCount),
      // 리뷰 반영 — 순도 분리 + 비정상 실행이 총계 밖으로 새지 않게 가시화.
      knownBug: sum((c) => c.knownBugCount),
      skipped: sum((c) => c.skippedCount),
      timedOutRuns: caseResults.filter((c) => c.timedOut).length,
      nonzeroExitRuns: caseResults.filter((c) => c.exitCode !== 0).length,
      unreconciledRuns: caseResults.filter((c) => !c.reconciled).length,
      decrqcraBridgeUses: sum((c) => c.decrqcraBridgeUses),
      winopsBridgeUses: sum((c) => c.winopsBridgeUses),
    },
  };
}
