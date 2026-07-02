import type { ChannelInfo } from "../types/audio";

interface ChannelListProps {
  channels: ChannelInfo[];
  activeIds: Set<string>;
  onToggle: (id: string) => void;
}

interface ChannelGroupProps {
  label: string;
  devices: ChannelInfo[];
  activeIds: Set<string>;
  onToggle: (id: string) => void;
}

function ChannelGroup({ label, devices, activeIds, onToggle }: ChannelGroupProps) {
  if (devices.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      <ul className="flex w-full flex-col gap-2">
        {devices.map((channel) => (
          <li key={channel.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={activeIds.has(channel.id)}
              onChange={() => onToggle(channel.id)}
            />
            <span className="flex-1 truncate text-sm">{channel.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every discovered device, split into "Inputs"/"Outputs" sub-sections - the device name's font size matches the main active-track list items (e.g. "Master Mix") above it, and there's no separate INPUT/OUTPUT badge since the section header already conveys that. */
export function ChannelList({ channels, activeIds, onToggle }: ChannelListProps) {
  const inputs = channels.filter((channel) => channel.kind === "input");
  const outputs = channels.filter((channel) => channel.kind === "output");

  return (
    <div className="flex w-full flex-col gap-3">
      <ChannelGroup label="Inputs" devices={inputs} activeIds={activeIds} onToggle={onToggle} />
      <ChannelGroup label="Outputs" devices={outputs} activeIds={activeIds} onToggle={onToggle} />
    </div>
  );
}
