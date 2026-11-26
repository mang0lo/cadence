/**
 * Variables of a plural message that shows a count ('{n} tiles'): `count` picks the plural form, `n` is the count as
 * the locale writes it (1,234 / 1.234). t() prints variables with String(), so `{count}` would read '1234'.
 */
export const countVars = (
  fmt: { int: (v: number) => string },
  count: number,
  vars?: Record<string, string | number>,
): Record<string, string | number> => ({ ...vars, count, n: fmt.int(count) });
