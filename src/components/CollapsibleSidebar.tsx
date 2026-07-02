import type { ReactNode } from "react";

interface CollapsibleSidebarProps {
  label: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  width: number;
  /** Which edge of the workspace this sidebar sits on - controls which way the chevrons point. */
  side: "left" | "right";
  children: ReactNode;
}

const COLLAPSED_WIDTH = 28;

/**
 * A sidebar column that toggles between its full content and a narrow edge
 * strip bearing a 90-degree rotated label (click either the strip or the
 * small chevron to flip state). Shared by the left Sources column and the
 * right Track Settings column.
 */
export function CollapsibleSidebar({
  label,
  collapsed,
  onToggleCollapse,
  width,
  side,
  children,
}: CollapsibleSidebarProps) {
  const expandIcon = side === "left" ? "›" : "‹";
  const collapseIcon = side === "left" ? "‹" : "›";

  return (
    <div
      style={{ width: collapsed ? COLLAPSED_WIDTH : width }}
      className="shrink-0 overflow-hidden rounded border border-neutral-800 bg-neutral-900 transition-all duration-200"
    >
      {collapsed ? (
        <button
          type="button"
          onClick={onToggleCollapse}
          title={`Show ${label}`}
          style={{ width: COLLAPSED_WIDTH }}
          className="flex h-full flex-col items-center justify-center gap-2 text-neutral-400 hover:text-neutral-100"
        >
          <span className="text-xs">{expandIcon}</span>
          <span
            className="whitespace-nowrap text-[10px] uppercase tracking-wide"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            {label}
          </span>
        </button>
      ) : (
        <div style={{ width }} className="flex h-full flex-col gap-2 overflow-y-auto p-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs uppercase tracking-wide text-neutral-500">{label}</span>
            <button
              type="button"
              onClick={onToggleCollapse}
              title={`Hide ${label}`}
              className="flex h-6 w-6 shrink-0 items-center justify-center self-center rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            >
              {collapseIcon}
            </button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
