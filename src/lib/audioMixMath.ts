import type { TrackEditParams, TrackSnapshot } from "../types/audio";

/** Gain range the volume controls (slider, dB box, and Amplify) allow. */
export const MAX_GAIN_DB = 24;
export const MIN_GAIN_DB = -40;
export const MAX_VOLUME_MULTIPLIER = 10 ** (MAX_GAIN_DB / 20);
export const MIN_VOLUME_MULTIPLIER = 10 ** (MIN_GAIN_DB / 20);

/** Number of min/max point-pairs a waveform is downsampled to for drawing. */
export const VISUAL_PEAK_POINTS = 1000;

export function msToFrames(ms: number, sampleRate: number): number {
  return Math.floor((ms / 1000) * sampleRate);
}

function downmixToMono(samples: number[], channels: number): Float32Array {
  const channelCount = Math.max(1, channels);
  const frameCount = Math.floor(samples.length / channelCount);
  const mono = new Float32Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channelCount; c++) {
      sum += samples[i * channelCount + c];
    }
    mono[i] = sum / channelCount;
  }

  return mono;
}

/** Downmixes to mono and trims, but does not fade/scale - shared by playback processing and peak analysis. */
function downmixAndTrim(track: TrackSnapshot, params: TrackEditParams): Float32Array {
  const mono = downmixToMono(track.samples, track.channels);

  const totalFrames = mono.length;
  const start = Math.min(msToFrames(params.trimStartMs, track.sampleRate), totalFrames);
  const end = Math.max(
    params.trimEndMs === 0
      ? totalFrames
      : Math.min(msToFrames(params.trimEndMs, track.sampleRate), totalFrames),
    start,
  );

  return mono.slice(start, end);
}

/**
 * Mirrors the Rust mixer's per-track processing (downmix, trim, fade
 * in/out, volume) client-side, purely for instant local preview playback -
 * the authoritative mixdown/encode still happens in Rust at export time.
 */
export function applyEditParams(track: TrackSnapshot, params: TrackEditParams): Float32Array {
  const edited = downmixAndTrim(track, params);
  const len = edited.length;

  const fadeInFrames = Math.min(msToFrames(params.fadeInMs, track.sampleRate), len);
  for (let i = 0; i < fadeInFrames; i++) {
    edited[i] *= i / fadeInFrames;
  }

  const fadeOutFrames = Math.min(msToFrames(params.fadeOutMs, track.sampleRate), len);
  for (let i = 0; i < fadeOutFrames; i++) {
    edited[len - 1 - i] *= i / fadeOutFrames;
  }

  for (let i = 0; i < len; i++) {
    edited[i] *= params.volume;
  }

  return edited;
}

/**
 * Finds the peak absolute sample value within the trimmed region (before
 * fade/volume are applied), so "Amplify" can solve for the volume that
 * brings that peak to exactly full scale.
 */
export function computePeakAmplitude(track: TrackSnapshot, params: TrackEditParams): number {
  const trimmed = downmixAndTrim(track, params);
  let peak = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const abs = Math.abs(trimmed[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/**
 * Volume multiplier that brings `peak` to exactly 1.0 full scale, clamped to
 * the volume control's usable range (-40dB..+24dB). If the audio is already
 * clipping (`peak > 1`), this comes out less than 1 - i.e. it turns the
 * volume down to the maximum safe level instead of up.
 */
export function computeAmplifyVolume(peak: number): number {
  if (peak <= 0) return 1;
  return Math.max(MIN_VOLUME_MULTIPLIER, Math.min(MAX_VOLUME_MULTIPLIER, 1 / peak));
}

/**
 * Downsamples `samples` into `pointCount` min/max pairs (interleaved:
 * `[min0, max0, min1, max1, ...]`) for near-instant waveform drawing
 * regardless of how many raw samples the clip actually has. Accepts
 * `ArrayLike` so it works on both plain `number[]` snapshots and
 * `Float32Array` mix results.
 */
export function computeVisualPeaks(samples: ArrayLike<number>, pointCount: number): Float32Array {
  const peaks = new Float32Array(pointCount * 2);
  if (samples.length === 0) return peaks;

  const samplesPerPoint = Math.max(1, Math.ceil(samples.length / pointCount));
  for (let p = 0; p < pointCount; p++) {
    const start = p * samplesPerPoint;
    if (start >= samples.length) break;
    const end = Math.min(start + samplesPerPoint, samples.length);

    let min = samples[start];
    let max = samples[start];
    for (let i = start + 1; i < end; i++) {
      const value = samples[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    peaks[p * 2] = min;
    peaks[p * 2 + 1] = max;
  }

  return peaks;
}

/** Scales a precomputed peaks array by a linear gain - equivalent to (and far cheaper than) rescaling the raw samples and recomputing peaks. */
export function scalePeaks(peaks: Float32Array, gain: number): Float32Array {
  if (gain === 1) return peaks;
  const scaled = new Float32Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    scaled[i] = peaks[i] * gain;
  }
  return scaled;
}

/**
 * Approximates fade in/out on a precomputed peaks array by ramping the
 * points that fall within the fade regions - visually accurate at the
 * peaks' resolution without ever touching the underlying raw samples.
 * Anchored to the trim window `[startMs, endMs)` (0 for `endMs` means "the
 * end of the buffer"), matching `applyFade`, so the waveform's fade curve
 * lines up with the trim handles instead of the raw clip's edges.
 */
export function applyFadeToPeaks(
  peaks: Float32Array,
  fadeInMs: number,
  fadeOutMs: number,
  totalDurationMs: number,
  startMs = 0,
  endMs = 0,
): Float32Array {
  if (totalDurationMs <= 0 || (fadeInMs <= 0 && fadeOutMs <= 0)) return peaks;

  const pointCount = peaks.length / 2;
  const faded = peaks.slice();
  const msPerPoint = totalDurationMs / pointCount;

  const effectiveEndMs = endMs === 0 ? totalDurationMs : Math.min(endMs, totalDurationMs);
  const startPoint = Math.max(0, Math.min(Math.floor(startMs / msPerPoint), pointCount));
  const endPoint = Math.max(startPoint, Math.min(Math.ceil(effectiveEndMs / msPerPoint), pointCount));
  const rangePoints = endPoint - startPoint;

  const fadeInPoints = Math.min(rangePoints, Math.ceil(fadeInMs / msPerPoint));
  for (let p = 0; p < fadeInPoints; p++) {
    const gain = p / fadeInPoints;
    const idx = startPoint + p;
    faded[idx * 2] *= gain;
    faded[idx * 2 + 1] *= gain;
  }

  const fadeOutPoints = Math.min(rangePoints, Math.ceil(fadeOutMs / msPerPoint));
  for (let p = 0; p < fadeOutPoints; p++) {
    const gain = p / fadeOutPoints;
    const idx = endPoint - 1 - p;
    faded[idx * 2] *= gain;
    faded[idx * 2 + 1] *= gain;
  }

  return faded;
}

/**
 * Applies fade in/out to a copy of `samples`, anchored to the trim window
 * `[startMs, endMs)` rather than the raw buffer - fade in starts ramping up
 * exactly at `startMs` and fade out finishes ramping down exactly at
 * `endMs` (0 means "the end of the buffer"). Used for the Master Mix's own
 * fade controls, which operate on the full mixed buffer while trim is
 * applied separately (only at playback time), so without this the fade
 * would ramp from/to the absolute start/end of the untrimmed mix instead of
 * the user's chosen trim boundaries.
 */
export function applyFade(
  samples: Float32Array,
  fadeInMs: number,
  fadeOutMs: number,
  sampleRate: number,
  startMs = 0,
  endMs = 0,
): Float32Array {
  const faded = samples.slice();
  const len = faded.length;

  const startFrame = Math.max(0, Math.min(msToFrames(startMs, sampleRate), len));
  const endFrame =
    endMs === 0 ? len : Math.max(startFrame, Math.min(msToFrames(endMs, sampleRate), len));
  const rangeFrames = endFrame - startFrame;

  const fadeInFrames = Math.min(msToFrames(fadeInMs, sampleRate), rangeFrames);
  for (let i = 0; i < fadeInFrames; i++) {
    faded[startFrame + i] *= i / fadeInFrames;
  }

  const fadeOutFrames = Math.min(msToFrames(fadeOutMs, sampleRate), rangeFrames);
  for (let i = 0; i < fadeOutFrames; i++) {
    faded[endFrame - 1 - i] *= i / fadeOutFrames;
  }

  return faded;
}

/**
 * Computes each track's position on the shared Master timeline - purely
 * positional arithmetic, no audio processing, so it's cheap enough to call
 * on every render/scrub-tick with no lag. Replaces the old pre-mixed
 * buffer's positioning step: the Master Mix is no longer downmixed into one
 * buffer for preview (see `Waveform`'s `overlayLayers` and
 * `App.tsx`'s multi-source playback engine) - each track stays independent,
 * and this is just "where does it sit on the shared timeline."
 *
 * A track's raw offset (`trimStartMs + scrubOffsetMs`) can go negative -
 * e.g. scrubbing an untrimmed track earlier than its own sample 0, to pull
 * it ahead of the others without first having to manually trim it for
 * "headroom". Rather than clamping that to 0 (which would silently discard
 * the shift and require exactly that manual trim workaround), every track's
 * offset is shifted by whatever the most negative raw offset is, so the
 * earliest track always lands at 0ms and every other track's position
 * relative to it is preserved exactly - the shared timeline dynamically
 * re-anchors itself instead of needing a pre-existing trim to "borrow" room
 * from.
 */
export function computeTimelinePositions(
  tracks: { channelId: string; trimStartMs: number; scrubOffsetMs: number }[],
): Map<string, number> {
  const rawOffsets = tracks.map((track) => ({
    channelId: track.channelId,
    rawOffsetMs: track.trimStartMs + track.scrubOffsetMs,
  }));
  const minOffsetMs = Math.min(0, ...rawOffsets.map((track) => track.rawOffsetMs));

  const positions = new Map<string, number>();
  for (const { channelId, rawOffsetMs } of rawOffsets) {
    positions.set(channelId, rawOffsetMs - minOffsetMs);
  }
  return positions;
}

export interface MasterEnvelopeParams {
  masterVolume: number;
  masterFadeInMs: number;
  masterFadeOutMs: number;
  masterTrimStartMs: number;
  /** Already resolved from the 0-means-"to the end" sentinel, in absolute/shared-timeline ms. */
  masterTrimEndMs: number;
}

export interface MasterTrackSlice {
  /** This track's audible samples, sliced to Master's trim window and shaped by Master's fade/volume. Empty if this track contributes nothing within the window. */
  samples: Float32Array;
  /** Where this slice begins on the shared/master timeline, in ms. */
  startAbsoluteMs: number;
}

/**
 * Slices `samples` (already trim/fade/volume-processed for this one track,
 * positioned at `trackOffsetMs` on the shared timeline) down to whatever
 * portion falls within Master's own trim window, and applies Master's own
 * fade in/out + volume to that portion. A single per-track pass - never any
 * cross-track summation - so Master's fade/volume controls keep working
 * even though tracks are never downmixed into one buffer: each one is
 * shaped independently, informed only by its own position relative to the
 * shared window, and gets summed acoustically by the browser once every
 * track's `AudioBufferSourceNode` plays through the same `AudioContext`
 * destination at the same time (see `App.tsx`'s Master playback engine).
 */
export function applyMasterEnvelope(
  samples: Float32Array,
  sampleRate: number,
  trackOffsetMs: number,
  envelope: MasterEnvelopeParams,
): MasterTrackSlice {
  const trackDurationMs = sampleRate > 0 ? (samples.length / sampleRate) * 1000 : 0;
  const trackEndMs = trackOffsetMs + trackDurationMs;

  const startAbsoluteMs = Math.max(trackOffsetMs, envelope.masterTrimStartMs);
  const endAbsoluteMs = Math.min(trackEndMs, envelope.masterTrimEndMs);

  if (endAbsoluteMs <= startAbsoluteMs) {
    return { samples: new Float32Array(0), startAbsoluteMs };
  }

  const startFrame = msToFrames(startAbsoluteMs - trackOffsetMs, sampleRate);
  const endFrame = msToFrames(endAbsoluteMs - trackOffsetMs, sampleRate);
  const slice = samples.slice(startFrame, endFrame);

  const fadeInEndMs = envelope.masterTrimStartMs + envelope.masterFadeInMs;
  const fadeOutStartMs = envelope.masterTrimEndMs - envelope.masterFadeOutMs;

  if (envelope.masterVolume !== 1 || envelope.masterFadeInMs > 0 || envelope.masterFadeOutMs > 0) {
    for (let i = 0; i < slice.length; i++) {
      const absoluteMs = startAbsoluteMs + (i / sampleRate) * 1000;
      let gain = envelope.masterVolume;
      if (envelope.masterFadeInMs > 0 && absoluteMs < fadeInEndMs) {
        gain *= Math.max(0, (absoluteMs - envelope.masterTrimStartMs) / envelope.masterFadeInMs);
      }
      if (envelope.masterFadeOutMs > 0 && absoluteMs > fadeOutStartMs) {
        gain *= Math.max(0, (envelope.masterTrimEndMs - absoluteMs) / envelope.masterFadeOutMs);
      }
      slice[i] *= gain;
    }
  }

  return { samples: slice, startAbsoluteMs };
}
