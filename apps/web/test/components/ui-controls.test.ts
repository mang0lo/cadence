/**
 * Primitives of apps/web/src/components/ui.tsx, rendered to static markup (no DOM in the web tests):
 * - a sortable table header is a real button (reachable and usable with the keyboard), not a clickable <th>;
 * - Input / Select / IconButton have a small size, so pages no longer override h-9 with the important modifier
 *   (`cn` is plain clsx and does not merge conflicting utilities).
 */
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Check } from 'lucide-react';
import { IconButton, Input, Select, TH } from '@/components/ui';

const classes = (html: string, tag: string): string[] =>
  (new RegExp(`<${tag}[^>]*class="([^"]*)"`).exec(html)?.[1] ?? '').split(/\s+/);

describe('TH', () => {
  const header = (props: Parameters<typeof TH>[0]) =>
    renderToStaticMarkup(h('table', null, h('thead', null, h('tr', null, h(TH, props)))));

  it('sorts with a button, which says what it sorts by', () => {
    const html = header({ children: 'Date', onClick: () => undefined, sorted: 'asc', title: 'Sort by date' });
    expect(html).toMatch(/<th[^>]*aria-sort="ascending"/);
    expect(html).toMatch(/<button type="button"[^>]*title="Sort by date"[^>]*>Date/);
    expect(html).not.toMatch(/<th[^>]*title=/);
  });

  it('shows the direction of the sorted column inside the button', () => {
    const html = header({ children: 'Distance', onClick: () => undefined, sorted: 'desc', numeric: true });
    expect(html).toMatch(/<button[^>]*>Distance<span[^>]*>↓<\/span><\/button>/);
    expect(html).toMatch(/<th[^>]*class="[^"]*text-right/);
  });

  it('is plain text without a sort', () => {
    const html = header({ children: 'Title' });
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-sort');
    expect(html).toMatch(/<th[^>]*>Title<\/th>/);
  });
});

describe('small controls', () => {
  it('Input and Select are 32 px high with small text', () => {
    for (const html of [
      renderToStaticMarkup(h(Input, { size: 'sm', className: 'w-16' })),
      renderToStaticMarkup(
        h(Select<'a'>, { size: 'sm', value: 'a', onChange: () => undefined, options: [{ value: 'a', label: 'A' }] }),
      ),
    ]) {
      const c = classes(html, html.startsWith('<input') ? 'input' : 'select');
      expect(c).toEqual(expect.arrayContaining(['h-8', 'text-xs']));
      expect(c).not.toContain('h-9');
      expect(c).not.toContain('text-sm');
    }
  });

  it('keep the regular size by default', () => {
    const c = classes(renderToStaticMarkup(h(Input, {})), 'input');
    expect(c).toEqual(expect.arrayContaining(['h-9', 'text-sm', 'w-full']));
    expect(c).not.toContain('h-8');
  });

  it('IconButton has a small size too', () => {
    const c = classes(renderToStaticMarkup(h(IconButton, { icon: Check, label: 'Done', size: 'sm' })), 'button');
    expect(c).toContain('size-7');
    expect(c).not.toContain('size-8');
  });
});
