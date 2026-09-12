# Apollo release gates

This checklist is the release authority for Apollo. A passing build or a visible
screen is not enough to release. Every gate needs recorded, dated evidence from
the isolated preview before the corresponding production switch can be enabled.

## Data and identity

- [x] Apollo test database is separate from the portal and contains no copied
  production customer data.
- [x] Activity, retention and memory schema use RLS and service-role-only
  grants in the test database.
- [x] Memory append/read and activity retention functions were exercised in
  rolled-back test transactions; no temporary records persisted.
- [ ] A real authenticated portal test user can write activity to the isolated
  database, proving the portal UUID identity contract.
- [ ] A non-owner authenticated user is denied owner reports and memory.
- [ ] The preview uses only dedicated Apollo service credentials, never a
  portal-database fallback; secrets are server-only.

## Activity and customer reporting

- [x] Browser collection defaults off and submits no customer identity.
- [x] Main and Instore use fixed server routes; server validates the source.
- [x] Completed search, deliberate product view, category view, basket add and
  interaction/visibility-limited active intervals have focused unit coverage.
- [ ] Preview journey proves Main/Instore source separation, code search,
  misspelling, zero-result search, product click and subsequent basket add.
- [ ] Preview journey proves hidden tab, idle interval, logout and multiple-tab
  handling against database events and reporting output.
- [ ] Presence, recorded basket value and current section reconcile with
  controlled signed-in test sessions. Presence is labelled “recently active”,
  using the 150-second window, never real time.
- [ ] Reporting reads collection health and source-specific watermarks; gaps
  and stale sources are displayed rather than shown as zero.

## Website and Positill sales

- [ ] Independently reconcile portal order totals/statuses/VAT basis for SAST
  day, Monday-start week, month and custom ranges, including cancellations and
  refunds, across a dataset beyond normal API page limits.
- [x] Keep the existing `sql-bridge.proto.co.za` Cloudflare route unchanged.
  The healthy `hermes-proto-bridge1` tunnel currently maps it to
  `http://localhost:8765` on BladeRunner-PC.
- [ ] Prove the existing bridge’s configured, authenticated health path through
  the normal admin server (not a browser-exposed bridge key), then inventory
  its existing approved reports. Do not replace, restart, reconfigure or make
  the bridge publicly less restrictive for Apollo.
- [ ] Using only existing approved reports, prove invoice header/line identity,
  document type, date/timezone, tax basis, credit treatment,
  customer/reference fields and pagination semantics. A missing field remains
  unavailable; Apollo must not add arbitrary SQL capability to the bridge.
- [ ] Reconcile website/POS transactions only by explicit reference. Show
  unmatched records and never infer a link from amounts or dates.
- [ ] Product rankings preserve variant/parent distinction and do not invent
  colour/design information absent from Positill.

## Operations and release

- [ ] Set isolated-preview flags and dedicated secrets only after the preceding
  gates pass. Confirm UI/API failures are non-blocking to search and checkout.
- [ ] Browser-test the owner Business Pulse, activity source/freshness labels,
  stale-last-success behaviour and database outage responses.
- [ ] Record the exact production deployment/rollback target, then deploy the
  narrow candidate with all customer-facing flags initially disabled.
- [ ] Enable one source at a time after a controlled production test, monitor
  collection health and preserve evidence for the release record.

## Explicitly unavailable until gates pass

Apollo must answer **unavailable**—not zero or an estimate—for Positill sales,
website/POS reconciliation, active browsing time, Main/Instore search funnels,
customer-interest rankings and named current-section activity until their
relevant gates have passed.
