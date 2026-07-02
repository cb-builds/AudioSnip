import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

interface InfoTooltipProps {
  text: string;
}

/**
 * A small "(i)" glyph that toggles a localized popup on click. The popup is
 * anchored by its right edge (via `right-0` on a positioned ancestor
 * supplied by the caller, e.g. `AccordionSection`'s `<summary>`) rather than
 * the icon's own position, so it opens toward the left and stays within a
 * narrow sidebar instead of overflowing past the panel's right edge.
 * Closes on its own "X" button or on any click outside the icon/popup.
 */
export function InfoTooltip({ text }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", handleOutsideClick);
    return () => window.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  function handleToggle(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    setOpen((v) => !v);
  }

  function handleClose(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  }

  return (
    <span ref={containerRef} className="inline-block align-middle">
      <button
        type="button"
        onClick={handleToggle}
        title="More info"
        className="ml-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-neutral-600 text-[9px] leading-none text-neutral-400 hover:border-violet-500 hover:text-violet-400"
      >
        i
      </button>
      {open && (
        <div
          onClick={(event) => event.stopPropagation()}
          className="absolute right-0 top-full z-20 mt-1 w-40 rounded border border-neutral-700 bg-neutral-800 p-2 pr-5 text-[10px] font-normal leading-snug text-neutral-300 shadow-lg"
        >
          <button
            type="button"
            onClick={handleClose}
            title="Close"
            className="absolute right-1 top-1 flex h-3 w-3 items-center justify-center text-[10px] leading-none text-neutral-400 hover:text-neutral-100"
          >
            ✕
          </button>
          {text}
        </div>
      )}
    </span>
  );
}
