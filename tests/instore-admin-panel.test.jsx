/* @vitest-environment happy-dom */
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import InstoreProductsPanel from "../src/components/InstoreProductsPanel.jsx";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const item = {
  sku: "SKU-1",
  title: "=unsafe",
  category: "Decor",
  recorded_stock: 4,
  confirmed_qty: 3,
  availability_mode: "stock_available",
  image_url: "",
  status: "pending",
  version: 2,
  updated_at: "2026-09-18T00:00:00Z",
};
const makeApi = (overrides = {}) => ({
  fetch: vi.fn(async () => ({
    items: [item],
    total: 1,
    page: 1,
    pageSize: 50,
    publishEnabled: false,
  })),
  stage: vi.fn(async () => ({ item, existing: false })),
  update: vi.fn(async () => ({ ok: true })),
  mutate: vi.fn(async () => ({ ok: true })),
  ...overrides,
});

describe("InstoreProductsPanel", () => {
  let root;
  let container;
  afterEach(() => {
    root?.unmount();
    container?.remove();
    vi.restoreAllMocks();
  });

  it("loads status tabs and keeps publish disabled when integration is pending", async () => {
    const client = makeApi();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<InstoreProductsPanel apiClient={client} />);
    });
    expect(client.fetch).toHaveBeenCalledWith({
      status: "live",
      q: "",
      page: 1,
      pageSize: 50,
    });
    expect(container.textContent).toContain("Publish integration pending");
    expect(
      container.querySelector(
        'button[title="Publishing integration is not enabled yet"]',
      ),
    ).toBeTruthy();
  });

  it("sends version with row updates and keeps approval gated", async () => {
    const client = makeApi();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<InstoreProductsPanel apiClient={client} />);
    });
    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Save"),
    );
    await act(async () => {
      save.click();
    });
    expect(client.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: "SKU-1",
        version: 2,
        patch: expect.objectContaining({ title: "=unsafe" }),
      }),
    );
    expect(client.mutate).not.toHaveBeenCalledWith(
      "approve",
      expect.anything(),
    );
  });

  it("requires filename review before staging an exact batch", async () => {
    const client = makeApi();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<InstoreProductsPanel apiClient={client} />);
    });
    const input = container.querySelector('input[type="file"]');
    const file = new File(["image"], "SKU-1.jpg", { type: "image/jpeg" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(client.stage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("SKU-1.jpg");
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Stage selected images").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await vi.waitFor(() => expect(client.stage).toHaveBeenCalled());
    expect(client.stage.mock.calls[0][0]).toMatchObject({
      filename: "SKU-1.jpg",
      contentType: "image/jpeg",
    });
    expect(client.stage.mock.calls[0][0].batchId).toBeTruthy();
  });

  it("shows failed staged files instead of silently dropping them", async () => {
    const client = makeApi({
      stage: vi.fn(async () => {
        throw new Error("Storage unavailable");
      }),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<InstoreProductsPanel apiClient={client} />);
    });
    const input = container.querySelector('input[type="file"]');
    const file = new File(["image"], "FAILED.jpg", { type: "image/jpeg" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.stage).not.toHaveBeenCalled();
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Stage selected images").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Some staged files failed");
    expect(container.textContent).toContain("1 failed and can be retried");
  });

  it("syncs with the row version and refreshes drafts from the server", async () => {
    const fresh = { ...item, title: "Fresh server title", version: 3 };
    const client = makeApi({
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          items: [item],
          total: 1,
          page: 1,
          pageSize: 50,
          publishEnabled: false,
        })
        .mockResolvedValueOnce({
          items: [fresh],
          total: 1,
          page: 1,
          pageSize: 50,
          publishEnabled: false,
        }),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<InstoreProductsPanel apiClient={client} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const sync = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Sync"),
    );
    await act(async () => {
      sync.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.mutate).toHaveBeenCalledWith("sync", {
      sku: "SKU-1",
      version: 2,
    });
    expect(
      container.querySelector('input[aria-label="SKU-1 title"]').value,
    ).toBe("Fresh server title");
  });

  it("blocks zero, negative, fractional, and blank stock-available quantities before calling the API", async () => {
    const invalidItem = { ...item, confirmed_qty: null };
    const client = makeApi({
      fetch: vi.fn(async () => ({
        items: [invalidItem],
        total: 1,
        page: 1,
        pageSize: 50,
        publishEnabled: false,
      })),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<InstoreProductsPanel apiClient={client} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Save"),
    );
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "whole confirmed quantity of at least 1",
    );

    const quantity = container.querySelector(
      'input[aria-label="SKU-1 confirmed quantity"]',
    );
    for (const invalid of ["0", "-3", "1.5"]) {
      await act(async () => {
        quantity.value = invalid;
        quantity.dispatchEvent(new Event("input", { bubbles: true }));
        quantity.dispatchEvent(new Event("change", { bubbles: true }));
        save.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(client.update).not.toHaveBeenCalled();
    }
  });

  it("only shows confirmed quantity for stock available and clears it for Positill and to order", async () => {
    const positillItem = {
      ...item,
      availability_mode: "positill",
      confirmed_qty: 8,
    };
    const client = makeApi({
      fetch: vi.fn(async () => ({
        items: [positillItem],
        total: 1,
        page: 1,
        pageSize: 50,
        publishEnabled: false,
      })),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<InstoreProductsPanel apiClient={client} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container.querySelector('input[aria-label="SKU-1 confirmed quantity"]'),
    ).toBeNull();
    expect(container.textContent).toContain("Uses Positill stock");
    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Save"),
    );
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.update).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ confirmed_qty: null }),
      }),
    );

    const mode = container.querySelector(
      'select[aria-label="SKU-1 availability mode"]',
    );
    await act(async () => {
      mode.value = "to_order";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      container.querySelector('input[aria-label="SKU-1 confirmed quantity"]'),
    ).toBeNull();
    expect(container.textContent).toContain("Ordered on request");
  });
});

