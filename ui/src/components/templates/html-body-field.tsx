// Authored by Tomás Neto (TN 2026)
import { FileUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { Callout } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { importHtmlFiles, type ImportedHtml } from '@/lib/html-import';
import { fmtBytes } from '@/lib/format';

/** HTML body editor with "Load file": an .htm/.html page (any encoding) plus the images it uses. */
export function HtmlBodyField({ value, onChange, disabled }: { value: string; onChange: (html: string) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportedHtml | null>(null);
  const [error, setError] = useState<string | null>(null);
  const broken = value.includes('�');

  const load = async (files: File[]) => {
    setError(null);
    setResult(null);
    if (!files.length) return;
    try {
      const r = await importHtmlFiles(files);
      onChange(r.html);
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground font-mono text-xs tabular-nums">{value ? fmtBytes(new Blob([value]).size) : ''}</span>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => input.current?.click()}>
          <FileUp className="size-4" /> Load file
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="HTML file and images"
          accept=".htm,.html,text/html,image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => {
            void load([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      <Textarea aria-label="HTML body" value={value} onChange={(e) => onChange(e.target.value)} rows={10} className="font-mono text-xs leading-5" />
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {result && (
        <Callout tone={result.missing.length ? 'warn' : 'ok'} data-testid="html-import-result">
          Loaded as {result.charset}
          {result.word ? ', Word markup cleaned' : ''}
          {result.embedded.length ? `, ${result.embedded.length} image${result.embedded.length > 1 ? 's' : ''} embedded` : ''}.
          {result.missing.length > 0 && (
            <>
              {' '}
              Not found: <span className="font-mono">{result.missing.join(', ')}</span>. Load the page again together with these files (Word keeps them in the
              folder next to the page).
            </>
          )}
        </Callout>
      )}
      {broken && !result && (
        <Callout tone="warn" data-testid="html-encoding-warning">
          The HTML contains � characters: it was read with the wrong encoding, so accents are lost. Use Load file with the original page instead of pasting
          it.
        </Callout>
      )}
    </div>
  );
}
