import { computeMasterMix, computeVisualPeaks, VISUAL_PEAK_POINTS } from "../lib/audioMixMath";
import type { TrackEditParams, TrackSnapshot } from "../types/audio";

export interface MixerWorkerRequest {
  requestId: number;
  tracks: { snapshot: TrackSnapshot; params: TrackEditParams }[];
}

export interface MixerWorkerResponse {
  requestId: number;
  samples: Float32Array;
  sampleRate: number;
  /** Precomputed min/max peaks (see `computeVisualPeaks`) so the main thread can paint the waveform instantly instead of scanning the full mix. */
  peaks: Float32Array;
}

/**
 * Cast rather than relying on the ambient `webworker` lib: this project's
 * tsconfig includes `DOM` (needed everywhere else), and TypeScript doesn't
 * allow mixing the `DOM` and `webworker` libs in one program without
 * conflicting global declarations. This interface describes exactly the two
 * calls this file needs, fully type-checked against that shape.
 */
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<MixerWorkerRequest>) => void) | null;
  postMessage: (message: MixerWorkerResponse, transfer: Transferable[]) => void;
};

workerScope.onmessage = (event) => {
  const { requestId, tracks } = event.data;
  const { samples, sampleRate } = computeMasterMix(tracks);
  const peaks = computeVisualPeaks(samples, VISUAL_PEAK_POINTS);
  // Transfer the underlying buffers back instead of copying them.
  workerScope.postMessage({ requestId, samples, sampleRate, peaks }, [samples.buffer, peaks.buffer]);
};
