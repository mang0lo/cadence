import type { LucideIcon } from 'lucide-react';
import { Hammer } from 'lucide-react';
import { Card, EmptyState, Page, PageHeader } from '@/components/ui';

/** Temporary page body for routes whose feature is still being built. */
export function Placeholder({ title, icon }: { title: string; icon?: LucideIcon }) {
  return (
    <Page>
      <PageHeader title={title} icon={icon} />
      <Card>
        <EmptyState icon={Hammer} title={title} description="This page is being built." />
      </Card>
    </Page>
  );
}
