import { useEffect, useMemo, useRef, useState } from "react";
import { AccordionSection } from "./components/AccordionSection";
import { AudioOptionsPanel } from "./components/AudioOptionsPanel";
import { CollapsibleSidebar } from "./components/CollapsibleSidebar";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { PlaybackTimer } from "./components/PlaybackTimer";
import { ScrubControl } from "./components/ScrubControl";
import { SecondsField } from "./components/SecondsField";
import { Settings } from "./components/Settings";
import { TrackEditor } from "./components/TrackEditor";
import { VolumeFader } from "./components/VolumeFader";
import { Waveform } from "./components/Waveform";
import { useHotkeyListener } from "./hooks/useHotkeyListener";
import {
  applyEditParams,
  applyFade,
  applyFadeToPeaks,
  computeAmplifyVolume,
  computePeak,
  computePeakAmplitude,
  MASTER_MIX_SAMPLE_RATE,
  msToFrames,
  scalePeaks,
  VISUAL_PEAK_POINTS,
} from "./lib/audioMixMath";
import { getAudioContext, TrackPlayer } from "./lib/audioPreview";
import {
  exportClip,
  flushBuffers,
  listChannels,
  startCapture,
  stopCapture,
} from "./lib/commands";
import { GEAR_ICON, PAUSE_ICON, PLAY_ICON, STOP_ICON } from "./lib/icons";
import { requestMasterMix } from "./lib/mixerWorkerClient";
import type { MasterMixWithPeaks } from "./lib/mixerWorkerClient";
import { defaultEditParams } from "./types/audio";
import type { ChannelInfo, TrackEditParams, TrackSnapshot } from "./types/audio";

/** Pseudo channel id used to key the combined Master Mix into the same playback maps as individual tracks. */
const MASTER_TRACK_ID = "__master__";

const EMPTY_MASTER_MIX: MasterMixWithPeaks = {
  samples: new Float32Array(0),
  sampleRate: MASTER_MIX_SAMPLE_RATE,
  peaks: new Float32Array(VISUAL_PEAK_POINTS * 2),
};

const GRADIENT_BUTTON = "bg-gradient-to-br from-blue-600 to-violet-600 text-white";
const NEUTRAL_BUTTON = "bg-neutral-800 text-neutral-100";
const SIDEBAR_WIDTH = 190;
const TRIM_INFO_TEXT =
  "Drag the purple handles on the waveform, or type exact seconds below, to set where this clip starts and ends. Values are precise to 0.01s.";
const SCRUB_INFO_TEXT =
  "Nudge this source earlier or later to fix sync drift against the other tracks. Hold [-]/[+] to repeat, or type an exact offset in seconds.";

/** `trimEndMs === 0` means "trim nothing off the end", matching the convention used everywhere else in the app. */
function computeEffectiveTrimEndMs(totalDurationMs: number, trimEndMs: number): number {
  return trimEndMs === 0 ? totalDurationMs : Math.min(trimEndMs, totalDurationMs);
}

function App() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [snapshots, setSnapshots] = useState<Record<string, TrackSnapshot>>({});
  const [editParams, setEditParams] = useState<Record<string, TrackEditParams>>({});
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [trackExportStatus, setTrackExportStatus] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [masterVolume, setMasterVolume] = useState(1);
  const [masterFadeInMs, setMasterFadeInMs] = useState(0);
  const [masterFadeOutMs, setMasterFadeOutMs] = useState(0);
  const [masterTrimStartMs, setMasterTrimStartMs] = useState(0);
  const [masterTrimEndMs, setMasterTrimEndMs] = useState(0);
  const [activeTrackId, setActiveTrackId] = useState<string>(MASTER_TRACK_ID);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Per-source overrides for the Master Mix only - never affect the
  // individual track's own volume/playback.
  const [mutedTrackIds, setMutedTrackIds] = useState<Set<string>>(new Set());
  const [masterTrackVolumes, setMasterTrackVolumes] = useState<Record<string, number>>({});
  const [linkAudioLevels, setLinkAudioLevels] = useState(true);

  const [playingIds, setPlayingIds] = useState<Set<string>>(new Set());
  // Positions are absolute - seconds from the start of the full, untrimmed
  // clip - so they stay meaningful (and directly comparable to trim bounds)
  // no matter how trim is currently set.
  const [playbackPositions, setPlaybackPositions] = useState<Record<string, number>>({});
  const playersRef = useRef<Map<string, TrackPlayer>>(new Map());
  // Tracks which trim bounds are actually baked into each loaded player's
  // buffer, so a trim change can be detected as stale and reloaded instead
  // of silently continuing to play/show the old boundaries.
  const loadedTrimRef = useRef<Map<string, { startMs: number; endMs: number }>>(new Map());

  function selectTrack(id: string) {
    setActiveTrackId(id);
    setTrackExportStatus(null);
  }

  function getMasterTrackVolume(id: string): number {
    const linkedVolume = editParams[id]?.volume ?? 1;
    return linkAudioLevels ? linkedVolume : (masterTrackVolumes[id] ?? linkedVolume);
  }

  function setMasterTrackVolume(id: string, volume: number) {
    stopAllPlayback();
    if (linkAudioLevels) {
      updateTrackParams(id, { volume });
    } else {
      setMasterTrackVolumes((prev) => ({ ...prev, [id]: volume }));
    }
  }

  // Thin wrappers around the Master's raw `useState` setters so every
  // Master-level settings input (volume, fade, trim) also stops playback
  // before applying, matching individual tracks' `updateTrackParams`.
  function updateMasterVolume(volume: number) {
    stopAllPlayback();
    setMasterVolume(volume);
  }

  function updateMasterFadeIn(ms: number) {
    stopAllPlayback();
    setMasterFadeInMs(ms);
  }

  function updateMasterFadeOut(ms: number) {
    stopAllPlayback();
    setMasterFadeOutMs(ms);
  }

  function updateMasterTrimStart(ms: number) {
    stopAllPlayback();
    setMasterTrimStartMs(ms);
  }

  function updateMasterTrimEnd(ms: number) {
    stopAllPlayback();
    setMasterTrimEndMs(ms);
  }

  function toggleMuteTrack(id: string) {
    setMutedTrackIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Unlinking should start from parity (whatever's currently shown while
  // linked), not resurrect a stale override from a previous unlink.
  function handleLinkToggle(linked: boolean) {
    setLinkAudioLevels(linked);
    if (!linked) {
      setMasterTrackVolumes(
        Object.fromEntries(Array.from(activeIds).map((id) => [id, editParams[id]?.volume ?? 1])),
      );
    }
  }

  /** The trim bounds (in ms, on the untrimmed timeline) currently in effect for a track. */
  function getTrimBounds(channelId: string): { startMs: number; endMs: number } {
    if (channelId === MASTER_TRACK_ID) {
      return { startMs: masterTrimStartMs, endMs: masterTrimEndMs };
    }
    const params = editParams[channelId] ?? defaultEditParams(channelId);
    return { startMs: params.trimStartMs, endMs: params.trimEndMs };
  }

  // Mirrors the latest `getTrimBounds` into a ref so the long-lived rAF loop
  // below can always read fresh trim bounds without needing to tear down
  // and restart itself on every trim edit.
  const getTrimBoundsRef = useRef(getTrimBounds);
  getTrimBoundsRef.current = getTrimBounds;

  // The heavy downmix/resample/sum work happens off the main thread in
  // mixer.worker.ts, so typing, dragging, and clicking anywhere else in the
  // UI never blocks on it. `isRegeneratingMaster` is true from the moment a
  // request is sent until its response (or a newer request's response,
  // whichever comes last) arrives.
  const [masterMixBase, setMasterMixBase] = useState<MasterMixWithPeaks>(EMPTY_MASTER_MIX);
  const [isRegeneratingMaster, setIsRegeneratingMaster] = useState(false);
  const latestMasterRequestId = useRef(0);

  useEffect(() => {
    const tracks = Array.from(activeIds)
      .filter((id) => !mutedTrackIds.has(id))
      .map((id) => {
        const snapshot = snapshots[id];
        if (!snapshot) return null;
        const baseParams = editParams[id] ?? defaultEditParams(id);
        const volume = getMasterTrackVolume(id);
        return { snapshot, params: { ...baseParams, volume } };
      })
      .filter((track): track is { snapshot: TrackSnapshot; params: TrackEditParams } => track !== null);

    setIsRegeneratingMaster(true);
    const { requestId, result } = requestMasterMix(tracks);
    latestMasterRequestId.current = requestId;

    result.then((mix) => {
      // A newer request superseded this one while it was in flight - drop
      // this stale result rather than momentarily flashing outdated audio.
      if (latestMasterRequestId.current !== requestId) return;
      setMasterMixBase(mix);
      setIsRegeneratingMaster(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIds, snapshots, editParams, mutedTrackIds, masterTrackVolumes, linkAudioLevels]);

  // Master fade in/out and master volume are preview/playback-only shaping
  // on top of the mixed tracks (like a mixing console's master bus) - they
  // aren't sent to the Rust export pipeline, which still mixes down from
  // each track's own params. Peaks are cheaply re-derived from the
  // already-downsampled worker output instead of ever rescanning the full
  // (potentially huge) sample buffer on the main thread. Master trim is
  // display/playback-only too (the waveform dims the trimmed-out region and
  // the player is loaded with only the trimmed slice) - it does not slice
  // `samples`/`peaks` here, matching how individual tracks dim rather than
  // cut their full-resolution peaks. Fade in/out is anchored to the current
  // trim window (`masterTrimStartMs`/`masterTrimEndMs`) so it ramps
  // relative to the Start/End boundaries rather than the raw mix's edges.
  const masterMix = useMemo(() => {
    let samples = masterMixBase.samples;
    let peaks = masterMixBase.peaks;

    if (masterFadeInMs > 0 || masterFadeOutMs > 0) {
      samples = applyFade(
        samples,
        masterFadeInMs,
        masterFadeOutMs,
        masterMixBase.sampleRate,
        masterTrimStartMs,
        masterTrimEndMs,
      );
      const totalDurationMs = (samples.length / masterMixBase.sampleRate) * 1000;
      peaks = applyFadeToPeaks(
        peaks,
        masterFadeInMs,
        masterFadeOutMs,
        totalDurationMs,
        masterTrimStartMs,
        masterTrimEndMs,
      );
    }

    if (masterVolume !== 1) {
      const scaledSamples = new Float32Array(samples.length);
      for (let i = 0; i < scaledSamples.length; i++) {
        scaledSamples[i] = samples[i] * masterVolume;
      }
      samples = scaledSamples;
      peaks = scalePeaks(peaks, masterVolume);
    }

    return { samples, sampleRate: masterMixBase.sampleRate, peaks };
  }, [masterMixBase, masterVolume, masterFadeInMs, masterFadeOutMs, masterTrimStartMs, masterTrimEndMs]);

  useEffect(() => {
    listChannels().then(setChannels);
  }, []);

  const {
    isCapturing: isCapturingClip,
    diagnosticLogs,
    forceCancel: forceCancelCapture,
  } = useHotkeyListener((snapshot: TrackSnapshot[]) => {
    const byChannel: Record<string, TrackSnapshot> = {};
    for (const track of snapshot) {
      byChannel[track.channelId] = track;
    }
    setSnapshots(byChannel);
    resetSessionAdjustments();
  });

  // Mirrored into refs (rather than listed as effect dependencies) so the
  // one-time global keydown listener below never has to tear down and
  // re-attach itself on every render, while still always acting on the
  // latest active track / toggle behavior.
  const activeTrackIdRef = useRef(activeTrackId);
  activeTrackIdRef.current = activeTrackId;
  const handleTogglePlayTrackRef = useRef(handleTogglePlayTrack);
  handleTogglePlayTrackRef.current = handleTogglePlayTrack;

  // Global Spacebar play/pause, bypassed whenever an input/slider/textbox
  // (or anything content-editable) currently has focus, so it never steals
  // the key from someone who's typing a value.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.code !== "Space") return;

      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.tagName === "SELECT" ||
          active.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      handleTogglePlayTrackRef.current(activeTrackIdRef.current);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Drives every playhead (master and individual): while any track is
  // playing, sample every playing track's position each frame and merge it
  // into `playbackPositions` (paused tracks' frozen positions are left
  // untouched). Positions are stored absolute (trim start + player offset)
  // via `getTrimBoundsRef` so they stay correct even if trim changes mid-playback.
  useEffect(() => {
    if (playingIds.size === 0) return;

    let rafId: number;
    function tick() {
      setPlaybackPositions((prev) => {
        const next = { ...prev };
        for (const id of playingIds) {
          const bounds = getTrimBoundsRef.current(id);
          next[id] = bounds.startMs / 1000 + (playersRef.current.get(id)?.getPosition() ?? 0);
        }
        return next;
      });
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playingIds]);

  function getPlayer(channelId: string): TrackPlayer {
    let player = playersRef.current.get(channelId);
    if (!player) {
      player = new TrackPlayer(getAudioContext());
      player.setOnEnded(() => {
        setPlayingIds((prev) => {
          const next = new Set(prev);
          next.delete(channelId);
          return next;
        });
        setPlaybackPositions((prev) => {
          const next = { ...prev };
          delete next[channelId];
          return next;
        });
      });
      playersRef.current.set(channelId, player);
    }
    return player;
  }

  function hasPlayableContent(channelId: string): boolean {
    if (channelId === MASTER_TRACK_ID) return masterMix.samples.length > 0;
    return Boolean(snapshots[channelId]);
  }

  /**
   * Loads (or reloads) `player`'s buffer if it's missing or stale relative
   * to the current trim bounds. Reloading preserves continuity: the prior
   * absolute position is remapped into the new trim's coordinate space
   * (clamped to the new bounds) and, if the track was playing, playback
   * resumes immediately from there - so trim edits apply live, without
   * requiring the user to hit Stop first.
   */
  function loadIfNeeded(channelId: string, player: TrackPlayer) {
    const bounds = getTrimBounds(channelId);
    const loaded = loadedTrimRef.current.get(channelId);
    const isStale =
      player.duration === 0 || !loaded || loaded.startMs !== bounds.startMs || loaded.endMs !== bounds.endMs;
    if (!isStale) return;

    const wasPlaying = player.isPlaying;
    const priorAbsoluteSeconds = playbackPositions[channelId] ?? bounds.startMs / 1000;

    if (channelId === MASTER_TRACK_ID) {
      if (masterMix.samples.length === 0) return;
      const totalFrames = masterMix.samples.length;
      const startFrame = Math.min(msToFrames(bounds.startMs, masterMix.sampleRate), totalFrames);
      const endFrame =
        bounds.endMs === 0
          ? totalFrames
          : Math.min(msToFrames(bounds.endMs, masterMix.sampleRate), totalFrames);
      const trimmed = masterMix.samples.slice(startFrame, Math.max(startFrame, endFrame));
      player.load(trimmed, masterMix.sampleRate);
    } else {
      const snapshot = snapshots[channelId];
      if (!snapshot) return;
      const params = editParams[channelId] ?? defaultEditParams(channelId);
      player.load(applyEditParams(snapshot, params), snapshot.sampleRate);
    }

    loadedTrimRef.current.set(channelId, bounds);

    const relativeSeconds = Math.max(0, Math.min(priorAbsoluteSeconds - bounds.startMs / 1000, player.duration));
    player.seekTo(relativeSeconds);
    if (wasPlaying) player.play();

    setPlaybackPositions((prev) => ({ ...prev, [channelId]: bounds.startMs / 1000 + relativeSeconds }));
  }

  function stopEverythingLocally() {
    for (const player of playersRef.current.values()) {
      player.stop();
    }
    setPlayingIds(new Set());
    setPlaybackPositions({});
  }

  /**
   * Fully stops whatever is currently playing (Master and/or any individual
   * track). Called at the start of every settings-adjustment handler
   * (scrub, volume/dB, trim, fade) so a live edit never fights an
   * already-playing buffer. This used to pause in place (preserving
   * position for a quick resume), but an edit can change the buffer's
   * content/length enough that resuming mid-clip felt disjointed - a full
   * stop resets to a clean, unambiguous state instead, requiring an
   * explicit Play to hear the updated result.
   */
  function stopAllPlayback() {
    if (playingIds.size === 0) return;
    const ids = Array.from(playingIds);
    for (const id of ids) {
      playersRef.current.get(id)?.stop();
    }
    setPlaybackPositions((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        delete next[id];
      }
      return next;
    });
    setPlayingIds(new Set());
  }

  /**
   * Enforces a strict single-active-playback rule: stops every other
   * currently playing stream before a new one starts, so the Master Mix and
   * an individual track (or two individual tracks) can never play at the
   * same time and phase/double up against each other.
   */
  function stopOtherPlayback(exceptChannelId: string) {
    const others = Array.from(playingIds).filter((id) => id !== exceptChannelId);
    if (others.length === 0) return;
    for (const id of others) {
      playersRef.current.get(id)?.stop();
    }
    setPlaybackPositions((prev) => {
      const next = { ...prev };
      for (const id of others) {
        delete next[id];
      }
      return next;
    });
    setPlayingIds((prev) => {
      const next = new Set(prev);
      for (const id of others) {
        next.delete(id);
      }
      return next;
    });
  }

  /**
   * Clears every session adjustment (scrub, fade, trim, volume/amplify -
   * both per-track and Master-level) back to its default, and stops
   * playback so nothing keeps playing against params that no longer match
   * what's displayed. Run whenever a new clip is captured or an export
   * completes successfully, so each take starts from a clean baseline.
   */
  function resetSessionAdjustments() {
    stopEverythingLocally();
    setEditParams({});
    setMasterVolume(1);
    setMasterFadeInMs(0);
    setMasterFadeOutMs(0);
    setMasterTrimStartMs(0);
    setMasterTrimEndMs(0);
    setMasterTrackVolumes({});
    setMutedTrackIds(new Set());
  }

  function toggleChannel(id: string) {
    // Changing the device selection invalidates every captured buffer -
    // flush everything (frontend and backend) so stale audio never blends
    // with the new selection.
    stopEverythingLocally();
    setSnapshots({});
    flushBuffers().catch(console.error);

    setActiveIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        stopCapture(id).catch(console.error);
        setMutedTrackIds((prevMuted) => {
          const nextMuted = new Set(prevMuted);
          nextMuted.delete(id);
          return nextMuted;
        });
        setMasterTrackVolumes((prevVolumes) => {
          const { [id]: _removed, ...rest } = prevVolumes;
          return rest;
        });
        setActiveTrackId((prevSelected) => (prevSelected === id ? MASTER_TRACK_ID : prevSelected));
      } else {
        next.add(id);
        startCapture(id).catch(console.error);
        setEditParams((prevParams) => ({
          ...prevParams,
          [id]: prevParams[id] ?? defaultEditParams(id),
        }));
      }
      return next;
    });
  }

  function updateTrackParams(id: string, patch: Partial<TrackEditParams>) {
    stopAllPlayback();
    setEditParams((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? defaultEditParams(id)), ...patch },
    }));
  }

  /** Adds `deltaMs` to the track's current scrub offset via a functional update, so rapid repeated calls (hold-to-repeat) never race or use a stale value. */
  function shiftTrackOffset(id: string, deltaMs: number) {
    stopAllPlayback();
    setEditParams((prev) => {
      const current = prev[id] ?? defaultEditParams(id);
      return { ...prev, [id]: { ...current, scrubOffsetMs: current.scrubOffsetMs + deltaMs } };
    });
  }

  function handleTogglePlayTrack(channelId: string) {
    const player = getPlayer(channelId);

    if (playingIds.has(channelId)) {
      player.pause();
      const bounds = getTrimBounds(channelId);
      const frozenAbsolute = bounds.startMs / 1000 + player.getPosition();
      setPlayingIds((prev) => {
        const next = new Set(prev);
        next.delete(channelId);
        return next;
      });
      setPlaybackPositions((prev) => ({ ...prev, [channelId]: frozenAbsolute }));
      return;
    }

    if (!hasPlayableContent(channelId)) return;
    stopOtherPlayback(channelId);
    loadIfNeeded(channelId, player);
    player.play();
    setPlayingIds((prev) => new Set(prev).add(channelId));
  }

  function handleStopTrack(channelId: string) {
    playersRef.current.get(channelId)?.stop();
    setPlayingIds((prev) => {
      const next = new Set(prev);
      next.delete(channelId);
      return next;
    });
    setPlaybackPositions((prev) => {
      const next = { ...prev };
      delete next[channelId];
      return next;
    });
  }

  /** Scrubs to `offsetSeconds` (within the trimmed clip) and starts playing immediately. */
  function handleScrubTrack(channelId: string, offsetSeconds: number) {
    const player = getPlayer(channelId);
    stopOtherPlayback(channelId);
    loadIfNeeded(channelId, player);
    player.seekTo(offsetSeconds);
    player.play();
    setPlayingIds((prev) => new Set(prev).add(channelId));
    const bounds = getTrimBounds(channelId);
    setPlaybackPositions((prev) => ({ ...prev, [channelId]: bounds.startMs / 1000 + offsetSeconds }));
  }

  /** Repositions the playhead to `absoluteSeconds` (relative to the full, untrimmed clip) without starting playback. */
  function handleSeekTrack(channelId: string, absoluteSeconds: number) {
    const player = getPlayer(channelId);
    loadIfNeeded(channelId, player);
    const bounds = getTrimBounds(channelId);
    const relativeSeconds = Math.max(0, absoluteSeconds - bounds.startMs / 1000);
    player.seekTo(relativeSeconds);
    setPlaybackPositions((prev) => ({ ...prev, [channelId]: absoluteSeconds }));
  }

  function handleAmplifyMaster() {
    updateMasterVolume(computeAmplifyVolume(computePeak(masterMixBase.samples)));
  }

  function handleAmplifyMasterTrack(id: string) {
    const snapshot = snapshots[id];
    if (!snapshot) return;
    const params = editParams[id] ?? defaultEditParams(id);
    const peak = computePeakAmplitude(snapshot, params);
    setMasterTrackVolume(id, computeAmplifyVolume(peak));
  }

  function handleAmplifyTrack(id: string) {
    const snapshot = snapshots[id];
    if (!snapshot) return;
    const params = editParams[id] ?? defaultEditParams(id);
    const peak = computePeakAmplitude(snapshot, params);
    updateTrackParams(id, { volume: computeAmplifyVolume(peak) });
  }

  async function handleExport() {
    const tracks = Array.from(activeIds).map((id) => editParams[id] ?? defaultEditParams(id));
    setExportStatus("Exporting...");
    try {
      const path = await exportClip(tracks);
      setExportStatus(path ? `Saved to ${path}` : "Export cancelled");
      if (path) resetSessionAdjustments();
    } catch (err) {
      console.error(err);
      setExportStatus(`Export failed: ${err}`);
    }
  }

  async function handleExportTrack(id: string) {
    const params = editParams[id] ?? defaultEditParams(id);
    setTrackExportStatus("Exporting...");
    try {
      const path = await exportClip([params]);
      setTrackExportStatus(path ? `Saved to ${path}` : "Export cancelled");
      if (path) resetSessionAdjustments();
    } catch (err) {
      console.error(err);
      setTrackExportStatus(`Export failed: ${err}`);
    }
  }

  const activeChannels = channels.filter((channel) => activeIds.has(channel.id));
  const activeChannel = activeChannels.find((channel) => channel.id === activeTrackId);

  const masterTotalDurationMs =
    masterMix.sampleRate > 0 ? (masterMix.samples.length / masterMix.sampleRate) * 1000 : 0;
  const masterEffectiveTrimEndMs = computeEffectiveTrimEndMs(masterTotalDurationMs, masterTrimEndMs);
  const masterMinSeconds = masterTrimStartMs / 1000;
  const masterMaxSeconds = masterEffectiveTrimEndMs / 1000;
  const masterDisplayPositionSeconds = Math.max(
    masterMinSeconds,
    Math.min(playbackPositions[MASTER_TRACK_ID] ?? masterMinSeconds, masterMaxSeconds),
  );

  const activeParams = activeChannel ? editParams[activeChannel.id] ?? defaultEditParams(activeChannel.id) : undefined;
  const activeSnapshot = activeChannel ? snapshots[activeChannel.id] : undefined;
  const activeTotalDurationMs =
    activeSnapshot && activeSnapshot.channels > 0 && activeSnapshot.sampleRate > 0
      ? (activeSnapshot.samples.length / activeSnapshot.channels / activeSnapshot.sampleRate) * 1000
      : 0;
  const activeEffectiveTrimEndMs = activeParams
    ? computeEffectiveTrimEndMs(activeTotalDurationMs, activeParams.trimEndMs)
    : 0;
  const activeMinSeconds = activeParams ? activeParams.trimStartMs / 1000 : 0;
  const activeMaxSeconds = activeEffectiveTrimEndMs / 1000;
  const activeDisplayPositionSeconds = activeParams
    ? Math.max(activeMinSeconds, Math.min(playbackPositions[activeTrackId] ?? activeMinSeconds, activeMaxSeconds))
    : 0;

  return (
    <main className="flex h-screen flex-col gap-4 bg-neutral-950 p-4 text-neutral-100">
      <div className="flex items-center justify-between">
        <h1 className="bg-gradient-to-br from-blue-500 to-violet-500 bg-clip-text text-lg font-semibold text-transparent">
          ShadowAudio
        </h1>
        <div className="flex items-center gap-3">
          {exportStatus && <span className="text-xs text-neutral-400">{exportStatus}</span>}
          <button
            type="button"
            onClick={handleExport}
            disabled={activeIds.size === 0}
            className={`rounded px-3 py-1 text-sm font-medium disabled:opacity-40 ${GRADIENT_BUTTON}`}
          >
            Export
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            title="Settings"
            className="flex h-8 w-8 items-center justify-center rounded border border-neutral-700 text-base text-neutral-200 hover:bg-neutral-800"
          >
            {GEAR_ICON}
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-2 overflow-hidden">
        {/* Left column: Source Directory - a static list of track names, collapsible. */}
        <CollapsibleSidebar
          label="Sources"
          collapsed={leftCollapsed}
          onToggleCollapse={() => setLeftCollapsed((v) => !v)}
          width={SIDEBAR_WIDTH}
          side="left"
        >
          <button
            type="button"
            onClick={() => selectTrack(MASTER_TRACK_ID)}
            className={`w-full truncate rounded px-2 py-1.5 text-left text-sm transition-colors ${
              activeTrackId === MASTER_TRACK_ID
                ? "bg-gradient-to-br from-blue-600 to-violet-600 text-white"
                : "text-neutral-300 hover:bg-neutral-800"
            }`}
          >
            Master Mix
          </button>
          {activeChannels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => selectTrack(channel.id)}
              className={`w-full truncate rounded px-2 py-1.5 text-left text-sm transition-colors ${
                activeTrackId === channel.id
                  ? "bg-gradient-to-br from-blue-600 to-violet-600 text-white"
                  : "text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {channel.name}
            </button>
          ))}
        </CollapsibleSidebar>

        {/* Center column: Timeline Console - every waveform, stacked vertically. */}
        <div
          style={{ scrollbarGutter: "stable" }}
          className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded border border-neutral-800 bg-neutral-950 p-3"
        >
          <div
            onClick={() => selectTrack(MASTER_TRACK_ID)}
            className={`flex cursor-pointer flex-col gap-2 rounded border p-3 transition-colors ${
              activeTrackId === MASTER_TRACK_ID
                ? "border-violet-500 bg-gradient-to-br from-blue-950/40 to-violet-950/40 ring-1 ring-violet-500"
                : "border-neutral-800 bg-neutral-900 hover:border-neutral-700"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="bg-gradient-to-br from-blue-400 to-violet-400 bg-clip-text text-sm font-semibold text-transparent">
                Master Mix
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTogglePlayTrack(MASTER_TRACK_ID);
                  }}
                  disabled={!hasPlayableContent(MASTER_TRACK_ID)}
                  title={playingIds.has(MASTER_TRACK_ID) ? "Pause" : "Play"}
                  className={`flex h-7 w-7 items-center justify-center rounded text-xs disabled:opacity-40 ${
                    playingIds.has(MASTER_TRACK_ID) ? GRADIENT_BUTTON : NEUTRAL_BUTTON
                  }`}
                >
                  {playingIds.has(MASTER_TRACK_ID) ? PAUSE_ICON : PLAY_ICON}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStopTrack(MASTER_TRACK_ID);
                  }}
                  disabled={!hasPlayableContent(MASTER_TRACK_ID)}
                  title="Stop"
                  className={`flex h-7 w-7 items-center justify-center rounded text-xs disabled:opacity-40 ${NEUTRAL_BUTTON}`}
                >
                  {STOP_ICON}
                </button>
              </div>
            </div>

            <div className="relative">
              <div className={isRegeneratingMaster ? "pointer-events-none opacity-30" : ""}>
                <Waveform
                  samples={masterMix.samples}
                  channels={1}
                  sampleRate={masterMix.sampleRate}
                  peaks={masterMix.peaks}
                  trimStartMs={masterTrimStartMs}
                  trimEndMs={masterTrimEndMs}
                  onTrimChange={(patch) => {
                    if (patch.trimStartMs !== undefined) updateMasterTrimStart(patch.trimStartMs);
                    if (patch.trimEndMs !== undefined) updateMasterTrimEnd(patch.trimEndMs);
                  }}
                  playbackPositionSeconds={masterDisplayPositionSeconds}
                  onScrub={(offset) => handleScrubTrack(MASTER_TRACK_ID, offset)}
                />
              </div>
              {isRegeneratingMaster && (
                <div className="absolute inset-0 flex items-center justify-center text-xs font-medium text-neutral-200">
                  Loading changes...
                </div>
              )}
            </div>
          </div>

          {activeChannels.map((channel) => {
            const params = editParams[channel.id] ?? defaultEditParams(channel.id);
            const snapshot = snapshots[channel.id];
            const totalDurationMs =
              snapshot && snapshot.channels > 0 && snapshot.sampleRate > 0
                ? (snapshot.samples.length / snapshot.channels / snapshot.sampleRate) * 1000
                : 0;
            const effectiveTrimEndMs = computeEffectiveTrimEndMs(totalDurationMs, params.trimEndMs);
            const minSeconds = params.trimStartMs / 1000;
            const displayPositionSeconds = Math.max(
              minSeconds,
              Math.min(playbackPositions[channel.id] ?? minSeconds, effectiveTrimEndMs / 1000),
            );

            return (
              <TrackEditor
                key={channel.id}
                channel={channel}
                snapshot={snapshot}
                params={params}
                onParamsChange={(patch) => updateTrackParams(channel.id, patch)}
                isPlaying={playingIds.has(channel.id)}
                positionSeconds={displayPositionSeconds}
                onPlayPause={() => handleTogglePlayTrack(channel.id)}
                onStop={() => handleStopTrack(channel.id)}
                onScrub={(offset) => handleScrubTrack(channel.id, offset)}
                isSelected={activeTrackId === channel.id}
                onSelect={() => selectTrack(channel.id)}
              />
            );
          })}

          {activeIds.size === 0 && (
            <span className="text-xs text-neutral-500">
              No audio sources selected - open Settings to choose devices.
            </span>
          )}
        </div>

        {/* Right column: Track Settings - defaults to (and always shows) the active track's options, collapsible. */}
        <CollapsibleSidebar
          label="Track Settings"
          collapsed={rightCollapsed}
          onToggleCollapse={() => setRightCollapsed((v) => !v)}
          width={SIDEBAR_WIDTH}
          side="right"
        >
          <span className="truncate text-xs font-medium text-neutral-300">
            {activeTrackId === MASTER_TRACK_ID ? "Master Mix" : activeChannel?.name}
          </span>

          {activeTrackId === MASTER_TRACK_ID ? (
            <>
              <PlaybackTimer
                positionSeconds={masterDisplayPositionSeconds}
                minSeconds={masterMinSeconds}
                maxSeconds={masterMaxSeconds}
                onSeek={(seconds) => handleSeekTrack(MASTER_TRACK_ID, seconds)}
              />

              <AudioOptionsPanel
                volume={masterVolume}
                onVolumeChange={updateMasterVolume}
                onAmplify={handleAmplifyMaster}
                fadeInMs={masterFadeInMs}
                onFadeInChange={updateMasterFadeIn}
                fadeOutMs={masterFadeOutMs}
                onFadeOutChange={updateMasterFadeOut}
                disabled={masterMixBase.samples.length === 0}
              />

              <AccordionSection label="Trim" infoText={TRIM_INFO_TEXT}>
                <div className="flex gap-2 pt-1">
                  <SecondsField label="Start" valueMs={masterTrimStartMs} onChange={updateMasterTrimStart} />
                  <SecondsField label="End" valueMs={masterTrimEndMs} onChange={updateMasterTrimEnd} />
                </div>
              </AccordionSection>

              <AccordionSection label="Source Volume Levels">
                <div className="flex flex-col gap-3 pt-1">
                  {activeChannels.length === 0 && (
                    <span className="text-xs text-neutral-500">No active tracks.</span>
                  )}

                  {activeChannels.map((channel) => (
                    <div
                      key={channel.id}
                      className="flex flex-col gap-1 border-b border-neutral-800/60 pb-2 last:border-b-0 last:pb-0"
                    >
                      <span className="truncate text-xs text-neutral-300">{channel.name}</span>
                      <VolumeFader
                        volume={getMasterTrackVolume(channel.id)}
                        onVolumeChange={(volume) => setMasterTrackVolume(channel.id, volume)}
                        onAmplify={() => handleAmplifyMasterTrack(channel.id)}
                        disabled={!snapshots[channel.id]}
                        leading={
                          <input
                            type="checkbox"
                            checked={!mutedTrackIds.has(channel.id)}
                            onChange={() => toggleMuteTrack(channel.id)}
                            title="Source enabled in Master Mix"
                          />
                        }
                      />
                    </div>
                  ))}

                  <label className="flex items-center gap-2 pt-1 text-xs text-neutral-300">
                    <input
                      type="checkbox"
                      checked={linkAudioLevels}
                      onChange={(e) => handleLinkToggle(e.target.checked)}
                    />
                    Link Audio Levels
                  </label>
                </div>
              </AccordionSection>

              <AccordionSection label="Scrub" infoText={SCRUB_INFO_TEXT}>
                <div className="flex flex-col gap-3 pt-1">
                  {activeChannels.length === 0 && (
                    <span className="text-xs text-neutral-500">No active tracks.</span>
                  )}

                  {activeChannels.map((channel) => (
                    <div key={channel.id} className="flex flex-col gap-1">
                      <span className="truncate text-xs text-neutral-300">{channel.name}</span>
                      <ScrubControl
                        offsetMs={editParams[channel.id]?.scrubOffsetMs ?? 0}
                        onShift={(deltaMs) => shiftTrackOffset(channel.id, deltaMs)}
                        onSetAbsolute={(ms) => updateTrackParams(channel.id, { scrubOffsetMs: ms })}
                      />
                    </div>
                  ))}
                </div>
              </AccordionSection>
            </>
          ) : (
            activeChannel &&
            activeParams && (
              <>
                <PlaybackTimer
                  positionSeconds={activeDisplayPositionSeconds}
                  minSeconds={activeMinSeconds}
                  maxSeconds={activeMaxSeconds}
                  onSeek={(seconds) => handleSeekTrack(activeChannel.id, seconds)}
                />

                <AudioOptionsPanel
                  volume={activeParams.volume}
                  onVolumeChange={(volume) => updateTrackParams(activeChannel.id, { volume })}
                  onAmplify={() => handleAmplifyTrack(activeChannel.id)}
                  fadeInMs={activeParams.fadeInMs}
                  onFadeInChange={(ms) => updateTrackParams(activeChannel.id, { fadeInMs: ms })}
                  fadeOutMs={activeParams.fadeOutMs}
                  onFadeOutChange={(ms) => updateTrackParams(activeChannel.id, { fadeOutMs: ms })}
                  disabled={!snapshots[activeChannel.id]}
                />

                <AccordionSection label="Trim" infoText={TRIM_INFO_TEXT}>
                  <div className="flex gap-2 pt-1">
                    <SecondsField
                      label="Start"
                      valueMs={activeParams.trimStartMs}
                      onChange={(ms) => updateTrackParams(activeChannel.id, { trimStartMs: ms })}
                    />
                    <SecondsField
                      label="End"
                      valueMs={activeParams.trimEndMs}
                      onChange={(ms) => updateTrackParams(activeChannel.id, { trimEndMs: ms })}
                    />
                  </div>
                </AccordionSection>

                <div className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
                  {trackExportStatus && (
                    <span className="text-xs text-neutral-400">{trackExportStatus}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleExportTrack(activeChannel.id)}
                    disabled={!snapshots[activeChannel.id]}
                    className={`rounded px-3 py-1 text-xs font-medium disabled:opacity-40 ${GRADIENT_BUTTON}`}
                  >
                    Export Track
                  </button>
                </div>
              </>
            )
          )}
        </CollapsibleSidebar>
      </div>

      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          channels={channels}
          activeIds={activeIds}
          onToggleChannel={toggleChannel}
        />
      )}

      {isCapturingClip && (
        <LoadingOverlay logs={diagnosticLogs} onForceCancel={forceCancelCapture} />
      )}
    </main>
  );
}

export default App;
