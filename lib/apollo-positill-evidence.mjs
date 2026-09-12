/**
 * A deliberately narrow adapter for the existing read-only Positill bridge.
 *
 * The bridge's `top-sellers` report exposes aggregated DBINVDT QTY/TOTAL
 * fields.  Its current contract does not establish a VAT basis, document
 * type/credit convention, or an external website-order reference.  Apollo
 * may show this as supporting evidence, but must never promote it to sales,
 * revenue, or reconciliation data.
 */

const SOURCE = 'POSWINSQL via existing read-only bridge';

function unavailable(window, checkedAt, reason) {
  return {
    source: SOURCE,
    status: 'unavailable',
    complete: false,
    data: null,
    reason,
    window,
    checkedAt,
    asOf: checkedAt,
    periodClosed: window ? Date.parse(window.end) <= Date.parse(checkedAt) : null,
    lastSuccessfulAt: null,
  };
}

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeText(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function sanitiseItems(items) {
  if (!Array.isArray(items)) throw new Error('Bridge returned an invalid report');
  return items.map((item) => {
    const code = safeText(item?.code, 80).toUpperCase();
    const quantity = finite(item?.totalQty);
    const rawTotal = finite(item?.totalValue);
    if (!code || quantity === null || rawTotal === null) throw new Error('Bridge report contains invalid raw values');
    return { code, title: safeText(item?.title || item?.name, 240) || code, quantity, rawTotal };
  });
}

/**
 * Read only an existing bridge report when the separate Apollo evidence flag
 * is enabled.  A calendar day is the sole compatible Apollo window: the
 * bridge only accepts named rolling periods, not arbitrary boundaries.
 */
export async function readPositillEvidence({ window, checkedAt = new Date().toISOString(), enabled = false, fetchTopSellers } = {}) {
  if (!enabled) return unavailable(window, checkedAt, 'Positill evidence is disabled until the existing bridge report is verified for Apollo.');
  if (!window || window.kind !== 'day') {
    return unavailable(window, checkedAt, 'The existing Positill report only supports named rolling periods; it cannot yet prove this Apollo week, month, or custom window.');
  }
  if (typeof fetchTopSellers !== 'function') return unavailable(window, checkedAt, 'Existing Positill bridge client is unavailable.');

  try {
    const report = await fetchTopSellers({ period: 'today', scope: 'top_sellers', limit: 20 });
    if (!report || report.dataSource !== 'erp_sql') throw new Error('Bridge report is unavailable');
    const items = sanitiseItems(report.items);
    const rawInvoiceHeaderCount = finite(report.invoiceHeaderCount);
    return {
      source: SOURCE,
      status: 'available',
      complete: false,
      data: {
        kind: 'raw_pos_line_aggregate_evidence',
        bridgePeriod: 'today',
        bridgePeriodLabel: safeText(report.periodLabel, 160) || 'today',
        topLineItems: items,
        rawInvoiceHeaderCount,
        taxBasis: 'unknown',
        creditNoteTreatment: 'unknown',
        documentTypeConvention: 'unknown',
        websiteReconciliation: 'unavailable',
        limitations: [
          'rawTotal is the bridge-reported DBINVDT TOTAL aggregate, not verified sales or revenue.',
          'Invoice-header count is raw report evidence; it is not a reconciled transaction count.',
          'VAT basis, credit-note handling, document types, and website-to-Positill references have not been verified.',
        ],
      },
      reason: 'Supporting Positill line evidence only; do not use as verified sales.',
      window,
      checkedAt,
      asOf: checkedAt,
      periodClosed: false,
      lastSuccessfulAt: checkedAt,
    };
  } catch {
    return unavailable(window, checkedAt, 'Existing Positill bridge report could not be read completely. Retry or check bridge health.');
  }
}

