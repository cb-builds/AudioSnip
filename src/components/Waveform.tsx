import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { computeVisualPeaks, scalePeaks, VISUAL_PEAK_POINTS } from "../lib/audioMixMath";
import type { TrackEditParams } from "../types/audio";

/**
 * One track's waveform drawn as a layer inside the Master overlay (see
 * `WaveformProps.overlayLayers`) - each layer is fully independent (its own
 * peaks, its own position on the shared timeline), so shifting one via
 * scrub is just changing `offsetMs` and redrawing, never recomputing any
 * audio data.
 */
export interface OverlayLayer {
  channelId: string;
  /** This layer's own downsampled peaks (see `useTrackPeaksCache`) - already reflects its own trim/fade/volume, but not Master's. */
  peaks: Float32Array;
  color: string;
  /** This layer's opacity within Master's trim window (0-1) - outside the trim window it's dimmed further, proportionally. */
  alpha: number;
  /** Where this layer begins on the shared timeline, in ms. */
  offsetMs: number;
  /** This layer's own trimmed duration, in ms. */
  durationMs: number;
}

interface WaveformProps {
  /** Single-layer mode (individual tracks): plain arrays from captured snapshots. */
  samples?: number[] | Float32Array;
  channels?: number;
  sampleRate?: number;
  /**
   * Precomputed min/max peaks (see `computeVisualPeaks`). When provided,
   * drawing skips scanning `samples` entirely. When omitted, peaks are
   * computed from `samples` here, memoized so that only stays cheap while
   * `samples` itself doesn't change.
   */
  peaks?: Float32Array;
  /** Linear gain applied to whichever peaks are drawn (prop or computed) - cheap enough to apply on every change instantly. */
  visualGain?: number;
  /**
   * Multi-layer overlay mode (Master): draws every active track's own
   * waveform layered on top of each other with semi-transparent colors,
   * instead of a single pre-mixed buffer. When provided, `samples`/`peaks`
   * are ignored.
   */
  overlayLayers?: OverlayLayer[];
  /** Required in overlay mode - the shared timeline's total duration in ms, since there's no single underlying buffer to derive it from. */
  overlayDurationMs?: number;
  trimStartMs: number;
  /** 0 means "trim nothing off the end". */
  trimEndMs: number;
  onTrimChange: (patch: Partial<TrackEditParams>) => void;
  /** Playback position, in seconds, from the start of the full (untrimmed) clip. Omit to hide the playhead. */
  playbackPositionSeconds?: number;
  /** Scrubs to `offsetSeconds` (within the trimmed clip) and starts playing immediately. */
  onScrub: (offsetSeconds: number) => void;
}

const HANDLE_HIT_PX = 8;
/** Active (in-trim) waveform peaks: clean cyan/blue (single-layer mode) - also the Master overlay's uniform color when the Scrub panel is collapsed. */
export const WAVEFORM_ACTIVE_COLOR = "#22d3ee";
/** Trimmed-out waveform peaks: desaturated gray (single-layer mode). */
const WAVEFORM_TRIMMED_COLOR = "#6b7280";
/** Trim drag handles: thin, solid purple. */
const TRIM_HANDLE_COLOR = "#8b5cf6";
/** Playhead: a lighter purple, distinct from the trim handles' shade. */
const PLAYHEAD_COLOR = "#c084fc";
/** An overlay layer's opacity outside Master's trim window, as a fraction of its own in-trim alpha - dimmer, matching the single-layer gray-out convention, whatever the layer's base alpha is. */
const LAYER_OUT_OF_TRIM_DIM_FACTOR = 0.4;

function pickTickIntervalSeconds(durationSeconds: number): number {
  if (durationSeconds <= 10) return 1;
  if (durationSeconds <= 30) return 5;
  if (durationSeconds <= 60) return 10;
  if (durationSeconds <= 300) return 30;
  return 60;
}

function formatClockTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function Waveform({
  samples,
  channels = 1,
  sampleRate = 0,
  peaks: peaksProp,
  visualGain = 1,
  overlayLayers,
  overlayDurationMs,
  trimStartMs,
  trimEndMs,
  onTrimChange,
  playbackPositionSeconds,
  onScrub,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rulerCanvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);

  const isOverlayMode = Boolean(overlayLayers);
  const totalFrames = samples ? Math.floor(samples.length / Math.max(1, channels)) : 0;
  const singleLayerDurationMs = sampleRate > 0 ? (totalFrames / sampleRate) * 1000 : 0;
  const durationMs = isOverlayMode ? (overlayDurationMs ?? 0) : singleLayerDurationMs;
  const effectiveTrimEndMs = trimEndMs === 0 ? durationMs : Math.min(trimEndMs, durationMs);

  // Expensive: only recomputed when the underlying raw samples actually
  // change, never on a volume tick. Skipped entirely in overlay mode, or if
  // the caller already supplies precomputed peaks.
  const basePeaks = useMemo(() => {
    if (isOverlayMode || peaksProp || !samples || samples.length === 0) return null;
    return computeVisualPeaks(samples, VISUAL_PEAK_POINTS);
  }, [isOverlayMode, peaksProp, samples]);

  // Cheap: applying a linear gain to ~1000 points is instant, so this can
  // safely re-run on every volume change without any drawing lag.
  const displayPeaks = useMemo(() => {
    if (isOverlayMode) return null;
    const base = peaksProp ?? basePeaks;
    if (!base) return null;
    return scalePeaks(base, visualGain);
  }, [isOverlayMode, peaksProp, basePeaks, visualGain]);

  function msToX(ms: number, width: number) {
    if (durationMs <= 0) return 0;
    return (ms / durationMs) * width;
  }

  function xToMs(x: number, width: number) {
    if (width <= 0) return 0;
    return Math.max(0, Math.min(1, x / width)) * durationMs;
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas;
    const midY = height / 2;

    ctx.fillStyle = "#171717";
    ctx.fillRect(0, 0, width, height);

    const startX = durationMs > 0 ? msToX(trimStartMs, width) : 0;
    const endX = durationMs > 0 ? msToX(effectiveTrimEndMs, width) : width;

    if (overlayLayers && overlayLayers.length > 0) {
      // Each layer is an independent track's own waveform, drawn
      // semi-transparently at its own position on the shared timeline -
      // overlapping layers blend visually instead of ever being summed
      // into actual audio data. Shifting a layer (scrub) only changes
      // `offsetMs`, so this whole block is just redrawing, never
      // recomputing peaks.
      ctx.lineWidth = 1;
      for (const layer of overlayLayers) {
        if (layer.peaks.length === 0 || layer.durationMs <= 0) continue;

        const layerStartX = msToX(layer.offsetMs, width);
        const layerEndX = msToX(layer.offsetMs + layer.durationMs, width);
        const layerPixelWidth = Math.max(1, layerEndX - layerStartX);
        const pointCount = layer.peaks.length / 2;

        const xStart = Math.max(0, Math.floor(layerStartX));
        const xEnd = Math.min(width, Math.ceil(layerEndX));

        let currentAlpha: number | null = null;
        for (let x = xStart; x < xEnd; x++) {
          const inTrim = x >= startX && x <= endX;
          const alpha = inTrim ? layer.alpha : layer.alpha * LAYER_OUT_OF_TRIM_DIM_FACTOR;
          if (alpha !== currentAlpha) {
            if (currentAlpha !== null) ctx.stroke();
            ctx.beginPath();
            ctx.strokeStyle = layer.color;
            ctx.globalAlpha = alpha;
            currentAlpha = alpha;
          }

          const layerRelativeX = x - layerStartX;
          const pointIndex = Math.min(
            pointCount - 1,
            Math.max(0, Math.floor((layerRelativeX / layerPixelWidth) * pointCount)),
          );
          const min = layer.peaks[pointIndex * 2];
          const max = layer.peaks[pointIndex * 2 + 1];

          ctx.moveTo(x + 0.5, midY + min * midY);
          ctx.lineTo(x + 0.5, midY + max * midY);
        }
        if (currentAlpha !== null) ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (displayPeaks && displayPeaks.length > 0) {
      ctx.lineWidth = 1;

      // displayPeaks is a fixed-size (VISUAL_PEAK_POINTS) array regardless
      // of the clip's raw sample count, so this loop is always O(width) -
      // no lag spike no matter how large the underlying audio is. Active
      // (in-trim) peaks are drawn cyan; trimmed-out peaks desaturated gray -
      // batched into as few stroke() calls as there are color transitions.
      const pointCount = displayPeaks.length / 2;
      let currentColor: string | null = null;
      for (let x = 0; x < width; x++) {
        const inTrim = x >= startX && x <= endX;
        const color = inTrim ? WAVEFORM_ACTIVE_COLOR : WAVEFORM_TRIMMED_COLOR;
        if (color !== currentColor) {
          if (currentColor !== null) ctx.stroke();
          ctx.beginPath();
          ctx.strokeStyle = color;
          currentColor = color;
        }

        const pointIndex = Math.min(pointCount - 1, Math.floor((x / width) * pointCount));
        const min = displayPeaks[pointIndex * 2];
        const max = displayPeaks[pointIndex * 2 + 1];

        ctx.moveTo(x + 0.5, midY + min * midY);
        ctx.lineTo(x + 0.5, midY + max * midY);
      }
      if (currentColor !== null) ctx.stroke();
    }

    if (durationMs > 0) {
      // Thin, solid purple trim handles.
      ctx.fillStyle = TRIM_HANDLE_COLOR;
      ctx.fillRect(startX - 1, 0, 2, height);
      ctx.fillRect(endX - 1, 0, 2, height);

      // Playhead. `playbackPositionSeconds` is absolute (relative to the
      // full, untrimmed clip) - clamped into the current trim bounds so a
      // stale position (e.g. from before the trim was just moved) never
      // draws outside the active region.
      if (playbackPositionSeconds !== undefined) {
        const clampedMs = Math.max(trimStartMs, Math.min(playbackPositionSeconds * 1000, effectiveTrimEndMs));
        const playheadX = msToX(clampedMs, width);
        ctx.fillStyle = PLAYHEAD_COLOR;
        ctx.fillRect(playheadX - 1, 0, 2, height);
      }
    }
  }, [displayPeaks, overlayLayers, trimStartMs, effectiveTrimEndMs, durationMs, playbackPositionSeconds]);

  // Ruler: tick marks scaled to the snapshot's true duration (not the
  // configured rolling-buffer maximum).
  useEffect(() => {
    const canvas = rulerCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = canvas;
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, width, height);

    if (durationMs <= 0) return;

    const durationSeconds = durationMs / 1000;
    const tickIntervalSeconds = pickTickIntervalSeconds(durationSeconds);

    ctx.strokeStyle = "#525252";
    ctx.fillStyle = "#a3a3a3";
    ctx.font = "9px sans-serif";
    ctx.textBaseline = "top";

    for (let t = 0; t <= durationSeconds + 0.001; t += tickIntervalSeconds) {
      const x = msToX(t * 1000, width);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, height - 6);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
      ctx.fillText(formatClockTime(t), Math.min(x + 2, width - 22), 0);
    }
  }, [durationMs]);

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || durationMs <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;

    const startX = msToX(trimStartMs, canvas.width);
    const endX = msToX(effectiveTrimEndMs, canvas.width);

    if (Math.abs(x - startX) <= HANDLE_HIT_PX) {
      setDragging("start");
    } else if (Math.abs(x - endX) <= HANDLE_HIT_PX) {
      setDragging("end");
    }
  }

  useEffect(() => {
    if (!dragging) return;

    function handleMove(event: PointerEvent) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
      const ms = xToMs(x, canvas.width);

      if (dragging === "start") {
        onTrimChange({ trimStartMs: Math.max(0, Math.min(ms, effectiveTrimEndMs - 1)) });
      } else {
        onTrimChange({ trimEndMs: Math.min(durationMs, Math.max(ms, trimStartMs + 1)) });
      }
    }

    function handleUp() {
      setDragging(null);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragging, trimStartMs, effectiveTrimEndMs, durationMs]);

  function handleRulerClick(event: ReactMouseEvent<HTMLCanvasElement>) {
    const canvas = rulerCanvasRef.current;
    if (!canvas || durationMs <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const clickMs = xToMs(x, canvas.width);

    if (clickMs < trimStartMs || clickMs > effectiveTrimEndMs) return;
    onScrub((clickMs - trimStartMs) / 1000);
  }

  return (
    <div className="flex flex-col gap-1">
      <canvas
        ref={rulerCanvasRef}
        width={640}
        height={20}
        onClick={handleRulerClick}
        className="h-5 w-full cursor-pointer rounded bg-neutral-950"
      />
      <canvas
        ref={canvasRef}
        width={640}
        height={96}
        onPointerDown={handlePointerDown}
        className="h-24 w-full cursor-ew-resize rounded bg-neutral-900"
      />
    </div>
  );
}
