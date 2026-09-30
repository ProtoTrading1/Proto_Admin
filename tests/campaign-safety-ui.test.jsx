/* @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CustomerEmailModal from '../src/components/CustomerEmailModal.jsx';
import EmailUnsubscribesPanel from '../src/components/EmailUnsubscribesPanel.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.React = React;
let root;
let container;
const response = (data, ok = true) => ({ ok, json: async () => data });
async function mount(component) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(component));
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
});

describe('campaign audience safety', () => {
  it('keeps the requested group while loading and selects it once loaded', async () => {
    let finishGroups;
    vi.stubGlobal('fetch', vi.fn((url) => url === '/api/email-groups'
      ? new Promise((resolve) => { finishGroups = resolve; })
      : Promise.resolve(response({ campaigns: [] }))));
    await mount(<CustomerEmailModal open initialAudience="group" initialGroupId="national" />);
    const picker = container.querySelector('select');
    expect(picker.value).toBe('group::national');
    expect(container.textContent).not.toContain('Ready to send to Approved trade customers');
    expect([...container.querySelectorAll('button')].find((b) => b.textContent.includes('Send now')).disabled).toBe(true);
    await act(async () => finishGroups(response({ groups: [{ id: 'national', name: 'National Prospects', memberCount: 11936 }] })));
    expect(picker.value).toBe('group::national');
    expect(picker.selectedOptions[0].textContent).toContain('National Prospects');
    expect([...container.querySelectorAll('button')].find((b) => b.textContent.includes('Send now')).disabled).toBe(false);
  });

  it('does not substitute approved customers when group loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => Promise.resolve(url === '/api/email-groups'
      ? response({ error: 'Groups unavailable' }, false) : response({ campaigns: [] }))));
    await mount(<CustomerEmailModal open initialAudience="group" initialGroupId="national" />);
    expect(container.querySelector('select').value).toBe('group::national');
    expect(container.textContent).toContain('Groups unavailable');
    expect([...container.querySelectorAll('button')].find((b) => b.textContent.includes('Send now')).disabled).toBe(true);
  });

  it('paginates one snapshot without refetching Brevo or reacting to new toast callbacks', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(response({ rows: Array.from({ length: 101 }, (_, i) => ({ email: `blocked${i}@example.test` })) }));
    vi.stubGlobal('fetch', fetchSpy);
    await mount(<EmailUnsubscribesPanel onShowToast={() => {}} />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toContain('all=1');
    const next = container.querySelector('[aria-label="Next page"]');
    await act(async () => next.click());
    expect(container.textContent).toContain('Page 2 of 3');
    expect(container.textContent).toContain('blocked50@example.test');
    await act(async () => root.render(<EmailUnsubscribesPanel onShowToast={() => {}} />));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('shows a failed lookup explicitly and does not retry in a render loop', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(response({ error: 'Brevo 429' }, false));
    vi.stubGlobal('fetch', fetchSpy);
    await mount(<EmailUnsubscribesPanel onShowToast={() => {}} />);
    expect(container.querySelector('[role="alert"]').textContent).toContain('Brevo 429');
    expect(container.textContent).not.toContain('No unsubscribed contacts yet');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
