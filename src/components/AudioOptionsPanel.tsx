import { SecondsField } from "./SecondsField";
import { VolumeFader } from "./VolumeFader";

interface AudioOptionsPanelProps {
  /** Linear multiplier (1.0 = unity gain). */
  volume: number;
  onVolumeChange: (volume: number) => void;
  onAmplify: () => void;
  fadeInMs: number;
  onFadeInChange: (ms: number) => void;
  fadeOutMs: number;
  onFadeOutChange: (ms: number) => void;
  disabled?: boolean;
}

/**
 * Advanced Audio Options layout shared by the Master Mix and every
 * individual track: a "Volume" label, the horizontal dB fader (slider +
 * dB box + Amplify, see `VolumeFader`), then Fade In/Out below.
 */
export function AudioOptionsPanel({
  volume,
  onVolumeChange,
  onAmplify,
  fadeInMs,
  onFadeInChange,
  fadeOutMs,
  onFadeOutChange,
  disabled,
}: AudioOptionsPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-neutral-400">Volume</span>
        <VolumeFader
          volume={volume}
          onVolumeChange={onVolumeChange}
          onAmplify={onAmplify}
          disabled={disabled}
        />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <SecondsField label="Fade in" valueMs={fadeInMs} onChange={onFadeInChange} />
        <SecondsField label="Fade out" valueMs={fadeOutMs} onChange={onFadeOutChange} />
      </div>
    </div>
  );
}
