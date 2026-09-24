import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeWhatsappPhone, formatWhatsappPhone } from '../api/_whatsapp-phone.js';
import { isOptOutMessage, resolveWhatsappAudience, VALID_WHATSAPP_AUDIENCE } from '../api/_whatsapp-audience.js';
import { renderBodyPreview, renderParamValue, trackedLinkFor } from '../api/_whatsapp-broadcast.js';

/**
 * The WhatsApp CRM's one job it must never get wrong: only message customers
 * who opted in, and never message someone who opted out. These tests hold that
 * boundary rather than the UI around it.
 */

// ---------------------------------------------------------------------------
// Phone normalization — the live customers table is genuinely this messy.
// ---------------------------------------------------------------------------

describe('normalizeWhatsappPhone', () => {
  it('normalizes the formats real customers actually typed', () => {
    const cases = [
      ['0821234567', '27821234567'],
      ['27821234567', '27821234567'],
      ['+27 82 502 2349', '27825022349'],
      ['(082) 8641262', '27828641262'],
      ['0027821234567', '27821234567'],
      // Country code pasted in front of the local format.
      ['270821234567', '27821234567'],
      ['+27 0798938565', '27798938565'],
      // Leading zero lost by a spreadsheet.
      ['821234567', '27821234567'],
      ['264811290444', '264811290444'],
    ];
    for (const [input, expected] of cases) {
      const result = normalizeWhatsappPhone(input);
      expect(result.valid, `${input} should be valid`).toBe(true);
      expect(result.phone, `${input} normalizes`).toBe(expected);
    }
  });

  it('refuses a field holding two numbers instead of gluing them together', () => {
    // Stripping punctuation would turn these into one long number that WATI
    // would happily accept and deliver nowhere.
    for (const input of ['0839495561   0629228360', '+264818792088/811249648', '+21 988 0666 , +27 64 204 6118']) {
      const result = normalizeWhatsappPhone(input);
      expect(result.valid, `${input} is not sendable`).toBe(false);
      expect(result.reason).toMatch(/more than one number/i);
    }
  });

  it('rejects numbers that are the wrong length rather than guessing', () => {
    for (const input of ['08326205', '07184566175', '073150523', '']) {
      expect(normalizeWhatsappPhone(input).valid, `${input} is rejected`).toBe(false);
    }
  });

  it('flags a landline instead of silently dropping it', () => {
    const result = normalizeWhatsappPhone('0214470000');
    expect(result.kind).toBe('sa_landline');
    expect(result.reason).toMatch(/landline/i);
  });

  it('formats a number for display', () => {
    expect(formatWhatsappPhone('27821234567')).toBe('+27 82 123 4567');
    expect(formatWhatsappPhone('264811290444')).toBe('+264811290444');
    expect(formatWhatsappPhone('')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// Opt-out keyword detection
// ---------------------------------------------------------------------------

describe('isOptOutMessage', () => {
  it('treats the standard opt-out words as an opt-out', () => {
    for (const text of ['STOP', 'stop', ' Stop ', 'unsubscribe', 'Opt out', 'opt-out', 'remove me', 'Please stop sending me specials']) {
      expect(isOptOutMessage(text), `"${text}" opts out`).toBe(true);
    }
  });

  it('does not unsubscribe a customer mid-conversation', () => {
    // A paying customer asking about an order must not silently fall off the
    // list because the word "stop" appeared somewhere in the sentence.
    for (const text of ["don't stop the order", 'can you stop by tomorrow', 'Do you have non-stop tape?', 'yes please', '']) {
      expect(isOptOutMessage(text), `"${text}" is not an opt-out`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The consent gate. A fake Supabase client lets us assert the resolver's rules
// exactly, including the case that matters most: a browser asking to send to a
// number that has since opted out.
// ---------------------------------------------------------------------------

function fakeSupabase({ customers = [], optOuts = [] } = {}) {
  return {
    from(table) {
      const rows = table === 'customers' ? customers
        : table === 'whatsapp_opt_outs' ? optOuts.map((phone) => ({ phone }))
          : [];
      const builder = {
        _rows: rows,
        select() { return builder; },
        eq(column, value) {
          builder._rows = builder._rows.filter((row) => row[column] === value);
          return builder;
        },
        in(column, values) {
          builder._rows = builder._rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        order() { return builder; },
        range() { return Promise.resolve({ data: builder._rows, error: null }); },
        update() { return builder; },
      };
      return builder;
    },
  };
}

const customer = (overrides) => ({
  id: 'c1',
  email: 'shop@example.com',
  phone: '0821234567',
  business_name: 'Example Shop',
  contact_name: 'Sam',
  business_type: 'Retail store',
  accept_whatsapp: true,
  is_approved: true,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('resolveWhatsappAudience', () => {
  it('only ever returns customers who opted in', async () => {
    // accept_whatsapp = true is applied as a query filter, so the fake client
    // has to honour it the same way — that is the point of the assertion.
    const sb = fakeSupabase({
      customers: [
        customer({ id: 'in', phone: '0821111111' }),
        customer({ id: 'out', phone: '0822222222', accept_whatsapp: false }),
      ],
    });
    const { recipients } = await resolveWhatsappAudience(sb, { audience: 'all' });
    expect(recipients.map((r) => r.customerId)).toEqual(['in']);
  });

  it('holds back an opted-out number and says why', async () => {
    const sb = fakeSupabase({
      customers: [customer({ id: 'a', phone: '0821111111' }), customer({ id: 'b', phone: '0822222222' })],
      optOuts: ['27822222222'],
    });
    const { recipients, skipped } = await resolveWhatsappAudience(sb, { audience: 'all' });
    expect(recipients.map((r) => r.customerId)).toEqual(['a']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('Opted out of WhatsApp');
  });

  it('cannot be talked into sending to an opted-out number by a selected list', async () => {
    // The regression this guards: an admin tab open since before the opt-out
    // still holds that phone in its tick list. The browser asks for it; the
    // resolver must refuse.
    const sb = fakeSupabase({
      customers: [customer({ id: 'a', phone: '0821111111' }), customer({ id: 'b', phone: '0822222222' })],
      optOuts: ['27822222222'],
    });
    const { recipients } = await resolveWhatsappAudience(sb, {
      audience: 'selected',
      phones: ['0821111111', '0822222222'],
    });
    expect(recipients.map((r) => r.phone)).toEqual(['27821111111']);
  });

  it('cannot be talked into sending to someone who never opted in', async () => {
    const sb = fakeSupabase({
      customers: [customer({ id: 'in', phone: '0821111111' })],
    });
    const { recipients, skipped } = await resolveWhatsappAudience(sb, {
      audience: 'selected',
      phones: ['0821111111', '0829999999'],
    });
    expect(recipients.map((r) => r.phone)).toEqual(['27821111111']);
    expect(skipped.some((row) => row.phone === '27829999999')).toBe(true);
  });

  it('sends one message per number when two customers share it', async () => {
    const sb = fakeSupabase({
      customers: [
        customer({ id: 'business', phone: '0821234567' }),
        customer({ id: 'owner', phone: '+27 82 123 4567' }),
      ],
    });
    const { recipients } = await resolveWhatsappAudience(sb, { audience: 'all' });
    expect(recipients).toHaveLength(1);
  });

  it('reports an unusable number as skipped rather than dropping it', async () => {
    const sb = fakeSupabase({ customers: [customer({ id: 'bad', phone: '08326205' })] });
    const { recipients, skipped } = await resolveWhatsappAudience(sb, { audience: 'all' });
    expect(recipients).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBeTruthy();
  });

  it('accepts only the three audiences the composer offers', () => {
    expect([...VALID_WHATSAPP_AUDIENCE].sort()).toEqual(['all', 'business-type', 'selected']);
  });
});

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

describe('broadcast template rendering', () => {
  const recipient = { contactName: 'Sam Nkosi', businessName: 'Example Shop' };

  it('fills merge fields per recipient', () => {
    expect(renderParamValue('Hi {{name}}', recipient)).toBe('Hi Sam Nkosi');
    expect(renderParamValue('Hi {{first_name}}', recipient)).toBe('Hi Sam');
    expect(renderParamValue('For {{business_name}}', recipient)).toBe('For Example Shop');
  });

  it('falls back to the business when there is no contact name', () => {
    expect(renderParamValue('Hi {{name}}', { businessName: 'Example Shop' })).toBe('Hi Example Shop');
  });

  it('substitutes this recipient’s own tracked link', () => {
    const link = trackedLinkFor('abc123');
    expect(renderParamValue('See {{link}}', recipient, link)).toBe(`See ${link}`);
    expect(link).toMatch(/\/api\/wa-click\?t=abc123$/);
  });

  it('flattens values WhatsApp would reject', () => {
    // WhatsApp rejects newlines and tabs in a template variable, failing the
    // whole send rather than that one value.
    expect(renderParamValue('line one\nline two\ttabbed', recipient)).toBe('line one line two tabbed');
  });

  it('renders a body preview for the history', () => {
    expect(renderBodyPreview('Hi {{1}}, {{2}} is here', { 1: 'Sam', 2: 'October' }))
      .toBe('Hi Sam, October is here');
    // An unfilled placeholder stays visible instead of vanishing.
    expect(renderBodyPreview('Hi {{1}} and {{2}}', { 1: 'Sam' })).toBe('Hi Sam and {{2}}');
  });
});

// ---------------------------------------------------------------------------
// Boundaries that are easy to erode later
// ---------------------------------------------------------------------------

const api = (name) => fs.readFileSync(new URL(`../api/${name}`, import.meta.url), 'utf8');

describe('WhatsApp CRM boundaries', () => {
  it('keeps the customer CRM and the internal team alert on separate clients', () => {
    // _wati-notify.js is the fulfilment-team alert and is guarded by its own
    // test asserting only order-team-whatsapp.js imports it. The CRM must not
    // reach into it, or a customer broadcast could end up on the team path.
    // Match imports, not prose: both files legitimately mention the other in a
    // comment explaining why the split exists.
    const imports = (source) => [...source.matchAll(/from\s+'(\.\/[^']+)'/g)].map((match) => match[1]);
    for (const file of ['_wati-client.js', '_whatsapp-broadcast.js', 'whatsapp-broadcast.js', 'whatsapp-sync.js']) {
      expect(imports(api(file)), `${file} does not import the team alert`).not.toContain('./_wati-notify.js');
    }
    expect(imports(api('order-team-whatsapp.js')), 'the team alert does not import the CRM')
      .toEqual(expect.not.arrayContaining(['./_wati-client.js', './_whatsapp-audience.js', './_whatsapp-broadcast.js']));
  });

  it('routes every send through the consent resolver', () => {
    const broadcast = api('_whatsapp-broadcast.js');
    expect(broadcast).toMatch(/resolveWhatsappAudience/);
    // The recipient list must be the resolver's output, never the request body.
    expect(broadcast).not.toMatch(/recipients\s*=\s*(body|phones)\b/);
  });

  it('fails the webhook closed when its secret is missing', () => {
    const webhook = api('wati-webhook.js');
    expect(webhook).toMatch(/WHATSAPP_WEBHOOK_SECRET/);
    expect(webhook).toMatch(/return res\.status\(503\)/);
    expect(webhook).toMatch(/timingSafeEqual/);
    // A secret in the query string leaks through logs and referrers.
    expect(webhook).not.toMatch(/req\.query\??\.\w*secret/i);
  });

  it('never hard-codes the WATI token', () => {
    for (const file of ['_wati-client.js', 'whatsapp-sync.js', 'whatsapp-templates.js']) {
      const source = api(file);
      expect(source, `${file} reads the token from the environment`).not.toMatch(/eyJhbGciOi/);
    }
    expect(api('_wati-client.js')).toMatch(/process\.env\.WATI_API_TOKEN/);
  });

  it('only redirects a click to an https destination from our own records', () => {
    const click = api('wa-click.js');
    expect(click).toMatch(/\^\^?\\?\/?https/);
    // The destination must come from the broadcast row, not the request.
    expect(click).not.toMatch(/req\.query\??\.(url|to|redirect|dest)/);
  });

  it('requires an admin session on every WhatsApp admin route', () => {
    for (const file of [
      'whatsapp-contacts.js', 'whatsapp-templates.js', 'whatsapp-opt-outs.js',
      'whatsapp-broadcast.js', 'whatsapp-dashboard.js', 'whatsapp-status.js',
    ]) {
      expect(api(file), `${file} guards with requireAdminKey`).toMatch(/requireAdminKey\(req, res\)/);
    }
    // The cron sync accepts the cron secret as well as an admin session.
    expect(api('whatsapp-sync.js')).toMatch(/requireCronOrAdminKey\(req, res\)/);
  });

  it('proves the connection by calling WATI, not by reading an env var', () => {
    // An expired token still satisfies `process.env.WATI_API_TOKEN`. If the
    // green dot were driven by that alone it would stay green right up until a
    // broadcast failed, which is the worst moment to learn the token died.
    const status = api('whatsapp-status.js');
    expect(status).toMatch(/watiListTemplates/);
    expect(status).toMatch(/connected = true/);
    // The token itself must never travel to the browser in the status payload.
    expect(status).not.toMatch(/token:\s*token|WATI_API_TOKEN\s*[,}]/);
  });

  it('separates "WATI reachable" from "webhook delivering"', () => {
    // The two halves fail independently: sends can work perfectly while a
    // mistyped X-Webhook-Secret means every broadcast reports 0 delivered.
    const status = api('whatsapp-status.js');
    expect(status).toMatch(/WHATSAPP_WEBHOOK_SECRET/);
    expect(status).toMatch(/lastEventAt/);
  });

  it('keeps the migration file in the repo so the schema is reviewable', () => {
    const migration = fileURLToPath(new URL('../migrations/070_whatsapp_crm.sql', import.meta.url));
    expect(fs.existsSync(migration)).toBe(true);
    const sql = fs.readFileSync(migration, 'utf8');
    expect(sql).toMatch(/whatsapp_opt_outs/);
    expect(sql).toMatch(/revoke all on table public\.whatsapp_opt_outs from anon, authenticated/);
  });
});
