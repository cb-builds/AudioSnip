import { useEffect, useState } from "react";
import { getBufferDuration, getHotkey, setBufferDuration, updateHotkey } from "../lib/commands";
import { acceleratorFromKeyboardEvent } from "../lib/hotkeyRecorder";
import type { ChannelInfo } from "../types/audio";
import { ChannelList } from "./ChannelList";

interface SettingsProps {
  onClose: () => void;
  channels: ChannelInfo[];
  activeIds: Set<string>;
  onToggleChannel: (id: string) => void;
}

export function Settings({ onClose, channels, activeIds, onToggleChannel }: SettingsProps) {
  const [currentHotkey, setCurrentHotkey] = useState("");
  const [recording, setRecording] = useState(false);
  const [pendingHotkey, setPendingHotkey] = useState<string | null>(null);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [savingHotkey, setSavingHotkey] = useState(false);

  const [durationInput, setDurationInput] = useState("30");
  const [durationError, setDurationError] = useState<string | null>(null);
  const [savingDuration, setSavingDuration] = useState(false);

  useEffect(() => {
    getHotkey().then(setCurrentHotkey).catch(console.error);
    getBufferDuration()
      .then((seconds) => setDurationInput(String(seconds)))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!recording) return;

    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      const accelerator = acceleratorFromKeyboardEvent(event);
      if (!accelerator) return;
      setPendingHotkey(accelerator);
      setRecording(false);
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [recording]);

  async function handleSaveHotkey() {
    if (!pendingHotkey) return;
    setSavingHotkey(true);
    setHotkeyError(null);
    try {
      await updateHotkey(pendingHotkey);
      setCurrentHotkey(pendingHotkey);
      setPendingHotkey(null);
    } catch (err) {
      setHotkeyError(String(err));
    } finally {
      setSavingHotkey(false);
    }
  }

  async function handleSaveDuration() {
    const seconds = Math.trunc(Number(durationInput));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      setDurationError("Enter a whole number of seconds greater than 0");
      return;
    }

    setSavingDuration(true);
    setDurationError(null);
    try {
      await setBufferDuration(seconds);
    } catch (err) {
      setDurationError(String(err));
    } finally {
      setSavingDuration(false);
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/60">
      <div className="flex max-h-[80vh] w-96 flex-col gap-4 overflow-y-auto rounded-lg bg-neutral-900 p-4 text-neutral-100">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-100"
          >
            &times;
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-neutral-400">Clip capture hotkey</span>
          <button
            type="button"
            onClick={() => {
              setRecording(true);
              setPendingHotkey(null);
              setHotkeyError(null);
            }}
            className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-left text-sm"
          >
            {recording ? "Press a key combination..." : (pendingHotkey ?? currentHotkey) || "Not set"}
          </button>

          {hotkeyError && <span className="text-xs text-red-400">{hotkeyError}</span>}

          {pendingHotkey && (
            <button
              type="button"
              onClick={handleSaveHotkey}
              disabled={savingHotkey}
              className="self-start rounded bg-cyan-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
            >
              {savingHotkey ? "Saving..." : "Save"}
            </button>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-neutral-400">Rolling buffer duration (seconds)</span>
          <input
            type="text"
            inputMode="numeric"
            value={durationInput}
            onChange={(e) => setDurationInput(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
          />

          {durationError && <span className="text-xs text-red-400">{durationError}</span>}

          <button
            type="button"
            onClick={handleSaveDuration}
            disabled={savingDuration}
            className="self-start rounded bg-cyan-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
          >
            {savingDuration ? "Saving..." : "Save"}
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-neutral-400">Audio devices</span>
          <ChannelList channels={channels} activeIds={activeIds} onToggle={onToggleChannel} />
        </div>
      </div>
    </div>
  );
}
