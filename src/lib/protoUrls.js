/** Canonical Proto portal URLs (client). */
export const PROTO_URLS = {
  admin: 'https://admin.proto.co.za',
  register: 'https://register.proto.co.za',
  // Host that serves the portal app today.
  site: 'https://site.proto.co.za',
  // Host customers are sent to from outgoing email (mirrors api/_proto-urls.js).
  publicSite: 'https://proto.co.za',
  // Unsubscribe destination for {{unsubscribe}} (mirrors api/_proto-urls.js).
  // Preview-only here; the sent value comes from the server env.
  unsubscribe: (import.meta.env?.VITE_UNSUBSCRIBE_URL || 'mailto:online@proto.co.za?subject=Unsubscribe').trim(),
};
