import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardHeader, Input } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { todayKey } from '@/lib/time';
import { useDraft } from './useDraft';
import { birthDateCommit, parseBounds, zoneBoundsProblem } from './validate';

export function Section({ title, icon, children, hint }: { title: string; icon: LucideIcon; children: ReactNode; hint?: string }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={hint} icon={icon} />
      <div className="grid gap-4">{children}</div>
    </Card>
  );
}

/** Number input that saves on blur/enter; empty = automatic (null). */
export function NumberSetting({
  value,
  placeholder,
  onSave,
  min,
  max,
}: {
  value: number | null;
  placeholder: string;
  onSave: (v: number | null) => void;
  min: number;
  max: number;
}) {
  const fmt = useFormat();
  const { draft, edit, reset, done } = useDraft(value?.toString() ?? '');
  const commit = () => {
    const n = draft.trim() === '' ? null : Math.round(fmt.parseNumber(draft));
    if ((n === null || (Number.isFinite(n) && n >= min && n <= max)) && n !== value) {
      done();
      onSave(n);
    } else reset();
  };
  return (
    <Input
      inputMode="numeric"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => edit(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className="max-w-40"
    />
  );
}

/**
 * Birth date that is saved when the field is left (or on Enter), and only as a complete, plausible date. Chrome's date
 * input reports every typed digit of the year (0001, 0019, 0198, 1987): saving each of them stored a garbage year,
 * and re-rendering from the saved value reset the typing.
 */
export function BirthDateSetting({
  override,
  shown,
  onSave,
}: {
  /** The date set in Cadence (null = Apple Health's). */
  override: string | null;
  /** The date shown without an override (the athlete's). */
  shown: string | null;
  onSave: (v: string | null) => void;
}) {
  const t = useT();
  const { draft, edit, reset, done } = useDraft(override ?? shown ?? '');
  const [invalid, setInvalid] = useState(false);
  const today = todayKey();
  const commit = (input: HTMLInputElement) => {
    const res = birthDateCommit({ value: input.value, badInput: input.validity.badInput }, override, shown, today);
    if (res) {
      done();
      onSave(res.save);
    } else {
      // something typed that is not a date to save: say so and show the saved date again
      setInvalid(input.validity.badInput || (input.value !== '' && input.value !== (override ?? shown ?? '')));
      reset();
    }
  };
  return (
    <>
      <Input
        type="date"
        min="1900-01-01"
        max={today}
        value={draft}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setInvalid(false);
          edit(e.target.value);
        }}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget)}
      />
      {invalid && <span className="text-xs text-critical-fg">{t('platform.settings.birthDateInvalid')}</span>}
    </>
  );
}

/**
 * The four upper limits of custom zones, edited together: saved (on blur / Enter) only when they ascend, because the
 * server ignores limits that do not and falls back to % of max HR.
 */
export function ZoneBoundsSetting({ value, onSave }: { value: number[]; onSave: (v: number[]) => void }) {
  const t = useT();
  const fmt = useFormat();
  const { draft, edit, reset, done } = useDraft(value.map(String));
  // the problem shows once the user leaves a field with it (not while typing), then until it is fixed
  const [checked, setChecked] = useState(false);
  const bounds = parseBounds(draft, fmt.locale);
  const problem = zoneBoundsProblem(bounds);
  const commit = () => {
    if (problem) {
      setChecked(true); // keep the draft and say what is wrong
      return;
    }
    setChecked(false);
    const next = bounds as number[];
    if (next.some((b, i) => b !== value[i])) {
      done();
      onSave(next);
    } else reset();
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {draft.map((b, i) => (
          <Input
            key={i}
            inputMode="numeric"
            value={b}
            aria-label={t('platform.settings.zoneLimit', { zone: i + 1 })}
            aria-invalid={(checked && !!problem) || undefined}
            onChange={(e) => edit((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            className="max-w-24"
          />
        ))}
      </div>
      {checked && problem && <span className="text-xs text-critical-fg">{t(`platform.settings.zoneProblems.${problem}`)}</span>}
    </div>
  );
}
