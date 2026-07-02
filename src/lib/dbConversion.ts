import { MAX_GAIN_DB, MIN_GAIN_DB } from "./audioMixMath";

/** Shared by `VolumeFader` and `CompactVolumeControl` so both stay in sync on exactly how a linear volume multiplier maps to/from the dB scale the sliders/textboxes actually operate on. */
export function volumeToDb(volume: number): number {
  return volume > 0 ? 20 * Math.log10(volume) : MIN_GAIN_DB;
}

export function dbToVolume(db: number): number {
  return 10 ** (db / 20);
}

export function clampDb(db: number): number {
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, db));
}

export function formatDb(volume: number): string {
  return clampDb(volumeToDb(volume)).toFixed(2);
}
