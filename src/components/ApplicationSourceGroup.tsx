import type { ChannelInfo } from "../types/audio";
import { AccordionSection } from "./AccordionSection";

interface ApplicationSourceGroupProps {
  applications: ChannelInfo[];
  activeIds: Set<string>;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  /** Controlled open state - omit for the default (closed) uncontrolled behavior. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** A circle with a horizontal line - the same style as the "Add App Sources" plus icon, minus the vertical stroke. */
const MINUS_CIRCLE_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="8" y1="12" x2="16" y2="12" />
  </svg>
);

/**
 * The "Applications" sub-section shared by the Sources sidebar's "Toggle
 * Audio Sources" menu and the Settings modal's "Audio Sources" tab - every
 * added application source, with its icon, an enable checkbox, and a
 * remove button flush with the column's right edge (hover shows "Remove?").
 */
export function ApplicationSourceGroup({
  applications,
  activeIds,
  onToggle,
  onRemove,
  open,
  onOpenChange,
}: ApplicationSourceGroupProps) {
  return (
    <AccordionSection label="Applications" open={open} onOpenChange={onOpenChange}>
      <ul className="flex w-full flex-col gap-2 pt-1">
        {applications.length === 0 ? (
          <li className="text-xs text-neutral-500">No applications added yet.</li>
        ) : (
          applications.map((channel) => (
            <li key={channel.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={activeIds.has(channel.id)}
                onChange={() => onToggle(channel.id)}
              />
              {channel.iconBase64 ? (
                <img src={channel.iconBase64} alt="" className="h-4 w-4 shrink-0 object-contain" />
              ) : (
                <span className="h-4 w-4 shrink-0 rounded bg-neutral-700" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{channel.name}</span>
              <button
                type="button"
                onClick={() => onRemove(channel.id)}
                title="Remove?"
                className="shrink-0 text-neutral-500 hover:text-red-400"
              >
                {MINUS_CIRCLE_ICON}
              </button>
            </li>
          ))
        )}
      </ul>
    </AccordionSection>
  );
}
