function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function money(value) {
  return positiveNumber(value).toLocaleString('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function periodLabel(periodDays) {
  return Number(periodDays) === 1 ? 'today' : `the last ${positiveNumber(periodDays) || 30} days`;
}

export function buildBuyerRankingAnswer(payload, requestedPeriodDays) {
  const periodDays = positiveNumber(payload?.periodDays) || positiveNumber(requestedPeriodDays) || 30;
  const reportedPeriodLabel = String(payload?.window?.label || '').trim();
  const window = reportedPeriodLabel
    ? reportedPeriodLabel.charAt(0).toLowerCase() + reportedPeriodLabel.slice(1)
    : periodLabel(periodDays);
  const displayPeriodLabel = reportedPeriodLabel || (periodDays === 1 ? 'Today' : `${periodDays}-day view`);
  const sourceRows = Array.isArray(payload?.leaders) ? payload.leaders : (Array.isArray(payload?.topCustomersByUnits) ? payload.topCustomersByUnits : []);
  const rows = sourceRows
    .filter((row) => String(row?.displayName || row?.companyName || '').trim() && positiveNumber(row?.units) > 0)
    .map((row) => ({
      companyName: String(row.displayName || row.companyName).trim(),
      units: positiveNumber(row.units),
      orders: positiveNumber(row.orders),
      spendExVat: positiveNumber(row.valueExVat ?? row.spendExVat),
    }));
  if (!rows.length) {
    return {
      type: 'buyer_ranking',
      title: 'Top online buyer',
      summary: `No customer order requests with valid item quantities were found for ${window}.`,
      findings: [],
      limitations: ['This checks online order requests recorded in Admin; it does not prove payment or fulfilment.'],
      sources: ['Order analytics — authenticated Admin only'],
      section: 'analytics',
      periodDays,
      periodLabel: displayPeriodLabel,
      identityHandledLocally: true,
    };
  }
  const top = rows[0];
  return {
    type: 'buyer_ranking',
    title: 'Top online buyer',
    summary: `${top.companyName} placed online order requests containing the most units for ${window}: ${top.units.toLocaleString('en-ZA')} units across ${top.orders.toLocaleString('en-ZA')} order request${top.orders === 1 ? '' : 's'}, worth ${money(top.spendExVat)} ex VAT.`,
    findings: rows.slice(0, 3).map((row, index) => ({
      severity: index === 0 ? 'low' : 'info',
      title: `${index + 1}. ${row.companyName}`,
      explanation: `${row.units.toLocaleString('en-ZA')} units across ${row.orders.toLocaleString('en-ZA')} order request${row.orders === 1 ? '' : 's'}.`,
      recommendedAction: index === 0 ? 'Open Order Analytics to review the underlying authenticated order records.' : '',
      evidence: [`Order value ${money(row.spendExVat)} ex VAT`],
    })),
    limitations: [
      'This ranks online order requests by valid positive item quantities; it does not prove payment or fulfilment.',
      'Company/customer identity was resolved inside authenticated Admin and was not sent to the Codex CLI worker.',
    ],
    sources: ['Order analytics — authenticated Admin only'],
    section: 'analytics',
    periodDays,
    periodLabel: displayPeriodLabel,
    identityHandledLocally: true,
  };
}
