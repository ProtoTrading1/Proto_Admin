export const ADMIN_REFRESH_EVENT = 'proto-admin-refresh-section';

export function dispatchAdminRefresh(section) {
  window.dispatchEvent(new CustomEvent(ADMIN_REFRESH_EVENT, { detail: section }));
}
