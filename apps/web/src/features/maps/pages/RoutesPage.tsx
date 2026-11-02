import { Route } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function RoutesPage() {
  const t = useT();
  return <Placeholder title={t('maps.titles.RoutesPage')} icon={Route} />;
}
