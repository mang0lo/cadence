/** A map that keeps at most `max` entries and drops the least recently used one (read or written) first. */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // most recently used last
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    for (const k of this.map.keys()) {
      if (this.map.size <= this.max) break;
      this.map.delete(k);
    }
  }

  /** Removes `key` while it still holds `value` (a newer value stored meanwhile stays). */
  deleteIf(key: K, value: V): void {
    if (this.map.get(key) === value) this.map.delete(key);
  }

  keys(): K[] {
    return [...this.map.keys()];
  }
}
