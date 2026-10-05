type KeyEventLike = { nativeEvent: { isComposing: boolean }; keyCode: number };

// While an input method (CJK, Bengali, …) is composing, Enter commits the
// candidate text — it must not submit. keyCode 229 covers engines that report
// the composing keydown before isComposing is set. Ported from upstream PR #3.
export function isImeComposing(event: KeyEventLike): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
