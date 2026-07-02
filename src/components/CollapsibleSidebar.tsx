import type { ReactNode } from "react";

interface CollapsibleSidebarProps {
  label: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  width: number;
  /** Which edge of the workspace this sidebar sits on - controls which way the chevrons point. */
  side: "left" | "right";
  children: ReactNode;
  /**
   * Rendered below `children` but pinned to the bottom of the column and
   * excluded from `children`'s own scroll area - e.g. a persistent utility
   * section that shouldn't be pushed down or out of view as the main list
   * above it grows.
   */
  footer?: ReactNode;
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
  footer,
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
        <div style={{ width }} className="flex h-full flex-col gap-2 p-2">
          <div className="flex shrink-0 items-center justify-between px-1">
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
          <div className="flex min-w-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden">{children}</div>
          {footer && <div className="shrink-0 border-t border-neutral-800 pt-2">{footer}</div>}
        </div>
      )}
    </div>
  );
}
