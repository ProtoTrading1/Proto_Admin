// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HermesPanel from '../src/components/HermesPanel.jsx';
import { installPreviewWriteGuard } from '../src/lib/previewWriteGuard.js';

let root;
let container;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.location.href = 'https://protoportal-admin-example-proto-team.vercel.app/?section=hermes';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.__protoPreviewWriteGuardInstalled;
  vi.unstubAllGlobals();
});

describe('Apollo isolated preview UI', () => {
  it('allows the customer-viewing question through the installed guard and renders a completed test answer', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ result: { summary: 'Synthetic viewing evidence', findings: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', transport);
    window.fetch = transport;
    installPreviewWriteGuard();
    vi.stubGlobal('fetch', window.fetch);
    await act(async () => root.render(React.createElement(HermesPanel, { onSelectSection: vi.fn() })));
    expect(container.textContent).toContain('Preview mode.');
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent.includes('What are customers viewing?'));
    await act(async () => button.click());
    expect(transport).toHaveBeenCalledWith('/api/codex-analytics-jobs', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({
      periodDays: 30,
      focus: 'customer_attention',
      mode: 'read_only',
      question: 'What products and categories are customers viewing, and for how long?',
      context: [],
      sourcePlan: ['customer_attention'],
    });
    expect(container.textContent).toContain('Synthetic viewing evidence');
    expect(container.textContent).toContain('Preview environment — not a live Proto check');
    expect(container.textContent).not.toContain('Live operational check');
    expect(container.textContent).not.toContain('This preview is read-only.');
    const blocked = await window.fetch('/api/site-config', { method: 'POST' });
    expect(blocked.status).toBe(409);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('labels preview health results without asserting that live Proto is healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ checks: [{ state: 'warning', label: 'Bridge', summary: 'Test bridge unavailable' }] }), { status: 200 })));
    await act(async () => root.render(React.createElement(HermesPanel, { onSelectSection: vi.fn() })));
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent.includes('Are systems healthy?'));
    await act(async () => button.click());
    expect(container.textContent).toContain('Test bridge unavailable');
    expect(container.textContent).toContain('Preview evidence only — not live operational status');
    expect(container.textContent).not.toContain('Live operational check');
  });

  it('does not add preview notices on the production domain', async () => {
    window.location.href = 'https://admin.proto.co.za/?section=hermes';
    await act(async () => root.render(React.createElement(HermesPanel, { onSelectSection: vi.fn() })));
    expect(container.textContent).not.toContain('Preview mode.');
    expect(container.textContent).toContain('What would you like to know?');
  });
});
