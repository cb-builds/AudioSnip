import type { ReactNode } from "react";
import { InfoTooltip } from "./InfoTooltip";

interface AccordionSectionProps {
  label: string;
  /** When provided, shows an "(i)" info popup next to the label. */
  infoText?: string;
  children: ReactNode;
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
export function AccordionSection({ label, infoText, children }: AccordionSectionProps) {
  return (
    <details className="group flex flex-col gap-2 border-t border-neutral-800 pt-3">
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
