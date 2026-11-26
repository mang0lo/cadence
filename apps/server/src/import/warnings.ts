/** Distinct warnings kept per import (a broken export must not bloat the job row). */
const MAX_WARNINGS = 200;

/**
 * Import warnings: one line per key, repeated ones with their count ("… (×1234)"). The first occurrence of a key is
 * appended to `out` right away (the job screen shows it while the import runs); finish() returns the final lines.
 */
export class WarningCollector {
  private readonly byKey = new Map<string, { msg: string; n: number }>();

  constructor(private readonly out: string[] = []) {}

  add(msg: string, key: string = msg): void {
    const hit = this.byKey.get(key);
    if (hit) {
      hit.n++;
      return;
    }
    if (this.byKey.size >= MAX_WARNINGS) return;
    this.byKey.set(key, { msg, n: 1 });
    this.out.push(msg);
  }

  get size(): number {
    return this.byKey.size;
  }

  finish(): string[] {
    return [...this.byKey.values()].map(({ msg, n }) => (n > 1 ? `${msg} (×${n})` : msg));
  }
}
