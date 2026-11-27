/**
 * The platform pages (import, settings, login …) show their texts in English and German: every key they pass to t()
 * as it is written must be in both dictionaries, or the page shows the key itself (e.g. on a button).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Messages } from '@/lib/i18n';
import { messages } from '@/features/platform/messages';

const root = fileURLToPath(new URL('../../../src/features/platform', import.meta.url));

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) && e.name !== 'messages.ts' ? [p] : [];
  });
}

const at = (m: Messages, key: string): unknown =>
  key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Messages)[k] : undefined), m);

describe('platform messages', () => {
  it('have every key the platform pages use, in en and de', () => {
    const used = new Map<string, string>();
    for (const file of sources(root)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*['"]platform\.([\w.]+)['"]/g))
        used.set(m[1]!, path.relative(root, file));
    }
    expect(used.size, 'literal t("platform.…") keys in features/platform').toBeGreaterThan(20);
    const missing = [...used].flatMap(([key, file]) =>
      (['en', 'de'] as const).flatMap((lang) =>
        at(messages[lang], key) === undefined ? [`${lang} platform.${key} (${file})`] : [],
      ),
    );
    expect(missing).toEqual([]);
  });
});
