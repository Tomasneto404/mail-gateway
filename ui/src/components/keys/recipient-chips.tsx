// Authored by Tomás Neto (TN 2026)
import { X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { ANY_RECIPIENT, isRecipientRule } from '@/lib/schemas';
import { cn } from '@/lib/utils';

interface Props {
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  id?: string;
}

/** Allowed recipients as chips. Accepts exact addresses ("ops@example.com"), domains ("@example.com") or "*" (anyone). */
export function RecipientChipsInput({ value, onChange, disabled, id }: Props) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return true;
    const bad = parts.filter((p) => !isRecipientRule(p));
    if (bad.length) {
      setError(`"${bad[0]}" is not valid. Use an exact address (ops@example.com), a domain (@example.com) or * for anyone.`);
      return false;
    }
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setDraft('');
    setError(null);
    return true;
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && draft.trim()) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Tab' && draft.trim()) {
      if (!commit(draft)) e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault(); // never submit the surrounding form from the chips input
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div>
      <div
        className={cn(
          'border-input dark:bg-input/30 flex min-h-9 flex-wrap items-center gap-1 rounded-md border bg-transparent px-2 py-1 shadow-xs',
          'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
          error && 'border-destructive',
          disabled && 'opacity-60',
        )}
      >
        {value.map((v) => (
          <span key={v} data-testid="recipient-chip" title={v === ANY_RECIPIENT ? 'Any recipient' : undefined} className="bg-secondary inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs">
            {v}
            {!disabled && (
              <button type="button" aria-label={`Remove ${v}`} className="hover:text-destructive" onClick={() => onChange(value.filter((x) => x !== v))}>
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        <input
          id={id}
          aria-label="Add allowed recipient"
          aria-invalid={!!error}
          className="min-w-40 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          placeholder={value.length ? '' : '@example.com, ops@example.com or * — press Enter'}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && commit(draft)}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (/[\s,;]/.test(t)) {
              e.preventDefault();
              commit(t);
            }
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-destructive mt-1 text-xs">
          {error}
        </p>
      ) : value.length === 0 ? (
        <p className="text-warning-foreground mt-1 text-xs">Empty allow-list: this key cannot send to anyone</p>
      ) : value.includes(ANY_RECIPIENT) ? (
        <p className="text-warning-foreground mt-1 text-xs">* allows any recipient. Quotas, recipient limits and domain caps still apply</p>
      ) : null}
    </div>
  );
}
