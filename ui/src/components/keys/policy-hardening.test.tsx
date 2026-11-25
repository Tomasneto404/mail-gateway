// Authored by Tomás Neto (TN 2026)
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { changeVs } from '@/components/dashboard/charts';
import { isIpRule } from '@/lib/schemas';
import { ChipsInput } from './chips-input';
import { diffPolicy, toForm } from './policy-editor';

const base = {
  id: 'k',
  name: 'agent',
  description: '',
  keyPrefix: 'mk_sbx_x…',
  mode: 'sandbox' as const,
  enabled: true,
  fromAddress: 'bot@corp.test',
  fromName: null,
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
  createdAt: '2026-11-18T10:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z',
};

describe('policy diff (new fields)', () => {
  it('sends only what changed, in API shape', () => {
    const before = toForm(base);
    const patch = diffPolicy(before, { ...before, allowedIps: ['10.0.0.0/8'], maxLinks: 3, expiresAt: '2027-01-31T18:00', templatesOnly: true });
    expect(patch).toEqual({ allowedIps: ['10.0.0.0/8'], maxLinks: 3, expiresAt: new Date('2027-01-31T18:00').toISOString(), templatesOnly: true });
    expect(diffPolicy(toForm({ ...base, expiresAt: '2027-01-01T00:00:00.000Z' }), { ...toForm({ ...base, expiresAt: '2027-01-01T00:00:00.000Z' }), expiresAt: '' })).toEqual({ expiresAt: null });
  });
});

describe('IP rules', () => {
  it('accepts addresses and ranges', () => {
    expect(['10.1.2.3', '10.0.0.0/8', '2001:db8::/32', '::1'].every(isIpRule)).toBe(true);
    expect(['300.1.1.1', '10.0.0.0/33', 'example.com', ''].some(isIpRule)).toBe(false);
  });
});

describe('ChipsInput', () => {
  it('adds valid entries and explains invalid ones', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ChipsInput label="Add IP" value={[]} onChange={onChange} validate={(v) => (isIpRule(v) ? null : 'not an IP')} />);
    await user.type(screen.getByLabelText('Add IP'), 'nope{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('"nope": not an IP');
    await user.clear(screen.getByLabelText('Add IP'));
    await user.type(screen.getByLabelText('Add IP'), '10.0.0.0/24{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['10.0.0.0/24']);
  });
});

describe('change vs previous period', () => {
  it('formats increases, decreases and edge cases', () => {
    expect(changeVs(112, 100, 'previous 24h')).toBe('+12% vs previous 24h');
    expect(changeVs(95, 100, 'previous 24h')).toBe('−5.0% vs previous 24h');
    expect(changeVs(5, 0, 'previous 24h')).toBe('5 more vs previous 24h');
    expect(changeVs(7, 7, 'previous 24h')).toBe('no change vs previous 24h');
    expect(changeVs(undefined, 3, 'x')).toBeNull();
  });
});
