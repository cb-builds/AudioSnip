import { invoke } from "@tauri-apps/api/core";
import type {
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

export function exportClip(tracks: TrackEditParams[]) {
  return invoke<string | null>("export_clip", { tracks });
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
