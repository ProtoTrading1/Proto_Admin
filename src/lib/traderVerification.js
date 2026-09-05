import { POSITILL_CUSTOMER_SALES_PERIOD } from './customerIq';

function has(value) {
  if (Array.isArray(value)) return value.some((item) => String(item || '').trim());
  return String(value || '').trim().length > 0;
}

function listText(value) {
  return Array.isArray(value) ? value.filter(has).join(', ') : String(value || '').trim();
}

export function traderVerificationSummary(customer = {}) {
  const evidence = [];

  const historicalSales = Number(customer.sales_last_12_months || 0);
  const invoices = Number(customer.invoice_count || 0);
  const hasHistory = historicalSales > 0 || invoices > 0;
  const claimedCode = String(customer.claimed_customer_code || '').trim().toUpperCase();
  if (hasHistory) {
    evidence.push({ tone: 'strong', label: 'Proto history found', detail: `${invoices || 'Previous'} invoices${historicalSales ? ` · R${historicalSales.toLocaleString('en-ZA')} in ${POSITILL_CUSTOMER_SALES_PERIOD.shortLabel} sales (${POSITILL_CUSTOMER_SALES_PERIOD.taxBasis})` : ''}` });
  } else if (claimedCode) {
    evidence.push({ tone: 'review', label: 'Old Proto code claimed', detail: `${claimedCode} · verify against email or phone before approval.` });
  } else {
    evidence.push({ tone: 'neutral', label: 'Proto history not linked', detail: 'No old code was supplied. Check the email or phone in SQL.' });
  }

  if (has(customer.sales_channels)) {
    evidence.push({ tone: 'positive', label: 'How they trade', detail: listText(customer.sales_channels) });
  }
  if (has(customer.product_categories)) {
    evidence.push({ tone: 'positive', label: 'What they sell', detail: listText(customer.product_categories) });
  } else if (has(customer.business_type)) {
    evidence.push({ tone: 'positive', label: 'Business category supplied', detail: customer.business_type });
  }
  if (has(customer.business_description)) {
    evidence.push({ tone: 'positive', label: 'Business description supplied', detail: customer.business_description });
  }
  if (has(customer.website)) {
    evidence.push({ tone: 'positive', label: 'Public business lead supplied', detail: customer.website });
  } else {
    evidence.push({ tone: 'neutral', label: 'No public business link', detail: 'This is not a reason to decline an informal trader.' });
  }
  if (has(customer.vat_number)) {
    evidence.push({ tone: 'positive', label: 'VAT number supplied', detail: customer.vat_number });
  }
  if (has(customer.company_address) && has(customer.delivery_address)) {
    evidence.push({ tone: 'positive', label: 'Addresses supplied', detail: 'Business and delivery addresses are present.' });
  }
  if (has(customer.phone) && has(customer.email)) {
    evidence.push({ tone: 'positive', label: 'Contact details supplied', detail: 'Email and phone are present.' });
  }

  const hasStructuredClassification = has(customer.sales_channels) && has(customer.product_categories);
  const hasBusinessEvidence = (hasStructuredClassification || has(customer.business_type))
    && (has(customer.business_description) || has(customer.website) || has(customer.vat_number) || has(customer.company_address));
  const recommendation = hasHistory
    ? 'Likely existing Proto customer'
    : claimedCode
      ? 'Verify claimed Proto code'
      : hasBusinessEvidence
        ? 'Trader evidence supplied'
        : 'Manual review needed';

  return {
    recommendation,
    tone: hasHistory ? 'strong' : (claimedCode || hasBusinessEvidence) ? 'review' : 'weak',
    evidence,
  };
}

export function businessSearchUrl(customer = {}) {
  const query = [customer.business_name || customer.name, customer.city, customer.province, 'South Africa business']
    .filter(has)
    .join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
