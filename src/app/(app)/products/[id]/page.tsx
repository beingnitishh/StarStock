"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Icon } from "@/components/icons";
import { ProductFormModal } from "@/components/ProductFormModal";
import { StockOpModal } from "@/components/StockOpModal";
import { TxTable } from "@/components/TxTable";
import {
  Button,
  EmptyState,
  ProductThumb,
  Spinner,
  StockAmount,
  TX_META,
  useToast,
} from "@/components/ui";
import { fmtDate, fmtInt, splitCartons } from "@/lib/units";
import type { OpType, ProductRow, TxRow, Warehouse } from "@/lib/types";

export default function ProductPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const toast = useToast();

  const [product, setProduct] = useState<ProductRow | null>(null);
  const [history, setHistory] = useState<TxRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [typeFilter, setTypeFilter] = useState<OpType | "all">("all");

  const [opType, setOpType] = useState<OpType>("inbound");
  const [opOpen, setOpOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [pRes, wRes] = await Promise.all([
        fetch(`/api/products/${id}`),
        fetch("/api/warehouses"),
      ]);
      if (pRes.status === 404) {
        setNotFound(true);
        return;
      }
      const pData = await pRes.json();
      const wData = await wRes.json();
      if (!pRes.ok) throw new Error(pData.error ?? "Failed to load product.");
      setProduct(pData.product);
      setHistory(pData.history ?? []);
      setWarehouses(wData.warehouses ?? []);
    } catch (e) {
      toast.push("error", "Failed to load product", e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const filteredHistory = useMemo(
    () => (typeFilter === "all" ? history : history.filter((h) => h.type === typeFilter)),
    [history, typeFilter],
  );

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-ink-faint">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (notFound || !product) {
    return (
      <div className="mx-auto max-w-md pt-16">
        <EmptyState
          icon="box"
          title="Product not found"
          text="It may have been removed, or the link is incorrect."
          action={
            <Link
              href="/inventory"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-paper hover:bg-brand-deep"
            >
              <Icon name="arrow-left" className="h-3.5 w-3.5" />
              Back to inventory
            </Link>
          }
        />
      </div>
    );
  }

  const totalCtn = splitCartons(product.totalPieces, product.cartonContains);

  return (
    <div className="rise-in space-y-5">
      <Link
        href="/inventory"
        className="inline-flex items-center gap-1.5 text-xs font-bold text-ink-soft transition-colors hover:text-brand"
      >
        <Icon name="arrow-left" className="h-3.5 w-3.5" />
        Back to inventory
      </Link>

      {/* Header card */}
      <div className="rounded-xl border border-line bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <ProductThumb src={product.imageUrl} name={product.name} size="h-20 w-20" rounded="rounded-xl" />
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="font-mono text-xl font-bold tracking-tight">{product.sku}</h1>
                <button
                  onClick={() => setEditOpen(true)}
                  className="rounded-md border border-line-strong p-1.5 text-ink-soft transition-colors hover:border-brand/50 hover:text-brand"
                  title="Edit product"
                >
                  <Icon name="pencil" className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mt-0.5 text-sm text-ink-soft">{product.name || "Unnamed product"}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                <span className="rounded-full bg-surface px-2.5 py-1 font-semibold text-ink-soft ring-1 ring-line">
                  Stock unit: <span className="capitalize">{product.stockUnit}</span>
                </span>
                <span className="rounded-full bg-surface px-2.5 py-1 font-semibold text-ink-soft ring-1 ring-line">
                  Carton contains: <span className="font-mono">{product.cartonContains} pcs</span>
                </span>
                <span className="rounded-full bg-surface px-2.5 py-1 font-semibold text-ink-soft ring-1 ring-line">
                  Opening stock:{" "}
                  <span className="font-mono">{fmtInt(product.openingStockPieces)} pcs</span>
                </span>
                <span className="rounded-full bg-surface px-2.5 py-1 font-semibold text-ink-soft ring-1 ring-line">
                  Listed {fmtDate(product.createdAt)}
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="text-right">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint">
                Total stock · all warehouses
              </p>
              <p className="mt-1 font-display text-2xl font-bold tracking-tight">
                {product.cartonContains > 1 ? (
                  <>
                    {fmtInt(totalCtn.cartons)} CTN
                    {totalCtn.remainder > 0 ? (
                      <span className="text-ink-soft"> + {totalCtn.remainder} PCS</span>
                    ) : null}
                  </>
                ) : (
                  <>{fmtInt(product.totalPieces)} PCS</>
                )}
              </p>
              <p className="font-mono text-xs text-ink-faint">{fmtInt(product.totalPieces)} pcs</p>
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="in" icon="inbound" onClick={() => { setOpType("inbound"); setOpOpen(true); }}>
                Inbound
              </Button>
              <Button size="sm" variant="out" icon="outbound" onClick={() => { setOpType("outbound"); setOpOpen(true); }}>
                Outbound
              </Button>
              <Button size="sm" variant="secondary" icon="swap" onClick={() => { setOpType("transfer"); setOpOpen(true); }}>
                Transfer
              </Button>
              <Button size="sm" variant="secondary" icon="sliders" onClick={() => { setOpType("adjustment"); setOpOpen(true); }}>
                Adjust
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        {/* Warehouse stock */}
        <div className="h-fit rounded-xl border border-line bg-card">
          <div className="border-b border-line px-5 py-3.5">
            <h2 className="font-display text-sm font-bold tracking-tight">Stock by warehouse</h2>
          </div>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                <th className="px-5 py-2">Warehouse</th>
                <th className="px-3 py-2 text-right">CTN</th>
                <th className="px-5 py-2 text-right">Pieces</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {product.stocks.map((s) => {
                const c = splitCartons(s.qtyPieces, product.cartonContains);
                return (
                  <tr key={s.warehouseId}>
                    <td className="px-5 py-2.5 text-[13px] font-semibold">{s.warehouseName}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-[13px]">{fmtInt(c.cartons)}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-[13px] font-semibold">
                      {fmtInt(s.qtyPieces)}
                    </td>
                  </tr>
                );
              })}
              {product.stocks.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-5 py-6 text-center text-xs text-ink-faint">
                    No stock recorded in any warehouse yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line-strong bg-surface">
                <td className="px-5 py-2.5 text-[13px] font-bold">Total</td>
                <td className="px-3 py-2.5 text-right font-mono text-[13px] font-bold">
                  {fmtInt(totalCtn.cartons)}
                </td>
                <td className="px-5 py-2.5 text-right font-mono text-[13px] font-bold">
                  {fmtInt(product.totalPieces)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* History */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-bold tracking-tight">
                History · last 30 days
              </h2>
              <p className="text-xs text-ink-faint">
                {history.length} recorded movement{history.length === 1 ? "" : "s"} — newest first
              </p>
            </div>
            <div className="flex gap-1 rounded-lg bg-ink/5 p-1">
              {(["all", "inbound", "outbound", "transfer", "adjustment"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-bold capitalize transition-colors ${
                    typeFilter === t ? "bg-card text-ink shadow-sm" : "text-ink-soft hover:text-ink"
                  }`}
                >
                  {t === "all" ? "All" : TX_META[t].label}
                </button>
              ))}
            </div>
          </div>
          <TxTable rows={filteredHistory} showProduct={false} />
        </div>
      </div>

      <StockOpModal
        open={opOpen}
        onClose={() => setOpOpen(false)}
        onDone={load}
        products={[product]}
        warehouses={warehouses}
        initialType={opType}
        initialProductId={product.id}
      />
      <ProductFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onDone={load}
        warehouses={warehouses}
        editing={product}
      />
    </div>
  );
}
