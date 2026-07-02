import { useRef } from "react";
import { applyEditParams, computeVisualPeaks, VISUAL_PEAK_POINTS } from "../lib/audioMixMath";
import type { ChannelInfo, TrackEditParams, TrackSnapshot } from "../types/audio";

interface CachedLayer {
  snapshot: TrackSnapshot;
  trimStartMs: number;
  trimEndMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  volume: number;
  peaks: Float32Array;
}

/**
 * Memoizes each active channel's own downsampled waveform peaks (used by
 * the Master overlay - see `Waveform`'s `overlayLayers`), keyed on
 * everything that actually changes a layer's *shape*: its snapshot
 * (identity, not content - a new capture always produces a new object),
 * trim, fade, and effective volume.
 *
 * `scrubOffsetMs` is deliberately excluded - scrubbing only shifts where a
 * layer is drawn on the shared timeline, never its content, so a scrub
 * commit must never invalidate this cache. That's what makes scrubbing
 * "just move a layer" cheap: this hook keeps returning the same
 * `Float32Array` reference for every unaffected track, and the expensive
 * `applyEditParams` + `computeVisualPeaks` pass only re-runs for a track
 * whose own trim/fade/volume actually changed.
 */
export function useTrackPeaksCache(
  activeChannels: ChannelInfo[],
  snapshots: Record<string, TrackSnapshot>,
  getEffectiveParams: (channelId: string) => TrackEditParams,
): Record<string, Float32Array> {
  const cacheRef = useRef<Map<string, CachedLayer>>(new Map());
  const result: Record<string, Float32Array> = {};

  for (const channel of activeChannels) {
    const snapshot = snapshots[channel.id];
    if (!snapshot) continue;

    const params = getEffectiveParams(channel.id);
    const cached = cacheRef.current.get(channel.id);

    if (
      cached &&
      cached.snapshot === snapshot &&
      cached.trimStartMs === params.trimStartMs &&
      cached.trimEndMs === params.trimEndMs &&
      cached.fadeInMs === params.fadeInMs &&
      cached.fadeOutMs === params.fadeOutMs &&
      cached.volume === params.volume
    ) {
      result[channel.id] = cached.peaks;
      continue;
    }

    const processed = applyEditParams(snapshot, params);
    const peaks = computeVisualPeaks(processed, VISUAL_PEAK_POINTS);
    cacheRef.current.set(channel.id, {
      snapshot,
      trimStartMs: params.trimStartMs,
      trimEndMs: params.trimEndMs,
      fadeInMs: params.fadeInMs,
      fadeOutMs: params.fadeOutMs,
      volume: params.volume,
      peaks,
    });
    result[channel.id] = peaks;
  }

  return result;
}
