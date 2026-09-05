/** Canonical Proto portal URLs — override via Vercel env if needed. */
export const PROTO_URLS = {
  admin: (process.env.ADMIN_PORTAL_URL || 'https://admin.proto.co.za').replace(/\/$/, ''),
  register: (process.env.REGISTER_PORTAL_URL || 'https://register.proto.co.za').replace(/\/$/, ''),

  // Origin the admin app CALLS server-to-server (e.g. POST /api/orders/notify).
  // It must be a host that actually runs the portal's serverless functions, so
  // it is deliberately NOT repointed with the customer-facing links below.
  site: (process.env.MAIN_PORTAL_URL || 'https://site.proto.co.za').replace(/\/$/, ''),

  // Origin customers CLICK in outgoing email. Proto is migrating the portal to
  // proto.co.za, so every link we mail out must land there. Keep this separate
  // from `site` — flipping the API base by accident breaks order notifications.
  publicSite: (process.env.PUBLIC_SITE_URL || 'https://proto.co.za').replace(/\/$/, ''),
};
