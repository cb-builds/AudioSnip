import type { ReactNode } from "react";
import type { SyntheticEvent } from "react";
import { InfoTooltip } from "./InfoTooltip";

interface AccordionSectionProps {
  label: string;
  /** When provided, shows an "(i)" info popup next to the label. */
  infoText?: string;
  children: ReactNode;
  /** Controlled open state - when provided (paired with `onOpenChange`), the caller owns whether this section is expanded. Omit for normal uncontrolled (self-toggling) behavior. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Set to false to omit the top border/padding - e.g. when the caller already supplies its own divider (the Sources sidebar's footer), so the two don't stack into a double border. Defaults to true. */
  bordered?: boolean;
}

/**
 * A collapsible Track Settings module (Trim, Source Volume Levels, Scrub)
 * built on the native `<details>`/`<summary>` element. The disclosure arrow
 * is drawn manually rather than relying on the browser's native marker,
 * since Chromium hides that marker once `<summary>` is switched to a flex
 * layout - which this needs, to align the label with the optional info
 * icon. `relative` on the `<summary>` also gives `InfoTooltip`'s popup a
 * wide-enough positioned ancestor to anchor against, so it stays inside a
 * narrow sidebar instead of overflowing it.
 */
export function AccordionSection({
  label,
  infoText,
  children,
  open,
  onOpenChange,
  bordered = true,
}: AccordionSectionProps) {
  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    onOpenChange?.(event.currentTarget.open);
  }

  return (
    <details
      open={open}
      onToggle={onOpenChange ? handleToggle : undefined}
      className={`group flex flex-col gap-2 ${bordered ? "border-t border-neutral-800 pt-3" : ""}`}
    >
      <summary className="relative flex cursor-pointer select-none items-center gap-1 text-xs font-medium text-neutral-300 [&::-webkit-details-marker]:hidden">
        <span className="inline-block text-neutral-500 transition-transform duration-150 group-open:rotate-90">
          ▸
        </span>
        {label}
        {infoText && <InfoTooltip text={infoText} />}
      </summary>
      {children}
    </details>
  );
}
