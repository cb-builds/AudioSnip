import { useEffect, useRef, useState } from "react";
import { confirmCaptureOverwrite, discardPendingCapture, getCaptureStatus } from "../lib/commands";
import type { TrackSnapshot } from "../types/audio";

/** How often to poll `get_capture_status`. */
const POLL_INTERVAL_MS = 300;

/** Max consecutive "processing" polls before giving up - 15 * 300ms = 4.5s. */
const MAX_POLL_ATTEMPTS = 15;

/** Caps the diagnostic log so a long session can't grow it unbounded. */
const MAX_DIAGNOSTIC_LOGS = 200;

export interface HotkeyCaptureState {
  isCapturing: boolean;
  /** Step-by-step trace of the current (or most recent) capture, newest last - shown in the loading overlay's terminal box for live debugging. */
  diagnosticLogs: string[];
  /** Escape hatch: immediately stops polling and forces the loading overlay closed. */
  forceCancel: () => void;
  /**
   * Set when the backend captured a new snip while one was already loaded -
   * the caller should render a confirmation prompt and call
   * `confirmOverwrite`/`cancelOverwrite` based on the user's answer. `null`
   * when there's nothing pending.
   */
  pendingOverwrite: TrackSnapshot[] | null;
  /** Accepts the pending overwrite: commits it on the backend and loads it into the workspace via `onTrigger`. */
  confirmOverwrite: () => void;
  /** Declines the pending overwrite: discards it on the backend, leaving the current session untouched. */
  cancelOverwrite: () => void;
}

/**
 * Polls the backend's capture status instead of listening for
 * `clip-capture-started`/`clip-capture-triggered` push events. The global
 * hotkey fires from the OS via `tauri-plugin-global-shortcut`, entirely
 * independent of whether the webview has finished (re-)registering its
 * `listen()` calls - an event emitted in that window is simply dropped with
 * no replay, which is exactly the race that let the backend's own logs show
 * a successful `clip-capture-triggered` emit that the frontend never saw.
 * Polling a plain request/response command has no such window: every check
 * is a fresh, self-contained round trip against whatever the backend
 * currently has stored (see `commands::get_capture_status` on the Rust
 * side), so there's nothing to race.
 */
export function useHotkeyListener(onTrigger: (snapshot: TrackSnapshot[]) => void): HotkeyCaptureState {
  const [isCapturing, setIsCapturing] = useState(false);
  const [diagnosticLogs, setDiagnosticLogs] = useState<string[]>([]);
  const [pendingOverwrite, setPendingOverwrite] = useState<TrackSnapshot[] | null>(null);
  const isCapturingRef = useRef(isCapturing);
  isCapturingRef.current = isCapturing;
  const intervalRef = useRef<number | undefined>(undefined);
  const attemptsRef = useRef(0);
  // Mirrored into a ref (rather than listed as an effect dependency) so the
  // long-lived poll interval below never has to tear down and restart
  // merely because the caller passed a new function reference on some
  // unrelated re-render - `App`'s `onTrigger` is a plain function
  // declaration recreated every render, and re-renders happen on every
  // animation frame while audio is playing. Without this, the interval
  // would be cleared and re-armed faster than its own 300ms period during
  // playback, effectively starving capture-status polling the whole time
  // something is playing.
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  function addLog(message: string) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    setDiagnosticLogs((prev) => {
      const next = [...prev, line];
      return next.length > MAX_DIAGNOSTIC_LOGS ? next.slice(next.length - MAX_DIAGNOSTIC_LOGS) : next;
    });
  }

  function stopPolling() {
    if (intervalRef.current !== undefined) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }
  }

  function forceCancel() {
    addLog("Force Cancel clicked - forcing isCapturing to false (polling continues in the background).");
    attemptsRef.current = 0;
    setIsCapturing(false);
    console.log("[hotkey] diagnostic log at force-cancel:", diagnosticLogs);
  }

  useEffect(() => {
    async function poll() {
      let status;
      try {
        status = await getCaptureStatus();
      } catch (err) {
        addLog(`Poll request itself failed: ${err}`);
        console.error("[hotkey] get_capture_status invoke failed:", err);
        return;
      }

      if (status.status === "idle") {
        return;
      }

      if (status.status === "processing") {
        if (!isCapturingRef.current) {
          addLog("Poll: status = processing - hotkey capture detected, showing loading overlay.");
          setIsCapturing(true);
          attemptsRef.current = 0;
        }
        attemptsRef.current += 1;
        addLog(`Poll: still processing (attempt ${attemptsRef.current}/${MAX_POLL_ATTEMPTS}).`);

        if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
          const elapsedSeconds = (MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000;
          addLog(
            `TIMEOUT: no success status after ${MAX_POLL_ATTEMPTS} checks (~${elapsedSeconds}s) - forcing isCapturing = false.`,
          );
          console.error("[hotkey] capture status poll timed out");
          attemptsRef.current = 0;
          setIsCapturing(false);
        }
        return;
      }

      if (status.status === "conflict") {
        addLog(
          `Poll: status = conflict - a clip is already loaded, awaiting overwrite confirmation for ${status.snapshot.length} channel(s).`,
        );
        attemptsRef.current = 0;
        setPendingOverwrite(status.snapshot);
        return;
      }

      if (status.status === "ready") {
        addLog(`Poll: status = ready - loading ${status.snapshot.length} channel(s) into the workspace.`);
        attemptsRef.current = 0;
        try {
          onTriggerRef.current(status.snapshot);
          addLog("Payload processed successfully.");
        } catch (err) {
          addLog(`Error while processing payload: ${err}`);
          console.error("[hotkey] failed to process the captured clip:", err);
        } finally {
          setIsCapturing(false);
        }
        return;
      }

      // status.status === "failed"
      addLog(`Poll: status = failed - ${status.message}`);
      console.error("[hotkey] capture failed:", status.message);
      attemptsRef.current = 0;
      setIsCapturing(false);
    }

    intervalRef.current = window.setInterval(poll, POLL_INTERVAL_MS);
    return stopPolling;
    // Runs once for the component's lifetime - see `onTriggerRef` above for
    // why `onTrigger` itself is deliberately not a dependency here.
  }, []);

  function confirmOverwrite() {
    if (!pendingOverwrite) return;
    const snapshot = pendingOverwrite;
    setPendingOverwrite(null);
    confirmCaptureOverwrite().catch((err) => console.error("[hotkey] confirm_capture_overwrite failed:", err));
    try {
      onTriggerRef.current(snapshot);
      addLog("Overwrite confirmed - payload processed successfully.");
    } catch (err) {
      addLog(`Error while processing overwrite payload: ${err}`);
      console.error("[hotkey] failed to process the confirmed overwrite:", err);
    }
  }

  function cancelOverwrite() {
    if (!pendingOverwrite) return;
    setPendingOverwrite(null);
    discardPendingCapture().catch((err) => console.error("[hotkey] discard_pending_capture failed:", err));
    addLog("Overwrite declined - discarding the newly captured clip.");
  }

  return { isCapturing, diagnosticLogs, forceCancel, pendingOverwrite, confirmOverwrite, cancelOverwrite };
}
