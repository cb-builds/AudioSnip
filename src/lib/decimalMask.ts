import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** Digits, an optional decimal point, and at most 2 digits after it - no leading sign. */
export const DECIMAL_PATTERN = /^\d*\.?\d{0,2}$/;
/** Same as `DECIMAL_PATTERN` but also allows a single leading "-" (for dB values). */
export const SIGNED_DECIMAL_PATTERN = /^-?\d*\.?\d{0,2}$/;

const NAVIGATION_KEYS = ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Tab", "Home", "End"];

/**
 * Keydown handler that firmly blocks any keystroke which would push a
 * numeric text input past 2 decimal places (or introduce anything that
 * isn't a digit, one decimal point, and - if `allowNegative` - one leading
 * minus sign). Pair with an `onChange` handler that re-validates against
 * the same pattern, since a keydown mask alone doesn't cover paste.
 */
export function maskDecimalKeyDown(
  event: ReactKeyboardEvent<HTMLInputElement>,
  allowNegative = false,
) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (NAVIGATION_KEYS.includes(event.key)) return;

  const allowedChars = allowNegative ? /^[0-9.-]$/ : /^[0-9.]$/;
  if (!allowedChars.test(event.key)) {
    event.preventDefault();
    return;
  }

  const input = event.currentTarget;
  const prospective =
    input.value.slice(0, input.selectionStart ?? input.value.length) +
    event.key +
    input.value.slice(input.selectionEnd ?? input.value.length);

  const pattern = allowNegative ? SIGNED_DECIMAL_PATTERN : DECIMAL_PATTERN;
  if (!pattern.test(prospective)) {
    event.preventDefault();
  }
}
