import { execFileSync } from 'node:child_process';

/**
 * 스폰되는 셸에 넣어줄 UTF-8 로케일을 결정한다.
 *
 * 왜 필요한가 (issue #321):
 *   macOS에서 앱을 Dock/Finder로 실행하면 로그인 셸의 `LANG`이 상속되지 않는다.
 *   그러면 자식 셸이 C/POSIX 로케일로 떨어지고, zsh ZLE(라인 에디터)가 멀티바이트
 *   UTF-8 입력(한글·CJK)을 조합하지 못해 `<0085>` 같은 메타 표기로 깨져 보인다.
 *   Windows 콘솔은 코드페이지/UTF-16 기반이라 `LANG` 개념이 없어 영향이 없다.
 *
 * 해결: 스폰 env에 `LANG`/`LC_ALL`/`LC_CTYPE`가 하나도 없을 때만, 시스템에 실제로
 *   설치된 UTF-8 로케일을 폴백으로 주입한다. 사용자가 셸 rc나 워크스페이스 프로필로
 *   직접 로케일을 지정한 경우는 건드리지 않는다(호출부에서 보장).
 */

/**
 * `Intl`이 주는 BCP-47 로케일("ko-KR")을 POSIX 리전 형태("ko_KR")로 변환한다.
 * 리전 서브태그가 없으면(예: "en") undefined를 반환해 리전 없는 추측을 피한다.
 */
export function intlToPosixRegion(bcp47: string): string | undefined {
  // "ko-Kore-KR" 같은 스크립트 서브태그가 낄 수 있으니 언어와 2글자 리전만 취한다.
  const parts = bcp47.split('-');
  const lang = parts[0]?.toLowerCase();
  const region = parts.find((p) => /^[A-Za-z]{2}$/.test(p) && p === p.toUpperCase());
  if (!lang || !region) return undefined;
  return `${lang}_${region}`;
}

/**
 * 설치된 로케일 목록(`locale -a` 출력)에서 최선의 UTF-8 로케일을 고른다.
 * 우선순위: 시스템 리전 → en_US.UTF-8 → C.UTF-8 → 임의의 UTF-8. 없으면 undefined.
 *
 * 순수 함수(입출력 없음)라 단위 테스트가 쉽다.
 */
export function pickUtf8Locale(available: string[], preferredRegion?: string): string | undefined {
  // 대소문자 무시 조회용 맵(정규화 키 → 원본 문자열).
  const utf8 = new Map<string, string>();
  for (const raw of available) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase().replace('utf8', 'utf-8');
    if (key.endsWith('.utf-8')) utf8.set(key, name);
  }
  const lookup = (candidate: string): string | undefined => {
    const hit = utf8.get(candidate.toLowerCase().replace('utf8', 'utf-8'));
    return hit;
  };

  if (preferredRegion) {
    const hit = lookup(`${preferredRegion}.UTF-8`);
    if (hit) return hit;
  }
  return lookup('en_US.UTF-8') ?? lookup('C.UTF-8') ?? utf8.values().next().value;
}

// 프로세스당 한 번만 계산(스폰마다 `locale -a`를 돌리지 않도록 메모이즈).
let cached: string | undefined;
let resolved = false;

/**
 * 이 머신에서 스폰 셸에 줄 UTF-8 로케일. Windows는 undefined(불필요).
 * `locale` 바이너리가 없거나 실패하면 en_US.UTF-8을 최선의 기본값으로 반환한다
 * (darwin/linux에 사실상 항상 존재).
 */
export function getShellUtf8Locale(): string | undefined {
  if (resolved) return cached;
  resolved = true;
  if (process.platform === 'win32') {
    cached = undefined;
    return cached;
  }
  let preferredRegion: string | undefined;
  try {
    preferredRegion = intlToPosixRegion(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    preferredRegion = undefined;
  }
  try {
    const out = execFileSync('locale', ['-a'], { encoding: 'utf8', timeout: 3000 });
    cached = pickUtf8Locale(out.split('\n'), preferredRegion) ?? 'en_US.UTF-8';
  } catch {
    // `locale -a`를 못 돌리면 UTF-8 조합만 되면 되므로 보편적으로 존재하는 값으로.
    cached = 'en_US.UTF-8';
  }
  return cached;
}

/** 테스트 전용: 메모이즈 캐시 초기화. */
export function __resetShellLocaleCacheForTest(): void {
  cached = undefined;
  resolved = false;
}
