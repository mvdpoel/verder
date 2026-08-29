import Link from "next/link";
import { cx } from "./cx";

/**
 * Tabs as LINKS, not buttons: in this app every tab is its own URL
 * (`/tasks?tab=waiting`), so you can come back to it and the server page does
 * the filtering itself. The active tab carries a cyan line that sits ON the
 * bar's border — hence the one-pixel negative margin.
 */
export function Tabs({
  items, active, className,
}: {
  items: ReadonlyArray<{ key: string; label: string; href: string }>;
  active: string;
  className?: string;
}) {
  return (
    <nav className={cx("flex gap-1 border-b border-edge", className)}>
      {items.map((item) => {
        const on = item.key === active;
        return (
          <Link
            key={item.key}
            href={item.href}
            className={cx(
              "-mb-px px-[14px] py-[9px] font-mono text-[10.5px] tracking-[0.16em] uppercase transition-colors",
              on ? "border-b border-signal text-ink-bright" : "text-ink-dim hover:text-ink-soft",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
