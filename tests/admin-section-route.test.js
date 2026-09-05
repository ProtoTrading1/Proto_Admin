import { describe, expect, it } from 'vitest';
import {
  adminSectionUrl,
  initialAdminSectionFromSearch,
  requestedAdminSectionFromSearch,
} from '../src/lib/adminSectionRoute.js';

const OWNER_SECTIONS = ['orders', 'product-loader', 'image-processing', 'catalogue'];
const CUSTOMER_SERVICE_SECTIONS = ['orders', 'customers', 'comms'];

describe('admin section routing', () => {
  it('opens the Image Processing Centre from current and legacy deep links', () => {
    expect(requestedAdminSectionFromSearch('?section=image-processing')).toBe('image-processing');
    expect(requestedAdminSectionFromSearch('?view=image-processing')).toBe('image-processing');
    expect(requestedAdminSectionFromSearch('?section=image-replace')).toBe('image-processing');
  });

  it('chooses Image Processing Centre as the initial owner section when requested', () => {
    expect(initialAdminSectionFromSearch({
      search: '?view=image-processing',
      allowedSectionIds: OWNER_SECTIONS,
    })).toBe('image-processing');

    expect(initialAdminSectionFromSearch({
      search: '?section=image-processing',
      allowedSectionIds: OWNER_SECTIONS,
    })).toBe('image-processing');
  });

  it('keeps restricted users out of owner-only Image Processing Centre links', () => {
    expect(initialAdminSectionFromSearch({
      search: '?view=image-processing',
      allowedSectionIds: CUSTOMER_SERVICE_SECTIONS,
    })).toBe('orders');
  });

  it('keeps order workspace links on Orders regardless of section defaults', () => {
    expect(initialAdminSectionFromSearch({
      search: '?section=image-processing',
      allowedSectionIds: OWNER_SECTIONS,
      hasOrderWorkspace: true,
    })).toBe('orders');
  });

  it('normalizes Image Processing Centre URLs and removes stale view aliases', () => {
    expect(adminSectionUrl({
      pathname: '/',
      search: '?view=image-processing',
      section: 'image-processing',
    })).toBe('/?section=image-processing');
  });

  it('preserves order params only while the Orders section is active', () => {
    expect(adminSectionUrl({
      pathname: '/',
      search: '?section=orders&orderTab=sent&focusOrder=abc',
      section: 'orders',
    })).toBe('/?section=orders&orderTab=sent&focusOrder=abc');

    expect(adminSectionUrl({
      pathname: '/',
      search: '?section=orders&orderTab=sent&focusOrder=abc',
      section: 'image-processing',
    })).toBe('/?section=image-processing');
  });

  it('removes the section param for the default Product Manager section', () => {
    expect(adminSectionUrl({
      pathname: '/',
      search: '?section=image-processing&orderTab=sent',
      section: 'catalogue',
    })).toBe('/');
  });
});
