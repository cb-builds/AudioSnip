import { useEffect, useRef, useState } from "react";
import logoUrl from "./assets/logo.PNG";
import { AccordionSection } from "./components/AccordionSection";
import { AddApplicationDialog } from "./components/AddApplicationDialog";
import { AudioOptionsPanel } from "./components/AudioOptionsPanel";
import { ChannelList } from "./components/ChannelList";
import { CollapsibleSidebar } from "./components/CollapsibleSidebar";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { PlaybackTimer } from "./components/PlaybackTimer";
import { ScrubControl } from "./components/ScrubControl";
import { SecondsField } from "./components/SecondsField";
import { Settings } from "./components/Settings";
import { TrackEditor } from "./components/TrackEditor";
import { VolumeFader } from "./components/VolumeFader";
import { Waveform, WAVEFORM_ACTIVE_COLOR } from "./components/Waveform";
import type { OverlayLayer } from "./components/Waveform";
import { useHotkeyListener } from "./hooks/useHotkeyListener";
import { useTrackPeaksCache } from "./hooks/useTrackPeaksCache";
import {
  applyEditParams,
  applyMasterEnvelope,
  computeAmplifyVolume,
  computePeakAmplitude,
  computeTimelinePositions,
} from "./lib/audioMixMath";
import type { MasterEnvelopeParams } from "./lib/audioMixMath";
import { getAudioContext, TrackPlayer } from "./lib/audioPreview";
import {
  exitApp,
  exportClip,
  flushBuffers,
  getActiveChannels,
  getDefaultVolumes,
  listChannels,
  requestCapture,
  setDefaultVolume,
  startCapture,
  stopCapture,
} from "./lib/commands";
import { MENU_ICON, PAUSE_ICON, PLAY_ICON, STOP_ICON } from "./lib/icons";
import { defaultEditParams } from "./types/audio";
import type { ChannelInfo, TrackEditParams, TrackSnapshot } from "./types/audio";

/** Pseudo channel id used to key the combined Master Mix into the same playback maps as individual tracks. */
const MASTER_TRACK_ID = "__master__";

const GRADIENT_BUTTON = "bg-gradient-to-br from-blue-600 to-violet-600 text-white";
const NEUTRAL_BUTTON = "bg-neutral-800 text-neutral-100";
const SIDEBAR_WIDTH = 190;
const TRIM_INFO_TEXT =
  "Drag the purple handles on the waveform, or type exact seconds below, to set where this clip starts and ends. Values are precise to 0.01s.";
const SCRUB_INFO_TEXT =
  "Nudge this source earlier or later to fix sync drift against the other tracks. Hold [-]/[+] to repeat, or type an exact offset in seconds. Expanding this menu also enables diagnostic mode, displaying each source clip in a unique color on the Master waveform to assist with multi-track alignment - collapsing it unifies the view back into a single color.";

/**
 * Strict, ordered 6-color source palette - index 0 is always Blue, index 1
 * always Purple, and so on, wrapping back to index 0 past 6 sources. Used
 * both for the Master overlay's diagnostic waveform layers and the Scrub
 * panel's per-source text labels, so the two stay in sync.
 */
const SOURCE_COLOR_PALETTE = [
  "#3b82f6", // Index 0: Blue
  "#a855f7", // Index 1: Purple
  "#22c55e", // Index 2: Green
  "#ef4444", // Index 3: Red
  "#eab308", // Index 4: Yellow
  "#f97316", // Index 5: Orange
];

function sourceColorForIndex(index: number): string {
  return SOURCE_COLOR_PALETTE[index % SOURCE_COLOR_PALETTE.length];
}

/** Opacity for the Master overlay's per-source diagnostic waveform layers, shown while the Scrub panel is expanded. */
const DIAGNOSTIC_LAYER_ALPHA = 0.5;

/** `trimEndMs === 0` means "trim nothing off the end", matching the convention used everywhere else in the app. */
function computeEffectiveTrimEndMs(totalDurationMs: number, trimEndMs: number): number {
  return trimEndMs === 0 ? totalDurationMs : Math.min(trimEndMs, totalDurationMs);
}

interface TimelineTrack {
  channelId: string;
  snapshot: TrackSnapshot;
  params: TrackEditParams;
  /** This track's position on the shared Master timeline, in ms (see `computeTimelinePositions`). */
  offsetMs: number;
  /** This track's own trimmed duration, in ms. */
  durationMs: number;
}

function App() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set());
  const [snapshots, setSnapshots] = useState<Record<string, TrackSnapshot>>({});
  const [editParams, setEditParams] = useState<Record<string, TrackEditParams>>({});
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [trackExportStatus, setTrackExportStatus] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showAddAppDialog, setShowAddAppDialog] = useState(false);
  // True from the instant a capture (initial or confirmed-overwrite) is
  // accepted until its data has actually been applied - drives the center
  // panel's "Loading audio snip" text. Set/cleared around a deferred
  // macrotask (see `applyCapturedSnapshot`) so the browser gets a real
  // paint of the loading state before the peak-computation work runs.
  const [isLoadingSnip, setIsLoadingSnip] = useState(false);
  const [masterVolume, setMasterVolume] = useState(1);
  const [masterFadeInMs, setMasterFadeInMs] = useState(0);
  const [masterFadeOutMs, setMasterFadeOutMs] = useState(0);
  const [masterTrimStartMs, setMasterTrimStartMs] = useState(0);
  const [masterTrimEndMs, setMasterTrimEndMs] = useState(0);
  const [activeTrackId, setActiveTrackId] = useState<string>(MASTER_TRACK_ID);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // Drives the Master overlay's color mode: collapsed shows a uniform
  // theme color at full opacity, expanded switches to the per-source
  // diagnostic palette at reduced opacity so overlapping shapes stay legible.
  const [isScrubExpanded, setIsScrubExpanded] = useState(false);
  // Per-device default volume (linear multiplier, configured in Settings >
  // Audio Sources), applied to a channel's edit params the moment a new
  // snapshot is captured for it.
  const [defaultVolumes, setDefaultVolumes] = useState<Record<string, number>>({});

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
  // Which underlying per-channel players currently belong to Master's
  // playback group (an internal bookkeeping set, separate from
  // `playingIds` - which only ever holds `MASTER_TRACK_ID` or one solo
  // channel id - so an individual TrackEditor's own Play/Pause button never
  // shows "playing" just because its audio happens to be sounding as part
  // of Master).
  const masterGroupChannelIdsRef = useRef<Set<string>>(new Set());
  // Anchors Master's virtual playback clock to a real AudioContext instant,
  // so its position can be derived from elapsed wall-clock time instead of
  // any single underlying track's player - some tracks may not be playing
  // at every point along the shared timeline (they may not have started
  // yet, or may have already ended).
  const masterClockRef = useRef<{ contextTimeAtStart: number; absoluteMsAtStart: number } | null>(null);

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

  /** Updates a device's configured default volume (Settings > Audio Sources), persisting it to the backend so it survives a restart and applies to the next snip captured for that channel. */
  function updateDefaultVolume(channelId: string, volume: number) {
    setDefaultVolumes((prev) => ({ ...prev, [channelId]: volume }));
    setDefaultVolume(channelId, volume).catch(console.error);
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

  /**
   * Every active, unmuted track's position on the shared Master timeline -
   * pure positional arithmetic (see `computeTimelinePositions`), never any
   * audio processing, so this is cheap enough to recompute on every render
   * (including mid-drag while scrubbing) with no lag.
   */
  function getTimelineTracks(): TimelineTrack[] {
    const relevant: { channelId: string; snapshot: TrackSnapshot; params: TrackEditParams }[] = [];
    for (const id of activeIds) {
      if (mutedTrackIds.has(id)) continue;
      const snapshot = snapshots[id];
      if (!snapshot) continue;
      relevant.push({ channelId: id, snapshot, params: editParams[id] ?? defaultEditParams(id) });
    }

    const positions = computeTimelinePositions(
      relevant.map((t) => ({
        channelId: t.channelId,
        trimStartMs: t.params.trimStartMs,
        scrubOffsetMs: t.params.scrubOffsetMs,
      })),
    );

    return relevant.map((t) => {
      const totalDurationMs =
        t.snapshot.channels > 0 && t.snapshot.sampleRate > 0
          ? (t.snapshot.samples.length / t.snapshot.channels / t.snapshot.sampleRate) * 1000
          : 0;
      const effectiveEndMs = computeEffectiveTrimEndMs(totalDurationMs, t.params.trimEndMs);
      return {
        channelId: t.channelId,
        snapshot: t.snapshot,
        params: t.params,
        offsetMs: positions.get(t.channelId) ?? 0,
        durationMs: Math.max(0, effectiveEndMs - t.params.trimStartMs),
      };
    });
  }

  const timelineTracks = getTimelineTracks();
  const sharedTimelineDurationMs = timelineTracks.reduce(
    (max, track) => Math.max(max, track.offsetMs + track.durationMs),
    0,
  );
  const masterEffectiveTrimEndMs = computeEffectiveTrimEndMs(sharedTimelineDurationMs, masterTrimEndMs);
  // Mirrored for the rAF tick below, so it can detect "Master's playback
  // has reached its trim end" without needing to tear down/restart on
  // every trim edit.
  const masterEffectiveEndMsRef = useRef(masterEffectiveTrimEndMs);
  masterEffectiveEndMsRef.current = masterEffectiveTrimEndMs;
  const masterMinSeconds = masterTrimStartMs / 1000;
  const masterMaxSeconds = masterEffectiveTrimEndMs / 1000;
  const masterDisplayPositionSeconds = Math.max(
    masterMinSeconds,
    Math.min(playbackPositions[MASTER_TRACK_ID] ?? masterMinSeconds, masterMaxSeconds),
  );

  const activeChannels = channels.filter((channel) => activeIds.has(channel.id));
  const activeChannel = activeChannels.find((channel) => channel.id === activeTrackId);

  // Each active channel's own downsampled peaks, for the Master overlay -
  // memoized independently of scrubOffsetMs, so scrubbing never re-triggers
  // this (the overlay just redraws the same peaks at a new x-offset).
  const trackPeaks = useTrackPeaksCache(activeChannels, snapshots, (channelId) => {
    const params = editParams[channelId] ?? defaultEditParams(channelId);
    return { ...params, volume: getMasterTrackVolume(channelId) };
  });

  useEffect(() => {
    listChannels().then(setChannels);
    getDefaultVolumes().then(setDefaultVolumes).catch(console.error);
    // Devices resumed from persisted settings are already capturing on the
    // backend by the time the frontend mounts - sync the checkboxes so they
    // don't show as off while a resumed device is actually recording.
    getActiveChannels()
      .then((ids) => setActiveIds(new Set(ids)))
      .catch(console.error);
  }, []);

  /**
   * Applies a freshly captured (or confirmed-overwrite) snapshot - shared by
   * both the plain capture path and the overwrite-confirmation "Yes" path,
   * since both need identical behavior here.
   *
   * Split into two phases across a macrotask boundary rather than doing it
   * all in one synchronous pass:
   *   1. Immediately clear whatever's currently shown (old track data,
   *      playback) and flip on `isLoadingSnip` - React 18 batches these into
   *      a single render, so the browser gets one clean paint of the empty
   *      view + "Loading audio snip" text.
   *   2. Only after that paint (via `setTimeout(..., 0)`, which always
   *      yields to the event loop first) does the actual heavier work run -
   *      building the snapshot map and resetting/seeding edit params, which
   *      triggers `useTrackPeaksCache`'s peak computation for the new
   *      waveforms. Doing this in the same tick as step 1 would let React
   *      batch it into the *same* render as the "Loading" text, so the
   *      browser would never actually get to paint it before the
   *      computation work ran.
   */
  function applyCapturedSnapshot(snapshot: TrackSnapshot[]) {
    stopEverythingLocally();
    setSnapshots({});
    setIsLoadingSnip(true);

    setTimeout(() => {
      const byChannel: Record<string, TrackSnapshot> = {};
      for (const track of snapshot) {
        byChannel[track.channelId] = track;
      }
      resetSessionAdjustments();
      // Seed each newly-captured channel's volume from its configured
      // default (Settings > Audio Sources > per-device "Default Volume"),
      // rather than always starting a fresh snip at unity gain.
      setEditParams(
        Object.fromEntries(
          snapshot.map((track) => [
            track.channelId,
            defaultEditParams(track.channelId, defaultVolumes[track.channelId] ?? 1),
          ]),
        ),
      );
      setSnapshots(byChannel);
      setIsLoadingSnip(false);
    }, 0);
  }

  const {
    isCapturing: isCapturingClip,
    diagnosticLogs,
    forceCancel: forceCancelCapture,
    pendingOverwrite,
    confirmOverwrite,
    cancelOverwrite,
  } = useHotkeyListener(applyCapturedSnapshot);

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
  // untouched). Individual tracks derive position from their own player;
  // Master derives it from its own wall-clock anchor (see
  // `getMasterCurrentAbsoluteMs`) since no single player represents "all of
  // Master" anymore, and also checks whether playback has run past Master's
  // trim end, stopping the whole group if so (there's no single buffer
  // whose "ended" event would tell us that).
  useEffect(() => {
    if (playingIds.size === 0) return;

    let rafId: number;
    function tick() {
      let masterEndReached = false;

      setPlaybackPositions((prev) => {
        const next = { ...prev };
        for (const id of playingIds) {
          if (id === MASTER_TRACK_ID) {
            const currentAbsoluteMs = getMasterCurrentAbsoluteMs();
            next[id] = currentAbsoluteMs / 1000;
            if (currentAbsoluteMs >= masterEffectiveEndMsRef.current) {
              masterEndReached = true;
            }
          } else {
            const bounds = getTrimBoundsRef.current(id);
            next[id] = bounds.startMs / 1000 + (playersRef.current.get(id)?.getPosition() ?? 0);
          }
        }
        return next;
      });

      if (masterEndReached) {
        stopMasterGroup();
        setPlayingIds((prev) => {
          const next = new Set(prev);
          next.delete(MASTER_TRACK_ID);
          return next;
        });
      }

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
    if (channelId === MASTER_TRACK_ID) return timelineTracks.length > 0;
    return Boolean(snapshots[channelId]);
  }

  /**
   * Loads (or reloads) `player`'s buffer if it's missing or stale relative
   * to the current trim bounds. Reloading preserves continuity: the prior
   * absolute position is remapped into the new trim's coordinate space
   * (clamped to the new bounds) and, if the track was playing, playback
   * resumes immediately from there - so trim edits apply live, without
   * requiring the user to hit Stop first. Individual-track playback only -
   * Master's playback loads each contributing track's own player directly
   * (see `startMasterGroupFrom`), since there's no single "Master player."
   */
  function loadIfNeeded(channelId: string, player: TrackPlayer) {
    const bounds = getTrimBounds(channelId);
    const loaded = loadedTrimRef.current.get(channelId);
    const isStale =
      player.duration === 0 || !loaded || loaded.startMs !== bounds.startMs || loaded.endMs !== bounds.endMs;
    if (!isStale) return;

    const wasPlaying = player.isPlaying;
    const priorAbsoluteSeconds = playbackPositions[channelId] ?? bounds.startMs / 1000;

    const snapshot = snapshots[channelId];
    if (!snapshot) return;
    const params = editParams[channelId] ?? defaultEditParams(channelId);
    player.load(applyEditParams(snapshot, params), snapshot.sampleRate);

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
    masterGroupChannelIdsRef.current = new Set();
    masterClockRef.current = null;
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
      if (id === MASTER_TRACK_ID) {
        stopMasterGroup();
      } else {
        playersRef.current.get(id)?.stop();
      }
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
      if (id === MASTER_TRACK_ID) {
        stopMasterGroup();
      } else {
        playersRef.current.get(id)?.stop();
      }
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

  /** Where Master's virtual playback clock currently sits, in ms - derived from wall-clock time elapsed since `startMasterGroupFrom` was last called, not from any single underlying track's player. */
  function getMasterCurrentAbsoluteMs(): number {
    if (!masterClockRef.current) return masterTrimStartMs;
    const { contextTimeAtStart, absoluteMsAtStart } = masterClockRef.current;
    const elapsedMs = (getAudioContext().currentTime - contextTimeAtStart) * 1000;
    return absoluteMsAtStart + elapsedMs;
  }

  /** Stops every underlying player currently part of Master's playback group, without touching anything playing solo. */
  function stopMasterGroup() {
    for (const channelId of masterGroupChannelIdsRef.current) {
      playersRef.current.get(channelId)?.stop();
    }
    masterGroupChannelIdsRef.current = new Set();
    masterClockRef.current = null;
  }

  /**
   * Starts (or restarts) Master's group playback from `startAbsoluteMs` -
   * schedules every active, unmuted track's own `AudioBufferSourceNode` to
   * begin at the exact same `AudioContext` instant, each already shaped by
   * Master's trim/fade/volume envelope (`applyMasterEnvelope`) and seeked
   * to wherever within its own slice `startAbsoluteMs` falls. This is the
   * "actual audio blending only happens during real-time playback" step -
   * every track sums acoustically through the shared `AudioContext`
   * destination; nothing is ever downmixed into one buffer.
   */
  function startMasterGroupFrom(startAbsoluteMs: number) {
    const tracks = getTimelineTracks();
    if (tracks.length === 0) return;

    const sharedDurationMs = tracks.reduce((max, t) => Math.max(max, t.offsetMs + t.durationMs), 0);
    const envelope: MasterEnvelopeParams = {
      masterVolume,
      masterFadeInMs,
      masterFadeOutMs,
      masterTrimStartMs,
      masterTrimEndMs: computeEffectiveTrimEndMs(sharedDurationMs, masterTrimEndMs),
    };

    const contextTime = getAudioContext().currentTime;
    const activeGroup = new Set<string>();

    for (const track of tracks) {
      const processed = applyEditParams(track.snapshot, {
        ...track.params,
        volume: getMasterTrackVolume(track.channelId),
      });
      const { samples, startAbsoluteMs: sliceStartMs } = applyMasterEnvelope(
        processed,
        track.snapshot.sampleRate,
        track.offsetMs,
        envelope,
      );
      if (samples.length === 0) continue;

      const player = getPlayer(track.channelId);
      player.load(samples, track.snapshot.sampleRate);
      // This buffer is Master-shaped (sliced/faded to Master's window), not
      // this channel's own plain trim/fade - invalidate so a later solo
      // play correctly detects staleness and reloads its own version.
      loadedTrimRef.current.delete(track.channelId);

      const relativeStartSeconds = (startAbsoluteMs - sliceStartMs) / 1000;
      const seekSeconds = Math.max(0, relativeStartSeconds);
      if (seekSeconds >= player.duration) continue; // this track's slice already finished by the requested start point

      const scheduleDelaySeconds = Math.max(0, -relativeStartSeconds);
      player.seekTo(seekSeconds);
      player.play(contextTime + scheduleDelaySeconds);
      activeGroup.add(track.channelId);
    }

    masterGroupChannelIdsRef.current = activeGroup;
    masterClockRef.current = { contextTimeAtStart: contextTime, absoluteMsAtStart: startAbsoluteMs };
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
    if (channelId === MASTER_TRACK_ID) {
      if (playingIds.has(MASTER_TRACK_ID)) {
        const currentAbsoluteMs = getMasterCurrentAbsoluteMs();
        stopMasterGroup();
        setPlayingIds((prev) => {
          const next = new Set(prev);
          next.delete(MASTER_TRACK_ID);
          return next;
        });
        setPlaybackPositions((prev) => ({ ...prev, [MASTER_TRACK_ID]: currentAbsoluteMs / 1000 }));
        return;
      }

      if (!hasPlayableContent(MASTER_TRACK_ID)) return;
      stopOtherPlayback(MASTER_TRACK_ID);
      const startAbsoluteMs = (playbackPositions[MASTER_TRACK_ID] ?? masterMinSeconds) * 1000;
      startMasterGroupFrom(startAbsoluteMs);
      setPlayingIds((prev) => new Set(prev).add(MASTER_TRACK_ID));
      return;
    }

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
    if (channelId === MASTER_TRACK_ID) {
      stopMasterGroup();
      setPlayingIds((prev) => {
        const next = new Set(prev);
        next.delete(MASTER_TRACK_ID);
        return next;
      });
      setPlaybackPositions((prev) => {
        const next = { ...prev };
        delete next[MASTER_TRACK_ID];
        return next;
      });
      return;
    }

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
    if (channelId === MASTER_TRACK_ID) {
      stopOtherPlayback(MASTER_TRACK_ID);
      stopMasterGroup();
      const startAbsoluteMs = masterTrimStartMs + offsetSeconds * 1000;
      startMasterGroupFrom(startAbsoluteMs);
      setPlayingIds((prev) => new Set(prev).add(MASTER_TRACK_ID));
      setPlaybackPositions((prev) => ({ ...prev, [MASTER_TRACK_ID]: startAbsoluteMs / 1000 }));
      return;
    }

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
    if (channelId === MASTER_TRACK_ID) {
      if (playingIds.has(MASTER_TRACK_ID)) {
        stopMasterGroup();
        startMasterGroupFrom(absoluteSeconds * 1000);
      }
      setPlaybackPositions((prev) => ({ ...prev, [MASTER_TRACK_ID]: absoluteSeconds }));
      return;
    }

    const player = getPlayer(channelId);
    loadIfNeeded(channelId, player);
    const bounds = getTrimBounds(channelId);
    const relativeSeconds = Math.max(0, absoluteSeconds - bounds.startMs / 1000);
    player.seekTo(relativeSeconds);
    setPlaybackPositions((prev) => ({ ...prev, [channelId]: absoluteSeconds }));
  }

  /**
   * Amplify Master needs the *mixed* signal's true peak to solve for a safe
   * gain - but actually downmixing just for this button would reintroduce
   * the background mixdown this whole refactor removes. Instead this uses a
   * conservative (safe, if occasionally too cautious) upper-bound estimate:
   * the sum of every track's own individual peak, i.e. what the mix would
   * hit if every track's loudest moment happened to land at the same
   * instant. This is a one-off calculation that only runs when the button
   * is clicked, not a reactive/background one.
   */
  function handleAmplifyMaster() {
    if (timelineTracks.length === 0) return;
    const worstCasePeak = timelineTracks.reduce((sum, track) => {
      const peak = computePeakAmplitude(track.snapshot, track.params);
      return sum + peak * getMasterTrackVolume(track.channelId);
    }, 0);
    updateMasterVolume(computeAmplifyVolume(worstCasePeak));
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

  /** Triggers the same capture (and confirmation-modal-driven overwrite check, if a clip is already loaded) as the "Capture Snip" hotkey and the tray's "Snip" menu item - the actual capture result arrives via `useHotkeyListener`'s poll loop. */
  async function handleCaptureSnip() {
    try {
      await requestCapture();
    } catch (err) {
      console.error(err);
    }
  }

  /** Wipes the buffer and clears the frontend's own session state - called only after the custom "Are you sure?" confirmation modal is accepted. */
  async function performResetBuffer() {
    setShowResetConfirm(false);
    try {
      await flushBuffers();
      resetSessionAdjustments();
      setSnapshots({});
    } catch (err) {
      console.error(err);
    }
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

  // Strict, ordered palette index per source - matches the order sources
  // appear in the Sources sidebar / Scrub list, so a track's overlay color
  // and its Scrub label color are always the same index.
  const sourceIndexByChannelId = new Map(activeChannels.map((channel, index) => [channel.id, index]));

  // Every active track's own waveform, layered on top of each other in the
  // Master overlay instead of a single pre-mixed buffer - scrubbing only
  // ever changes a layer's `offsetMs` here, never the peaks themselves.
  // Collapsing the Scrub panel switches every layer to a single uniform
  // theme color at full opacity; expanding it switches to the per-source
  // diagnostic palette at reduced opacity so overlapping shapes stay legible.
  const overlayLayers: OverlayLayer[] = timelineTracks
    .map((track) => ({
      channelId: track.channelId,
      peaks: trackPeaks[track.channelId],
      color: isScrubExpanded
        ? sourceColorForIndex(sourceIndexByChannelId.get(track.channelId) ?? 0)
        : WAVEFORM_ACTIVE_COLOR,
      alpha: isScrubExpanded ? DIAGNOSTIC_LAYER_ALPHA : 1,
      offsetMs: track.offsetMs,
      durationMs: track.durationMs,
    }))
    .filter((layer): layer is OverlayLayer => Boolean(layer.peaks));

  return (
    <main className="flex h-screen flex-col gap-4 bg-neutral-950 p-4 text-neutral-100">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src={logoUrl} alt="AudioSnip logo" className="h-5 w-auto object-contain" />
          <h1 className="bg-gradient-to-br from-blue-500 to-violet-500 bg-clip-text text-lg font-semibold text-transparent">
            AudioSnip
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {exportStatus && <span className="text-xs text-neutral-400">{exportStatus}</span>}
          <button
            type="button"
            onClick={handleCaptureSnip}
            disabled={activeIds.size === 0 || isCapturingClip}
            className={`rounded px-3 py-1 text-sm font-medium disabled:opacity-40 ${GRADIENT_BUTTON}`}
          >
            Capture Snip
          </button>
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            disabled={Object.keys(snapshots).length === 0}
            className="rounded border border-neutral-700 bg-black px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={activeIds.size === 0}
            className={`rounded px-3 py-1 text-sm font-medium disabled:opacity-40 ${GRADIENT_BUTTON}`}
          >
            Export
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowMenu((v) => !v)}
              title="Menu"
              className="flex h-8 w-8 items-center justify-center rounded text-base text-neutral-200 hover:bg-neutral-800"
            >
              {MENU_ICON}
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded border border-neutral-800 bg-neutral-900 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setShowMenu(false);
                      setShowSettings(true);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
                  >
                    Settings
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowMenu(false);
                      exitApp().catch(console.error);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-neutral-800"
                  >
                    Exit App
                  </button>
                </div>
              </>
            )}
          </div>
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
          footer={
            <AccordionSection label="Toggle Audio Sources" bordered={false}>
              <div className="max-h-40 overflow-y-auto overflow-x-hidden pt-1">
                <ChannelList
                  channels={channels}
                  activeIds={activeIds}
                  onToggle={toggleChannel}
                  onAddApplicationSource={() => setShowAddAppDialog(true)}
                />
              </div>
            </AccordionSection>
          }
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
              className={`flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-sm transition-colors ${
                activeTrackId === channel.id
                  ? "bg-gradient-to-br from-blue-600 to-violet-600 text-white"
                  : "text-neutral-300 hover:bg-neutral-800"
              }`}
            >
              {channel.kind === "application" &&
                (channel.iconBase64 ? (
                  <img src={channel.iconBase64} alt="" className="h-4 w-4 shrink-0 object-contain" />
                ) : (
                  <span className="h-4 w-4 shrink-0 rounded bg-neutral-700" />
                ))}
              <span className="truncate">{channel.name}</span>
            </button>
          ))}
        </CollapsibleSidebar>

        {/* Center column: Timeline Console - every waveform, stacked vertically. Shows a single centered placeholder instead of any (empty) track containers until the first snip is captured. */}
        <div
          style={{ scrollbarGutter: "stable" }}
          className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded border border-neutral-800 bg-neutral-950 p-3"
        >
          {Object.keys(snapshots).length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <span className="text-2xl font-light text-neutral-500">
                {isLoadingSnip ? "Loading audio snip" : "Capture an audio snip to begin editing"}
              </span>
            </div>
          ) : (
            <>
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

                <Waveform
                  overlayLayers={overlayLayers}
                  overlayDurationMs={sharedTimelineDurationMs}
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
            </>
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
                disabled={!hasPlayableContent(MASTER_TRACK_ID)}
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

              <AccordionSection
                label="Scrub"
                infoText={SCRUB_INFO_TEXT}
                open={isScrubExpanded}
                onOpenChange={setIsScrubExpanded}
              >
                <div className="flex flex-col gap-3 pt-1">
                  {activeChannels.length === 0 && (
                    <span className="text-xs text-neutral-500">No active tracks.</span>
                  )}

                  {activeChannels.map((channel, index) => (
                    <div key={channel.id} className="flex flex-col gap-1">
                      <span
                        className="truncate text-xs font-medium"
                        style={{ color: sourceColorForIndex(index) }}
                      >
                        {channel.name}
                      </span>
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
          defaultVolumes={defaultVolumes}
          onDefaultVolumeChange={updateDefaultVolume}
        />
      )}

      {isCapturingClip && (
        <LoadingOverlay logs={diagnosticLogs} onForceCancel={forceCancelCapture} />
      )}

      {pendingOverwrite && (
        <ConfirmDialog
          message="Are you sure you want to overwrite the current audio?"
          onConfirm={confirmOverwrite}
          onCancel={cancelOverwrite}
        />
      )}

      {showResetConfirm && (
        <ConfirmDialog
          message="Are you sure?"
          onConfirm={performResetBuffer}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}

      {showAddAppDialog && (
        <AddApplicationDialog
          onClose={() => setShowAddAppDialog(false)}
          onAdd={(source) => {
            setChannels((prev) => [
              ...prev.filter((existing) => existing.id !== source.id),
              { id: source.id, name: source.name, kind: "application", iconBase64: source.iconBase64 },
            ]);
            // Capturing a specific application is the whole point of adding
            // it - toggle it on immediately rather than making the user
            // separately find it in the new "Applications" group and check
            // it themselves.
            toggleChannel(source.id);
          }}
        />
      )}
    </main>
  );
}

export default App;
