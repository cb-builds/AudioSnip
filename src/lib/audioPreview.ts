let sharedContext: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedContext) {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

/**
 * Controls playback of a single track's processed audio.
 *
 * Web Audio's `AudioBufferSourceNode` can only ever be started once, so
 * "pause" is implemented by stopping the node and remembering how far it
 * got; "resume" creates a fresh node starting from that remembered offset.
 * `play(when)` accepts an explicit `AudioContext` time so multiple players
 * can be scheduled to start at the exact same instant if needed.
 *
 * Stopping (or reaching the end naturally) discards the loaded buffer, so
 * the next `play()` call reprocesses the track from its current edit
 * params; pausing keeps the buffer so resuming doesn't need to reprocess.
 */
export class TrackPlayer {
  private readonly context: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startContextTime = 0;
  private pausedAtSeconds = 0;
  private playing = false;
  private onEnded: (() => void) | null = null;

  constructor(context: AudioContext) {
    this.context = context;
  }

  load(samples: Float32Array, sampleRate: number) {
    this.stop();
    const buffer = this.context.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.copyToChannel(samples, 0);
    this.buffer = buffer;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Current playback position, in seconds; frozen while paused/stopped. */
  getPosition(): number {
    if (!this.playing) return this.pausedAtSeconds;
    const elapsed = this.context.currentTime - this.startContextTime;
    return Math.min(this.pausedAtSeconds + elapsed, this.duration);
  }

  setOnEnded(callback: (() => void) | null) {
    this.onEnded = callback;
  }

  /** Starts (or resumes) playback. `when` lets multiple players be scheduled in sync. */
  play(when?: number) {
    if (!this.buffer || this.playing) return;
    const startAt = when ?? this.context.currentTime;
    const bufferAtStart = this.buffer;

    const source = this.context.createBufferSource();
    source.buffer = bufferAtStart;
    source.connect(this.context.destination);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.playing = false;
      this.pausedAtSeconds = 0;
      this.buffer = null;
      this.onEnded?.();
    };

    source.start(startAt, this.pausedAtSeconds);
    this.source = source;
    this.startContextTime = startAt;
    this.playing = true;
  }

  /**
   * Repositions playback (used for scrubbing). Stops any currently-playing
   * source; the caller decides whether to resume with `play()`. Keeps the
   * loaded buffer, so no reprocessing is needed.
   */
  seekTo(offsetSeconds: number) {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // already stopped/never started - nothing to do
      }
      this.source = null;
    }
    this.pausedAtSeconds = Math.max(0, Math.min(offsetSeconds, this.duration));
    this.playing = false;
  }

  /** Pauses in place; the loaded buffer is kept so `play()` can resume without reprocessing. */
  pause() {
    if (!this.playing || !this.source) return;
    this.pausedAtSeconds = this.getPosition();
    this.source.onended = null;
    this.source.stop();
    this.source = null;
    this.playing = false;
  }

  /** Stops and resets to the start, discarding the loaded buffer. */
  stop() {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        // already stopped/never started - nothing to do
      }
      this.source = null;
    }
    this.playing = false;
    this.pausedAtSeconds = 0;
    this.buffer = null;
  }
}
