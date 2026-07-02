import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { computeVisualPeaks, scalePeaks, VISUAL_PEAK_POINTS } from "../lib/audioMixMath";
import type { TrackEditParams } from "../types/audio";

interface WaveformProps {
  /** Plain arrays come from captured snapshots; `Float32Array` from the computed Master Mix. */
  samples?: number[] | Float32Array;
  channels?: number;
  sampleRate?: number;
  /**
   * Precomputed min/max peaks (see `computeVisualPeaks`), e.g. from the
   * mixer worker. When provided, drawing skips scanning `samples` entirely -
   * only used for duration math. When omitted, peaks are computed from
   * `samples` here, memoized so that only stays cheap while `samples`
   * itself doesn't change.
   */
  peaks?: Float32Array;
  /** Linear gain applied to whichever peaks are drawn (prop or computed) - cheap enough to apply on every change instantly. */
  visualGain?: number;
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
/** Active (in-trim) waveform peaks: clean cyan/blue. */
const WAVEFORM_ACTIVE_COLOR = "#22d3ee";
/** Trimmed-out waveform peaks: desaturated gray. */
const WAVEFORM_TRIMMED_COLOR = "#6b7280";
/** Trim drag handles: thin, solid purple. */
const TRIM_HANDLE_COLOR = "#8b5cf6";
/** Playhead: a lighter purple, distinct from the trim handles' shade. */
const PLAYHEAD_COLOR = "#c084fc";

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
  trimStartMs,
  trimEndMs,
  onTrimChange,
  playbackPositionSeconds,
  onScrub,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rulerCanvasRef = useRef<HTMLCanvasElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);

  const totalFrames = samples ? Math.floor(samples.length / Math.max(1, channels)) : 0;
  const durationMs = sampleRate > 0 ? (totalFrames / sampleRate) * 1000 : 0;
  const effectiveTrimEndMs = trimEndMs === 0 ? durationMs : Math.min(trimEndMs, durationMs);

  // Expensive: only recomputed when the underlying raw samples actually
  // change, never on a volume tick. Skipped entirely if the caller already
  // supplies precomputed peaks (e.g. the Master Mix, from the worker).
  const basePeaks = useMemo(() => {
    if (peaksProp || !samples || samples.length === 0) return null;
    return computeVisualPeaks(samples, VISUAL_PEAK_POINTS);
  }, [peaksProp, samples]);

  // Cheap: applying a linear gain to ~1000 points is instant, so this can
  // safely re-run on every volume change without any drawing lag.
  const displayPeaks = useMemo(() => {
    const base = peaksProp ?? basePeaks;
    if (!base) return null;
    return scalePeaks(base, visualGain);
  }, [peaksProp, basePeaks, visualGain]);

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

    if (displayPeaks && displayPeaks.length > 0) {
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
  }, [displayPeaks, trimStartMs, effectiveTrimEndMs, durationMs, playbackPositionSeconds]);

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
