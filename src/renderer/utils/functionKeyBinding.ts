import type { CustomKeybinding } from '../../shared/types';

// === 커스텀 키바인딩의 "단독" F키(F1–F12) 판별 (pure helper) ===
//
// macOS 기본 설정(`com.apple.keyboard.fnState` = 0)에서는 F1–F12가 미디어/시스템
// 키로 동작해 keydown 이벤트가 앱에 전달되지 않는다. 즉 수정자 없는 단독 F키
// 바인딩(예: 'F7')은 Fn을 함께 누르거나 시스템 설정을 바꾸지 않으면 발동하지 않는다.
// 반면 'Ctrl+F7'처럼 수정자를 얹으면 macOS는 이를 기능 키로 앱에 전달하므로 정상
// 동작한다(그래서 Mac 기본값이 Ctrl+F7이다). 따라서 안내문은 오직 "단독 F키"
// 바인딩에만 필요하다 — 수정자가 붙은 조합에는 뜨면 안 된다(자기모순).
//
// 순수 함수라 store 없이 렌더/셀렉터에서 호출 가능하고 단위 테스트도 쉽다.

/** F1–F12 형태인지 검사한다(F13+ 제외). */
const FUNCTION_KEY_RE = /^F([1-9]|1[0-2])$/;

/**
 * 콤보 문자열이 수정자 없는 단독 F키(F1–F12)인지 판별.
 * 예: 'F7' → true, 'Ctrl+F7' → false('+'가 있으면 정규식이 매치되지 않음), 'A' → false.
 */
export function isBareFunctionKeyCombo(key: string): boolean {
  return FUNCTION_KEY_RE.test(key.trim());
}

/**
 * 주어진 커스텀 키바인딩 목록에 수정자 없는 단독 F키 바인딩이 하나라도 있으면 true.
 * (macOS 전용 안내문 노출 조건으로 사용)
 */
export function hasBareFunctionKeyBinding(keybindings: CustomKeybinding[]): boolean {
  return keybindings.some((kb) => isBareFunctionKeyCombo(kb.key));
}
