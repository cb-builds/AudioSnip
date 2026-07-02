const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/**
 * Builds an accelerator string (e.g. "Control+Shift+KeyK") from a keydown
 * event, matching the format the Rust `global-hotkey` parser expects.
 * `event.code` values (KeyK, Digit5, ArrowUp, F1, ...) map 1:1 onto the
 * parser's accepted key tokens, so no translation table is needed - only
 * the modifier names differ (`metaKey` -> "Super", since the parser has no
 * "Meta" token).
 *
 * Returns `null` if the event is a bare modifier press with no main key yet.
 */
export function acceleratorFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(event.code)) {
    return null;
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.altKey) modifiers.push("Alt");
  if (event.metaKey) modifiers.push("Super");

  return [...modifiers, event.code].join("+");
}
