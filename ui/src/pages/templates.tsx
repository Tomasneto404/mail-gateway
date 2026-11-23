// Authored by Tomás Neto (TN 2026)
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '@/api/client';
import { previewTemplate, useCreateTemplate, useDeleteTemplate, useTemplates, useUpdateTemplate, type TemplateT } from '@/api/queries';
import { Pill } from '@/components/common/badges';
import { Field, PageHeader } from '@/components/common/page';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useMe } from '@/lib/auth';
import { fmtShort } from '@/lib/format';
import { keyNameSchema } from '@/lib/schemas';

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]{0,63})\s*\}\}/g;
const variablesOf = (...parts: string[]) => [...new Set(parts.flatMap((p) => [...p.matchAll(VAR_RE)].map((m) => m[1])))].sort();

type Draft = { name: string; description: string; subject: string; text: string; html: string };
const empty: Draft = { name: '', description: '', subject: '', text: '', html: '' };

function TemplateEditor({ template, open, onOpenChange, canManage }: { template: TemplateT | null; open: boolean; onOpenChange: (o: boolean) => void; canManage: boolean }) {
  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const del = useDeleteTemplate();
  const [d, setD] = useState<Draft>(empty);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ subject: string; text?: string; html?: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setD(template ? { name: template.name, description: template.description, subject: template.subject, text: template.text ?? '', html: template.html ?? '' } : empty);
    setVars({});
    setPreview(null);
    setPreviewError(null);
  }, [open, template]);

  const variables = useMemo(() => variablesOf(d.subject, d.text, d.html), [d]);
  const nameError = d.name && !keyNameSchema.safeParse(d.name).success ? 'Letters, digits, ".", "_" and "-" only' : undefined;
  const dirty = !template || d.name !== template.name || d.description !== template.description || d.subject !== template.subject || d.text !== (template.text ?? '') || d.html !== (template.html ?? '');
  const valid = !!d.name && !nameError && !!d.subject.trim() && (!!d.text.trim() || !!d.html.trim());

  const save = async () => {
    const body = { name: d.name, description: d.description, subject: d.subject, text: d.text || null, html: d.html || null };
    if (template) await update.mutateAsync({ id: template.id, body });
    else await create.mutateAsync(body);
    onOpenChange(false);
  };

  const runPreview = async () => {
    if (!template) return;
    setPreviewError(null);
    try {
      setPreview(await previewTemplate(template.id, Object.fromEntries(variables.map((v) => [v, vars[v] ?? '']))));
    } catch (e) {
      setPreview(null);
      setPreviewError(errorMessage(e));
    }
  };

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD((x) => ({ ...x, [k]: e.target.value }));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-3xl" bodyClassName="gap-0">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{template ? template.name : 'New template'}</SheetTitle>
          <SheetDescription>Variables are written {'{{name}}'}. Values are HTML-escaped in the HTML body; clients must provide every variable.</SheetDescription>
        </SheetHeader>
        <fieldset disabled={!canManage} className="grid gap-5 px-6 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="tpl-name" error={nameError} hint="Clients send it as &quot;template&quot;">
              <Input id="tpl-name" value={d.name} onChange={set('name')} className="font-mono" />
            </Field>
            <Field label="Description" htmlFor="tpl-desc" hint="Shown to API clients in GET /v1/templates">
              <Input id="tpl-desc" value={d.description} onChange={set('description')} />
            </Field>
          </div>
          <Field label="Subject" htmlFor="tpl-subject">
            <Input id="tpl-subject" value={d.subject} onChange={set('subject')} />
          </Field>
          <Tabs defaultValue="text">
            <TabsList>
              <TabsTrigger value="text">Text</TabsTrigger>
              <TabsTrigger value="html">HTML</TabsTrigger>
            </TabsList>
            <TabsContent value="text" className="pt-2">
              <Textarea aria-label="Text body" value={d.text} onChange={set('text')} rows={10} className="font-mono text-xs leading-5" />
            </TabsContent>
            <TabsContent value="html" className="pt-2">
              <Textarea aria-label="HTML body" value={d.html} onChange={set('html')} rows={10} className="font-mono text-xs leading-5" />
            </TabsContent>
          </Tabs>
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-secondary-foreground">Variables</span>
            {variables.length ? variables.map((v) => <Pill key={v} className="font-mono">{v}</Pill>) : <span className="text-muted-foreground">none</span>}
          </div>
          {template?.usedBy.length ? <p className="text-secondary-foreground text-sm">Allowed by {template.usedBy.join(', ')}</p> : null}
        </fieldset>

        {template && (
          <section className="grid gap-4 border-t px-6 py-5" aria-label="Preview">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Preview</h3>
              <Button size="sm" variant="outline" onClick={() => void runPreview()} disabled={dirty}>
                Render
              </Button>
            </div>
            {dirty && <p className="text-muted-foreground text-xs">Save the changes to preview them</p>}
            {variables.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {variables.map((v) => (
                  <Field key={v} label={<span className="font-mono text-xs">{v}</span>} htmlFor={`var-${v}`}>
                    <Input id={`var-${v}`} value={vars[v] ?? ''} onChange={(e) => setVars((x) => ({ ...x, [v]: e.target.value }))} />
                  </Field>
                ))}
              </div>
            )}
            {previewError && <p className="text-destructive text-sm">{previewError}</p>}
            {preview && (
              <div className="grid gap-3">
                <div className="text-sm">
                  <span className="text-secondary-foreground">Subject </span>
                  {preview.subject}
                </div>
                {preview.html && <iframe title="Template preview" sandbox="" srcDoc={preview.html} className="h-72 w-full rounded-lg border bg-white" />}
                {preview.text && <pre className="bg-muted/60 max-h-60 overflow-auto rounded-md border p-3 font-mono text-xs leading-5 whitespace-pre-wrap">{preview.text}</pre>}
              </div>
            )}
          </section>
        )}

        {canManage && (
          <div className="bg-background sticky bottom-0 flex items-center gap-2 border-t px-6 py-3">
            {template && (
              <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Delete
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={!valid || !dirty || create.isPending || update.isPending}>
                {template ? 'Save template' : 'Create template'}
              </Button>
            </div>
          </div>
        )}
        {template && (
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete "${template.name}"?`}
            description={template.usedBy.length ? `Keys ${template.usedBy.join(', ')} still allow it; remove it from their policy first.` : 'Clients sending it will get TEMPLATE_NOT_FOUND.'}
            confirmLabel="Delete template"
            destructive
            onConfirm={async () => {
              await del.mutateAsync(template.id);
              onOpenChange(false);
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

export function TemplatesPage() {
  const { can } = useMe();
  const { data, isLoading } = useTemplates();
  const [editing, setEditing] = useState<TemplateT | null>(null);
  const [open, setOpen] = useState(false);
  const canManage = can('templates:manage');

  const cols: Column<TemplateT>[] = [
    {
      id: 'name',
      header: 'Template',
      cell: (t) => (
        <div className="min-w-0">
          <div className="font-mono text-sm">{t.name}</div>
          {t.description && <div className="text-muted-foreground truncate text-xs">{t.description}</div>}
        </div>
      ),
    },
    { id: 'subject', header: 'Subject', className: 'max-w-md', cell: (t) => <span className="text-secondary-foreground block truncate">{t.subject}</span> },
    { id: 'variables', header: 'Variables', cell: (t) => <span className="text-secondary-foreground font-mono text-xs">{t.variables.join(', ') || '—'}</span> },
    { id: 'usedBy', header: 'Allowed by', cell: (t) => <span className="text-secondary-foreground">{t.usedBy.length ? `${t.usedBy.length} key${t.usedBy.length === 1 ? '' : 's'}` : 'any key'}</span> },
    { id: 'updatedAt', header: 'Updated', cell: (t) => <span className="text-secondary-foreground tabular font-mono text-xs">{fmtShort(t.updatedAt)}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Templates"
        description="Server-side messages that clients fill with variables instead of sending free-form content"
        actions={
          canManage && (
            <Button
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <Plus /> New template
            </Button>
          )
        }
      />
      <DataTable
        columns={cols}
        rows={data?.items}
        rowKey={(t) => t.id}
        loading={isLoading}
        onRowClick={(t) => {
          setEditing(t);
          setOpen(true);
        }}
        empty={{ title: 'No templates yet', description: canManage ? 'Create one, then let keys use it with "Templates only" for structured, safer sends.' : undefined }}
      />
      <TemplateEditor template={editing} open={open} onOpenChange={setOpen} canManage={canManage} />
    </>
  );
}
