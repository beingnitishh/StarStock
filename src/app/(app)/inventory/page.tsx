"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { BulkUploadModal } from "@/components/BulkUploadModal";
import { ProductFormModal } from "@/components/ProductFormModal";
import { StockOpModal } from "@/components/StockOpModal";
import {
  Button,
  EmptyState,
  Input,
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
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [whFilter, setWhFilter] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("sku-asc");

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
      setProducts(pData.products ?? []);
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

  return (
    <div className="rise-in space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Inventory</h1>
          <p className="mt-1 text-sm text-ink-faint">
            {fmtInt(products.length)} products · sorted by SKU · stock across {warehouses.length}{" "}
            warehouse{warehouses.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" icon="download" onClick={exportExcel}>
            Export Excel
          </Button>
          <Button variant="secondary" icon="upload" onClick={() => setBulkOpen(true)}>
            Bulk upload
          </Button>
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            List product
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-card p-3">
        <div className="relative min-w-[240px] flex-1">
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
        <Select value={whFilter} onChange={(e) => setWhFilter(e.target.value)} className="w-44">
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="w-40">
          <option value="sku-asc">SKU A → Z</option>
          <option value="sku-desc">SKU Z → A</option>
          <option value="stock-desc">Stock high → low</option>
          <option value="stock-asc">Stock low → high</option>
        </Select>
        <label className="flex cursor-pointer select-none items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs font-semibold text-ink-soft">
          <input
            type="checkbox"
            checked={lowOnly}
            onChange={(e) => setLowOnly(e.target.checked)}
            className="h-3.5 w-3.5 accent-[#0e6b5c]"
          />
          Low stock only
        </label>
      </div>

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
            products.length === 0 ? (
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
        <div className="overflow-x-auto rounded-xl border border-line bg-card">
          <table className="w-full min-w-[900px] text-left">
            <thead>
              <tr className="border-b border-line bg-surface text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                <th className="px-4 py-2.5">Product</th>
                <th className="px-4 py-2.5">Carton contains</th>
                <th className="px-4 py-2.5">Stock by warehouse</th>
                <th className="px-4 py-2.5">Total stock</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((p) => {
                const low = p.totalPieces < Math.max(p.cartonContains, 1);
                return (
                  <tr
                    key={p.id}
                    onClick={() => router.push(`/products/${p.id}`)}
                    className="cursor-pointer transition-colors hover:bg-surface/70"
                  >
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
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="sm"
                          variant="in"
                          icon="inbound"
                          onClick={() =>
                            setOpModal({ open: true, type: "inbound", productId: p.id })
                          }
                        >
                          Inbound
                        </Button>
                        <Button
                          size="sm"
                          variant="out"
                          icon="outbound"
                          onClick={() =>
                            setOpModal({ open: true, type: "outbound", productId: p.id })
                          }
                        >
                          Outbound
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
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
    </div>
  );
}
