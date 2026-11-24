// Authored by Tomás Neto (TN 2026)
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

/** Same-origin CSV download URL (session cookie authenticates the GET). Empty params are dropped. */
export function exportUrl(path: string, params: Record<string, string | number | undefined>, delimiter: 'comma' | 'semicolon' = 'comma') {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  if (delimiter === 'semicolon') q.set('delimiter', 'semicolon');
  const qs = q.toString();
  return `${path}${qs ? `?${qs}` : ''}`;
}

/** "Export CSV" button with comma / semicolon (Excel PT) variants. */
export function ExportMenu({ path, params, label = 'Export CSV', size = 'sm' }: { path: string; params: Record<string, string | number | undefined>; label?: string; size?: 'sm' | 'default' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant="outline">
          <Download className="size-4" /> {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Uses the current filters (max rows applies)</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <a href={exportUrl(path, params)} download data-testid="export-csv">
            CSV (comma separated)
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={exportUrl(path, params, 'semicolon')} download data-testid="export-csv-excel">
            CSV for Excel (semicolon)
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
