"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/icons";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  ProductThumb,
  Spinner,
  StockAmount,
  useToast,
} from "@/components/ui";
import { fmtDate, fmtInt } from "@/lib/units";
import type { ProductRow, Warehouse } from "@/lib/types";

type WarehouseStockItem = {
  product: ProductRow;
  qtyPieces: number;
  updatedAt: string | null;
};

type WarehouseDetail = {
  warehouse: Warehouse;
  items: WarehouseStockItem[];
  skuCount: number;
  totalPieces: number;
};

export default function WarehouseDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const wid = Number(id);
  const toast = useToast();

  const [detail, setDetail] = useState<WarehouseDetail | null>(null);
  const [allWarehouses, setAllWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isInteger(wid)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    try {
      const [dRes, wRes] = await Promise.all([
        fetch(`/api/warehouses/${wid}`),
        fetch("/api/warehouses"),
      ]);
      if (dRes.status === 404) {
        setNotFound(true);
        return;
      }
      const dData = await dRes.json();
      const wData = await wRes.json();
      if (!dRes.ok) throw new Error(dData.error ?? "Failed to load warehouse.");
      setDetail(dData);
      setAllWarehouses(wData.warehouses ?? []);
      setRenameValue(dData.warehouse.name);
    } catch (e) {
      toast.push("error", "Failed to load warehouse", e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wid]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!detail) return [];
    const q = query.trim().toLowerCase();
    if (!q) return detail.items;
    return detail.items.filter(
      (it) =>
        it.product.sku.toLowerCase().includes(q) ||
        it.product.name.toLowerCase().includes(q),
    );
  }, [detail, query]);

  async function saveRename() {
    if (!detail || !renameValue.trim()) return;
    setSavingName(true);
    try {
      const res = await fetch(`/api/warehouses/${detail.warehouse.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Rename failed.");
      toast.push("success", "Warehouse renamed", data.warehouse.name);
      setRenaming(false);
      load();
    } catch (e) {
      toast.push("error", "Rename failed", e instanceof Error ? e.message : undefined);
    } finally {
      setSavingName(false);
    }
  }

  async function downloadExcel() {
    if (!detail) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/export/warehouse/${detail.warehouse.id}`);
      if (!res.ok) {
        let msg = "Download failed.";
        try {
          const data = await res.json();
          msg = data.error ?? msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      // Try to read the filename from content-disposition, fall back to a safe one.
      const cd = res.headers.get("content-disposition") ?? "";
      const match = /filename="?([^";]+)"?/i.exec(cd);
      a.href = url;
      a.download = match?.[1] ?? `warehouse-${detail.warehouse.id}-stock.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.push("success", "Stock exported", `${detail.warehouse.name} stock downloaded.`);
    } catch (e) {
      toast.push("error", "Download failed", e instanceof Error ? e.message : undefined);
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-ink-faint">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (notFound || !detail) {
    return (
      <div className="mx-auto max-w-md pt-16">
        <EmptyState
          icon="warehouse"
          title="Warehouse not found"
          text="It may have been removed, or the link is incorrect."
          action={
            <Link
              href="/warehouses"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-paper hover:bg-brand-deep"
            >
              <Icon name="arrow-left" className="h-3.5 w-3.5" />
              Back to warehouses
            </Link>
          }
        />
      </div>
    );
  }

  const { warehouse, items, skuCount, totalPieces } = detail;

  return (
    <div className="rise-in space-y-5">
      <Link
        href="/warehouses"
        className="inline-flex items-center gap-1.5 text-xs font-bold text-ink-soft transition-colors hover:text-brand"
      >
        <Icon name="arrow-left" className="h-3.5 w-3.5" />
        Back to warehouses
      </Link>

      {/* Header card */}
      <div className="rounded-xl border border-line bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3 sm:gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand sm:h-14 sm:w-14">
              <Icon name="warehouse" className="h-5 w-5 sm:h-6 sm:w-6" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h1 className="truncate font-display text-xl font-bold tracking-tight sm:text-2xl">{warehouse.name}</h1>
                <button
                  onClick={() => {
                    setRenameValue(warehouse.name);
                    setRenaming(true);
                  }}
                  className="rounded-md border border-line-strong p-1.5 text-ink-soft transition-colors hover:border-brand/50 hover:text-brand"
                  title="Rename warehouse"
                >
                  <Icon name="pencil" className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-faint">Warehouse created {fmtDate(warehouse.createdAt)}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] sm:gap-3">
                <span className="rounded-full bg-surface px-2.5 py-1 font-semibold text-ink-soft ring-1 ring-line">
                  <span className="font-mono text-ink">{fmtInt(skuCount)}</span> stocked SKU{skuCount === 1 ? "" : "s"}
                </span>
                <span className="rounded-full bg-surface px-2.5 py-1 font-semibold text-ink-soft ring-1 ring-line">
                  <span className="font-mono text-ink">{fmtInt(totalPieces)}</span> total pieces
                </span>
                {allWarehouses.length > 1 ? (
                  <span className="rounded-full bg-surface px-2.5 py-1 font-semibold text-ink-faint ring-1 ring-line">
                    1 of {fmtInt(allWarehouses.length)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Button
              variant="secondary"
              icon="download"
              onClick={downloadExcel}
              loading={exporting}
              className="flex-1 justify-center sm:flex-none"
            >
              Download Excel
            </Button>
          </div>
        </div>
      </div>

      {/* Stock table */}
      <div className="rounded-xl border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h2 className="font-display text-sm font-bold tracking-tight">Products in this warehouse</h2>
            <p className="text-xs text-ink-faint">
              {items.length === 0
                ? "No products are stocked here yet."
                : `${fmtInt(items.length)} product${items.length === 1 ? "" : "s"} tracked · ${fmtInt(filtered.length)} shown`}
            </p>
          </div>
          {items.length > 0 ? (
            <div className="w-full max-w-xs">
              <div className="relative">
                <Icon
                  name="search"
                  className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search SKU or product name…"
                  className="pl-8"
                />
              </div>
            </div>
          ) : null}
        </div>

        {items.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon="box"
              title="This warehouse is empty"
              text="Record an inbound transaction or adjustment to place stock here."
              action={
                <Link
                  href="/inventory"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-paper hover:bg-brand-deep"
                >
                  <Icon name="grid" className="h-3.5 w-3.5" />
                  Open inventory
                </Link>
              }
            />
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-faint">
            No products match “{query}”.
          </p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[680px] text-left sm:min-w-0">
              <thead>
                <tr className="border-b border-line bg-surface/60 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                  <th className="px-5 py-2.5">Product</th>
                  <th className="px-3 py-2.5">SKU</th>
                  <th className="px-3 py-2.5">Stock unit</th>
                  <th className="px-3 py-2.5 text-right">Pcs / Carton</th>
                  <th className="px-5 py-2.5 text-right">Stock on hand</th>
                  <th className="px-5 py-2.5 text-right">Last updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((it) => (
                  <tr
                    key={it.product.id}
                    className="transition-colors hover:bg-surface/60"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/products/${it.product.id}`}
                        className="flex items-center gap-3"
                      >
                        <ProductThumb
                          src={it.product.imageUrl}
                          name={it.product.name}
                          size="h-10 w-10"
                          rounded="rounded-lg"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-semibold">
                            {it.product.name || "Unnamed product"}
                          </p>
                          {it.product.imageUrl ? null : (
                            <p className="text-[11px] text-ink-faint">No image</p>
                          )}
                        </div>
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <Link
                        href={`/products/${it.product.id}`}
                        className="font-mono text-[12px] font-semibold text-ink-soft hover:text-brand"
                      >
                        {it.product.sku}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-[12px] capitalize text-ink-soft">
                      {it.product.stockUnit}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-[12px] text-ink-soft">
                      {fmtInt(Math.max(it.product.cartonContains, 1))}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <StockAmount
                        pieces={it.qtyPieces}
                        per={it.product.cartonContains}
                        align="right"
                      />
                    </td>
                    <td className="px-5 py-3 text-right text-[11px] text-ink-faint">
                      {it.updatedAt ? fmtDate(it.updatedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line-strong bg-surface">
                  <td colSpan={4} className="px-5 py-3 text-[13px] font-bold">
                    Total in {warehouse.name}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="font-mono text-[13px] font-bold">{fmtInt(totalPieces)} PCS</div>
                    <div className="font-mono text-[11px] text-ink-faint">across {fmtInt(skuCount)} SKU{skuCount === 1 ? "" : "s"}</div>
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Rename modal */}
      <Modal
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename warehouse"
        subtitle={`Currently “${warehouse.name}”`}
        width="max-w-sm"
      >
        <div className="space-y-4">
          <Field label="New name" required>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveRename();
              }}
              maxLength={60}
              autoFocus
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={saveRename}
              loading={savingName}
              disabled={!renameValue.trim() || renameValue.trim() === warehouse.name}
            >
              Save
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
