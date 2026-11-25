// Authored by Tomás Neto (TN 2026)
import { Link } from '@tanstack/react-router';
import { Send } from 'lucide-react';
import { useState } from 'react';
import type { KeyPolicy } from '@/api/queries';
import { useMessage, useTestSend } from '@/api/queries';
import { ApiError } from '@/api/client';
import { StatusBadge } from '@/components/common/badges';
import { Field } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

function suggestRecipient(k: KeyPolicy) {
  const exact = k.allowedRecipients.find((r) => !r.startsWith('@') && r !== '*');
  if (exact) return exact;
  const dom = k.allowedRecipients.find((r) => r.startsWith('@'));
  return dom ? `test${dom}` : '';
}

/** Sends through the normal pipeline with this key (full policy enforcement) and follows the status. */
export function TestSendDialog({ policy, disabled }: { policy: KeyPolicy; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(suggestRecipient(policy));
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [sentId, setSentId] = useState<string>();
  const [err, setErr] = useState<ApiError | null>(null);
  const send = useTestSend(policy.id);
  const msg = useMessage(sentId);

  return (
    <>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        <Send className="size-4" /> Send test email
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setSentId(undefined);
            setErr(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send test email</DialogTitle>
            <DialogDescription>
              Uses key <b>{policy.name}</b> ({policy.mode}) and its policy. {policy.mode === 'sandbox' ? 'It will land in Mailpit.' : 'This will be delivered for real.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field label="To" htmlFor="ts-to">
              <Input id="ts-to" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Subject" htmlFor="ts-subject" hint="Optional">
              <Input id="ts-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={`mail-gateway test (${policy.name})`} />
            </Field>
            <Field label="Text" htmlFor="ts-text" hint="Optional">
              <Textarea id="ts-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            {err && (
              <div role="alert" className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-2 text-sm">
                <span className="font-mono text-xs">{err.code}</span> — {err.message}
              </div>
            )}
            {sentId && (
              <div data-testid="test-send-result" className="flex items-center justify-between rounded-md border p-2 text-sm">
                <span className="flex items-center gap-2">
                  Status: {msg.data ? <StatusBadge status={msg.data.status} /> : '…'}
                </span>
                <Link to="/messages" search={{ id: sentId }} className="text-brand text-sm hover:underline">
                  Open in Messages
                </Link>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={send.isPending || !to}
              onClick={async () => {
                setErr(null);
                try {
                  const r = await send.mutateAsync({ to, ...(subject ? { subject } : {}), ...(text ? { text } : {}) });
                  setSentId(r.id);
                } catch (e) {
                  if (e instanceof ApiError) setErr(e);
                }
              }}
            >
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
