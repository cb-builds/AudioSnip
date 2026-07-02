import { useEffect, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, PointerEvent as ReactPointerEvent } from "react";
import { maskDecimalKeyDown, SIGNED_DECIMAL_PATTERN } from "../lib/decimalMask";

interface ScrubControlProps {
  offsetMs: number;
  /** Adds `deltaMs` to whatever the current offset is (parent accumulates via a functional state update, so rapid repeated calls never race). */
  onShift: (deltaMs: number) => void;
  /** Sets the offset to an absolute value (from typing directly into the box). */
  onSetAbsolute: (ms: number) => void;
}

/** Each click/tick nudges by 0.1 seconds (100ms internally; displayed in seconds). */
const STEP_MS = 100;
const REPEAT_INTERVAL_MS = 60;
const INITIAL_HOLD_DELAY_MS = 300;

/**
 * Micro-alignment control: [-] button, a masked seconds textbox, [+] button.
 * The offset is stored (and communicated to the parent) in milliseconds,
 * but always displayed/edited in seconds here. While a button is held, each
 * tick updates only the displayed number (a local pending delta) - the
 * expensive `onShift` call (which triggers the Master Mix worker
 * re-render) fires exactly once, on release, so holding the button never
 * causes per-tick worker lag.
 *
 * Release is tracked via `pointerup`/`pointercancel`/`mouseup` listeners on
 * `window` rather than the button's own `onPointerUp`/`onMouseUp` (or
 * `onMouseLeave`) - a small button is easy to drift the cursor off of
 * during a longer hold, and relying on the button's own handlers would
 * either cut the repeat short early (losing the deferred-commit benefit and
 * only committing a tiny, easy-to-miss shift) or, worse, never fire at all
 * if the pointer is released outside the button's bounds - leaving the
 * repeat running indefinitely and fighting any manual typing into the box.
 */
export function ScrubControl({ offsetMs, onShift, onSetAbsolute }: ScrubControlProps) {
  const [text, setText] = useState((offsetMs / 1000).toFixed(2));
  const [isEditing, setIsEditing] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);
  const intervalRef = useRef<number | undefined>(undefined);
  const pendingDeltaRef = useRef(0);
  const releaseHandlerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (isEditing) return;
    setText((offsetMs / 1000).toFixed(2));
  }, [offsetMs, isEditing]);

  function applyLocalDelta(deltaMs: number) {
    pendingDeltaRef.current += deltaMs;
    setText(((offsetMs + pendingDeltaRef.current) / 1000).toFixed(2));
  }

  function commitPending() {
    if (pendingDeltaRef.current !== 0) {
      onShift(pendingDeltaRef.current);
      pendingDeltaRef.current = 0;
    }
  }

  function stopHold() {
    if (timeoutRef.current !== undefined) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
    if (intervalRef.current !== undefined) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }
    if (releaseHandlerRef.current) {
      const handler = releaseHandlerRef.current;
      window.removeEventListener("pointerup", handler);
      window.removeEventListener("pointercancel", handler);
      window.removeEventListener("mouseup", handler);
      releaseHandlerRef.current = null;
    }
    commitPending();
  }

  function startHold(direction: 1 | -1, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    applyLocalDelta(direction * STEP_MS);
    timeoutRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(() => {
        applyLocalDelta(direction * STEP_MS);
      }, REPEAT_INTERVAL_MS);
    }, INITIAL_HOLD_DELAY_MS);

    const handleRelease = () => stopHold();
    releaseHandlerRef.current = handleRelease;
    window.addEventListener("pointerup", handleRelease);
    window.addEventListener("pointercancel", handleRelease);
    window.addEventListener("mouseup", handleRelease);
  }

  useEffect(() => stopHold, []);

  function handleChange(event: ReactChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    if (SIGNED_DECIMAL_PATTERN.test(value) || value === "-") {
      setText(value);
    }
  }

  function handleBlur() {
    setIsEditing(false);
    const parsed = Number(text);
    const seconds = Number.isFinite(parsed) ? parsed : offsetMs / 1000;
    setText(seconds.toFixed(2));
    onSetAbsolute(seconds * 1000);
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onPointerDown={(event) => startHold(-1, event)}
        className="rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100 hover:bg-neutral-700"
      >
        -
      </button>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onFocus={() => setIsEditing(true)}
        onBlur={handleBlur}
        onKeyDown={(e) => maskDecimalKeyDown(e, true)}
        onChange={handleChange}
        className="w-16 rounded bg-neutral-800 px-1 py-0.5 text-center text-xs text-neutral-100"
      />
      <button
        type="button"
        onPointerDown={(event) => startHold(1, event)}
        className="rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100 hover:bg-neutral-700"
      >
        +
      </button>
    </div>
  );
}
