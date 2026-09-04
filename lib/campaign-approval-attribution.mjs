function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function uniqueEmails(values) {
  return [...new Set((values || []).map(normalizeEmail).filter(Boolean))];
}

function validDate(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function approvalEntry(customer) {
  const email = normalizeEmail(customer.email);
  const approvedAt = customer.approved_at || customer.created_at || null;
  return {
    email,
    businessName: String(customer.business_name || customer.name || '').trim(),
    contactName: String(customer.contact_name || customer.name || '').trim(),
    approvedAt,
    estimated: customer.approved_at_inferred === true || !customer.approved_at,
  };
}

/**
 * Join campaign recipient snapshots to approved portal customers.
 *
 * `approved_at_inferred` distinguishes historical backfill (account creation
 * time) from approval transitions captured exactly after migration 065.
 */
export function enrichCampaignsWithApprovals(campaigns = [], customers = []) {
  const approvedByEmail = new Map();
  for (const customer of customers || []) {
    const email = normalizeEmail(customer?.email);
    if (!email || customer?.is_approved !== true) continue;
    approvedByEmail.set(email, customer);
  }

  const preparedCampaigns = (campaigns || []).map((campaign, index) => {
    const recipients = uniqueEmails(campaign?.recipientEmails);
    return {
      campaign,
      index,
      recipients,
      recipientSet: new Set(recipients),
      sentAt: validDate(campaign?.sentAt),
    };
  });
  const conversionsByCampaign = new Map();

  // Last-touch attribution: one approval is credited to the most recent
  // campaign that reached that address before approval, never to every send.
  for (const customer of approvedByEmail.values()) {
    const email = normalizeEmail(customer.email);
    const approvedAt = validDate(customer.approved_at || customer.created_at);
    if (approvedAt == null) continue;

    const attributed = preparedCampaigns
      .filter(({ recipientSet, sentAt }) => sentAt != null && sentAt <= approvedAt && recipientSet.has(email))
      .sort((a, b) => b.sentAt - a.sentAt)[0];
    if (!attributed) continue;
    const existing = conversionsByCampaign.get(attributed.index) || [];
    existing.push(approvalEntry(customer));
    conversionsByCampaign.set(attributed.index, existing);
  }

  return preparedCampaigns.map(({ campaign, index, recipients }) => {
    if (!recipients.length) {
      return {
        ...campaign,
        approvalMetrics: {
          available: false,
          approvedNow: 0,
          approvedAfterSend: 0,
          confirmedAfterSend: 0,
          estimatedAfterSend: 0,
          conversionRate: 0,
          approvedCustomers: [],
          convertedCustomers: [],
        },
      };
    }

    const approvedCustomers = recipients
      .map((email) => approvedByEmail.get(email))
      .filter(Boolean)
      .map(approvalEntry);
    const convertedCustomers = conversionsByCampaign.get(index) || [];
    const confirmedAfterSend = convertedCustomers.filter((customer) => !customer.estimated).length;
    const estimatedAfterSend = convertedCustomers.length - confirmedAfterSend;
    const accepted = Number.isFinite(campaign.sent) ? campaign.sent : recipients.length;

    return {
      ...campaign,
      approvalMetrics: {
        available: true,
        approvedNow: approvedCustomers.length,
        approvedAfterSend: convertedCustomers.length,
        confirmedAfterSend,
        estimatedAfterSend,
        conversionRate: accepted > 0 ? Math.round((convertedCustomers.length / accepted) * 10000) / 100 : 0,
        approvedCustomers,
        convertedCustomers,
      },
    };
  });
}
