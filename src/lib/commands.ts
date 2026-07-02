import { invoke } from "@tauri-apps/api/core";
import type { CaptureStatus, ChannelInfo, TrackEditParams } from "../types/audio";

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

export function exportClip(tracks: TrackEditParams[]) {
  return invoke<string | null>("export_clip", { tracks });
}

export function getHotkey() {
  return invoke<string>("get_hotkey");
}

export function updateHotkey(shortcut: string) {
  return invoke<void>("update_hotkey", { shortcut });
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
