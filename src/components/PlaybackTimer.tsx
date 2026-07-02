import { useEffect, useState } from "react";
import type { ChangeEvent as ReactChangeEvent } from "react";
import { DECIMAL_PATTERN, maskDecimalKeyDown } from "../lib/decimalMask";

interface PlaybackTimerProps {
  /** Playback position, in seconds, from the start of the full (untrimmed) clip. */
  positionSeconds?: number;
  /** The trimmed clip's start, in seconds - used to clamp typed values and as the default before anything has played. */
  minSeconds: number;
  /** The trimmed clip's end, in seconds. */
  maxSeconds: number;
  onSeek: (absoluteSeconds: number) => void;
}

/**
 * The playback position readout/editor, relocated into the Track Settings
 * panel. Values are absolute (relative to the full, untrimmed clip) so the
 * box reads the true starting point (e.g. 20.47s) rather than resetting to
 * 0 whenever the trim boundaries move. Freezes its displayed text while
 * focused so reformatting doesn't fight the user's typing, and
 * commits/clamps on blur - the same pattern used by every other numeric
 * field in the app.
 */
export function PlaybackTimer({ positionSeconds, minSeconds, maxSeconds, onSeek }: PlaybackTimerProps) {
  const [text, setText] = useState((positionSeconds ?? minSeconds).toFixed(2));
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (isEditing) return;
    setText((positionSeconds ?? minSeconds).toFixed(2));
  }, [positionSeconds, minSeconds, isEditing]);

  function handleChange(event: ReactChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    if (DECIMAL_PATTERN.test(value)) {
      setText(value);
    }
  }

  function handleBlur() {
    setIsEditing(false);
    const parsed = Number(text);
    const clamped = Number.isFinite(parsed) ? Math.max(minSeconds, Math.min(parsed, maxSeconds)) : minSeconds;
    setText(clamped.toFixed(2));
    onSeek(clamped);
  }

  return (
    <label className="flex flex-col gap-1 text-xs text-neutral-400">
      Playback position
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onFocus={() => setIsEditing(true)}
        onBlur={handleBlur}
        onKeyDown={maskDecimalKeyDown}
        onChange={handleChange}
        className="w-24 rounded bg-neutral-800 px-1 py-0.5 text-neutral-100"
      />
    </label>
  );
}
