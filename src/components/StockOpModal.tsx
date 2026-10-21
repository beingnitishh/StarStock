"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Field, Input, Modal, Select, Textarea, useToast } from "./ui";
import { Icon } from "./icons";
import { fmtInt, toPieces } from "@/lib/units";
import type { OpType, ProductRow, Warehouse } from "@/lib/types";

const DESTINATIONS = ["Sold to Customer", "Damaged / Write-off", "Return to Supplier", "Other"];

const TYPE_LABELS: Record<OpType, { title: string; subtitle: string; verb: string }> = {
  inbound: {
    title: "Inbound stock",
    subtitle: "Receive stock into a warehouse",
    verb: "Record inbound",
  },
  outbound: {
    title: "Outbound stock",
    subtitle: "Move stock out of a warehouse",
    verb: "Record outbound",
  },
  transfer: {
    title: "Warehouse transfer",
    subtitle: "Move stock between warehouses",
    verb: "Record transfer",
  },
  adjustment: {
    title: "Stock adjustment",
    subtitle: "Set a warehouse to an exact final stock",
    verb: "Apply adjustment",
  },
};

export function StockOpModal({
  open,
  onClose,
  onDone,
  products: productsProp,
  warehouses: warehousesProp,
  initialType,
  initialProductId,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  products?: ProductRow[];
  warehouses?: Warehouse[];
  initialType?: OpType;
  initialProductId?: number;
}) {
  const toast = useToast();
  const [type, setType] = useState<OpType>(initialType ?? "inbound");
  const [products, setProducts] = useState<ProductRow[]>(productsProp ?? []);
  const [warehouses, setWarehouses] = useState<Warehouse[]>(warehousesProp ?? []);

  const [query, setQuery] = useState("");
  const [productId, setProductId] = useState<number | null>(null);
  const [dropOpen, setDropOpen] = useState(false);

  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState<"piece" | "carton">("piece");
  const [warehouseId, setWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [destination, setDestination] = useState("Sold to Customer");
  const [customDestination, setCustomDestination] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setType(initialType ?? "inbound");
    setProductId(initialProductId ?? null);
    const initial = productsProp?.find((p) => p.id === initialProductId);
    setQuery(initial ? initial.sku : "");
    setQty("");
    setUnit("piece");
    setWarehouseId("");
    setToWarehouseId("");
    setDestination("Sold to Customer");
    setCustomDestination("");
    setReason("");
    setError(null);
    setBusy(false);
    if (productsProp) setProducts(productsProp);
    if (warehousesProp) setWarehouses(warehousesProp);
    if (!productsProp) {
      fetch("/api/products", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setProducts(d.products ?? []))
        .catch(() => {});
    }
    if (!warehousesProp) {
      fetch("/api/warehouses")
        .then((r) => r.json())
        .then((d) => setWarehouses(d.warehouses ?? []))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const product = products.find((p) => p.id === productId) ?? null;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 8);
    return products
      .filter((p) => p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, products]);

  // A stock row means the product is listed, even when its quantity is zero.
  const adjustmentWarehouses = warehouses.filter((warehouse) =>
    product?.stocks.some((stock) => stock.warehouseId === warehouse.id),
  );
  const selectableWarehouses = type === "adjustment" ? adjustmentWarehouses : warehouses;
  const warehouseValid = selectableWarehouses.some((warehouse) => String(warehouse.id) === warehouseId);

  const qtyNum = Number(qty);
  const qtyValid =
    qty !== "" &&
    Number.isInteger(qtyNum) &&
    (type === "adjustment" ? qtyNum >= 0 : qtyNum > 0);
  const pieces = product && qtyValid ? toPieces(qtyNum, unit, product.cartonContains) : 0;

  const currentWhPieces =
    product && warehouseId
      ? (product.stocks.find((s) => s.warehouseId === Number(warehouseId))?.qtyPieces ?? 0)
      : 0;

  const canSubmit =
    !!product &&
    qtyValid &&
    warehouseValid &&
    (type === "transfer" ? warehouseId !== "" && toWarehouseId !== "" && warehouseId !== toWarehouseId : warehouseId !== "");

  async function submit() {
    if (!product || !canSubmit) return;
    setBusy(true);
    setError(null);
    const finalDestination =
      type === "outbound"
        ? destination === "Other"
          ? customDestination.trim() || "Other"
          : destination
        : null;
    try {
      const res = await fetch("/api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          productId: product.id,
          qty: qtyNum,
          unit,
          warehouseId: warehouseId ? Number(warehouseId) : null,
          toWarehouseId: type === "transfer" && toWarehouseId ? Number(toWarehouseId) : null,
          destination: finalDestination,
          reason: reason.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Operation failed.");
      const whName = warehouses.find((w) => w.id === Number(warehouseId))?.name ?? "";
      const messages: Record<OpType, string> = {
        inbound: `+${fmtInt(pieces)} pcs received into ${whName}.`,
        outbound: `−${fmtInt(pieces)} pcs out of ${whName}${finalDestination ? ` · ${finalDestination}` : ""}.`,
        transfer: `${fmtInt(pieces)} pcs moved ${whName} → ${warehouses.find((w) => w.id === Number(toWarehouseId))?.name ?? ""}.`,
        adjustment: `${whName} set to ${fmtInt(pieces)} pcs. Total now ${fmtInt(data.resultingTotalPieces)} pcs.`,
      };
      toast.push("success", TYPE_LABELS[type].title + " recorded", messages[type]);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed.");
      setBusy(false);
    }
  }

  const meta = TYPE_LABELS[type];

  return (
    <Modal open={open} onClose={onClose} title={meta.title} subtitle={meta.subtitle} width="max-w-xl">
      {/* Type switcher */}
      <div className="grid grid-cols-4 gap-1 rounded-lg bg-ink/5 p-1">
        {(Object.keys(TYPE_LABELS) as OpType[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setType(t);
              if (t === "adjustment" && !adjustmentWarehouses.some((w) => String(w.id) === warehouseId)) {
                setWarehouseId("");
              }
              setError(null);
            }}
            className={`rounded-md px-2 py-1.5 text-xs font-bold capitalize transition-colors ${
              type === t ? "bg-card text-ink shadow-sm" : "text-ink-soft hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-4">
        {/* Product picker */}
        <div className="relative">
          <Field label="Product" required>
            <Input
              value={query}
              placeholder="Search by SKU or name…"
              onChange={(e) => {
                setQuery(e.target.value);
                setProductId(null);
                if (type === "adjustment") setWarehouseId("");
                setDropOpen(true);
              }}
              onFocus={() => setDropOpen(true)}
              onBlur={() => window.setTimeout(() => setDropOpen(false), 120)}
              className="font-mono"
            />
          </Field>
          {dropOpen && !productId ? (
            <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-line bg-card shadow-xl">
              {matches.length === 0 ? (
                <p className="px-3 py-3 text-xs text-ink-faint">No matching products.</p>
              ) : (
                matches.map((p) => (
                  <button
                    key={p.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setProductId(p.id);
                      setQuery(p.sku);
                      setDropOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-brand-soft/50"
                  >
                    <span className="font-mono text-xs font-bold">{p.sku}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">{p.name}</span>
                    <span className="font-mono text-[11px] text-ink-faint">
                      {fmtInt(p.totalPieces)} pcs
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {product ? (
          <div className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5">
            <Icon name="box" className="h-4 w-4 text-brand" />
            <p className="text-xs text-ink-soft">
              <span className="font-mono font-bold text-ink">{product.sku}</span>
              {product.name ? ` · ${product.name}` : ""} · 1 CTN ={" "}
              {product.cartonContains} pcs · Total{" "}
              <span className="font-mono font-semibold text-ink">{fmtInt(product.totalPieces)} pcs</span>
            </p>
          </div>
        ) : null}

        {/* Quantity + unit */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_150px]">
          <Field
            label={type === "adjustment" ? "Final stock quantity" : "Quantity"}
            required
            hint={type === "adjustment" ? "sets exact final stock" : undefined}
          >
            <Input
              type="number"
              min={0}
              step={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
              className="font-mono"
            />
          </Field>
          <Field label="Unit" required>
            <Select value={unit} onChange={(e) => setUnit(e.target.value as "piece" | "carton")}>
              <option value="piece">Pieces</option>
              <option value="carton">Cartons</option>
            </Select>
          </Field>
        </div>

        {/* Warehouses */}
        {type === "transfer" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="From warehouse" required>
              <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Select…</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="To warehouse" required>
              <Select value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)}>
                <option value="">Select…</option>
                {warehouses
                  .filter((w) => String(w.id) !== warehouseId)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        ) : (
          <Field
            label={
              type === "inbound"
                ? "Destination warehouse"
                : type === "outbound"
                  ? "Source warehouse"
                  : "Warehouse to adjust"
            }
            required
          >
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">Select…</option>
              {selectableWarehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
            {type === "adjustment" && !product ? (
              <p className="mt-1 text-xs text-ink-faint">Select a product to see its warehouses.</p>
            ) : type === "adjustment" && adjustmentWarehouses.length === 0 ? (
              <p className="mt-1 text-xs text-ink-faint">This product is not listed in any warehouse.</p>
            ) : null}
          </Field>
        )}

        {/* Outbound destination */}
        {type === "outbound" ? (
          <Field label="Destination / purpose" required>
            <Select value={destination} onChange={(e) => setDestination(e.target.value)}>
              {DESTINATIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
            {destination === "Other" ? (
              <Input
                className="mt-2"
                value={customDestination}
                onChange={(e) => setCustomDestination(e.target.value)}
                placeholder="Describe the destination…"
                maxLength={120}
              />
            ) : null}
          </Field>
        ) : null}

        {/* Preview line */}
        {product && qtyValid ? (
          <div className="flex items-center gap-2 rounded-lg bg-brand-soft/70 px-3 py-2.5 text-xs font-medium text-brand-deep">
            <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
            {type === "adjustment" ? (
              <span>
                Sets the selected warehouse to exactly{" "}
                <span className="font-mono font-bold">{fmtInt(pieces)} pcs</span>
                {product.cartonContains > 1
                  ? ` (${fmtInt(Math.floor(pieces / product.cartonContains))} CTN + ${pieces % product.cartonContains} PCS)`
                  : ""}
                . Current: <span className="font-mono font-bold">{fmtInt(currentWhPieces)} pcs</span>.
              </span>
            ) : (
              <span>
                {qtyNum} {unit === "carton" ? `carton${qtyNum === 1 ? "" : "s"}` : `piece${qtyNum === 1 ? "" : "s"}`}
                {unit === "carton" && product.cartonContains > 1 ? ` × ${product.cartonContains} pcs` : ""} ={" "}
                <span className="font-mono font-bold">{fmtInt(pieces)} pieces</span>
                {type !== "inbound" && warehouseId ? (
                  <>
                    {" "}
                    · warehouse holds <span className="font-mono font-bold">{fmtInt(currentWhPieces)} pcs</span>
                  </>
                ) : null}
              </span>
            )}
          </div>
        ) : null}

        <Field label="Reason / message" hint="optional, kept with the record">
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Supplier delivery PO-1042, damaged batch, cycle count…"
            maxLength={500}
          />
        </Field>

        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-out/30 bg-out-soft px-3 py-2.5 text-[13px] font-medium text-out">
            <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={!canSubmit}
            icon={
              type === "inbound"
                ? "inbound"
                : type === "outbound"
                  ? "outbound"
                  : type === "transfer"
                    ? "swap"
                    : "sliders"
            }
          >
            {meta.verb}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
