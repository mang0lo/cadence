import { Grid3x3 } from 'lucide-react';
import { Placeholder } from '@/components/Placeholder';
import { useT } from '@/lib/i18n';

export default function ExplorerPage() {
  const t = useT();
  return <Placeholder title={t('maps.titles.ExplorerPage')} icon={Grid3x3} />;
}
