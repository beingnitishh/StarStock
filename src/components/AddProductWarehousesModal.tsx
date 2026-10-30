"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { Button, Input, Modal, useToast } from "./ui";
import { fmtInt, MAX_STOCK_PIECES, toPieces } from "@/lib/units";
import type { ProductRow, Warehouse } from "@/lib/types";

export function AddProductWarehousesModal({
  open,
  onClose,
  onDone,
  product,
  warehouses,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  product: ProductRow;
  warehouses: Warehouse[];
}) {
  if (!open) return null;

  return (
    <AddProductWarehousesDialog
      onClose={onClose}
      onDone={onDone}
      product={product}
      warehouses={warehouses}
    />
  );
}

function AddProductWarehousesDialog({
  onClose,
  onDone,
  product,
  warehouses,
}: {
  onClose: () => void;
  onDone: () => Promise<void> | void;
  product: ProductRow;
  warehouses: Warehouse[];
}) {
  const router = useRouter();
  const toast = useToast();

  const listedIds = useMemo(
    () => new Set(product.stocks.map((s) => s.warehouseId)),
    [product.stocks],
  );
  const availableWarehouses = useMemo(
    () => warehouses.filter((w) => !listedIds.has(w.id)),
    [warehouses, listedIds],
  );

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [openingByWarehouse, setOpeningByWarehouse] = useState<
    Record<number, string>
  >(() =>
    Object.fromEntries(availableWarehouses.map((w) => [w.id, "0"])),
  );
  const [unit, setUnit] = useState<"piece" | "carton">(
    product.cartonContains > 1 ? product.stockUnit : "piece",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const activeSelectedIds = useMemo(
    () =>
      availableWarehouses
        .filter((w) => selectedSet.has(w.id))
        .map((w) => w.id),
    [availableWarehouses, selectedSet],
  );

  const perCarton = Math.max(product.cartonContains, 1);

  const previewPieces = useMemo(() => {
    let sum = 0;
    for (const wid of activeSelectedIds) {
      const raw = (openingByWarehouse[wid] ?? "0").trim();
      if (!raw) continue;
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0) {
        sum += toPieces(n, unit, perCarton);
      }
    }
    return sum;
  }, [activeSelectedIds, openingByWarehouse, unit, perCarton]);

  function toggleWarehouse(warehouseId: number) {
    setError(null);
    setSelectedIds((prev) =>
      prev.includes(warehouseId)
        ? prev.filter((id) => id !== warehouseId)
        : [...prev, warehouseId],
    );
  }

  function handleOpeningChange(warehouseId: number, value: string) {
    setError(null);
    setOpeningByWarehouse((prev) => ({ ...prev, [warehouseId]: value }));
    const parsed = Number(value.trim());
    if (
      value.trim() !== "" &&
      Number.isFinite(parsed) &&
      parsed > 0 &&
      !selectedSet.has(warehouseId)
    ) {
      setSelectedIds((prev) =>
        prev.includes(warehouseId) ? prev : [...prev, warehouseId],
      );
    }
  }

  function toggleSelectAll() {
    setError(null);
    if (activeSelectedIds.length === availableWarehouses.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(availableWarehouses.map((w) => w.id));
    }
  }

  async function submit() {
    if (busy) return;
    setError(null);

    if (activeSelectedIds.length === 0) {
      setError("Select at least one warehouse.");
      return;
    }

    const payload: Array<{ warehouseId: number; openingStock: number }> = [];
    for (const wid of activeSelectedIds) {
      const whName =
        availableWarehouses.find((w) => w.id === wid)?.name ?? "warehouse";
      const raw = (openingByWarehouse[wid] ?? "0").trim();
      const openingStock = raw === "" ? 0 : Number(raw);
      if (
        !Number.isFinite(openingStock) ||
        !Number.isInteger(openingStock) ||
        openingStock < 0
      ) {
        setError(
          `Opening stock for "${whName}" must be a whole number (0 or more).`,
        );
        return;
      }
      const pieces = toPieces(openingStock, unit, perCarton);
      if (!Number.isSafeInteger(pieces) || pieces > MAX_STOCK_PIECES) {
        setError(
          `Opening stock for "${whName}" exceeds StarStock's quantity limits.`,
        );
        return;
      }
      payload.push({ warehouseId: wid, openingStock });
    }

    setBusy(true);
    try {
      const res = await fetch(`/api/products/${product.id}/warehouses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          warehouses: payload,
          unit,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data.error ?? "Could not add product to the selected warehouses.",
        );
      }

      const added: Array<{ warehouseId: number; warehouseName: string; qtyPieces: number }> =
        Array.isArray(data.added) ? data.added : [];

      await onDone();
      router.refresh();

      if (added.length === 1) {
        toast.push(
          "success",
          "Added to warehouse",
          `${product.sku} is now listed in ${added[0].warehouseName}.`,
        );
      } else if (added.length > 1) {
        toast.push(
          "success",
          "Added to warehouses",
          `${product.sku} added to ${added.length} warehouses.`,
        );
      } else {
        toast.push(
          "info",
          "Already listed",
          `${product.sku} was already listed in the selected warehouse${payload.length === 1 ? "" : "s"}.`,
        );
      }

      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not add product to the selected warehouses.",
      );
      setBusy(false);
    }
  }

  const allSelected =
    availableWarehouses.length > 0 &&
    activeSelectedIds.length === availableWarehouses.length;

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Add product to another warehouse"
      subtitle={`${product.sku}${product.name ? ` · ${product.name}` : ""}`}
      width="max-w-lg"
    >
      <div className="space-y-4">
        {availableWarehouses.length === 0 ? (
          <p className="rounded-lg border border-line bg-card px-3.5 py-4 text-center text-sm text-ink-soft">
            Already in all warehouses.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-ink-soft">
                  Warehouses not yet listing this product
                </p>
                <p className="text-[11px] text-ink-faint">
                  {activeSelectedIds.length} of {availableWarehouses.length} selected
                  {" · "}opening stock defaults to 0
                </p>
              </div>
              <div className="flex items-center gap-2">
                {product.cartonContains > 1 ? (
                  <div
                    className="inline-flex rounded-lg bg-ink/5 p-0.5"
                    role="group"
                    aria-label="Opening stock unit"
                  >
                    {(["piece", "carton"] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        disabled={busy}
                        onClick={() => setUnit(u)}
                        className={`rounded-md px-2 py-1 text-[11px] font-bold capitalize transition-colors ${
                          unit === u
                            ? "bg-card text-ink shadow-sm"
                            : "text-ink-soft hover:text-ink"
                        }`}
                      >
                        {u}s
                      </button>
                    ))}
                  </div>
                ) : null}
                {availableWarehouses.length > 1 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={toggleSelectAll}
                    className="rounded-md px-2 py-1 text-xs font-semibold text-brand transition-colors hover:bg-brand-soft/60 disabled:opacity-50"
                  >
                    {allSelected ? "Clear all" : "Select all"}
                  </button>
                ) : null}
              </div>
            </div>

            <div className="max-h-72 space-y-2 overflow-y-auto pr-0.5">
              {availableWarehouses.map((w) => {
                const checked = selectedSet.has(w.id);
                const rawQty = openingByWarehouse[w.id] ?? "0";
                const inputId = `add-wh-opening-${w.id}`;
                return (
                  <div
                    key={w.id}
                    className={`flex flex-col gap-2.5 rounded-lg border p-3 transition-colors sm:flex-row sm:items-center sm:justify-between ${
                      checked
                        ? "border-brand/50 bg-brand-soft/25"
                        : "border-line bg-card hover:border-line-strong"
                    }`}
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={() => toggleWarehouse(w.id)}
                        className="h-4 w-4 shrink-0 rounded border-line-strong accent-brand focus:ring-2 focus:ring-brand-ring/50"
                      />
                      <span className="truncate text-sm font-semibold text-ink">
                        {w.name}
                      </span>
                    </label>
                    <div className="flex items-center justify-between gap-2 pl-6 sm:justify-end sm:pl-0">
                      <label
                        htmlFor={inputId}
                        className="whitespace-nowrap text-xs font-semibold text-ink-soft"
                      >
                        Opening stock
                      </label>
                      <div className="relative w-28 sm:w-32">
                        <Input
                          id={inputId}
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          disabled={busy}
                          value={rawQty}
                          onChange={(e) =>
                            handleOpeningChange(w.id, e.target.value)
                          }
                          placeholder="0"
                          className="h-9 pr-11 text-right font-mono text-sm"
                        />
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-ink-faint">
                          {unit === "carton" ? "ctn" : "pcs"}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {activeSelectedIds.length > 0 ? (
              <div className="flex items-center gap-2 rounded-lg bg-brand-soft/70 px-3 py-2.5 text-xs font-medium text-brand-deep">
                <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
                <span>
                  Adding to{" "}
                  <span className="font-bold">
                    {activeSelectedIds.length} warehouse
                    {activeSelectedIds.length === 1 ? "" : "s"}
                  </span>
                  {previewPieces > 0 ? (
                    <>
                      {" · "}
                      <span className="font-mono font-bold">
                        +{fmtInt(previewPieces)} pcs
                      </span>{" "}
                      opening stock
                      {unit === "carton" && product.cartonContains > 1
                        ? ` (1 CTN = ${product.cartonContains} pcs)`
                        : ""}
                    </>
                  ) : (
                    " · listed with 0 opening stock"
                  )}
                </span>
              </div>
            ) : null}
          </>
        )}

        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-out/30 bg-out-soft px-3 py-2.5 text-[13px] font-medium text-out">
            <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="plus"
            onClick={submit}
            loading={busy}
            disabled={activeSelectedIds.length === 0 || availableWarehouses.length === 0}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
