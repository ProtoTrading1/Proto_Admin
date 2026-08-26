import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendCustomerEmailBroadcast } from '../src/lib/customers.js';

/**
 * Regression: the composer sent `groupId`, this client dropped it on the floor,
 * and the API answered every group send with "Choose a group to send to." —
 * which reads like an empty audience picker rather than a lost field. Group
 * sending was broken from the day Groups shipped, tests included, because
 * nothing asserted on the request body.
 */
function stubFetch(response = { ok: true, sent: 3 }) {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => response,
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const bodyOf = (spy) => JSON.parse(spy.mock.calls[0][1].body);

afterEach(() => { vi.unstubAllGlobals(); });

describe('sendCustomerEmailBroadcast', () => {
  it('forwards groupId so a group send survives the API audience check', async () => {
    const spy = stubFetch();
    await sendCustomerEmailBroadcast({
      audience: 'group',
      groupId: 'grp_8f21',
      subject: 'Proto Trading is now live',
      htmlBlock: '<p>hi</p>',
    });

    expect(spy).toHaveBeenCalledWith('/api/customer-email-broadcast', expect.anything());
    expect(bodyOf(spy).groupId).toBe('grp_8f21');
    expect(bodyOf(spy).audience).toBe('group');
  });

  it('forwards groupId on a test send too — the API checks the audience before the test branch', async () => {
    const spy = stubFetch({ ok: true, test: true, sent: 1 });
    await sendCustomerEmailBroadcast({
      audience: 'group',
      groupId: 'grp_8f21',
      subject: 'Proto Trading is now live',
      htmlBlock: '<p>hi</p>',
      testEmail: 'danieljoffeinfo@gmail.com',
    });

    expect(bodyOf(spy).groupId).toBe('grp_8f21');
    expect(bodyOf(spy).testEmail).toBe('danieljoffeinfo@gmail.com');
  });

  it('still carries the fields the other audiences depend on', async () => {
    const spy = stubFetch();
    await sendCustomerEmailBroadcast({
      audience: 'all-approved',
      subject: 'Subject',
      introText: 'Body',
      businessTypes: ['Homeware & kitchenware'],
      recipients: ['jane@abcstationers.co.za'],
      importBatch: 'batch-2',
    });

    expect(bodyOf(spy)).toMatchObject({
      audience: 'all-approved',
      subject: 'Subject',
      introText: 'Body',
      businessTypes: ['Homeware & kitchenware'],
      recipients: ['jane@abcstationers.co.za'],
      importBatch: 'batch-2',
    });
  });

  it('surfaces the API error message rather than a generic failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Choose a group to send to.' }),
    }));

    await expect(sendCustomerEmailBroadcast({ audience: 'group', subject: 'x' }))
      .rejects.toThrow('Choose a group to send to.');
  });
});
