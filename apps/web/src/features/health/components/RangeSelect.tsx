import { SegmentedControl } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { RANGE_KEYS, type RangeKey } from '../lib/hooks';

/** Time range presets (30 days … all), shown as one row above the charts it scopes. */
export function RangeSelect({
  value,
  onChange,
  keys = RANGE_KEYS,
}: {
  value: RangeKey;
  onChange: (v: RangeKey) => void;
  keys?: RangeKey[];
}) {
  const t = useT();
  return (
    <SegmentedControl
      label={t('health.range.label')}
      value={value}
      onChange={onChange}
      items={keys.map((k) => ({ value: k, label: t(`health.range.${k}`) }))}
    />
  );
}
