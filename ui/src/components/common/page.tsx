// Authored by Tomás Neto (TN 2026)
import { Check, Copy, Inbox } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-20 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 sm:px-8 py-4">
      <div className="min-w-0">
        <h1 className="text-xl leading-7 font-medium">{title}</h1>
        {description && <p className="text-secondary-foreground text-sm">{description}</p>}
      </div>
      {actions && (
        <div className="flex items-center gap-2" data-tour="page-actions">
          {actions}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ title, description, icon, className }: { title: string; description?: string; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn('text-muted-foreground flex flex-col items-center justify-center gap-2 py-16 text-center', className)}>
      <div className="mb-1 grid size-10 place-items-center rounded-lg border">{icon ?? <Inbox className="size-4" strokeWidth={1.5} />}</div>
      <div className="text-foreground text-sm font-medium">{title}</div>
      {description && <div className="text-secondary-foreground max-w-sm text-sm">{description}</div>}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={async () => {
        await navigator.clipboard?.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? 'Copied' : label}
    </Button>
  );
}

export function Field({ label, children, hint, error, htmlFor }: { label: ReactNode; children: ReactNode; hint?: ReactNode; error?: string; htmlFor?: string }) {
  return (
    // content-start: rows never stretch, so inputs in the same grid row stay aligned
    // even when only one of the fields has a hint/error underneath.
    <div className="grid min-w-0 content-start gap-1.5">
      <label htmlFor={htmlFor} className="text-sm leading-5 font-medium">
        {label}
      </label>
      {children}
      {error ? <p className="text-destructive text-xs leading-4">{error}</p> : hint ? <p className="text-muted-foreground text-xs leading-4">{hint}</p> : null}
    </div>
  );
}

export function KV({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(112px,auto)_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-secondary-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A quiet notice: hairline box on the raised surface, the signal colour only on the icon's edge bar. */
export function Callout({ tone = 'info', icon, children, className, ...rest }: { tone?: 'info' | 'warn' | 'ok'; icon?: ReactNode; children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        'bg-muted/50 relative flex items-start gap-3 overflow-hidden rounded-lg border py-3 pr-3 pl-4 text-sm',
        'before:absolute before:inset-y-0 before:left-0 before:w-0.5',
        tone === 'warn' ? 'before:bg-warning' : tone === 'ok' ? 'before:bg-positive' : 'before:bg-brand',
        className,
      )}
    >
      {icon && <span className={cn('mt-0.5 shrink-0 [&_svg]:size-4', tone === 'warn' ? 'text-warning-foreground' : tone === 'ok' ? 'text-positive' : 'text-brand')}>{icon}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
