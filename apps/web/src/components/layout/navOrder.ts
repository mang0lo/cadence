/** Order of the sidebar (pure): the athlete's saved order applied to the pages the feature modules declare. */

export interface Orderable {
  path: string;
  group: string;
  /** Default position inside the group. */
  order: number;
}

export interface NavPrefs {
  /** Paths in the wanted order. */
  order: readonly string[];
  /** Groups in the wanted order. */
  groups: readonly string[];
}

const LAST = Number.MAX_SAFE_INTEGER;

/**
 * Groups and their pages in the wanted order. What the saved order does not know (a page added by a newer version)
 * follows after the known ones, in its default order.
 */
export function orderNav<T extends Orderable>(
  items: readonly T[],
  groups: readonly string[],
  prefs: NavPrefs,
): { group: string; items: T[] }[] {
  const rank = new Map(prefs.order.map((p, i) => [p, i]));
  const groupRank = new Map(prefs.groups.map((g, i) => [g, i]));
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (groupRank.get(a.g) ?? LAST) - (groupRank.get(b.g) ?? LAST) || a.i - b.i)
    .map(({ g }) => ({
      group: g,
      items: items
        .filter((it) => it.group === g)
        .sort((a, b) => (rank.get(a.path) ?? LAST) - (rank.get(b.path) ?? LAST) || a.order - b.order),
    }))
    .filter((g) => g.items.length);
}

/** `list` with the entry at `from` moved to position `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x!);
  return out;
}

/**
 * `full` with its shown entries replaced by `shown` in its new order. Entries that are not shown (pages hidden
 * because the athlete has no data for them) keep their slots, so they return where they were.
 */
export function mergeShown(full: readonly string[], shown: readonly string[]): string[] {
  const set = new Set(shown);
  let i = 0;
  return full.map((p) => (set.has(p) ? shown[i++]! : p));
}
