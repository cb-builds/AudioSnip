interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A frontend-rendered confirmation overlay, styled to match the app's own
 * dark blue/purple theme - used instead of a native OS/Tauri message dialog
 * for the overwrite and buffer-reset confirmations specifically, since a
 * native message dialog plays the OS's system notification sound on
 * Windows, which this app never wants to trigger.
 */
export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="flex w-80 flex-col gap-4 rounded-lg border border-violet-800/50 bg-gradient-to-br from-neutral-900 to-[#1c1533] p-5 text-neutral-100 shadow-2xl shadow-violet-950/50">
        <p className="text-sm text-neutral-200">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded bg-neutral-800 px-4 py-1.5 text-sm font-medium text-neutral-200 hover:bg-neutral-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-gradient-to-br from-blue-600 to-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Yes
          </button>
        </div>
      </div>
    </div>
  );
}
