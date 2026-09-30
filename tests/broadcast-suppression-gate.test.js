import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ audience: vi.fn(), selected: vi.fn(), send: vi.fn(), suppression: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('../api/_brevo-email.js', () => ({ fetchCustomerAudience: mocks.audience, fetchRecipientsByEmail: mocks.selected, sendBroadcastBatch: mocks.send }));
vi.mock('../api/_brevo-suppression.js', () => ({ excludeBrevoSuppressedRecipients: mocks.suppression }));
vi.mock('../api/_email-campaigns.js', () => ({ appendEmailCampaign: vi.fn() }));
vi.mock('../api/_customer-email-status.js', () => ({ markCustomersEmailed: vi.fn(), markCrmContactsEmailed: vi.fn() }));
import { runEmailBroadcast } from '../api/_send-email-broadcast.js';

afterEach(() => vi.resetAllMocks());
describe('real broadcast suppression gate', () => {
  it.each(['group', 'all-approved', 'selected'])('checks fresh suppression before sending %s', async (audience) => {
    const candidates = [{ email: 'keep@example.test' }, { email: 'blocked@example.test' }];
    mocks.audience.mockResolvedValue(candidates);
    mocks.selected.mockResolvedValue(candidates);
    mocks.suppression.mockResolvedValue([candidates[0]]);
    mocks.send.mockResolvedValue({ sent: 1, failed: 0, errors: [], failedEmails: [], messageIds: [] });
    await runEmailBroadcast({ audience, groupId: 'national', recipients: audience === 'selected' ? candidates.map((r) => r.email) : null, subject: 'Test' });
    expect(mocks.suppression).toHaveBeenCalledWith(candidates);
    expect(mocks.send.mock.calls[0][0]).toEqual([candidates[0]]);
  });
  it('sends nothing and propagates an unavailable suppression check', async () => {
    mocks.audience.mockResolvedValue([{ email: 'keep@example.test' }]);
    mocks.suppression.mockRejectedValue(new Error('Brevo 429'));
    await expect(runEmailBroadcast({ audience: 'group', groupId: 'national', subject: 'Test' })).rejects.toThrow('Brevo 429');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
