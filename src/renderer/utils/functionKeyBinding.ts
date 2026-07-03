import type { CustomKeybinding } from '../../shared/types';

// === 커스텀 키바인딩의 F키(맨 F1–F12) 판별 (pure helper) ===
//
// macOS 기본 설정(`com.apple.keyboard.fnState` = 0)에서는 F1–F12가 미디어/시스템
// 키로 동작해 keydown 이벤트가 앱에 전달되지 않는다. 즉 F키 단독 바인딩(예: 'F7')은
// Fn을 함께 누르거나 시스템 설정을 바꾸지 않으면 발동하지 않는다. 설정 패널에서
// 이 상황을 안내하기 위해, 콤보의 "마지막 파트"가 F키인 바인딩이 하나라도 있는지
// 검사한다. 순수 함수라 store 없이 렌더/셀렉터에서 호출 가능하고 단위 테스트도 쉽다.
//
// Ctrl/Shift 등 수정자와 함께 눌러도(예: 'Ctrl+F7') macOS의 미디어 키 소비는 동일하게
// 일어나므로, 수정자 유무와 무관하게 마지막 파트만 본다.

/** 콤보 문자열의 마지막 파트가 F1–F12 형태인지 검사한다. 예: 'F7' → true, 'Ctrl+F7' → true. */
const FUNCTION_KEY_RE = /^F([1-9]|1[0-2])$/;

/** 단일 콤보(예: 'F7', 'Ctrl+F7')가 맨 F키를 최종 트리거로 사용하는지 판별. */
export function isBareFunctionKeyCombo(key: string): boolean {
  const lastPart = key.split('+').pop() ?? key;
  return FUNCTION_KEY_RE.test(lastPart.trim());
}

/**
 * 주어진 커스텀 키바인딩 목록에 F키를 최종 트리거로 쓰는 바인딩이 하나라도 있으면 true.
 * (macOS 전용 안내문 노출 조건으로 사용)
 */
export function hasBareFunctionKeyBinding(keybindings: CustomKeybinding[]): boolean {
  return keybindings.some((kb) => isBareFunctionKeyCombo(kb.key));
}
