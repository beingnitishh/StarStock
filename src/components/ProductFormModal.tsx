"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button, Field, Input, Modal, ProductThumb, Select, Spinner, useToast } from "./ui";
import { Icon } from "./icons";
import { prepareProductImage } from "@/lib/image-client";
import { IMAGE_ACCEPT } from "@/lib/images";
import type { ProductRow, Warehouse } from "@/lib/types";

export function ProductFormModal({
  open,
  onClose,
  onDone,
  warehouses,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  warehouses: Warehouse[];
  editing?: ProductRow | null;
}) {
  const toast = useToast();
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [stockUnit, setStockUnit] = useState<"piece" | "carton">("piece");
  const [cartonContains, setCartonContains] = useState("1");
  const [openingQty, setOpeningQty] = useState("0");
  const [warehouseIds, setWarehouseIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageTouched, setImageTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skuInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSku(editing?.sku ?? "");
    setName(editing?.name ?? "");
    setImageUrl(editing?.imageUrl ?? "");
    setStockUnit(editing?.stockUnit ?? "piece");
    setCartonContains(String(editing?.cartonContains ?? 1));
    setOpeningQty("0");
    // No default — user must explicitly pick one or more warehouses
    setWarehouseIds([]);
    setError(null);
    setBusy(false);
    setImageBusy(false);
    setImageTouched(false);
    const frame = window.requestAnimationFrame(() => {
      if (editing) nameInputRef.current?.focus();
      else skuInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImageBusy(true);
    setError(null);
    try {
      // Decodes any format the browser understands (JPG, PNG, WebP, GIF, BMP,
      // AVIF, ICO, SVG, TIFF…), then downsizes and compresses it for storage.
      const prepared = await prepareProductImage(file);
      setImageUrl(prepared.dataUrl);
      setImageTouched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that image. Try a different file.");
    } finally {
      setImageBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const res = await fetch(`/api/products/${editing.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            // Only send the photo when it actually changed — re-sending the
            // existing preview URL would be a pointless round trip.
            ...(imageTouched ? { imageUrl } : {}),
            stockUnit,
            cartonContains: Number(cartonContains),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Update failed.");
        toast.push("success", "Product updated", `${sku} saved.`);
      } else {
        if (warehouseIds.length === 0) {
          throw new Error("Select at least one warehouse where the opening stock is stored.");
        }
        const res = await fetch("/api/products", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sku,
            name,
            imageUrl,
            stockUnit,
            cartonContains: Number(cartonContains),
            openingQty: Number(openingQty || 0),
            // Every selected warehouse receives the opening stock.
            warehouseIds,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not create the product.");
        if (data.imageWarning) {
          toast.push("info", "Product listed — photo not saved", data.imageWarning as string);
        } else {
          toast.push("success", "Product listed", `${sku} added to inventory.`);
        }
      }
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit product" : "List a product"}
      subtitle={
        editing
          ? "SKU is the permanent identifier and cannot be changed."
          : "Opening stock becomes the product's current stock."
      }
      width="max-w-xl"
    >
      <div className="space-y-4">
        {/* Image */}
        <div className="flex items-center gap-4">
          <ProductThumb src={imageUrl} name={name} size="h-20 w-20" rounded="rounded-xl" />
          <div className="space-y-1.5">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-xs font-semibold transition-colors hover:border-brand/50 hover:bg-brand-soft/40">
              {imageBusy ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="upload" className="h-3.5 w-3.5" />}
              Upload image
              <input
                type="file"
                accept={IMAGE_ACCEPT}
                className="hidden"
                onChange={onFile}
                disabled={imageBusy || busy}
              />
            </label>
            {imageUrl ? (
              <button
                onClick={() => {
                  setImageUrl("");
                  setImageTouched(true);
                }}
                className="block text-[11px] font-semibold text-out hover:underline"
              >
                Remove image
              </button>
            ) : (
              <p className="max-w-[240px] text-[11px] leading-relaxed text-ink-faint">
                JPG, PNG, WebP, GIF, BMP, AVIF, SVG or TIFF · resized automatically.
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="SKU" required hint={editing ? "read-only" : "unique identifier"}>
            <Input
              ref={skuInputRef}
              value={sku}
              onChange={(e) => setSku(e.target.value.toUpperCase())}
              placeholder="e.g. BTL-750"
              disabled={!!editing}
              className="font-mono uppercase disabled:bg-surface disabled:text-ink-soft"
              maxLength={60}
            />
          </Field>
          <Field label="Product name">
            <Input
              ref={nameInputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sparkling Water 750ml"
              maxLength={120}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Stock unit" required hint="unit of opening stock">
            <Select
              value={stockUnit}
              onChange={(e) => setStockUnit(e.target.value as "piece" | "carton")}
            >
              <option value="piece">Piece</option>
              <option value="carton">Carton</option>
            </Select>
          </Field>
          <Field label="Carton contains" required hint="pieces per carton">
            <Input
              type="number"
              min={1}
              step={1}
              value={cartonContains}
              onChange={(e) => setCartonContains(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>

        {!editing ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Opening stock" required hint={`in ${stockUnit}s`}>
              <Input
                type="number"
                min={0}
                step={1}
                value={openingQty}
                onChange={(e) => setOpeningQty(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field
              label="Opening stock warehouse"
              required
              hint={
                warehouses.length > 0 && warehouseIds.length === warehouses.length
                  ? "all warehouses"
                  : warehouseIds.length > 0
                    ? `${warehouseIds.length} of ${warehouses.length} selected`
                    : undefined
              }
            >
              <WarehouseMultiSelect
                warehouses={warehouses}
                selected={warehouseIds}
                onChange={setWarehouseIds}
                disabled={busy}
              />
              {warehouseIds.length > 0 ? (
                <p className="mt-1 text-[11px] font-medium text-brand">
                  Will create opening stock in {warehouseIds.length} warehouse
                  {warehouseIds.length === 1 ? "" : "s"}.
                </p>
              ) : null}
            </Field>
          </div>
        ) : null}

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
            disabled={imageBusy}
            icon={editing ? "pencil" : "plus"}
          >
            {editing ? "Save changes" : "List product"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------- Multi-select warehouse picker ---------------------- */

function CheckboxMark({
  checked,
  indeterminate = false,
}: {
  checked: boolean;
  indeterminate?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        checked || indeterminate
          ? "border-brand bg-brand text-paper"
          : "border-line-strong bg-card"
      }`}
    >
      {indeterminate ? (
        <span className="h-0.5 w-2 rounded-full bg-paper" />
      ) : checked ? (
        <Icon name="check" className="h-3 w-3" strokeWidth={3} />
      ) : null}
    </span>
  );
}

/**
 * Dropdown with tick boxes so a product can be listed in any subset of
 * warehouses — "All Warehouses" stays pinned on top and ticks/unticks every
 * warehouse in one click. Each selected warehouse receives the opening stock.
 */
function WarehouseMultiSelect({
  warehouses,
  selected,
  onChange,
  disabled = false,
}: {
  warehouses: Warehouse[];
  selected: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const total = warehouses.length;
  const selectedSet = new Set(selected);
  const allSelected = total > 0 && selected.length === total;
  const someSelected = selected.length > 0 && !allSelected;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function toggleAll() {
    // Ticking "All Warehouses" selects every warehouse; ticking it again
    // clears the selection so the user can start from scratch.
    onChange(allSelected ? [] : warehouses.map((w) => w.id));
  }

  function toggleOne(id: number) {
    onChange(
      selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id],
    );
  }

  let triggerLabel: string;
  if (selected.length === 0) {
    triggerLabel = "Select warehouse";
  } else if (allSelected) {
    triggerLabel = "All Warehouses";
  } else if (selected.length === 1) {
    triggerLabel = warehouses.find((w) => w.id === selected[0])?.name ?? "1 warehouse selected";
  } else {
    triggerLabel = `${selected.length} warehouses selected`;
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(e) => {
        // Escape closes only the dropdown — stop it from closing the modal.
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-line-strong bg-card px-3 py-2 text-left text-sm text-ink outline-none motion-field focus:border-brand focus:ring-2 focus:ring-brand-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={`truncate ${selected.length === 0 ? "text-ink-faint" : ""}`}>
          {triggerLabel}
        </span>
        <Icon
          name="chevron-down"
          className={`h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-line-strong bg-card shadow-lg shadow-coal/15"
        >
          <button
            type="button"
            role="option"
            aria-selected={allSelected}
            disabled={total === 0}
            onClick={toggleAll}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-brand-soft/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CheckboxMark checked={allSelected} indeterminate={someSelected} />
            All Warehouses
          </button>
          <div className="border-t border-line" />
          {total === 0 ? (
            <p className="px-3 py-2.5 text-xs text-ink-faint">
              No warehouses yet — create a warehouse first.
            </p>
          ) : (
            <div className="max-h-56 overflow-y-auto">
              {warehouses.map((w) => {
                const checked = selectedSet.has(w.id);
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggleOne(w.id)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-ink hover:bg-brand-soft/40"
                  >
                    <CheckboxMark checked={checked} />
                    <span className="truncate">{w.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
