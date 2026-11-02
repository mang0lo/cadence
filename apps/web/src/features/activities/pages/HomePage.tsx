import { LayoutDashboard } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function HomePage() {
  const t = useT();
  return <Placeholder title={t('activities.titles.HomePage')} icon={LayoutDashboard} />;
}
