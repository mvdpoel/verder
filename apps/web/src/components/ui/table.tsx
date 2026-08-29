import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * Tables. No borders around the cells, only hairlines under the rows: the same
 * rule `Row` follows, which is what keeps a table and a list reading as the same
 * thing on one page.
 *
 * A table gets its own horizontal scroll from `TableWrap` — a wide table must
 * never make the PAGE scroll sideways, because then the whole layout moves and
 * the sidebar is suddenly gone.
 */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("w-full overflow-x-auto", className)}>{children}</div>;
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <table className={cx("w-full border-collapse", className)}>{children}</table>;
}

export function Th({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cx(
        "border-b border-edge pb-[10px] text-left font-mono text-[9px] font-normal",
        "tracking-[0.2em] uppercase text-ink-faint",
        className,
      )}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cx("border-b border-hairline py-[11px] text-[13.5px] font-light text-ink-soft", className)}
      {...rest}
    />
  );
}
