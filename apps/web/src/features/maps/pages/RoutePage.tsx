import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function RoutePage() {
  const t = useT();
  return <Placeholder title={t('maps.titles.RoutePage')} />;
}
