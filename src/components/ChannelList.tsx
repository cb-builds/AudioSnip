import type { ChannelInfo } from "../types/audio";
import { AccordionSection } from "./AccordionSection";
import { AddAppSourcesButton } from "./AddAppSourcesButton";
import { ApplicationSourceGroup } from "./ApplicationSourceGroup";

interface ChannelListProps {
  channels: ChannelInfo[];
  activeIds: Set<string>;
  onToggle: (id: string) => void;
  onAddApplicationSource: () => void;
  onRemoveApplicationSource: (id: string) => void;
}

interface ChannelGroupProps {
  label: string;
  devices: ChannelInfo[];
  activeIds: Set<string>;
  onToggle: (id: string) => void;
}

/** A nested, independently collapsible sub-section (defaults closed, like every other `AccordionSection` in the app) - the device name's font size matches the main active-track list items (e.g. "Master Mix") above it. */
function ChannelGroup({ label, devices, activeIds, onToggle }: ChannelGroupProps) {
  return (
    <AccordionSection label={label}>
      <ul className="flex w-full flex-col gap-2 pt-1">
        {devices.length === 0 ? (
          <li className="text-xs text-neutral-500">No devices found.</li>
        ) : (
          devices.map((channel) => (
            <li key={channel.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={activeIds.has(channel.id)}
                onChange={() => onToggle(channel.id)}
              />
              <span className="flex-1 truncate text-sm">{channel.name}</span>
            </li>
          ))
        )}
      </ul>
    </AccordionSection>
  );
}

/** Every discovered device (plus user-added application sources), split into independently collapsible "Inputs"/"Outputs"/"Applications" sub-sections (all default closed), with "Add App Sources" directly underneath - there's no separate INPUT/OUTPUT badge on individual rows since the section header already conveys that. */
export function ChannelList({
  channels,
  activeIds,
  onToggle,
  onAddApplicationSource,
  onRemoveApplicationSource,
}: ChannelListProps) {
  const inputs = channels.filter((channel) => channel.kind === "input");
  const outputs = channels.filter((channel) => channel.kind === "output");
  const applications = channels.filter((channel) => channel.kind === "application");

  return (
    <div className="flex w-full flex-col gap-1">
      <ChannelGroup label="Inputs" devices={inputs} activeIds={activeIds} onToggle={onToggle} />
      <ChannelGroup label="Outputs" devices={outputs} activeIds={activeIds} onToggle={onToggle} />
      <ApplicationSourceGroup
        applications={applications}
        activeIds={activeIds}
        onToggle={onToggle}
        onRemove={onRemoveApplicationSource}
      />
      <AddAppSourcesButton onClick={onAddApplicationSource} />
    </div>
  );
}
