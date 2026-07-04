import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { disable as disableAutostart, enable as enableAutostart } from "@tauri-apps/plugin-autostart";
import {
  getBufferDuration,
  getGeneralSettings,
  getHotkeys,
  resetSettingsToDefault,
  setBufferDuration,
  setCloseToTray,
  setMinimizeToTray,
  setRunAtStartup,
  setStartMinimized,
  updateHotkey,
} from "../lib/commands";
import { acceleratorFromKeyboardEvent } from "../lib/hotkeyRecorder";
import type { ChannelInfo, HotkeyAction } from "../types/audio";
import { AccordionSection } from "./AccordionSection";
import { AddAppSourcesButton } from "./AddAppSourcesButton";
import { ApplicationSourceGroup } from "./ApplicationSourceGroup";
import { CompactVolumeControl } from "./CompactVolumeControl";
import { ConfirmDialog } from "./ConfirmDialog";

interface SettingsProps {
  onClose: () => void;
  channels: ChannelInfo[];
  activeIds: Set<string>;
  onToggleChannel: (id: string) => void;
  defaultVolumes: Record<string, number>;
  onDefaultVolumeChange: (channelId: string, volume: number) => void;
  onAddApplicationSource: () => void;
  onRemoveApplicationSource: (id: string) => void;
}

const HOTKEY_ACTIONS: { id: HotkeyAction; label: string }[] = [
  { id: "captureSnip", label: "Capture Snip" },
  { id: "showApp", label: "Show App" },
  { id: "resetBuffer", label: "Reset Buffer" },
];

interface HotkeyRowProps {
  label: string;
  boundValue: string;
  pendingValue: string | undefined;
  isRecording: boolean;
  onStartRecording: () => void;
  onSave: () => void;
  onClear: () => void;
  saving: boolean;
  error?: string;
}

function HotkeyRow({
  label,
  boundValue,
  pendingValue,
  isRecording,
  onStartRecording,
  onSave,
  onClear,
  saving,
  error,
}: HotkeyRowProps) {
  const displayValue = pendingValue !== undefined ? pendingValue : boundValue;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-neutral-400">{label}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onStartRecording}
          className="flex-1 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-left text-sm text-neutral-100"
        >
          {isRecording ? "Press a key combination..." : displayValue || "Not set"}
        </button>
        {boundValue && pendingValue === undefined && (
          <button
            type="button"
            onClick={onClear}
            title="Clear"
            className="text-xs text-neutral-400 hover:text-neutral-100"
          >
            Clear
          </button>
        )}
      </div>
      {error && <span className="text-xs text-red-400">{error}</span>}
      {pendingValue !== undefined && (
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="self-start rounded bg-cyan-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      )}
    </div>
  );
}

interface DeviceGroupProps {
  label: string;
  devices: ChannelInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeIds: Set<string>;
  onToggleChannel: (id: string) => void;
  defaultVolumes: Record<string, number>;
  onDefaultVolumeChange: (channelId: string, volume: number) => void;
}

function DeviceGroup({
  label,
  devices,
  open,
  onOpenChange,
  activeIds,
  onToggleChannel,
  defaultVolumes,
  onDefaultVolumeChange,
}: DeviceGroupProps) {
  return (
    <AccordionSection label={label} open={open} onOpenChange={onOpenChange}>
      <div className="flex flex-col gap-3 pt-1">
        {devices.length === 0 && <span className="text-xs text-neutral-500">No devices found.</span>}

        {devices.length > 0 && (
          <div className="flex items-center gap-3">
            <span className="w-8 shrink-0 text-center text-[10px] uppercase tracking-wide text-neutral-500">
              Enable
            </span>
          </div>
        )}

        {devices.map((device) => (
          <div
            key={device.id}
            className="flex items-start gap-3 border-b border-neutral-800/60 pb-3 last:border-b-0 last:pb-0"
          >
            <div className="flex w-8 shrink-0 justify-center pt-1">
              <input
                type="checkbox"
                checked={activeIds.has(device.id)}
                onChange={() => onToggleChannel(device.id)}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-sm text-neutral-200">{device.name}</span>
              <span className="text-xs text-neutral-400">Default Volume</span>
              <CompactVolumeControl
                volume={defaultVolumes[device.id] ?? 1}
                onVolumeChange={(volume) => onDefaultVolumeChange(device.id, volume)}
              />
            </div>
          </div>
        ))}
      </div>
    </AccordionSection>
  );
}

export function Settings({
  onClose,
  channels,
  activeIds,
  onToggleChannel,
  defaultVolumes,
  onDefaultVolumeChange,
  onAddApplicationSource,
  onRemoveApplicationSource,
}: SettingsProps) {
  const [tab, setTab] = useState<"general" | "hotkeys" | "sources" | "about">("general");

  const [hotkeys, setHotkeys] = useState<Partial<Record<HotkeyAction, string>>>({});
  const [recordingAction, setRecordingAction] = useState<HotkeyAction | null>(null);
  const [pendingHotkeys, setPendingHotkeys] = useState<Partial<Record<HotkeyAction, string>>>({});
  const [hotkeyErrors, setHotkeyErrors] = useState<Partial<Record<HotkeyAction, string>>>({});
  const [savingAction, setSavingAction] = useState<HotkeyAction | null>(null);

  const [durationInput, setDurationInput] = useState("30");

  const [minimizeToTray, setMinimizeToTrayState] = useState(true);
  const [closeToTray, setCloseToTrayState] = useState(true);
  const [runAtStartup, setRunAtStartupState] = useState(true);
  const [startMinimized, setStartMinimizedState] = useState(true);

  const [inputsOpen, setInputsOpen] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [applicationsOpen, setApplicationsOpen] = useState(false);

  const [appVersion, setAppVersion] = useState("");
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  useEffect(() => {
    getHotkeys().then(setHotkeys).catch(console.error);
    getBufferDuration()
      .then((seconds) => setDurationInput(String(seconds)))
      .catch(console.error);
    getGeneralSettings()
      .then((settings) => {
        setMinimizeToTrayState(settings.minimizeToTray);
        setCloseToTrayState(settings.closeToTray);
        setRunAtStartupState(settings.runAtStartup);
        setStartMinimizedState(settings.startMinimized);
      })
      .catch(console.error);
    getVersion().then(setAppVersion).catch(console.error);
  }, []);

  useEffect(() => {
    if (!recordingAction) return;

    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      const accelerator = acceleratorFromKeyboardEvent(event);
      if (!accelerator || !recordingAction) return;
      setPendingHotkeys((prev) => ({ ...prev, [recordingAction]: accelerator }));
      setRecordingAction(null);
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recordingAction]);

  async function handleSaveHotkey(action: HotkeyAction) {
    const pending = pendingHotkeys[action];
    if (pending === undefined) return;
    setSavingAction(action);
    setHotkeyErrors((prev) => ({ ...prev, [action]: undefined }));
    try {
      await updateHotkey(action, pending);
      setHotkeys((prev) => ({ ...prev, [action]: pending }));
      setPendingHotkeys((prev) => {
        const next = { ...prev };
        delete next[action];
        return next;
      });
    } catch (err) {
      setHotkeyErrors((prev) => ({ ...prev, [action]: String(err) }));
    } finally {
      setSavingAction(null);
    }
  }

  function handleClearHotkey(action: HotkeyAction) {
    setPendingHotkeys((prev) => ({ ...prev, [action]: "" }));
  }

  /** Commits the buffer duration input if it's a valid whole number of seconds - silently keeps whatever was last saved otherwise, since there's no explicit Save button to surface an error against. */
  async function commitBufferDuration() {
    const seconds = Math.trunc(Number(durationInput));
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    try {
      await setBufferDuration(seconds);
    } catch (err) {
      console.error(err);
    }
  }

  /** Saves the buffer duration automatically, then closes - there's no separate Save button for it, so this is the only point it's committed. */
  async function handleClose() {
    await commitBufferDuration();
    onClose();
  }

  async function handleMinimizeToTrayChange(enabled: boolean) {
    setMinimizeToTrayState(enabled);
    try {
      await setMinimizeToTray(enabled);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleCloseToTrayChange(enabled: boolean) {
    setCloseToTrayState(enabled);
    try {
      await setCloseToTray(enabled);
    } catch (err) {
      console.error(err);
    }
  }

  /** Flips the actual OS-level autostart registration (via the plugin's own enable/disable) and persists the choice so it's re-applied on the next launch. */
  async function handleRunAtStartupChange(enabled: boolean) {
    setRunAtStartupState(enabled);
    try {
      await (enabled ? enableAutostart() : disableAutostart());
      await setRunAtStartup(enabled);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleStartMinimizedChange(enabled: boolean) {
    setStartMinimizedState(enabled);
    try {
      await setStartMinimized(enabled);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleResetToDefault() {
    setShowResetConfirm(false);
    try {
      await resetSettingsToDefault();
    } catch (err) {
      console.error(err);
    }
  }

  const inputs = channels.filter((channel) => channel.kind === "input");
  const outputs = channels.filter((channel) => channel.kind === "output");
  const applications = channels.filter((channel) => channel.kind === "application");

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60">
      <div className="flex max-h-[85vh] w-[30rem] flex-col gap-4 overflow-hidden rounded-lg bg-neutral-900 text-neutral-100">
        <div className="flex items-center justify-between p-4 pb-0">
          <h2 className="text-base font-semibold">Settings</h2>
          <button type="button" onClick={handleClose} className="text-neutral-400 hover:text-neutral-100">
            &times;
          </button>
        </div>

        <div className="flex gap-1 border-b border-neutral-800 px-4">
          <button
            type="button"
            onClick={() => setTab("general")}
            className={
              tab === "general"
                ? "border-b-2 border-violet-500 px-3 py-2 text-sm font-medium text-neutral-100"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200"
            }
          >
            General
          </button>
          <button
            type="button"
            onClick={() => setTab("hotkeys")}
            className={
              tab === "hotkeys"
                ? "border-b-2 border-violet-500 px-3 py-2 text-sm font-medium text-neutral-100"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200"
            }
          >
            Hotkeys
          </button>
          <button
            type="button"
            onClick={() => setTab("sources")}
            className={
              tab === "sources"
                ? "border-b-2 border-violet-500 px-3 py-2 text-sm font-medium text-neutral-100"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200"
            }
          >
            Audio Sources
          </button>
          <button
            type="button"
            onClick={() => setTab("about")}
            className={
              tab === "about"
                ? "border-b-2 border-violet-500 px-3 py-2 text-sm font-medium text-neutral-100"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200"
            }
          >
            About
          </button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
          {tab === "general" ? (
            <>
              <label className="flex items-center justify-between text-sm text-neutral-200">
                Minimize to tray
                <input
                  type="checkbox"
                  checked={minimizeToTray}
                  onChange={(e) => handleMinimizeToTrayChange(e.target.checked)}
                />
              </label>

              <label className="flex items-center justify-between text-sm text-neutral-200">
                Close to tray
                <input
                  type="checkbox"
                  checked={closeToTray}
                  onChange={(e) => handleCloseToTrayChange(e.target.checked)}
                />
              </label>

              <label className="flex items-center justify-between text-sm text-neutral-200">
                Run at Startup
                <input
                  type="checkbox"
                  checked={runAtStartup}
                  onChange={(e) => handleRunAtStartupChange(e.target.checked)}
                />
              </label>

              {runAtStartup && (
                <label className="flex items-center justify-between pl-4 text-sm text-neutral-200">
                  Start minimized to System tray
                  <input
                    type="checkbox"
                    checked={startMinimized}
                    onChange={(e) => handleStartMinimizedChange(e.target.checked)}
                  />
                </label>
              )}

              <div className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
                <span className="text-xs text-neutral-400">Buffer Duration</span>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={durationInput}
                    onChange={(e) => setDurationInput(e.target.value)}
                    onBlur={commitBufferDuration}
                    className="w-16 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                  />
                  <span className="text-xs text-neutral-400">seconds</span>
                </div>
              </div>
            </>
          ) : tab === "hotkeys" ? (
            <div className="flex flex-col gap-4">
              {HOTKEY_ACTIONS.map(({ id, label }) => (
                <HotkeyRow
                  key={id}
                  label={label}
                  boundValue={hotkeys[id] ?? ""}
                  pendingValue={pendingHotkeys[id]}
                  isRecording={recordingAction === id}
                  onStartRecording={() => {
                    setRecordingAction(id);
                    setPendingHotkeys((prev) => {
                      const next = { ...prev };
                      delete next[id];
                      return next;
                    });
                    setHotkeyErrors((prev) => ({ ...prev, [id]: undefined }));
                  }}
                  onSave={() => handleSaveHotkey(id)}
                  onClear={() => handleClearHotkey(id)}
                  saving={savingAction === id}
                  error={hotkeyErrors[id]}
                />
              ))}
            </div>
          ) : tab === "sources" ? (
            <>
              <DeviceGroup
                label="Inputs"
                devices={inputs}
                open={inputsOpen}
                onOpenChange={setInputsOpen}
                activeIds={activeIds}
                onToggleChannel={onToggleChannel}
                defaultVolumes={defaultVolumes}
                onDefaultVolumeChange={onDefaultVolumeChange}
              />
              <DeviceGroup
                label="Outputs"
                devices={outputs}
                open={outputsOpen}
                onOpenChange={setOutputsOpen}
                activeIds={activeIds}
                onToggleChannel={onToggleChannel}
                defaultVolumes={defaultVolumes}
                onDefaultVolumeChange={onDefaultVolumeChange}
              />
              <ApplicationSourceGroup
                applications={applications}
                activeIds={activeIds}
                onToggle={onToggleChannel}
                onRemove={onRemoveApplicationSource}
                open={applicationsOpen}
                onOpenChange={setApplicationsOpen}
              />
              <AddAppSourcesButton onClick={onAddApplicationSource} />
            </>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-neutral-400">Version</span>
                <span className="text-sm text-neutral-200">{appVersion || "..."}</span>
              </div>

              <div className="flex flex-col gap-2 border-t border-neutral-800 pt-3">
                <span className="text-xs text-neutral-400">
                  Erases every saved preference (hotkeys, device/application selection, default volumes, tray and
                  startup settings, buffer duration) and restarts the app.
                </span>
                <button
                  type="button"
                  onClick={() => setShowResetConfirm(true)}
                  className="self-start rounded border border-white bg-black px-3 py-1 text-sm font-medium text-white"
                >
                  Reset to Default
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showResetConfirm && (
        <ConfirmDialog
          message="Are you sure? This will erase all settings and restart the app."
          onConfirm={handleResetToDefault}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}
    </div>
  );
}
