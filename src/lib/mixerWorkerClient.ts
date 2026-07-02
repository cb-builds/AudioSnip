import type { MasterMixResult } from "./audioMixMath";
import type { MixerWorkerRequest, MixerWorkerResponse } from "../workers/mixer.worker";
import type { TrackEditParams, TrackSnapshot } from "../types/audio";

export interface MasterMixWithPeaks extends MasterMixResult {
  peaks: Float32Array;
}

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, (result: MasterMixWithPeaks) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/mixer.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<MixerWorkerResponse>) => {
      const { requestId, samples, sampleRate, peaks } = event.data;
      const resolve = pending.get(requestId);
      pending.delete(requestId);
      resolve?.({ samples, sampleRate, peaks });
    };
  }
  return worker;
}

/**
 * Computes the Master Mix (audio + precomputed visual peaks) off the main
 * thread, so heavy per-drag recomputes never block the UI. Returns the
 * request's id (for the caller to detect and ignore stale/superseded
 * responses) alongside a promise for the result.
 */
export function requestMasterMix(
  tracks: { snapshot: TrackSnapshot; params: TrackEditParams }[],
): { requestId: number; result: Promise<MasterMixWithPeaks> } {
  const requestId = ++nextRequestId;
  const request: MixerWorkerRequest = { requestId, tracks };

  const result = new Promise<MasterMixWithPeaks>((resolve) => {
    pending.set(requestId, resolve);
    getWorker().postMessage(request);
  });

  return { requestId, result };
}
