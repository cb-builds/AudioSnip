import { useEffect, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, ReactNode } from "react";
import { MAX_GAIN_DB, MIN_GAIN_DB } from "../lib/audioMixMath";
import { maskDecimalKeyDown, SIGNED_DECIMAL_PATTERN } from "../lib/decimalMask";

interface VolumeFaderProps {
  /** Linear multiplier (1.0 = unity gain). */
  volume: number;
  onVolumeChange: (volume: number) => void;
  onAmplify: () => void;
  disabled?: boolean;
  /** Rendered immediately to the left of the slider - e.g. a per-track "enabled" checkbox in the Master's Source Volume Levels list. */
  leading?: ReactNode;
}

function volumeToDb(volume: number): number {
  return volume > 0 ? 20 * Math.log10(volume) : MIN_GAIN_DB;
}

function dbToVolume(db: number): number {
  return 10 ** (db / 20);
}

function clampDb(db: number): number {
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, db));
}

function formatDb(volume: number): string {
  return clampDb(volumeToDb(volume)).toFixed(2);
}

/**
 * A horizontal dB-scale slider, paired with a dB text box and an Amplify
 * button - both tied to the exact same underlying dB value (the slider
 * simply displays/edits `volumeToDb(volume)` directly, rather than a
 * separately-synced linear representation), so there's nothing to keep in
 * sync between them. Shared by the per-track Advanced Audio Options and the
 * Master Mix's per-source "Source Volume Levels" rows.
 */
export function VolumeFader({ volume, onVolumeChange, onAmplify, disabled, leading }: VolumeFaderProps) {
  const [dbText, setDbText] = useState(() => formatDb(volume));
  const [isEditingDb, setIsEditingDb] = useState(false);

  useEffect(() => {
    if (isEditingDb) return;
    setDbText(formatDb(volume));
  }, [volume, isEditingDb]);

  function commitDb(db: number) {
    onVolumeChange(dbToVolume(clampDb(db)));
  }

  function handleSliderChange(event: ReactChangeEvent<HTMLInputElement>) {
    commitDb(Number(event.target.value));
  }

  function handleDbChange(event: ReactChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    if (!(SIGNED_DECIMAL_PATTERN.test(value) || value === "-")) return;
    setDbText(value);

    const parsed = Number(value);
    if (value !== "" && value !== "-" && Number.isFinite(parsed)) {
      commitDb(parsed);
    }
  }

  function handleDbBlur() {
    setIsEditingDb(false);
    const parsed = Number(dbText);
    const clamped = Number.isFinite(parsed) ? clampDb(parsed) : clampDb(volumeToDb(volume));
    setDbText(clamped.toFixed(2));
    commitDb(clamped);
  }

  const sliderDb = clampDb(volumeToDb(volume));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {leading}
        <input
          type="range"
          min={MIN_GAIN_DB}
          max={MAX_GAIN_DB}
          step={0.1}
          value={sliderDb}
          onChange={handleSliderChange}
          disabled={disabled}
          className="w-full flex-1 accent-cyan-500"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onAmplify}
          disabled={disabled}
          className="rounded bg-gradient-to-br from-blue-600 to-violet-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
        >
          Amplify
        </button>
        <label className="flex items-center gap-1 text-xs text-neutral-400">
          <input
            type="text"
            inputMode="decimal"
            value={dbText}
            onFocus={() => setIsEditingDb(true)}
            onBlur={handleDbBlur}
            onKeyDown={(e) => maskDecimalKeyDown(e, true)}
            onChange={handleDbChange}
            disabled={disabled}
            className="w-12 rounded bg-neutral-800 px-1 py-0.5 text-neutral-100"
          />
          dB
        </label>
      </div>
    </div>
  );
}
