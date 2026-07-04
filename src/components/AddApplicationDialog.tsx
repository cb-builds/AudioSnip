import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { addApplicationSource, getActiveApplications, getExeMetadata, getInstalledApplications } from "../lib/commands";
import type { AppInfo, ApplicationSource } from "../types/audio";

interface AddApplicationDialogProps {
  onClose: () => void;
  onAdd: (source: ApplicationSource) => void;
}

type Tab = "open" | "all";

function AppIcon({ src }: { src: string | null }) {
  if (!src) {
    return <div className="h-6 w-6 shrink-0 rounded bg-neutral-800" />;
  }
  return <img src={src} alt="" className="h-6 w-6 shrink-0 rounded object-contain" />;
}

/**
 * A single "All apps" row. The backend doesn't eagerly extract an icon for
 * every installed application (there can be hundreds), so a row with no
 * icon yet fetches its own lazily via `getExeMetadata` once mounted.
 */
function AppRow({ app, selected, onSelect }: { app: AppInfo; selected: boolean; onSelect: () => void }) {
  const [icon, setIcon] = useState(app.iconBase64);

  useEffect(() => {
    if (icon !== null) return;
    let cancelled = false;
    getExeMetadata(app.exePath)
      .then((metadata) => {
        if (!cancelled) setIcon(metadata.iconBase64);
      })
      .catch(() => {
        if (!cancelled) setIcon(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.exePath]);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center gap-3 border-b border-neutral-800/60 px-3 py-2 text-left text-sm last:border-b-0 ${
          selected
            ? "bg-gradient-to-br from-blue-600/30 to-violet-600/30 text-white"
            : "text-neutral-200 hover:bg-neutral-800/60"
        }`}
      >
        <AppIcon src={icon} />
        <span className="truncate">{app.name}</span>
      </button>
    </li>
  );
}

/**
 * Themed modal (matching `ConfirmDialog`'s dark blue/purple styling) for
 * adding an application-specific Sources entry - lets the user pick from
 * currently running apps, every installed app, or browse the filesystem
 * directly for an arbitrary `.exe`.
 */
export function AddApplicationDialog({ onClose, onAdd }: AddApplicationDialogProps) {
  const [tab, setTab] = useState<Tab>("open");
  const [openApps, setOpenApps] = useState<AppInfo[] | null>(null);
  const [allApps, setAllApps] = useState<AppInfo[] | null>(null);
  const [selected, setSelected] = useState<AppInfo | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "open" && openApps === null) {
      getActiveApplications()
        .then(setOpenApps)
        .catch((err) => {
          setError(String(err));
          setOpenApps([]);
        });
    }
    if (tab === "all" && allApps === null) {
      getInstalledApplications()
        .then(setAllApps)
        .catch((err) => {
          setError(String(err));
          setAllApps([]);
        });
    }
  }, [tab, openApps, allApps]);

  const list = tab === "open" ? openApps : allApps;

  async function commitPath(path: string) {
    setAdding(true);
    setError(null);
    try {
      const source = await addApplicationSource(path);
      onAdd(source);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setAdding(false);
    }
  }

  async function handleBrowse() {
    const path = await openFileDialog({
      multiple: false,
      filters: [{ name: "Applications", extensions: ["exe"] }],
    });
    if (!path) return;
    await commitPath(path);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="flex h-[28rem] w-96 flex-col gap-3 rounded-lg border border-violet-800/50 bg-gradient-to-br from-neutral-900 to-[#1c1533] p-4 text-neutral-100 shadow-2xl shadow-violet-950/50">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Add Application Source</h2>
          <button type="button" onClick={onClose} className="text-neutral-400 hover:text-neutral-100">
            &times;
          </button>
        </div>

        <div className="flex gap-1 border-b border-neutral-800">
          <button
            type="button"
            onClick={() => setTab("open")}
            className={
              tab === "open"
                ? "border-b-2 border-violet-500 px-3 py-1.5 text-xs font-medium text-neutral-100"
                : "border-b-2 border-transparent px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
            }
          >
            Open apps
          </button>
          <button
            type="button"
            onClick={() => setTab("all")}
            className={
              tab === "all"
                ? "border-b-2 border-violet-500 px-3 py-1.5 text-xs font-medium text-neutral-100"
                : "border-b-2 border-transparent px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
            }
          >
            All apps
          </button>
        </div>

        <div className="flex-1 overflow-y-auto rounded border border-neutral-800">
          {list === null ? (
            <div className="p-3 text-xs text-neutral-500">Loading...</div>
          ) : list.length === 0 ? (
            <div className="p-3 text-xs text-neutral-500">No applications found.</div>
          ) : (
            <ul className="flex flex-col">
              {list.map((app) => (
                <AppRow
                  key={app.exePath}
                  app={app}
                  selected={selected?.exePath === app.exePath}
                  onSelect={() => setSelected(app)}
                />
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={handleBrowse}
          className="self-start text-xs text-cyan-400 hover:text-cyan-300 hover:underline"
        >
          Browse for a different app
        </button>

        {error && <span className="text-xs text-red-400">{error}</span>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-neutral-800 px-4 py-1.5 text-sm font-medium text-neutral-200 hover:bg-neutral-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => selected && commitPath(selected.exePath)}
            disabled={!selected || adding}
            className="rounded bg-gradient-to-br from-blue-600 to-violet-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {adding ? "Adding..." : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
