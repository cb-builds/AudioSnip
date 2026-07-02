import { useEffect, useState } from "react";
import type { ChangeEvent as ReactChangeEvent } from "react";
import { MAX_GAIN_DB, MIN_GAIN_DB } from "../lib/audioMixMath";
import { clampDb, dbToVolume, formatDb, volumeToDb } from "../lib/dbConversion";
import { maskDecimalKeyDown, SIGNED_DECIMAL_PATTERN } from "../lib/decimalMask";

interface CompactVolumeControlProps {
  /** Linear multiplier (1.0 = unity gain). */
  volume: number;
  onVolumeChange: (volume: number) => void;
}

/**
 * A single-row volume control - a shortened slider with the dB textbox and
 * "dB" label inline to its right, instead of `VolumeFader`'s slider-then-
 * Amplify-row stacked layout. Used where there's no Amplify action and no
 * room to spare for a second row, e.g. Settings' per-device "Default
 * Volume" presets.
 */
export function CompactVolumeControl({ volume, onVolumeChange }: CompactVolumeControlProps) {
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
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={MIN_GAIN_DB}
        max={MAX_GAIN_DB}
        step={0.1}
        value={sliderDb}
        onChange={handleSliderChange}
        className="w-20 shrink-0 accent-cyan-500"
      />
      <input
        type="text"
        inputMode="decimal"
        value={dbText}
        onFocus={() => setIsEditingDb(true)}
        onBlur={handleDbBlur}
        onKeyDown={(e) => maskDecimalKeyDown(e, true)}
        onChange={handleDbChange}
        className="w-12 shrink-0 rounded bg-neutral-800 px-1 py-0.5 text-xs text-neutral-100"
      />
      <span className="text-xs text-neutral-400">dB</span>
    </div>
  );
}
