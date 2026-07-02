import { PAUSE_ICON, PLAY_ICON, STOP_ICON } from "../lib/icons";
import type { ChannelInfo, TrackEditParams, TrackSnapshot } from "../types/audio";
import { Waveform } from "./Waveform";

interface TrackEditorProps {
  channel: ChannelInfo;
  snapshot?: TrackSnapshot;
  params: TrackEditParams;
  onParamsChange: (patch: Partial<TrackEditParams>) => void;
  isPlaying: boolean;
  positionSeconds?: number;
  onPlayPause: () => void;
  onStop: () => void;
  onScrub: (offsetSeconds: number) => void;
  isSelected: boolean;
  onSelect: () => void;
}

export function TrackEditor({
  channel,
  snapshot,
  params,
  onParamsChange,
  isPlaying,
  positionSeconds,
  onPlayPause,
  onStop,
  onScrub,
  isSelected,
  onSelect,
}: TrackEditorProps) {
  return (
    <div
      onClick={onSelect}
      className={`flex cursor-pointer flex-col gap-2 rounded border p-2 transition-colors ${
        isSelected
          ? "border-violet-500 bg-gradient-to-br from-blue-950/40 to-violet-950/40 ring-1 ring-violet-500"
          : "border-neutral-800 hover:border-neutral-700"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-300">{channel.name}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPlayPause}
            disabled={!snapshot}
            title={isPlaying ? "Pause" : "Play"}
            className="flex h-7 w-7 items-center justify-center rounded bg-neutral-800 text-xs text-neutral-100 disabled:opacity-40"
          >
            {isPlaying ? PAUSE_ICON : PLAY_ICON}
          </button>
          <button
            type="button"
            onClick={onStop}
            disabled={!snapshot}
            title="Stop"
            className="flex h-7 w-7 items-center justify-center rounded bg-neutral-800 text-xs text-neutral-100 disabled:opacity-40"
          >
            {STOP_ICON}
          </button>
        </div>
      </div>

      <Waveform
        samples={snapshot?.samples}
        channels={snapshot?.channels}
        sampleRate={snapshot?.sampleRate}
        visualGain={params.volume}
        trimStartMs={params.trimStartMs}
        trimEndMs={params.trimEndMs}
        onTrimChange={onParamsChange}
        playbackPositionSeconds={positionSeconds}
        onScrub={onScrub}
      />
    </div>
  );
}
