interface LoadingOverlayProps {
  /** Step-by-step capture trace from `useHotkeyListener`, newest last. */
  logs: string[];
  /** Escape hatch: immediately unblocks the UI without waiting for the automatic safety timeout. */
  onForceCancel: () => void;
}

/**
 * Full-screen glassmorphism overlay shown while a hotkey-triggered capture
 * is in flight (see `useHotkeyListener`) - grays out and blurs the entire
 * interface so it's obvious a new clip is loading rather than that the app
 * has stalled. Includes a live diagnostic log and a manual escape hatch so a
 * freeze can be diagnosed and dismissed on the spot instead of only being
 * caught after the fact.
 */
export function LoadingOverlay({ logs, onForceCancel }: LoadingOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-neutral-950/70 p-6 backdrop-blur-md">
      <span className="animate-pulse bg-gradient-to-br from-blue-400 to-violet-400 bg-clip-text text-xl font-semibold text-transparent">
        Loading audio clip...
      </span>

      <div className="diagnostic-log-terminal max-h-48 w-full max-w-lg overflow-y-auto rounded border border-neutral-700 bg-black/80 p-3 font-mono text-[11px] leading-relaxed text-green-400 shadow-lg">
        {logs.length === 0 ? (
          <div className="text-neutral-500">Waiting for capture events...</div>
        ) : (
          logs.map((line, index) => (
            <div key={index} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))
        )}
      </div>

      <button
        type="button"
        onClick={onForceCancel}
        className="rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
      >
        Force Cancel & View Workspace
      </button>
    </div>
  );
}
