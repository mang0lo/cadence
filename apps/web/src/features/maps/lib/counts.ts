/**
 * Variables of a plural message that shows a count ('{count} tiles').
 * @deprecated t() writes numbers the way the locale writes them (1,234 / 1.234) and picks the plural form from them:
 * pass `{ ...vars, count }` instead.
 */
export const countVars = (
  _fmt: { int: (v: number) => string },
  count: number,
  vars?: Record<string, string | number>,
): Record<string, string | number> => ({ ...vars, count });
