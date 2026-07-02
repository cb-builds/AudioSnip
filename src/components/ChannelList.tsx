import type { ChannelInfo } from "../types/audio";

interface ChannelListProps {
  channels: ChannelInfo[];
  activeIds: Set<string>;
  onToggle: (id: string) => void;
}

export function ChannelList({ channels, activeIds, onToggle }: ChannelListProps) {
  return (
    <ul className="flex w-full flex-col gap-2">
      {channels.map((channel) => (
        <li key={channel.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={activeIds.has(channel.id)}
            onChange={() => onToggle(channel.id)}
          />
          <span className="flex-1 truncate">{channel.name}</span>
          <span className="rounded bg-neutral-800 px-1 text-[10px] uppercase text-neutral-400">
            {channel.kind}
          </span>
        </li>
      ))}
    </ul>
  );
}
