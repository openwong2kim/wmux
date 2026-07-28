// E0 컨포먼스 하니스 — M2 차등 러너 (스펙: engine-core-decision-2026-07-09.md §5-2)
//
// recording.bin + events.jsonl을 피검체에 feed → 전셀 스냅샷 추출 → 셀 단위 diff → 4분류 대장
// 리포트. 피검체는 Subject 인터페이스로 추상화한다:
//   (a) @xterm/headless      — 현재 유일 구현체(기준선).
//   (b) 우리 코어(E1)         — 나중에 XtermSubject와 같은 형상으로 꽂힌다.
//   (c) 제3 레퍼런스(D2 조건부) — 심판 축.
//
// 기준선 폭 모델은 **Unicode 11로 명시 고정**한다(@xterm/addon-unicode11 로딩 + activeVersion='11').
// 본체 renderer와 동일한 폭 모델을 쓰기 위함(lockfile 핀).
//
// NOTE (unicode-graphemes swap): the product (renderer + HeadlessSnapshot) has since moved to
// @xterm/addon-unicode-graphemes ('15-graphemes'), so this baseline NO LONGER tracks the renderer's
// width model — and that is deliberate. This subject is the differential DENOMINATOR: its goldens
// pin *measured* xterm.js-U11 behavior, and intended-diffs.json already reserves the exact cell
// (cjk-emoji, x=0, y=2, width) where U11's VS16 width-1 is expected to become width 2 under
// grapheme clustering. Re-pinning this subject to '15-graphemes' would erase that reserved
// coordinate and turn gate ③ into a self-comparison. Keep U11 here until the E1 core lands as a
// second subject.

import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  CellSnapshot,
  DiffClassification,
  DiffEntry,
  DiffReport,
  Geometry,
  GridSnapshot,
  IntendedDiff,
  RecordingEvent,
  ThroughputMetrics,
} from './types';

/**
 * 피검체 인터페이스. recording을 events 트레일에 맞춰 재생하고 전 그리드 스냅샷을 낸다.
 * 우리 코어(E1)·제3 레퍼런스가 이 인터페이스로 나중에 꽂힌다(현 구현체는 XtermSubject 하나).
 */
export interface Subject {
  readonly name: string;
  /**
   * recording.bin을 events 트레일에 맞춰 재생하고 최종 그리드 스냅샷 + 처리량 계측을 반환한다.
   */
  replay(recording: Uint8Array, events: readonly RecordingEvent[]): Promise<SubjectResult>;
}

export interface SubjectResult {
  readonly grid: GridSnapshot;
  readonly metrics: ThroughputMetrics;
  /**
   * 재생 중 만난 reflow_mode 이벤트 목록(R9). xterm.js는 자체 reflow 정책이라 이 신호로 재생
   * 규율을 바꾸지 않지만("무시"), "무시했다"는 사실을 정직하게 결과에 담는다 — E1 코어가 꽂히면
   * Subject.replay가 이 신호를 실제 재생 규율에 전달한다(그때 이 목록이 그 전달의 근거가 된다).
   */
  readonly reflowModeEvents: readonly Extract<RecordingEvent, { type: 'reflow_mode' }>[];
}

/**
 * 이벤트 스트림 불변식 검증(R3). 재생 진입 전에 강제한다 — 위반을 정렬로 은닉하지 않고 명시 throw.
 *   ① 첫 이벤트는 init(초기 geometry)이어야 한다.
 *   ② byteOffset이 **원본 순서 그대로** 단조 비감소여야 한다(정렬로 뒤섞어 은닉 금지).
 *   ③ 모든 byteOffset이 [0, recordingLength] 범위 안이어야 한다.
 * 위반 시 손상 이벤트 파일임을 알리며 throw한다(재생은 신뢰된 스트림에만 진행).
 */
export function validateEventStream(
  events: readonly RecordingEvent[],
  recordingLength: number,
): void {
  if (events.length === 0) {
    throw new Error('[differ] 이벤트 스트림이 비어있다(최소 init 필요 — recorder 불변식 위반)');
  }
  // ① 첫 이벤트 = init. (런타임 파싱된 손상 파일일 수 있으므로 byteOffset도 런타임 검증한다 —
  // 타입 좁힘이 init.byteOffset을 리터럴 0으로 만들어 never가 되는 것을 피하려 number로 먼저 읽는다.)
  const first = events[0];
  const firstOffset: number = first.byteOffset;
  if (first.type !== 'init') {
    throw new Error(`[differ] 첫 이벤트가 init이 아니다: type=${first.type}(recorder 불변식 위반)`);
  }
  if (firstOffset !== 0) {
    throw new Error(`[differ] init byteOffset이 0이 아니다: ${firstOffset}`);
  }
  // ②③ 원본 순서 그대로 단조 비감소 + 범위.
  let prev = -1;
  for (let i = 0; i < events.length; i++) {
    const off = events[i].byteOffset;
    if (off < 0 || off > recordingLength) {
      throw new Error(
        `[differ] byteOffset 범위 위반: 이벤트[${i}] offset=${off} (허용 0..${recordingLength})`,
      );
    }
    if (off < prev) {
      throw new Error(
        `[differ] byteOffset이 원본 순서에서 단조 비감소가 아니다: 이벤트[${i}] offset=${off} < 직전 ${prev}(손상 이벤트 파일)`,
      );
    }
    prev = off;
  }
}

/** init 이벤트에서 초기 geometry를 뽑는다(검증 후 호출 전제 — 트레일 선두는 항상 init). */
function initialGeometryOf(events: readonly RecordingEvent[]): Geometry {
  const init = events.find((e) => e.type === 'init');
  if (!init || init.type !== 'init') {
    throw new Error('[differ] events에 init 이벤트가 없다(recorder 불변식 위반)');
  }
  return init.geometry;
}

/**
 * intended-diffs.json을 읽어 (d) 의도된 개선 승인 목록을 로드한다(R4). 차등 실행 엔트리와 테스트가
 * diffGrids의 intended 파라미터로 이 결과를 넘긴다. 파일은 { "intended": IntendedDiff[] } 형태이며,
 * _comment 같은 메타 키는 무시한다. 파일 부재/파싱 실패는 명시 throw(무음 빈 목록 폴백 금지 —
 * 승인 목록이 사라지면 (d)가 전부 unclassified로 떨어져 게이트가 요란해지므로 조용한 실패는 위험).
 */
export const INTENDED_DIFFS_PATH = path.join(__dirname, 'intended-diffs.json');

export function loadIntendedDiffs(filePath: string = INTENDED_DIFFS_PATH): IntendedDiff[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`[differ] intended-diffs.json 로드 실패: ${filePath} (${String(e)})`);
  }
  const parsed = JSON.parse(text) as { intended?: unknown };
  const list = parsed.intended;
  if (!Array.isArray(list)) {
    throw new Error('[differ] intended-diffs.json에 intended 배열이 없다');
  }
  // 스키마 정합 검증: 각 항목이 IntendedDiff 필드(workloadName·x·y·field·reason)를 갖는지.
  return list.map((raw, i): IntendedDiff => {
    const it = raw as Partial<IntendedDiff>;
    if (
      typeof it.workloadName !== 'string' ||
      typeof it.x !== 'number' ||
      typeof it.y !== 'number' ||
      typeof it.field !== 'string' ||
      typeof it.reason !== 'string'
    ) {
      throw new Error(`[differ] intended-diffs.json 항목[${i}] 스키마 불일치: ${JSON.stringify(raw)}`);
    }
    return { workloadName: it.workloadName, x: it.x, y: it.y, field: it.field, reason: it.reason };
  });
}

/**
 * XtermSubject 옵션. feedChunkBytes를 주면 [cursor..offset) 구간을 그 바이트 수 단위로 쪼개
 * feed한다(기본: 구간 통째). 1을 주면 1바이트씩 흘려 파서의 청크 경계 강건성을 검증할 수 있다
 * (게이트①-b, R10). 청크 크기만 다르고 검증·geometry·resize·추출 규율은 완전히 동일하다.
 */
export interface XtermSubjectOptions {
  readonly feedChunkBytes?: number;
}

/**
 * @xterm/headless 피검체. Unicode11Addon을 로딩하고 activeVersion='11'로 고정한다.
 * write는 콜백 기반(파서가 비동기 청크 처리)이므로 재생은 콜백을 await하며 순차 feed한다.
 */
export class XtermSubject implements Subject {
  readonly name: string;
  private readonly feedChunkBytes: number;

  constructor(opts: XtermSubjectOptions = {}) {
    // feedChunkBytes ≤ 0은 무의미하므로 통째(Infinity 상당)로 간주.
    this.feedChunkBytes =
      opts.feedChunkBytes && opts.feedChunkBytes > 0 ? opts.feedChunkBytes : Number.POSITIVE_INFINITY;
    this.name =
      this.feedChunkBytes === Number.POSITIVE_INFINITY
        ? 'xterm.js@6'
        : `xterm.js@6(${this.feedChunkBytes}B-chunked)`;
  }

  async replay(recording: Uint8Array, events: readonly RecordingEvent[]): Promise<SubjectResult> {
    // R3: 재생 진입 전에 이벤트 스트림 불변식을 강제한다(위반 = throw, 정렬 은닉 금지).
    validateEventStream(events, recording.length);
    const initial = initialGeometryOf(events);
    // scrollback 0 — 코퍼스는 화면(뷰포트) 상태를 검증하므로 히스토리 없이 뷰포트만 본다.
    // allowProposedApi: Unicode11Addon 등록에 필요.
    const term = new Terminal({
      cols: initial.cols,
      rows: initial.rows,
      scrollback: 0,
      allowProposedApi: true,
    });
    // 기준선 폭 모델 = Unicode 11 명시 고정(본체 renderer 정렬).
    // addon 타입은 @xterm/xterm의 Terminal을 기대하지만 headless Terminal과 구조 호환 →
    // loadAddon은 ITerminalAddon만 요구하므로 런타임 안전(addon은 core만 만진다).
    term.loadAddon(new Unicode11Addon() as never);
    term.unicode.activeVersion = '11';

    // 재생 순서 = **원본 트레일 순서 그대로**(정렬 제거 — R3). validateEventStream이 이미
    // byteOffset 단조 비감소를 보장하므로 정렬은 불필요하고, 정렬은 손상 스트림을 조용히 은닉하는
    // 부작용이 있어 제거한다. init은 초기 geometry로 이미 소비했으므로 뒤 이벤트만 순회한다.
    const ordered = events.filter((e) => e.type !== 'init');
    // reflow_mode 신호를 정직하게 채집(R9). xterm.js는 자체 정책이라 재생 규율을 바꾸지 않지만,
    // "만났고 무시했다"는 사실을 결과에 담는다(E1 코어는 이 신호를 실제 재생 규율에 전달할 것).
    const reflowModeEvents: Extract<RecordingEvent, { type: 'reflow_mode' }>[] = [];

    const bytesTotal = recording.length;
    const feedStart = performance.now();

    // 오프셋 기반 재생: [0..offset) 구간을 feed한 뒤 그 offset의 이벤트(resize)를 적용.
    let cursor = 0;
    const writeChunk = (chunk: Uint8Array): Promise<void> =>
      new Promise<void>((resolve) => term.write(chunk, resolve));
    // [from..to) 구간을 feedChunkBytes 단위로 흘린다(통째면 한 번, 1이면 1바이트씩 — R10).
    const feedRange = async (from: number, to: number): Promise<void> => {
      let at = from;
      while (at < to) {
        const end = Math.min(at + this.feedChunkBytes, to);
        await writeChunk(recording.subarray(at, end));
        at = end;
      }
    };

    for (const ev of ordered) {
      if (ev.byteOffset > cursor) {
        await feedRange(cursor, ev.byteOffset);
        cursor = ev.byteOffset;
      }
      if (ev.type === 'resize') {
        term.resize(ev.geometry.cols, ev.geometry.rows);
      } else if (ev.type === 'reflow_mode') {
        // 정직한 채집: xterm.js는 무시하되 결과에 기록(R9 — "무시"를 결과에 남긴다).
        reflowModeEvents.push(ev);
      }
    }
    // 남은 꼬리 feed.
    if (cursor < recording.length) {
      await feedRange(cursor, recording.length);
    }
    const feedMs = performance.now() - feedStart;

    const extractStart = performance.now();
    const grid = extractGrid(term);
    const extractMs = performance.now() - extractStart;

    const metrics: ThroughputMetrics = {
      subject: this.name,
      bytesTotal,
      feedMs,
      feedMBps: feedMs > 0 ? bytesTotal / 1e6 / (feedMs / 1000) : 0,
      extractMs,
      cellCount: grid.cols * grid.rows,
    };

    term.dispose();
    return { grid, metrics, reflowModeEvents };
  }
}

/** headless Terminal의 활성 버퍼 전 셀을 GridSnapshot으로 추출. */
export function extractGrid(term: Terminal): GridSnapshot {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const activeBuffer: 'normal' | 'alternate' = buf.type === 'alternate' ? 'alternate' : 'normal';

  const cells: CellSnapshot[][] = [];
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const row: CellSnapshot[] = [];
    for (let x = 0; x < cols; x++) {
      // getCell을 재사용 없이 매 셀 새로 받는다(xterm은 재사용 셀 객체를 권장하나, 스냅샷은
      // 값 복사가 필요하므로 즉시 값으로 추출한다).
      const cell = line?.getCell(x);
      if (!cell) {
        row.push(emptyCell());
        continue;
      }
      row.push({
        char: cell.getChars(),
        width: cell.getWidth(),
        code: cell.getCode(),
        fgMode: cell.getFgColorMode(),
        fg: cell.getFgColor(),
        bgMode: cell.getBgColorMode(),
        bg: cell.getBgColor(),
        fgPalette: cell.isFgPalette(),
        fgRGB: cell.isFgRGB(),
        fgDefault: cell.isFgDefault(),
        bgPalette: cell.isBgPalette(),
        bgRGB: cell.isBgRGB(),
        bgDefault: cell.isBgDefault(),
        bold: cell.isBold() !== 0,
        italic: cell.isItalic() !== 0,
        dim: cell.isDim() !== 0,
        underline: cell.isUnderline() !== 0,
        blink: cell.isBlink() !== 0,
        inverse: cell.isInverse() !== 0,
        invisible: cell.isInvisible() !== 0,
        strikethrough: cell.isStrikethrough() !== 0,
        overline: cell.isOverline() !== 0,
      });
    }
    cells.push(row);
  }

  return {
    cols,
    rows,
    activeBuffer,
    cursor: { x: buf.cursorX, y: buf.cursorY },
    cells,
  };
}

function emptyCell(): CellSnapshot {
  return {
    char: '',
    width: 1,
    code: 0,
    fgMode: 0,
    fg: -1,
    bgMode: 0,
    bg: -1,
    fgPalette: false,
    fgRGB: false,
    fgDefault: true,
    bgPalette: false,
    bgRGB: false,
    bgDefault: true,
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    blink: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    overline: false,
  };
}

/**
 * CellSnapshot의 diff 대상 필드(문자·폭·이식가능 색표현·9플래그·code).
 *
 * **fgMode/bgMode(raw 색모드 상수)는 의도적으로 제외한다**(R6): 이 정수는 xterm.js 내부 표현이라
 * 우리 코어·제3 레퍼런스가 같은 상수를 낼 보장이 없다 — 교차-피검체 비교에 넣으면 "표현만 다르고
 * 의미는 같은" 거짓 불일치를 만든다. 이식 가능한 색 판정은 fg/bg 값 + palette/rgb/default boolean
 * 3종으로 충분하다(fgMode/bgMode는 types.ts에서 참고 필드로만 유지).
 */
const CELL_FIELDS: readonly (keyof CellSnapshot)[] = [
  'char',
  'width',
  'code',
  'fg',
  'bg',
  'fgPalette',
  'fgRGB',
  'fgDefault',
  'bgPalette',
  'bgRGB',
  'bgDefault',
  'bold',
  'italic',
  'dim',
  'underline',
  'blink',
  'inverse',
  'invisible',
  'strikethrough',
  'overline',
];

/**
 * 두 그리드 스냅샷을 셀 단위로 비교해 불일치 리포트를 낸다. (d) 의도된 개선은 intended 목록에
 * 등재된 (workload,x,y,field)만 'intended'로 표기하고, 나머지는 모두 'unclassified'로 남긴다
 * (암묵 (d) 금지 — §5-2). (a)/(b)/(c) 자동 판정은 하지 않는다: 그 심판은 사람/제3 레퍼런스의
 * 몫이며, 하니스는 "불일치가 있다"는 사실과 좌표·양측 값만 정직하게 보고한다.
 */
export function diffGrids(
  workloadName: string,
  a: GridSnapshot,
  b: GridSnapshot,
  subjectA: string,
  subjectB: string,
  intended: readonly IntendedDiff[] = [],
): DiffReport {
  const mismatches: DiffEntry[] = [];
  const intendedKey = (x: number, y: number, field: string): boolean =>
    intended.some(
      (i) => i.workloadName === workloadName && i.x === x && i.y === y && i.field === field,
    );
  const classify = (x: number, y: number, field: string): DiffClassification =>
    intendedKey(x, y, field) ? 'intended' : 'unclassified';

  // 그리드 형상 불일치는 셀 비교 전에 별도 기록(형상이 다르면 셀 좌표 대응이 무의미).
  if (a.cols !== b.cols || a.rows !== b.rows) {
    mismatches.push({
      x: -1,
      y: -1,
      field: 'grid-shape',
      a: { cols: a.cols, rows: a.rows },
      b: { cols: b.cols, rows: b.rows },
      classification: classify(-1, -1, 'grid-shape'),
    });
  }

  // 활성 버퍼(normal|alternate) 불일치는 셀 비교 전에 기록한다(R5). 한 피검체는 normal, 다른
  // 피검체는 alternate를 그리고 있으면 셀 좌표 비교 자체가 의미를 잃으므로 최우선 신호다
  // (alt-screen 진입/이탈 처리 차이를 조기에 드러낸다).
  if (a.activeBuffer !== b.activeBuffer) {
    mismatches.push({
      x: -1,
      y: -1,
      field: 'activeBuffer',
      a: a.activeBuffer,
      b: b.activeBuffer,
      classification: classify(-1, -1, 'activeBuffer'),
    });
  }

  // 커서 불일치.
  if (a.cursor.x !== b.cursor.x || a.cursor.y !== b.cursor.y) {
    mismatches.push({
      x: a.cursor.x,
      y: a.cursor.y,
      field: 'cursor',
      a: a.cursor,
      b: b.cursor,
      classification: classify(a.cursor.x, a.cursor.y, 'cursor'),
    });
  }

  // 셀 단위 비교 — 공통 교집합 영역만(형상 불일치 시 좌표 대응 붕괴 방지).
  const rows = Math.min(a.rows, b.rows);
  const cols = Math.min(a.cols, b.cols);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ca = a.cells[y]?.[x];
      const cb = b.cells[y]?.[x];
      if (!ca || !cb) continue;
      for (const field of CELL_FIELDS) {
        if (ca[field] !== cb[field]) {
          mismatches.push({
            x,
            y,
            field,
            a: ca[field],
            b: cb[field],
            classification: classify(x, y, field),
          });
        }
      }
    }
  }

  return {
    workloadName,
    subjectA,
    subjectB,
    gridShape: { cols: a.cols, rows: a.rows },
    totalCells: a.cols * a.rows,
    mismatches,
    identical: mismatches.length === 0,
  };
}

/**
 * 두 스냅샷이 완전히 동일한지(결정성 게이트 ①에 쓰인다). intended 목록을 비우면 어떤 불일치도
 * 실패로 본다 — 결정성은 같은 피검체 2회이므로 intended가 있을 수 없다.
 */
export function snapshotsEqual(a: GridSnapshot, b: GridSnapshot): boolean {
  return diffGrids('__determinism__', a, b, 'run1', 'run2').identical;
}

/**
 * 교차-피검체 차등 실행 엔트리(R4). 두 피검체를 같은 recording으로 재생하고, intended-diffs.json의
 * 승인 목록을 **자동 로드**해 diffGrids에 배선한 뒤 리포트를 낸다. E1에서 우리 코어(subjectB)가
 * 꽂히면 이 함수가 xterm.js(subjectA) 기준선과의 차등을 내고, 승인 목록에 등재된 좌표(VS16 폭·
 * reflow 복원)만 'intended'로 승격된다. 여기서 loadIntendedDiffs()가 실행 경로에 놓인다.
 */
export async function runDifferential(
  workloadName: string,
  recording: Uint8Array,
  events: readonly RecordingEvent[],
  subjectA: Subject,
  subjectB: Subject,
  intended: readonly IntendedDiff[] = loadIntendedDiffs(),
): Promise<DiffReport> {
  const [ra, rb] = await Promise.all([
    subjectA.replay(recording, events),
    subjectB.replay(recording, events),
  ]);
  return diffGrids(workloadName, ra.grid, rb.grid, subjectA.name, subjectB.name, intended);
}
