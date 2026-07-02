import { useEffect, useState } from "react";
import type { ChangeEvent as ReactChangeEvent } from "react";
import { DECIMAL_PATTERN, maskDecimalKeyDown } from "../lib/decimalMask";

interface SecondsFieldProps {
  label: string;
  valueMs: number;
  onChange: (ms: number) => void;
  align?: "left" | "right";
}

/**
 * Seconds input strictly masked to at most 2 decimal places (matching the
 * playback timer box), freezing its displayed text while focused so
 * reformatting doesn't fight the user's typing, and committing/clamping on
 * blur. Shared by Trim Start/End and Fade In/Out, across every track
 * including the Master Mix.
 */
export function SecondsField({ label, valueMs, onChange, align = "left" }: SecondsFieldProps) {
  const [text, setText] = useState((valueMs / 1000).toFixed(2));
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (isEditing) return;
    setText((valueMs / 1000).toFixed(2));
  }, [valueMs, isEditing]);

  function handleChange(event: ReactChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    if (DECIMAL_PATTERN.test(value)) {
      setText(value);
    }
  }

  function handleBlur() {
    setIsEditing(false);
    const parsed = Number(text);
    const seconds = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    setText(seconds.toFixed(2));
    onChange(seconds * 1000);
  }

  return (
    <label className={`flex flex-col gap-1 text-xs ${align === "right" ? "items-end" : "items-start"}`}>
      <span className="text-neutral-400">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onFocus={() => setIsEditing(true)}
        onBlur={handleBlur}
        onKeyDown={maskDecimalKeyDown}
        onChange={handleChange}
        className="w-20 rounded bg-neutral-800 px-1 py-0.5 text-neutral-100"
      />
    </label>
  );
}
