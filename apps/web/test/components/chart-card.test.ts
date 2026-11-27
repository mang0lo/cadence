/**
 * ChartCard's table view (apps/web/src/components/charts/ChartCard.tsx): a `table` given as a function is built only
 * while the table is shown, so charts with hundreds of points do not build hidden rows on every render.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { ChartCard, type TableSource } from '@/components/charts/ChartCard';
import { renderHook } from '../features/maps/fake-react';

vi.mock('react', async () => (await import('../features/maps/fake-react')).fakeReact);
vi.mock('@/lib/i18n', () => ({ useT: () => (key: string) => key }));
// the primitives as plain element types: only ChartCard's own logic runs
vi.mock('@/components/ui', () => ({
  Card: 'Card',
  CardHeader: 'CardHeader',
  IconButton: 'IconButton',
  Table: 'Table',
  TD: 'TD',
  TH: 'TH',
  cn: (...c: unknown[]) => c.filter(Boolean).join(' '),
}));

type El = ReactElement<Record<string, unknown>>;

/** Elements of a tree by type (children and the header's actions). */
function find(node: unknown, type: string, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) find(n, type, out);
  } else if (node && typeof node === 'object' && 'props' in node) {
    const el = node as El;
    if (el.type === type) out.push(el);
    find(el.props.children, type, out);
    find(el.props.actions, type, out);
  }
  return out;
}

interface Props {
  table?: TableSource;
}

function render(props: Props) {
  return renderHook((p: Props) => ChartCard({ title: 'Chart', children: 'the chart', ...p }) as El, props);
}

describe('ChartCard table view', () => {
  it('builds a table given as a function only while it is shown', () => {
    const build = vi.fn(() => ({ columns: [{ key: 'day', label: 'Day' }], rows: [{ day: 'Mon' }, { day: 'Tue' }] }));
    const h = render({ table: build });
    expect(build).not.toHaveBeenCalled();
    expect(find(h.result.current, 'Table')).toHaveLength(0);

    const toggle = () => (find(h.result.current, 'IconButton')[0]!.props.onClick as () => void)();
    toggle();
    expect(build).toHaveBeenCalledTimes(1);
    expect(find(h.result.current, 'TD')).toHaveLength(2);
    // a render for another reason with the same function does not build it again
    h.rerender({ table: build });
    expect(build).toHaveBeenCalledTimes(1);

    toggle();
    expect(find(h.result.current, 'Table')).toHaveLength(0);
    h.rerender({ table: build });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('still takes a ready table, and shows no toggle without one', () => {
    const h = render({ table: { columns: [{ key: 'a', label: 'A', numeric: true }], rows: [{ a: 1 }] } });
    (find(h.result.current, 'IconButton')[0]!.props.onClick as () => void)();
    expect(find(h.result.current, 'TD')).toHaveLength(1);
    expect(find(render({}).result.current, 'IconButton')).toHaveLength(0);
  });
});
