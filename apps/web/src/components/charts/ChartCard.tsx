import { useMemo, useState, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardHeader, IconButton, Table, TD, TH, cn } from '@/components/ui';
import { useT } from '@/lib/i18n';

export interface TableView {
  columns: { key: string; label: string; numeric?: boolean }[];
  rows: Record<string, ReactNode>[];
}

/**
 * The table view of a chart, or a function that builds it. A function is called only while the table is shown, so a
 * chart with hundreds of points does not build hundreds of hidden rows (with links) on every render; give it a stable
 * identity (useMemo / useCallback) to build the rows once per change of the data. It must not call hooks.
 */
export type TableSource = TableView | (() => TableView);

/**
 * Card wrapper for a chart. Pass `table` to give the chart its accessible table-view twin
 * (toggle in the header) — every value shown in a tooltip should also be reachable there.
 */
export function ChartCard({
  title,
  subtitle,
  icon,
  actions,
  table,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  table?: TableSource;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const [showTable, setShowTable] = useState(false);
  const view = useMemo(
    () => (showTable && table ? (typeof table === 'function' ? table() : table) : null),
    [showTable, table],
  );
  return (
    <Card className={cn('flex min-w-0 flex-col', className)}>
      <CardHeader
        title={title}
        subtitle={subtitle}
        icon={icon}
        actions={
          <>
            {actions}
            {table && (
              <IconButton
                icon={showTable ? BarChart3 : Table2}
                label={showTable ? t('common.showChart') : t('common.showTable')}
                onClick={() => setShowTable((v) => !v)}
              />
            )}
          </>
        }
      />
      {view ? (
        <Table className="max-h-80">
          <thead>
            <tr>
              {view.columns.map((c) => (
                <TH key={c.key} numeric={c.numeric}>
                  {c.label}
                </TH>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r, i) => (
              <tr key={i}>
                {view.columns.map((c) => (
                  <TD key={c.key} numeric={c.numeric}>
                    {r[c.key]}
                  </TD>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        children
      )}
      {footer && <div className="mt-3 border-t border-border pt-3 text-xs text-fg-3">{footer}</div>}
    </Card>
  );
}
