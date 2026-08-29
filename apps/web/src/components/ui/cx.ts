/**
 * The smallest class helper that works: keep the parts that really are strings,
 * join the rest. No `clsx` dependency — the web app runs on Next and React and
 * nothing else, and this design system is not going to be what breaks that.
 *
 * The parameter is `unknown` rather than `string | false | undefined` because
 * the usual call is `cond && "class"`, and in this codebase `cond` is often a
 * ReactNode or a number. A stricter signature forces a `!!` dance at every call
 * site without making anything safer: whatever is not a string drops out here.
 */
export function cx(...parts: unknown[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}
