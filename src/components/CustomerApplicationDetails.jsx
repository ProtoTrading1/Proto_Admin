import React from 'react';
import {
  Building2,
  CalendarDays,
  CheckCircle,
  CircleHelp,
  Globe,
  MapPin,
  MessageCircle,
  Search,
  ShoppingBag,
  Store,
} from 'lucide-react';

function text(value) {
  return String(value ?? '').trim();
}

function values(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

export function applicationWebsiteHref(value) {
  const raw = text(value);
  if (!raw) return '';
  const hasExplicitWebScheme = /^https?:\/\//i.test(raw);
  const looksLikeDomain = /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?:[/:?#].*)?$/i.test(raw);
  if (!hasExplicitWebScheme && !looksLikeDomain) return '';
  try {
    const url = new URL(hasExplicitWebScheme ? raw : `https://${raw}`);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export function applicationAddress(customer = {}) {
  const structured = [
    [text(customer.building_type), text(customer.unit_number)].filter(Boolean).join(' '),
    text(customer.street_name),
    text(customer.suburb),
    text(customer.city),
    text(customer.province),
    text(customer.postal_code),
    text(customer.country),
  ].filter(Boolean);
  return structured.length ? structured.join(', ') : text(customer.delivery_address);
}

export function hasApplicationAnswers(customer = {}) {
  return [
    customer.sales_channels,
    customer.product_categories,
    customer.business_description,
    customer.monthly_spend,
    customer.website,
    customer.claimed_customer_code,
    customer.vat_number,
    customer.company_address,
    applicationAddress(customer),
    customer.accept_whatsapp,
  ].some((value) => Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && text(value));
}

function Detail({ icon: Icon, label, children, wide = false }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className={`adm-application-detail${wide ? ' adm-application-detail--wide' : ''}`}>
      <Icon size={15} aria-hidden="true" />
      <div>
        <div className="adm-application-detail-label">{label}</div>
        <div className="adm-application-detail-value">{children}</div>
      </div>
    </div>
  );
}

function Chips({ items }) {
  return (
    <div className="adm-application-chips">
      {items.map((item) => <span key={item}>{item}</span>)}
    </div>
  );
}

export default function CustomerApplicationDetails({ customer }) {
  const isOnHold = customer.application_status === 'on_hold';
  const salesChannels = values(customer.sales_channels);
  const productCategories = values(customer.product_categories);
  const deliveryAddress = applicationAddress(customer);
  const websiteHref = applicationWebsiteHref(customer.website);
  const applicationDate = customer.created_at
    ? new Date(customer.created_at).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const whatsappAnswer = customer.accept_whatsapp == null
    ? 'Not answered'
    : customer.accept_whatsapp ? 'Yes — opted in' : 'No — opted out';

  return (
    <section className="adm-application" aria-labelledby="customer-application-heading">
      <div className="adm-application-head">
        <div>
          <span className="adm-application-kicker">Online trade application</span>
          <h3 id="customer-application-heading">Application details</h3>
        </div>
        <span className={`adm-application-status adm-application-status--${customer.is_approved ? 'approved' : isOnHold ? 'on-hold' : 'pending'}`}>
          {customer.is_approved ? <CheckCircle size={13} aria-hidden="true" /> : <CircleHelp size={13} aria-hidden="true" />}
          {customer.is_approved ? 'Approved' : isOnHold ? 'On hold' : 'Awaiting review'}
        </span>
      </div>
      <p className="adm-application-note">
        Answers captured through the online application. Contact preferences and addresses may reflect later customer updates.
      </p>

      {isOnHold && (
        <div className="adm-application-hold-note">
          <strong>On-hold reason</strong>
          <span>{text(customer.application_hold_reason) || 'No reason recorded.'}</span>
        </div>
      )}

      {hasApplicationAnswers(customer) ? (
        <div className="adm-application-grid">
          <Detail icon={Store} label="How they trade" wide>
            {salesChannels.length ? <Chips items={salesChannels} /> : 'Not answered'}
          </Detail>
          <Detail icon={ShoppingBag} label="What they sell" wide>
            {productCategories.length ? <Chips items={productCategories} /> : (text(customer.business_type) || 'Not answered')}
          </Detail>
          <Detail icon={MessageCircle} label="Their business in their own words" wide>
            {text(customer.business_description) || 'Not answered'}
          </Detail>
          <Detail icon={Building2} label="Estimated monthly spend">{text(customer.monthly_spend) || 'Not answered'}</Detail>
          <Detail icon={Globe} label="Website or social page">
            {text(customer.website)
              ? websiteHref
                ? <a href={websiteHref} target="_blank" rel="noreferrer">{text(customer.website)}</a>
                : text(customer.website)
              : 'Not answered'}
          </Detail>
          <Detail icon={Search} label="Previous Proto code supplied">{text(customer.claimed_customer_code) || 'None supplied'}</Detail>
          <Detail icon={MessageCircle} label="WhatsApp permission">{whatsappAnswer}</Detail>
          <Detail icon={Building2} label="VAT number">{text(customer.vat_number) || 'None supplied'}</Detail>
          <Detail icon={MapPin} label="Company address" wide>{text(customer.company_address) || 'Not answered'}</Detail>
          <Detail icon={MapPin} label="Delivery address" wide>{deliveryAddress || 'Not answered'}</Detail>
        </div>
      ) : (
        <div className="adm-application-empty">
          No structured online-application answers were captured for this customer.
        </div>
      )}

      {applicationDate && (
        <div className="adm-application-date">
          <CalendarDays size={13} aria-hidden="true" /> Submitted {applicationDate}
        </div>
      )}
    </section>
  );
}
