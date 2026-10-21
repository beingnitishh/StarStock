"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { BulkUploadModal } from "@/components/BulkUploadModal";
import { ProductFormModal } from "@/components/ProductFormModal";
import { useCanWrite, useSession } from "@/components/session";
import { StockOpModal } from "@/components/StockOpModal";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  ProductThumb,
  Select,
  StockAmount,
  useToast,
} from "@/components/ui";
import { fmtInt, skuCompare } from "@/lib/units";
import type { OpType, ProductRow, Warehouse } from "@/lib/types";

type SortKey = "sku-asc" | "sku-desc" | "stock-desc" | "stock-asc";

export default function InventoryPage() {
  const router = useRouter();
  const toast = useToast();
  const canWrite = useCanWrite();
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const user = useSession();
  const isAdmin = user?.role === "admin";
  const [search, setSearch] = useState("");
  const [whFilter, setWhFilter] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("sku-asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [deleteSelectedOpen, setDeleteSelectedOpen] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [forceDeleting, setForceDeleting] = useState(false);
  const [verifyPassword, setVerifyPassword] = useState("");
  const [forceDeleteError, setForceDeleteError] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const [opModal, setOpModal] = useState<{ open: boolean; type: OpType; productId?: number }>({
    open: false,
    type: "inbound",
  });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [pRes, wRes] = await Promise.all([
        fetch("/api/products"),
        fetch("/api/warehouses"),
      ]);
      const [pData, wData] = await Promise.all([pRes.json(), wRes.json()]);
      if (!pRes.ok || !wRes.ok) throw new Error(pData.error ?? wData.error ?? "Failed to load.");
      const nextProducts = (pData.products ?? []) as ProductRow[];
      setProducts(nextProducts);
      setSelectedIds((current) => {
        const existingIds = new Set(nextProducts.map((product) => product.id));
        const next = new Set([...current].filter((id) => existingIds.has(id)));
        return next.size === current.size ? current : next;
      });
      setWarehouses(wData.warehouses ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    let list = [...products];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
      );
    }
    if (whFilter) {
      list = list.filter((p) => p.stocks.some((s) => s.warehouseId === Number(whFilter)));
    }
    if (lowOnly) {
      list = list.filter((p) => p.totalPieces < Math.max(p.cartonContains, 1));
    }
    switch (sort) {
      case "sku-asc":
        list.sort((a, b) => skuCompare(a.sku, b.sku));
        break;
      case "sku-desc":
        list.sort((a, b) => skuCompare(b.sku, a.sku));
        break;
      case "stock-desc":
        list.sort((a, b) => b.totalPieces - a.totalPieces);
        break;
      case "stock-asc":
        list.sort((a, b) => a.totalPieces - b.totalPieces);
        break;
    }
    return list;
  }, [products, search, whFilter, lowOnly, sort]);

  const selectedProducts = useMemo(
    () => products.filter((product) => selectedIds.has(product.id)),
    [products, selectedIds],
  );
  const selectedWithStock = useMemo(
    () => selectedProducts.filter((product) => product.stocks.some((stock) => stock.qtyPieces > 0)),
    [selectedProducts],
  );
  const visibleSelectedCount = filtered.filter((product) => selectedIds.has(product.id)).length;
  const allFilteredSelected = filtered.length > 0 && visibleSelectedCount === filtered.length;
  const partiallyFilteredSelected = visibleSelectedCount > 0 && !allFilteredSelected;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallyFilteredSelected;
    }
  }, [partiallyFilteredSelected]);

  function toggleProductSelection(id: number, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleFilteredSelection(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const product of filtered) {
        if (checked) next.add(product.id);
        else next.delete(product.id);
      }
      return next;
    });
  }

  async function exportExcel() {
    try {
      const res = await fetch("/api/export/stock");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Export failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `star-stock-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast.push("success", "Export ready", "Current stock downloaded as Excel.");
    } catch (e) {
      toast.push("error", "Export failed", e instanceof Error ? e.message : undefined);
    }
  }

  async function deleteSelectedProducts() {
    if (deletingSelected || selectedProducts.length === 0 || selectedWithStock.length > 0) return;

    const ids = selectedProducts.map((product) => product.id);
    setDeletingSelected(true);
    try {
      const res = await fetch("/api/products/bulk", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        deleted?: Array<{ id: number; sku: string }>;
      };
      if (!res.ok) throw new Error(data.error ?? "Delete failed.");

      const deletedIds = new Set(data.deleted?.map((product) => product.id) ?? ids);
      setProducts((current) => current.filter((product) => !deletedIds.has(product.id)));
      setSelectedIds((current) => new Set([...current].filter((id) => !deletedIds.has(id))));
      setDeleteSelectedOpen(false);
      const count = data.deleted?.length ?? ids.length;
      toast.push(
        "success",
        "Products deleted",
        `${fmtInt(count)} selected SKU${count === 1 ? " was" : "s were"} removed from the catalog.`,
      );
    } catch (e) {
      toast.push(
        "error",
        "Could not delete selected SKUs",
        e instanceof Error ? e.message : "Please try again.",
      );
      // Refresh stock in case it changed after this selection was made.
      void load();
    } finally {
      setDeletingSelected(false);
    }
  }

  /** Force delete selected SKUs — including ones that still hold stock — after
   * verifying the signed-in Admin's password. */
  async function forceDeleteSelected() {
    if (forceDeleting || selectedProducts.length === 0 || !isAdmin) return;
    if (!verifyPassword.trim()) {
      setForceDeleteError("Enter your admin password to verify.");
      return;
    }

    const ids = selectedProducts.map((product) => product.id);
    setForceDeleteError(null);
    setForceDeleting(true);
    try {
      const res = await fetch("/api/products/bulk/force-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, password: verifyPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        deleted?: Array<{ id: number; sku: string }>;
      };
      if (!res.ok) throw new Error(data.error ?? "Force delete failed.");

      const deletedIds = new Set(data.deleted?.map((product) => product.id) ?? ids);
      setProducts((current) => current.filter((product) => !deletedIds.has(product.id)));
      setSelectedIds((current) => new Set([...current].filter((id) => !deletedIds.has(id))));
      setDeleteSelectedOpen(false);
      setVerifyPassword("");
      setForceDeleteError(null);
      const count = data.deleted?.length ?? ids.length;
      toast.push(
        "success",
        "Products force deleted",
        `${fmtInt(count)} selected SKU${count === 1 ? " was" : "s were"} removed from the catalog, along with their stock and movement history.`,
      );
    } catch (e) {
      setForceDeleteError(e instanceof Error ? e.message : "Please try again.");
      // Refresh stock in case it changed after this selection was made.
      void load();
    } finally {
      setForceDeleting(false);
    }
  }

  return (
    <div className="rise-in space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight">Inventory</h1>
          <p className="mt-1 text-sm text-ink-faint">
            {fmtInt(products.length)} products · sorted by SKU · stock across {warehouses.length}{" "}
            warehouse{warehouses.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button variant="secondary" icon="download" onClick={exportExcel} className="flex-1 justify-center sm:flex-none">
            <span className="hidden sm:inline">Export Excel</span>
            <span className="sm:hidden">Export</span>
          </Button>
          {canWrite ? (
            <>
              <Button
                variant="secondary"
                icon="upload"
                onClick={() => setBulkOpen(true)}
                className="flex-1 justify-center sm:flex-none"
              >
                <span className="hidden sm:inline">Bulk upload</span>
                <span className="sm:hidden">Bulk</span>
              </Button>
              <Button
                variant="primary"
                icon="plus"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
                className="flex-1 justify-center sm:flex-none"
              >
                <span className="hidden sm:inline">List product</span>
                <span className="sm:hidden">New</span>
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-card p-3">
        <div className="relative w-full min-w-0 flex-1 sm:w-auto sm:min-w-[240px]">
          <Icon
            name="search"
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by SKU or product name…"
            className="pl-9"
          />
        </div>
        <Select value={whFilter} onChange={(e) => setWhFilter(e.target.value)} className="w-full flex-1 sm:w-44 sm:flex-none">
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="w-full flex-1 sm:w-40 sm:flex-none">
          <option value="sku-asc">SKU A → Z</option>
          <option value="sku-desc">SKU Z → A</option>
          <option value="stock-desc">Stock high → low</option>
          <option value="stock-asc">Stock low → high</option>
        </Select>
        <label className="flex w-full cursor-pointer select-none items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs font-semibold text-ink-soft sm:w-auto">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(e) => setLowOnly(e.target.checked)}
            className="h-3.5 w-3.5 accent-[#0e6b5c]"
          />
          Low stock only
        </label>
      </div>

      {canWrite && selectedIds.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/20 bg-brand-soft/40 px-3.5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <Icon name="check" className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-bold text-ink">
                {fmtInt(selectedIds.size)} product{selectedIds.size === 1 ? "" : "s"} selected
              </p>
              {visibleSelectedCount !== selectedIds.size ? (
                <p className="text-xs text-ink-faint">
                  {fmtInt(visibleSelectedCount)} visible with the current filters
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSelectedIds(new Set())}
              className="flex-1 sm:flex-none"
            >
              Clear selection
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="trash"
              onClick={() => {
                setVerifyPassword("");
                setForceDeleteError(null);
                setDeleteSelectedOpen(true);
              }}
              className="flex-1 sm:flex-none"
            >
              Delete selected
            </Button>
          </div>
        </div>
      ) : null}

      {/* Table */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-ink/5" />
          ))}
        </div>
      ) : loadError ? (
        <EmptyState
          icon="alert"
          title="Could not load inventory"
          text={loadError}
          action={<Button variant="primary" onClick={load}>Retry</Button>}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="box"
          title={products.length === 0 ? "No products listed yet" : "Nothing matches your filters"}
          text={
            products.length === 0
              ? "List a single product or upload a bulk file to build your catalog."
              : "Try a different search term or clear the filters."
          }
          action={
            products.length === 0 && canWrite ? (
              <Button
                variant="primary"
                icon="plus"
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                List your first product
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="-mx-4 overflow-x-auto rounded-none border-y border-line bg-card px-4 sm:mx-0 sm:rounded-xl sm:border sm:px-0">
          <table className="w-full min-w-[820px] text-left sm:min-w-[940px]">
            <thead>
              <tr className="border-b border-line bg-surface text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                {canWrite ? (
                  <th className="w-12 px-4 py-2.5">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={(e) => toggleFilteredSelection(e.target.checked)}
                      aria-label="Select all products matching the current filters"
                      title="Select all filtered products"
                      className="h-4 w-4 cursor-pointer rounded accent-[#0e6b5c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    />
                  </th>
                ) : null}
                <th className="px-4 py-2.5">Product</th>
                <th className="px-4 py-2.5">Carton contains</th>
                <th className="px-4 py-2.5">Stock by warehouse</th>
                <th className="px-4 py-2.5">Total stock</th>
                {canWrite ? <th className="px-4 py-2.5 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((p) => {
                const low = p.totalPieces < Math.max(p.cartonContains, 1);
                return (
                  <tr
                    key={p.id}
                    onClick={() => router.push(`/products/${p.id}`)}
                    className={`cursor-pointer transition-colors ${
                      selectedIds.has(p.id) ? "bg-brand-soft/25 hover:bg-brand-soft/40" : "hover:bg-surface/70"
                    }`}
                  >
                    {canWrite ? (
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.id)}
                          onChange={(e) => toggleProductSelection(p.id, e.target.checked)}
                          aria-label={`Select SKU ${p.sku}`}
                          className="h-4 w-4 cursor-pointer rounded accent-[#0e6b5c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                        />
                      </td>
                    ) : null}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <ProductThumb src={p.imageUrl} name={p.name} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[13px] font-bold">{p.sku}</span>
                            {low ? (
                              <span
                                className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                                  p.totalPieces === 0
                                    ? "bg-out-soft text-out"
                                    : "bg-warn-soft text-warn"
                                }`}
                              >
                                {p.totalPieces === 0 ? "Out of stock" : "Low"}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 max-w-[260px] truncate text-xs text-ink-faint">
                            {p.name || "Unnamed product"}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-ink-soft">
                      {p.cartonContains} pcs / CTN
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex max-w-[300px] flex-wrap gap-1.5">
                        {p.stocks.length === 0 ? (
                          <span className="text-xs text-ink-faint">Not stocked</span>
                        ) : (
                          p.stocks.map((s) => (
                            <span
                              key={s.warehouseId}
                              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-[11px]"
                              title={`${s.warehouseName}: ${fmtInt(s.qtyPieces)} pcs`}
                            >
                              <span className="max-w-[90px] truncate font-semibold text-ink-soft">
                                {s.warehouseName}
                              </span>
                              <span className="font-mono font-bold">{fmtInt(s.qtyPieces)}</span>
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <StockAmount pieces={p.totalPieces} per={p.cartonContains} />
                    </td>
                    {canWrite ? (
                      <td className="px-4 py-3">
                        <div
                          className="flex justify-end gap-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            size="sm"
                            variant="in"
                            icon="inbound"
                            onClick={() =>
                              setOpModal({ open: true, type: "inbound", productId: p.id })
                            }
                            aria-label="Inbound"
                          >
                            <span className="hidden sm:inline">Inbound</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="out"
                            icon="outbound"
                            onClick={() =>
                              setOpModal({ open: true, type: "outbound", productId: p.id })
                            }
                            aria-label="Outbound"
                          >
                            <span className="hidden sm:inline">Outbound</span>
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals (write actions — hidden for read-only Member accounts) */}
      {canWrite ? (
        <>
          <StockOpModal
            open={opModal.open}
            onClose={() => setOpModal((m) => ({ ...m, open: false }))}
            onDone={load}
            products={products}
            warehouses={warehouses}
            initialType={opModal.type}
            initialProductId={opModal.productId}
          />
          <ProductFormModal
            open={formOpen}
            onClose={() => setFormOpen(false)}
            onDone={load}
            warehouses={warehouses}
            editing={editing}
          />
          <BulkUploadModal open={bulkOpen} onClose={() => setBulkOpen(false)} onDone={load} />
          <Modal
            open={deleteSelectedOpen}
            onClose={() => {
              if (!deletingSelected && !forceDeleting) setDeleteSelectedOpen(false);
            }}
            title="Delete selected products?"
            subtitle={`${fmtInt(selectedProducts.length)} selected SKU${selectedProducts.length === 1 ? "" : "s"}`}
            width="max-w-lg"
          >
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-ink-soft">
                This permanently removes the selected products, their stock records, and their
                movement history. This cannot be undone.
              </p>

              {selectedProducts.length > 0 ? (
                <div className="max-h-52 overflow-y-auto rounded-lg border border-line bg-card">
                  <ul className="divide-y divide-line">
                    {selectedProducts.map((product) => (
                      <li
                        key={product.id}
                        className="flex items-center justify-between gap-3 px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-mono text-xs font-bold">{product.sku}</p>
                          <p className="truncate text-[11px] text-ink-faint">
                            {product.name || "Unnamed product"}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 font-mono text-xs font-semibold ${
                            product.totalPieces > 0 ? "text-out" : "text-ink-soft"
                          }`}
                        >
                          {fmtInt(product.totalPieces)} pcs
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="rounded-lg bg-surface px-3 py-2.5 text-sm text-ink-faint">
                  No products are selected. Close this dialog and select at least one SKU.
                </p>
              )}

              {selectedWithStock.length > 0 ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-out/20 bg-out-soft p-3 text-out" role="alert">
                    <div className="flex items-start gap-2">
                      <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                      <p className="text-xs font-semibold leading-relaxed">
                        {fmtInt(selectedWithStock.length)} selected SKU{selectedWithStock.length === 1 ? " still holds" : "s still hold"} stock.
                        Bring stock to zero or deselect those products before deleting.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const stockedIds = new Set(selectedWithStock.map((product) => product.id));
                        setSelectedIds((current) =>
                          new Set([...current].filter((id) => !stockedIds.has(id))),
                        );
                        if (selectedWithStock.length === selectedProducts.length) {
                          setDeleteSelectedOpen(false);
                        }
                      }}
                      className="mt-2 text-out hover:bg-out/10 hover:text-out"
                    >
                      Deselect stocked SKUs
                    </Button>
                  </div>

                  {isAdmin ? (
                    <div className="rounded-lg border border-brand/20 bg-brand-soft p-3 text-brand">
                      <p className="text-xs font-semibold leading-relaxed">
                        Or verify with your admin password to force delete all{" "}
                        {fmtInt(selectedProducts.length)} selected SKU{
                          selectedProducts.length === 1 ? "" : "s"
                        } — including the ones that still hold stock. Their stock and movement
                        history will be permanently removed and cannot be restored.
                      </p>
                      <Field label="Admin password" required>
                        <Input
                          type="password"
                          value={verifyPassword}
                          onChange={(e) => {
                            setVerifyPassword(e.target.value);
                            setForceDeleteError(null);
                          }}
                          placeholder="••••••••"
                          autoComplete="current-password"
                        />
                      </Field>
                      {forceDeleteError ? (
                        <p className="mt-2 text-[11px] font-medium text-out">
                          {forceDeleteError}
                        </p>
                      ) : null}
                      <div className="flex justify-end gap-2 mt-3">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setVerifyPassword("")}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          icon="trash"
                          onClick={forceDeleteSelected}
                          loading={forceDeleting}
                          disabled={forceDeleting || !verifyPassword.trim()}
                        >
                          Verify & delete all{" "}
                          {fmtInt(selectedProducts.length)} SKU{selectedProducts.length === 1 ? "" : "s"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[11px] text-ink-faint">
                      These SKUs still hold stock. Only an Admin can verify and force delete them.
                    </div>
                  )}
                </div>
              ) : selectedProducts.length > 0 ? (
                <p className="rounded-lg bg-in-soft px-3 py-2.5 text-xs font-semibold text-in">
                  All selected products currently have zero stock and can be deleted.
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setDeleteSelectedOpen(false)}
                  disabled={deletingSelected}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  icon="trash"
                  onClick={deleteSelectedProducts}
                  loading={deletingSelected}
                  disabled={selectedProducts.length === 0 || selectedWithStock.length > 0}
                >
                  Delete {fmtInt(selectedProducts.length)} SKU{selectedProducts.length === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          </Modal>
        </>
      ) : null}
    </div>
  );
}
