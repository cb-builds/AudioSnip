import type { ChannelInfo } from "../types/audio";
import { AccordionSection } from "./AccordionSection";

interface ChannelListProps {
  channels: ChannelInfo[];
  activeIds: Set<string>;
  onToggle: (id: string) => void;
  onAddApplicationSource: () => void;
}

interface ChannelGroupProps {
  label: string;
  devices: ChannelInfo[];
  activeIds: Set<string>;
  onToggle: (id: string) => void;
  emptyLabel: string;
}

/** A nested, independently collapsible sub-section (defaults closed, like every other `AccordionSection` in the app) - the device name's font size matches the main active-track list items (e.g. "Master Mix") above it. */
function ChannelGroup({ label, devices, activeIds, onToggle, emptyLabel }: ChannelGroupProps) {
  return (
    <AccordionSection label={label}>
      <ul className="flex w-full flex-col gap-2 pt-1">
        {devices.length === 0 ? (
          <li className="text-xs text-neutral-500">{emptyLabel}</li>
        ) : (
          devices.map((channel) => (
            <li key={channel.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={activeIds.has(channel.id)}
                onChange={() => onToggle(channel.id)}
              />
              {channel.kind === "application" &&
                (channel.iconBase64 ? (
                  <img src={channel.iconBase64} alt="" className="h-4 w-4 shrink-0 object-contain" />
                ) : (
                  <span className="h-4 w-4 shrink-0 rounded bg-neutral-700" />
                ))}
              <span className="flex-1 truncate text-sm">{channel.name}</span>
            </li>
          ))
        )}
      </ul>
    </AccordionSection>
  );
}

const PLUS_CIRCLE_ICON = (
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
    <line x1="12" y1="8" x2="12" y2="16" />
    <line x1="8" y1="12" x2="16" y2="12" />
  </svg>
);

/** Every discovered device (plus user-added application sources), split into independently collapsible "Inputs"/"Outputs"/"Applications" sub-sections (all default closed), with "Add Application Source" directly underneath - there's no separate INPUT/OUTPUT badge on individual rows since the section header already conveys that. */
export function ChannelList({ channels, activeIds, onToggle, onAddApplicationSource }: ChannelListProps) {
  const inputs = channels.filter((channel) => channel.kind === "input");
  const outputs = channels.filter((channel) => channel.kind === "output");
  const applications = channels.filter((channel) => channel.kind === "application");

  return (
    <div className="flex w-full flex-col gap-1">
      <ChannelGroup label="Inputs" devices={inputs} activeIds={activeIds} onToggle={onToggle} emptyLabel="No devices found." />
      <ChannelGroup label="Outputs" devices={outputs} activeIds={activeIds} onToggle={onToggle} emptyLabel="No devices found." />
      <ChannelGroup
        label="Applications"
        devices={applications}
        activeIds={activeIds}
        onToggle={onToggle}
        emptyLabel="No applications added yet."
      />
      <button
        type="button"
        onClick={onAddApplicationSource}
        className="flex items-center gap-2 rounded px-1 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-800"
      >
        {PLUS_CIRCLE_ICON}
        Add Application Source
      </button>
    </div>
  );
}
