/**
 * UI primitives. Import from '@/components/ui'. Styling uses theme tokens only (bg-surface, text-fg-2,
 * border-border, text-accent-fg …) so everything works in light and dark mode.
 */
import { describeError } from '@/lib/errors';
import { useT } from '@/lib/i18n';
import clsx, { type ClassValue } from 'clsx';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Inbox, Loader2, Minus, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const cn = (...v: ClassValue[]) => clsx(v);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Page container: consistent max width and padding. */
export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className={cn('mx-auto w-full px-4 pb-16 pt-6 sm:px-6 lg:px-8', wide ? 'max-w-[1600px]' : 'max-w-7xl', className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  icon: Icon,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  /** Optional row below the title (filters, tabs). */
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {Icon && (
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-fg">
              <Icon size={20} />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-fg-3">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** One row of filters above the content it scopes. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export function Grid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-4', className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  padded = true,
  as: As = 'section',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  as?: 'section' | 'div' | 'article';
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <As
      className={cn('rounded-card border border-border bg-surface shadow-card', padded && 'p-4 sm:p-5', className)}
      {...rest}
    >
      {children}
    </As>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  icon: Icon,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    // on phones the actions (e.g. a wide segmented control) move below the title instead of pushing the card wider
    <div className={cn('mb-3 flex items-start justify-between gap-x-3 gap-y-2 max-sm:flex-wrap', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {Icon && <Icon size={16} className="shrink-0 text-fg-3" />}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg">{title}</h2>
          {subtitle && <p className="truncate text-xs text-fg-3">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex min-w-0 max-w-full items-center gap-1.5 sm:shrink-0">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: 'sm' | 'md';
    icon?: LucideIcon;
    loading?: boolean;
  }
>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-colors disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-accent-strong text-on-accent hover:brightness-110',
        variant === 'secondary' && 'border border-border-strong bg-surface text-fg hover:bg-surface-2',
        variant === 'ghost' && 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        variant === 'danger' && 'bg-critical text-white hover:brightness-110',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'sm' ? 14 : 16} className="animate-spin" /> : Icon && <Icon size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
});

export function IconButton({
  icon: Icon,
  label,
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'grid size-8 place-items-center rounded-control text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg',
        active && 'bg-accent-soft text-accent-fg',
        className,
      )}
      {...rest}
    >
      <Icon size={16} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Direction × whether "up is good" decides the status color; always paired with an arrow icon. */
export function Delta({
  value,
  text,
  upIsGood = true,
  className,
}: {
  /** Signed change used for the direction. */
  value: number;
  /** Pre-formatted label, e.g. "+12 %" or "−0:08 /km". */
  text: string;
  upIsGood?: boolean;
  className?: string;
}) {
  const dir = value > 0 ? 1 : value < 0 ? -1 : 0;
  const good = dir === 0 ? null : (dir > 0) === upIsGood;
  const Icon = dir > 0 ? ArrowUpRight : dir < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium',
        good === true && 'text-good-fg',
        good === false && 'text-critical-fg',
        good === null && 'text-fg-3',
        className,
      )}
    >
      <Icon size={14} aria-hidden />
      {text}
    </span>
  );
}

/** Stat tile: label · value (+unit) · optional delta / hint / trend. Values use proportional figures. */
export function Stat({
  label,
  value,
  unit,
  delta,
  hint,
  trend,
  size = 'md',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  delta?: ReactNode;
  hint?: ReactNode;
  trend?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="truncate text-xs font-medium text-fg-3">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span
          className={cn(
            'font-semibold tracking-tight text-fg',
            size === 'sm' && 'text-lg',
            size === 'md' && 'text-2xl',
            size === 'lg' && 'text-4xl sm:text-5xl',
          )}
        >
          {value}
        </span>
        {unit && <span className={cn('font-medium text-fg-3', size === 'lg' ? 'text-lg' : 'text-sm')}>{unit}</span>}
      </div>
      {(delta || hint) && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-3">
          {delta}
          {hint}
        </div>
      )}
      {trend && <div className="mt-2">{trend}</div>}
    </div>
  );
}

/** A row of stat tiles inside a card. */
export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4', className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function Badge({
  children,
  tone = 'neutral',
  icon: Icon,
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'warning' | 'critical';
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-surface-2 text-fg-2',
        tone === 'accent' && 'bg-accent-soft text-accent-fg',
        tone === 'good' && 'bg-good/12 text-good-fg',
        tone === 'warning' && 'bg-warning/18 text-fg',
        tone === 'critical' && 'bg-critical/12 text-critical-fg',
        className,
      )}
    >
      {Icon && <Icon size={12} aria-hidden />}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tabs & segmented control
// ---------------------------------------------------------------------------

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
}

/** Underlined section tabs. */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: TabItem<T>[];
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('flex gap-1 overflow-x-auto border-b border-border scrollbar-thin', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={it.value === value}
          onClick={() => onChange(it.value)}
          className={cn(
            '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            it.value === value ? 'border-accent text-fg' : 'border-transparent text-fg-3 hover:text-fg',
          )}
        >
          {it.icon && <it.icon size={15} />}
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Compact pill toggle (metric switchers, period pickers). */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  items,
  size = 'md',
  className,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: TabItem<T>[];
  size?: 'sm' | 'md';
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex max-w-full overflow-x-auto rounded-control border border-border bg-surface-2 p-0.5 scrollbar-thin',
        className,
      )}
    >
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={it.value === value}
          onClick={() => onChange(it.value)}
          className={cn(
            'inline-flex items-center gap-1 whitespace-nowrap rounded-[7px] font-medium transition-colors',
            size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-xs sm:text-sm',
            it.value === value ? 'bg-surface text-fg shadow-card' : 'text-fg-3 hover:text-fg',
          )}
        >
          {it.icon && <it.icon size={14} />}
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const controlBase =
  'rounded-control border border-border-strong bg-surface px-3 text-sm text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none';

/** True when the caller sets its own width (e.g. 'w-40', 'sm:w-auto'); `cn` does not merge conflicting utilities. */
const hasWidth = (className?: string) => !!className && /(^|\s)([a-z0-9]+:)*w-/.test(className);

/** Form controls are full width unless the caller passes a `w-*` class. */
const controlClass = (extra: string, className?: string) =>
  cn(controlBase, extra, !hasWidth(className) && 'w-full', className);

/**
 * Labelled form row. Wraps a single native control (Input, Select, Textarea) in a <label>. For composite controls
 * (SegmentedControl, button rows, several inputs) pass `group`: a <label> would forward clicks to its first button
 * and give that button the whole label as its name, so a labelled role="group" is rendered instead.
 */
export function Field({
  label,
  help,
  children,
  className,
  group,
}: {
  label: ReactNode;
  help?: ReactNode;
  children: ReactNode;
  className?: string;
  group?: boolean;
}) {
  const id = useId();
  if (group) {
    return (
      <div role="group" aria-labelledby={id} className={cn('flex flex-col gap-1.5', className)}>
        <span id={id} className="text-xs font-medium text-fg-2">
          {label}
        </span>
        {children}
        {help && <span className="text-xs text-fg-3">{help}</span>}
      </div>
    );
  }
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-fg-2">{label}</span>
      {children}
      {help && <span className="text-xs text-fg-3">{help}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={controlClass('h-9', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={controlClass('min-h-20 py-2', className)} {...rest} />;
});

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> & {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={controlClass('h-9 cursor-pointer pr-8', className)}
      {...rest}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-surface-3',
        )}
      >
        <span
          className={cn(
            'absolute left-0 top-0.5 size-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-4.5' : 'translate-x-0.5',
          )}
        />
      </button>
      {label && (
        <label htmlFor={id} className="cursor-pointer text-sm text-fg-2">
          {label}
        </label>
      )}
    </span>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  className,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  className?: string;
  label?: string;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn('h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[var(--accent)]', className)}
      style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, var(--surface-3) ${pct}%)` }}
    />
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Spinner({ className, size = 18 }: { className?: string; size?: number }) {
  const t = useT();
  return <Loader2 size={size} className={cn('animate-spin text-fg-3', className)} aria-label={t('common.loading')} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-control bg-surface-2', className)} />;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      <span className="grid size-11 place-items-center rounded-full bg-surface-2 text-fg-3">
        <Icon size={20} />
      </span>
      <div className="text-sm font-semibold text-fg">{title}</div>
      {description && <div className="max-w-md text-sm text-fg-3">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * An error in the user's language: API errors are translated by their code, with the server's (English) message as
 * a small detail below. A string is shown as it is (pass translated text).
 */
export function ErrorState({ error, className }: { error: unknown; className?: string }) {
  const t = useT();
  const { message, detail } = describeError(error, t);
  return (
    <div className={cn('flex items-start gap-2 rounded-control bg-critical/10 px-3 py-2 text-sm text-critical-fg', className)}>
      <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="block">{message}</span>
        {detail && <span className="mt-0.5 block break-words text-xs opacity-80">{detail}</span>}
      </span>
    </div>
  );
}

/** Horizontal meter. `value` 0..1. Track is a lighter step of the same color. */
export function ProgressBar({
  value,
  color = 'var(--accent)',
  className,
  height = 8,
  label,
}: {
  value: number;
  color?: string;
  className?: string;
  height?: number;
  label?: string;
}) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      className={cn('w-full overflow-hidden rounded-full', className)}
      style={{ height, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
    >
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${v * 100}%`, background: color }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto scrollbar-thin', className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function TH({
  children,
  className,
  numeric,
  onClick,
  sorted,
}: {
  children?: ReactNode;
  className?: string;
  numeric?: boolean;
  onClick?: () => void;
  sorted?: 'asc' | 'desc' | null;
}) {
  return (
    <th
      onClick={onClick}
      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
      className={cn(
        'whitespace-nowrap border-b border-border px-3 py-2 text-xs font-medium text-fg-3',
        numeric ? 'text-right' : 'text-left',
        onClick && 'cursor-pointer select-none hover:text-fg',
        className,
      )}
    >
      {children}
      {sorted && <span className="ml-1">{sorted === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );
}

export function TD({ children, className, numeric }: { children?: ReactNode; className?: string; numeric?: boolean }) {
  return (
    <td className={cn('border-b border-border px-3 py-2 text-fg-2', numeric && 'tabular text-right', className)}>
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cn(
        'm-auto w-[min(92vw,520px)] rounded-card border border-border bg-surface p-0 text-fg shadow-pop backdrop:bg-black/40',
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <IconButton icon={X} label={t('common.close')} onClick={onClose} />
      </div>
      <div className="px-5 py-4">{children}</div>
      {actions && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{actions}</div>}
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Definition list for "key: value" detail panels. */
export function KeyValues({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-3">{k}</dt>
          <dd className="text-right font-medium text-fg tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Hover/focus tooltip for small inline elements (DOM based, not for charts). */
export function Hint({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {children}
      {show && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-max max-w-64 -translate-x-1/2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-fg shadow-pop"
        >
          {content}
        </span>
      )}
    </span>
  );
}
