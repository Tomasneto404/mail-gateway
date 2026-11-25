// Authored by Tomás Neto (TN 2026)
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { KeyPolicy } from '@/api/queries';
import { PolicyEditor, diffPolicy, toForm } from './policy-editor';

const policy: KeyPolicy = {
  id: '0190-key',
  name: 'report-agent',
  description: 'nightly reports',
  keyPrefix: 'mk_sbx_abcd…',
  mode: 'sandbox',
  enabled: true,
  fromAddress: 'reports@corp.test',
  fromName: 'Reports',
  allowReplyTo: false,
  allowedRecipients: ['@corp.test'],
  maxRecipientsPerMessage: 10,
  maxMessageBytes: 1048576,
  quotaPerHour: 50,
  quotaPerDay: 200,
  attachmentsAllowed: false,
  maxAttachmentBytes: 5242880,
  liveProvider: null,
  allowedIps: [],
  expiresAt: null,
  previousSecretValidUntil: null,
  allowedLinkDomains: [],
  maxLinks: null,
  blockSecrets: true,
  allowedAttachmentTypes: [],
  scanAttachments: false,
  allowDuplicates: false,
  templatesOnly: false,
  allowedTemplates: [],
  warmup: true,
  liveSince: null,
  warmupState: null,
  prefixStale: false,
  lastUsedAt: null,
  rotatedAt: null,
  createdAt: '2026-11-16T10:00:00Z',
  updatedAt: '2026-11-16T10:00:00Z',
};

function setup(over: Partial<KeyPolicy> = {}, props: { readOnly?: boolean; canUpdate?: boolean; canPromote?: boolean } = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<PolicyEditor policy={{ ...policy, ...over }} onSave={onSave} {...props} />);
  return { onSave, user };
}

describe('PolicyEditor', () => {
  it('renders the current policy', () => {
    setup();
    expect(screen.getByLabelText('From address')).toHaveValue('reports@corp.test');
    expect(screen.getAllByTestId('recipient-chip').map((c) => c.textContent)).toEqual(['@corp.test']);
    expect(screen.getByRole('radio', { name: 'Sandbox' })).toHaveAttribute('aria-checked', 'true');
  });

  it('recipient chips: rejects invalid entries, accepts addresses and @domains, removes chips', async () => {
    const { user } = setup();
    const input = screen.getByLabelText('Add allowed recipient');
    await user.type(input, 'example.com{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('"example.com" is not valid');
    expect(screen.getAllByTestId('recipient-chip')).toHaveLength(1);

    await user.clear(input);
    await user.type(input, 'Ops@Partner.io{Enter}@other.test,');
    expect(screen.getAllByTestId('recipient-chip').map((c) => c.textContent)).toEqual(['@corp.test', 'ops@partner.io', '@other.test']);

    await user.click(screen.getByRole('button', { name: 'Remove @corp.test' }));
    expect(screen.getAllByTestId('recipient-chip')).toHaveLength(2);
  });

  it('accepts * (any recipient) and says so', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('Add allowed recipient'), '*{Enter}');
    expect(screen.getAllByTestId('recipient-chip').map((c) => c.textContent)).toEqual(['@corp.test', '*']);
    expect(screen.getByText(/allows any recipient/)).toBeInTheDocument();
  });

  it('warns about an empty allow-list', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Remove @corp.test' }));
    expect(screen.getByText(/cannot send to anyone/)).toBeInTheDocument();
  });

  it('shows a clear warning when promoting to live and requires confirmation', async () => {
    const { user, onSave } = setup();
    expect(screen.queryByText('Promoting to live')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Live' }));
    expect(screen.getByText('Promoting to live')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Promote "report-agent" to live?')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Promote to live' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ mode: 'live' }));
  });

  it('validates with zod and does not save invalid input', async () => {
    const { user, onSave } = setup();
    const from = screen.getByLabelText('From address');
    await user.clear(from);
    await user.type(from, 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByText('Enter a plain email address')).toBeInTheDocument();

    await user.clear(from);
    await user.type(from, 'reports@corp.test');
    const q = screen.getByLabelText('Quota per hour');
    await user.clear(q);
    await user.type(q, '-5');
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByText('Must be 0 or more')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves only the changed fields', async () => {
    const { user, onSave } = setup();
    const q = screen.getByLabelText('Quota per hour');
    await user.clear(q);
    await user.type(q, '20');
    await user.click(screen.getByRole('switch', { name: 'Allow attachments' }));
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ quotaPerHour: 20, attachmentsAllowed: true }));
  });

  it('allow repeated messages saves allowDuplicates', async () => {
    const { user, onSave } = setup();
    await user.click(screen.getByRole('switch', { name: 'Allow repeated messages' }));
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ allowDuplicates: true }));
  });

  it('is read-only for viewers', () => {
    setup({}, { readOnly: true });
    expect(screen.getByLabelText('From address')).toBeDisabled();
    expect(screen.getByLabelText('Add allowed recipient')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
  });
});

describe('PolicyEditor RBAC', () => {
  it('without keys:promote the Live and Approval modes are disabled', () => {
    setup({}, { canPromote: false });
    expect(screen.getByRole('radio', { name: 'Live' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Approval' })).toBeDisabled();
    expect(screen.getByLabelText('From address')).toBeEnabled();
    expect(screen.getByText(/do not allow promoting/)).toBeInTheDocument();
  });

  it('with only keys:promote, just the mode can change', async () => {
    const { user, onSave } = setup({}, { canUpdate: false, canPromote: true });
    expect(screen.getByLabelText('From address')).toBeDisabled();
    expect(screen.getByLabelText('Quota per hour')).toBeDisabled();
    expect(screen.getByLabelText('Add allowed recipient')).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Approval' }));
    await user.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ mode: 'approval' }));
  });
});

describe('diffPolicy', () => {
  it('maps the "default" provider to null and empty fromName to null', () => {
    const before = toForm({ ...policy, liveProvider: 'smtp' });
    expect(diffPolicy(before, { ...before, liveProvider: 'default', fromName: '' })).toEqual({ liveProvider: null, fromName: null });
  });
});
