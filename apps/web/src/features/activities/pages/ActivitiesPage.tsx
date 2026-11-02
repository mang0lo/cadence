import { ListChecks } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function ActivitiesPage() {
  const t = useT();
  return <Placeholder title={t('activities.titles.ActivitiesPage')} icon={ListChecks} />;
}
