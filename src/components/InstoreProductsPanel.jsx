import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  FileUp,
  Loader2,
  RefreshCw,
  Search,
  UploadCloud,
} from "lucide-react";
import api from "../lib/instoreAdminApi.js";
import "./InstoreProductsPanel.css";
const TABS = ["live", "archived", "recycle"];
const PAGE_SIZE = 50;

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(items) {
  const cols = [
    "sku",
    "title",
    "category",
    "status",
    "recorded_stock",
    "confirmed_qty",
    "availability_mode",
    "review_error",
    "batch_id",
    "updated_at",
  ];
  const body = [cols, ...items.map((item) => cols.map((key) => item[key]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "instore-products.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function initialDraft(item) {
  return {
    title: item.title || "",
    category: item.category || "",
    availability_mode: item.availability_mode || "positill",
    confirmed_qty: item.confirmed_qty ?? "",
  };
}

function confirmedQuantityForSave(draft) {
  // Confirmed quantity is only meaningful before Positill has received stock.
  // Do not persist a stale manual number for normal or to-order listings.
  if (draft.availability_mode !== "stock_available") return { value: null };
  const raw = String(draft.confirmed_qty ?? "").trim();
  if (
    !/^\d+$/.test(raw) ||
    Number(raw) < 1 ||
    !Number.isSafeInteger(Number(raw))
  ) {
    return {
      error:
        "Enter a whole confirmed quantity of at least 1 for Stock available.",
    };
  }
  return { value: Number(raw) };
}

function batchUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean))
    for (let i = 0; i < bytes.length; i += 1)
      bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function InstoreProductsPanel({ apiClient = api, onShowToast }) {
  const [status, setStatus] = useState("live");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [publishEnabled, setPublishEnabled] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [drafts, setDrafts] = useState({});
  const [rowState, setRowState] = useState({});
  const [loading, setLoading] = useState(false);
  const [staging, setStaging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const batchIdRef = useRef("");
  const folderRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiClient.fetch({
        status,
        q,
        page,
        pageSize: PAGE_SIZE,
      });
      const nextItems = result.items || [];
      setItems(nextItems);
      setTotal(Number(result.total) || 0);
      setPublishEnabled(result.publishEnabled === true);
      setDrafts(
        Object.fromEntries(
          nextItems.map((item) => [item.sku, initialDraft(item)]),
        ),
      );
    } catch (err) {
      setError(err.message || "Could not load Instore Products");
    } finally {
      setLoading(false);
    }
  }, [apiClient, page, q, status]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [status, q]);

  const selectedItems = useMemo(
    () => items.filter((item) => selected.has(item.sku)),
    [items, selected],
  );
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setRow = (sku, patch) => {
    setDrafts((current) => ({
      ...current,
      [sku]: { ...current[sku], ...patch },
    }));
    // A corrected input should not retain an obsolete validation message.
    setRowState((current) =>
      current[sku]?.status === "error" ? { ...current, [sku]: null } : current,
    );
  };
  const update = async (item) => {
    const draft = drafts[item.sku] || initialDraft(item);
    const quantity = confirmedQuantityForSave(draft);
    if (quantity.error) {
      setRowState((current) => ({
        ...current,
        [item.sku]: { status: "error", message: quantity.error },
      }));
      return;
    }
    setRowState((current) => ({
      ...current,
      [item.sku]: { status: "pending", message: "Saving…" },
    }));
    try {
      const patch = { ...draft, confirmed_qty: quantity.value };
      await apiClient.update({ sku: item.sku, patch, version: item.version });
      setRowState((current) => ({
        ...current,
        [item.sku]: { status: "success", message: "Saved" },
      }));
      await load();
    } catch (err) {
      setRowState((current) => ({
        ...current,
        [item.sku]: { status: "error", message: err.message },
      }));
    }
  };

  const mutate = async (action, item, { confirm = true } = {}) => {
    if (action === "approve" && !publishEnabled) return;
    if (
      action === "approve" &&
      confirm &&
      !window.confirm(`Approve ${item.sku} for Instore Products?`)
    )
      return;
    setRowState((current) => ({
      ...current,
      [item.sku]: { status: "pending", message: `${action}…` },
    }));
    try {
      await apiClient.mutate(action, { sku: item.sku, version: item.version });
      setSelected((current) => {
        const next = new Set(current);
        next.delete(item.sku);
        return next;
      });
      await load();
    } catch (err) {
      setRowState((current) => ({
        ...current,
        [item.sku]: {
          status: "error",
          message: err.message || `${action} failed`,
        },
      }));
    }
  };

  const bulkApprove = async () => {
    if (
      !publishEnabled ||
      !selectedItems.length ||
      !window.confirm(
        `Approve ${selectedItems.length} selected Instore product${selectedItems.length === 1 ? "" : "s"}?`,
      )
    )
      return;
    for (const item of selectedItems)
      await mutate("approve", item, { confirm: false });
    // mutate removes successful rows; failed rows remain selected so the
    // operator can retry only failures without losing the selection.
  };

  const stageFolder = async (files) => {
    const images = [...(files || [])].filter(
      (file) =>
        /^image\/(jpeg|jpg|png|webp)$/i.test(file.type || "") ||
        /\.(jpe?g|png|webp)$/i.test(file.name),
    );
    if (!images.length) {
      setError("Choose a folder containing JPG, PNG, or WebP image files.");
      return;
    }
    if (!batchIdRef.current) batchIdRef.current = batchUuid();
    setStaging(true);
    setError("");
    setNotice("");
    let ok = 0;
    let failed = 0;
    for (const file of images) {
      const key = `file:${file.name}`;
      setRowState((current) => ({
        ...current,
        [key]: { status: "pending", message: "Staging…" },
      }));
      try {
        await apiClient.stage({
          batchId: batchIdRef.current,
          filename: file.name,
          imageBase64: await fileBase64(file),
          contentType: file.type || "image/jpeg",
        });
        ok += 1;
        setRowState((current) => ({
          ...current,
          [key]: { status: "success", message: "Staged" },
        }));
      } catch (err) {
        failed += 1;
        setRowState((current) => ({
          ...current,
          [key]: { status: "error", message: err.message || "Stage failed" },
        }));
      }
    }
    setStaging(false);
    setNotice(
      `${ok} image${ok === 1 ? "" : "s"} staged${failed ? `; ${failed} failed and can be retried` : ""}.`,
    );
    if (ok) {
      setStatus("archived");
      setPage(1);
      await load();
    }
  };

  return (
    <section className="instore-panel" aria-labelledby="instore-products-title">
      <div>
        <h2 id="instore-products-title">Instore Products</h2>
        <p className="instore-muted">
          Stage, review, approve, and control Instore listings. Main catalogue
          Archive is unchanged.
        </p>
      </div>
      <div className="instore-toolbar">
        <label htmlFor="instore-search">
          <Search size={15} /> Search
        </label>
        <input
          id="instore-search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="SKU, title, barcode…"
        />
        <button
          type="button"
          className="adm-btn-ghost"
          onClick={() => void load()}
        >
          <RefreshCw size={14} /> Refresh
        </button>
        <button
          type="button"
          className="adm-btn-ghost"
          onClick={() => downloadCsv(items)}
          disabled={!items.length}
        >
          Export CSV
        </button>
      </div>
      <div
        className="instore-tabs"
        role="tablist"
        aria-label="Instore product status"
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={status === tab}
            onClick={() => setStatus(tab)}
          >
            {tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      <div className="instore-bulk">
        <input
          ref={folderRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          webkitdirectory=""
          directory=""
          hidden
          onChange={(event) => {
            void stageFolder(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="adm-btn-secondary"
          onClick={() => folderRef.current?.click()}
          disabled={staging}
        >
          <UploadCloud size={15} />{" "}
          {staging ? "Staging folder…" : "Stage image folder"}
        </button>
        <button
          type="button"
          className="adm-btn-primary"
          onClick={() => void bulkApprove()}
          disabled={!publishEnabled || !selectedItems.length || staging}
          title={
            !publishEnabled
              ? "Publishing integration is not enabled yet"
              : undefined
          }
        >
          <Check size={15} /> Approve selected ({selectedItems.length})
        </button>
        {!publishEnabled && (
          <span className="instore-muted">
            Publish integration pending; approval is disabled.
          </span>
        )}
      </div>
      {error && (
        <div className="instore-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="instore-success" role="status">
          {notice}
        </div>
      )}
      {Object.entries(rowState).some(
        ([key, value]) => key.startsWith("file:") && value.status === "error",
      ) && (
        <div className="instore-error" role="alert">
          Some staged files failed. Choose the folder again to retry failed
          files; successful files are safe to skip.
        </div>
      )}
      {loading ? (
        <p className="instore-muted">
          <Loader2 className="spin" size={15} /> Loading…
        </p>
      ) : (
        <div className="instore-table-wrap">
          <table className="instore-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all visible products"
                    checked={Boolean(
                      items.length && selectedItems.length === items.length,
                    )}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? new Set(items.map((item) => item.sku))
                          : new Set(),
                      )
                    }
                  />
                </th>
                <th>Product</th>
                <th>Price / unit</th>
                <th>Availability</th>
                <th>Review</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const draft = drafts[item.sku] || initialDraft(item);
                const state = rowState[item.sku];
                const needsConfirmedQty =
                  draft.availability_mode === "stock_available";
                return (
                  <tr key={item.sku}>
                    <td className="instore-select-cell" data-label="Select">
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.sku}`}
                        checked={selected.has(item.sku)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(item.sku);
                            else next.delete(item.sku);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td data-label="Product">
                      <div className="instore-editor instore-product-editor">
                        {item.image_url ? (
                          <img
                            className="instore-thumb"
                            src={item.image_url}
                            alt=""
                          />
                        ) : (
                          <div
                            className="instore-thumb"
                            aria-label="No image"
                          />
                        )}
                        <div className="instore-product-fields">
                          <strong>{item.sku}</strong>
                          <label>
                            <span>Product description</span>
                            <input
                              aria-label={`${item.sku} title`}
                              value={draft.title}
                              onChange={(event) =>
                                setRow(item.sku, { title: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            <span>Category</span>
                            <input
                              aria-label={`${item.sku} category`}
                              value={draft.category}
                              onChange={(event) =>
                                setRow(item.sku, {
                                  category: event.target.value,
                                })
                              }
                            />
                          </label>
                        </div>
                      </div>
                    </td>
                    <td data-label="Price / unit">
                      <div className="instore-editor">
                        <strong>
                          {item.price_incl_vat == null
                            ? "—"
                            : `R${Number(item.price_incl_vat).toFixed(2)}`}
                        </strong>
                        <span>{item.units_of_issue || "—"}</span>
                      </div>
                    </td>
                    <td data-label="Availability">
                      <div className="instore-editor">
                        <label>
                          <span>Sales mode</span>
                          <select
                            aria-label={`${item.sku} availability mode`}
                            value={draft.availability_mode}
                            onChange={(event) =>
                              setRow(item.sku, {
                                availability_mode: event.target.value,
                                ...(event.target.value === "stock_available"
                                  ? {}
                                  : { confirmed_qty: "" }),
                              })
                            }
                          >
                            <option value="positill">Positill</option>
                            <option value="stock_available">
                              Stock available
                            </option>
                            <option value="to_order">To order</option>
                          </select>
                        </label>
                        <span>Recorded: {item.recorded_stock ?? "—"}</span>
                        {needsConfirmedQty ? (
                          <label>
                            <span>Confirmed quantity</span>
                            <input
                              aria-label={`${item.sku} confirmed quantity`}
                              type="number"
                              min="1"
                              step="1"
                              inputMode="numeric"
                              value={draft.confirmed_qty}
                              onChange={(event) =>
                                setRow(item.sku, {
                                  confirmed_qty: event.target.value,
                                })
                              }
                              placeholder="Confirmed qty"
                              required
                            />
                          </label>
                        ) : (
                          <span className="instore-muted">
                            {draft.availability_mode === "positill"
                              ? "Uses Positill stock"
                              : "Ordered on request"}
                          </span>
                        )}
                      </div>
                    </td>
                    <td data-label="Review">
                      <div
                        className={`instore-status${item.review_error ? " instore-status--error" : ""}`}
                      >
                        {item.status || "Pending"}
                      </div>
                      {item.review_error && (
                        <div className="instore-status--error">
                          {item.review_error}
                        </div>
                      )}
                      {state?.message && (
                        <div
                          className={`instore-status instore-status--${state.status}`}
                        >
                          {state.message}
                        </div>
                      )}
                    </td>
                    <td data-label="Actions">
                      <div className="instore-actions">
                        <button
                          type="button"
                          className="adm-btn-ghost adm-btn--sm"
                          onClick={() => void update(item)}
                          disabled={state?.status === "pending"}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="adm-btn-ghost adm-btn--sm"
                          onClick={() => void mutate("sync", item)}
                        >
                          Sync
                        </button>
                        {status === "live" && (
                          <button
                            type="button"
                            className="adm-btn-ghost adm-btn--sm"
                            onClick={() => void mutate("archive", item)}
                          >
                            Archive
                          </button>
                        )}
                        {status === "archived" && (
                          <button
                            type="button"
                            className="adm-btn-ghost adm-btn--sm"
                            onClick={() => void mutate("approve", item)}
                            disabled={!publishEnabled}
                            title={
                              !publishEnabled
                                ? "Publishing integration is not enabled yet"
                                : undefined
                            }
                          >
                            Approve
                          </button>
                        )}
                        {status === "recycle" && (
                          <button
                            type="button"
                            className="adm-btn-ghost adm-btn--sm"
                            onClick={() => void mutate("restore", item)}
                          >
                            Restore
                          </button>
                        )}
                        <button
                          type="button"
                          className="adm-btn-ghost adm-btn--sm"
                          onClick={() => void mutate("recycle", item)}
                        >
                          Recycle
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="instore-toolbar">
        <button
          type="button"
          className="adm-btn-ghost"
          disabled={page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          Previous
        </button>
        <span className="instore-muted">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className="adm-btn-ghost"
          disabled={page >= pageCount}
          onClick={() => setPage((value) => value + 1)}
        >
          Next
        </button>
        <span className="instore-muted">{total} products</span>
      </div>
    </section>
  );
}
