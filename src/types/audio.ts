export interface ChannelInfo {
  id: string;
  name: string;
  kind: "input" | "output";
}

export interface TrackSnapshot {
  channelId: string;
  samples: number[];
  sampleRate: number;
  channels: number;
}

/** Mirrors Rust's `CaptureStatus` - polled via `getCaptureStatus()` instead of a push event. */
export type CaptureStatus =
  | { status: "idle" }
  | { status: "processing" }
  | { status: "ready"; snapshot: TrackSnapshot[] }
  | { status: "conflict"; snapshot: TrackSnapshot[] }
  | { status: "failed"; message: string };

export interface TrackEditParams {
  channelId: string;
  /** Linear volume multiplier (1.0 = unity gain). */
  volume: number;
  trimStartMs: number;
  /** 0 means "don't trim anything off the end". */
  trimEndMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Micro-alignment offset (can be negative) shifting this track's position in the Master Mix only - doesn't affect the track's own trim/playback. */
  scrubOffsetMs: number;
}

export function defaultEditParams(channelId: string, volume = 1): TrackEditParams {
  return {
    channelId,
    volume,
    trimStartMs: 0,
    trimEndMs: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    scrubOffsetMs: 0,
  };
}

/** Mirrors Rust's `GeneralSettings`. */
export interface GeneralSettings {
  minimizeToTray: boolean;
  closeToTray: boolean;
  runAtStartup: boolean;
  startMinimized: boolean;
}

/** The 3 named hotkey action ids the backend understands (see `hotkey.rs`). */
export type HotkeyAction = "captureSnip" | "showApp" | "resetBuffer";
