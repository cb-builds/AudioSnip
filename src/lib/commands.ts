import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  AppMetadata,
  ApplicationSource,
  CaptureStatus,
  ChannelInfo,
  GeneralSettings,
  HotkeyAction,
  TrackEditParams,
} from "../types/audio";

export function listChannels() {
  return invoke<ChannelInfo[]>("list_channels");
}

/** Polls the global hotkey's capture lifecycle - see `useHotkeyListener`. */
export function getCaptureStatus() {
  return invoke<CaptureStatus>("get_capture_status");
}

export function startCapture(channelId: string) {
  return invoke<void>("start_capture", { channelId });
}

export function stopCapture(channelId: string) {
  return invoke<void>("stop_capture", { channelId });
}

/** Which channel ids the backend is already capturing - used on startup to sync the UI with devices resumed from persisted settings. */
export function getActiveChannels() {
  return invoke<string[]>("get_active_channels");
}

/** Triggers the same capture (and overwrite-confirmation) flow as the "Capture Snip" hotkey and the tray's "Snip" menu item. */
export function requestCapture() {
  return invoke<void>("request_capture");
}

/** Commits whatever capture the backend staged in `pending_capture` after a "conflict" status - call once the frontend's own confirmation modal is accepted. */
export function confirmCaptureOverwrite() {
  return invoke<void>("confirm_capture_overwrite");
}

/** Discards whatever capture the backend staged in `pending_capture` - call once the frontend's own confirmation modal is declined. */
export function discardPendingCapture() {
  return invoke<void>("discard_pending_capture");
}

/**
 * Rounds every millisecond-based field to a whole integer before it crosses
 * the Tauri IPC bridge. The Rust side deserializes these into `u32`s - a
 * fractional value (e.g. from a waveform drag handle's pixel-to-ms math, or
 * a `seconds * 1000` conversion landing on a floating-point value like
 * `4445.7894...`) would otherwise fail that deserialization and surface as
 * an export crash. `volume` is a gain multiplier, not a time value, so it's
 * left untouched.
 */
function sanitizeTrackTiming(params: TrackEditParams): TrackEditParams {
  return {
    ...params,
    trimStartMs: Math.round(params.trimStartMs),
    trimEndMs: Math.round(params.trimEndMs),
    fadeInMs: Math.round(params.fadeInMs),
    fadeOutMs: Math.round(params.fadeOutMs),
    scrubOffsetMs: Math.round(params.scrubOffsetMs),
  };
}

export function exportClip(tracks: TrackEditParams[]) {
  return invoke<string | null>("export_clip", { tracks: tracks.map(sanitizeTrackTiming) });
}

/** Returns the accelerator string currently bound to each hotkey action - empty means unbound. */
export function getHotkeys() {
  return invoke<Record<HotkeyAction, string>>("get_hotkeys");
}

export function updateHotkey(action: HotkeyAction, shortcut: string) {
  return invoke<void>("update_hotkey", { action, shortcut });
}

export function getBufferDuration() {
  return invoke<number>("get_buffer_duration");
}

export function setBufferDuration(seconds: number) {
  return invoke<void>("set_buffer_duration", { seconds });
}

export function flushBuffers() {
  return invoke<void>("flush_buffers");
}

export function getGeneralSettings() {
  return invoke<GeneralSettings>("get_general_settings");
}

export function setMinimizeToTray(enabled: boolean) {
  return invoke<void>("set_minimize_to_tray", { enabled });
}

export function setCloseToTray(enabled: boolean) {
  return invoke<void>("set_close_to_tray", { enabled });
}

/** Persists the "Run at Startup" preference - call alongside the autostart plugin's own `enable()`/`disable()`, which actually flips the OS-level registration. */
export function setRunAtStartup(enabled: boolean) {
  return invoke<void>("set_run_at_startup", { enabled });
}

/** Persists whether an autostart-triggered launch should keep the window hidden in the tray. */
export function setStartMinimized(enabled: boolean) {
  return invoke<void>("set_start_minimized", { enabled });
}

/** Per-device default volume (linear multiplier), applied when a new snapshot is captured for that channel. */
export function getDefaultVolumes() {
  return invoke<Record<string, number>>("get_default_volumes");
}

export function setDefaultVolume(channelId: string, volume: number) {
  return invoke<void>("set_default_volume", { channelId, volume });
}

/** Terminates the app entirely - backs the top bar menu's "Exit App" option. */
export function exitApp() {
  return invoke<void>("exit_app");
}

/** Currently running applications with at least one visible, titled window - backs the "Add Application Source" dialog's "Open apps" tab. */
export function getActiveApplications() {
  return invoke<AppInfo[]>("get_active_applications");
}

/** Every application registered in the Windows Uninstall registry - backs the "All apps" tab. Icons aren't populated eagerly; fetch per-row via `getExeMetadata`. */
export function getInstalledApplications() {
  return invoke<AppInfo[]>("get_installed_applications");
}

/** Resolves a friendly name and icon for an arbitrary executable path - used for the "Browse for a different app" flow and lazy per-row icon loading. */
export function getExeMetadata(path: string) {
  return invoke<AppMetadata>("get_exe_metadata", { path });
}

/** Adds (or updates) a persisted application source for the given executable path - it's then returned by `listChannels()` (`kind: "application"`) like any other channel. */
export function addApplicationSource(path: string) {
  return invoke<ApplicationSource>("add_application_source", { path });
}
