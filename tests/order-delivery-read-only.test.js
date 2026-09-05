// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrderEmailNotify from '../src/components/OrderEmailNotify.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('order delivery control expansion', () => {
  let root;
  let container;

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
    }
    container?.remove();
    vi.restoreAllMocks();
    root = undefined;
    container = undefined;
  });

  it('loads delivery status without automatically posting notifications', async () => {
    const fetchMock = vi.fn(async (url, options = {}) => ({
      ok: true,
      json: async () => url.startsWith('/api/order-notify-log')
        ? { found: false }
        : { ok: true },
    }));
    vi.stubGlobal('fetch', fetchMock);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(OrderEmailNotify, {
        orderId: 'order-123',
        orderStatus: 'pending',
      }));
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/order-notify-log?orderId=order-123');
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(container.textContent).toContain('No delivery record yet');
  });

  it('posts only after the user clicks the explicit send button', async () => {
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      json: async () => url.startsWith('/api/order-notify-log')
        ? { found: false }
        : { ok: true },
    }));
    vi.stubGlobal('fetch', fetchMock);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(OrderEmailNotify, {
        orderId: 'order-456',
        orderStatus: 'pending',
      }));
    });
    await settle();

    const sendButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Send missing notifications'));
    expect(sendButton).toBeTruthy();

    await act(async () => {
      sendButton.click();
    });
    await settle();

    const postCalls = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0][0]).toBe('/api/order-notification');
    expect(JSON.parse(postCalls[0][1].body)).toEqual({
      orderId: 'order-456',
      action: 'send-missing',
    });
  });
});
