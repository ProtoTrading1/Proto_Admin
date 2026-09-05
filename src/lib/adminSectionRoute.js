export const DEFAULT_OWNER_SECTION = 'catalogue';

export function normalizeRequestedAdminSection(value) {
  const section = String(value || '').trim();
  if (section === 'image-replace') return 'image-processing';
  return section;
}

export function requestedAdminSectionFromSearch(search = '') {
  const params = new URLSearchParams(search);
  return normalizeRequestedAdminSection(params.get('section') || params.get('view'));
}

export function initialAdminSectionFromSearch({
  search = '',
  allowedSectionIds = [],
  hasOrderWorkspace = false,
  fallbackSection = 'orders',
} = {}) {
  const preferred = hasOrderWorkspace
    ? 'orders'
    : requestedAdminSectionFromSearch(search) || DEFAULT_OWNER_SECTION;
  return allowedSectionIds.includes(preferred) ? preferred : allowedSectionIds[0] || fallbackSection;
}

export function adminSectionUrl({ pathname = '/', search = '', hash = '', section = DEFAULT_OWNER_SECTION } = {}) {
  const params = new URLSearchParams(search);
  if (section && section !== DEFAULT_OWNER_SECTION) {
    params.set('section', section);
  } else {
    params.delete('section');
  }
  params.delete('view');

  if (section !== 'orders') {
    params.delete('orderTab');
    params.delete('focusOrder');
  }

  const nextSearch = params.toString();
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`;
}
