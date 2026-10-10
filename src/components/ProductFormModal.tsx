"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import { Button, Field, Input, Modal, ProductThumb, Select, Spinner, useToast } from "./ui";
import { Icon } from "./icons";
import type { ProductRow, Warehouse } from "@/lib/types";

async function fileToDataUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const max = 512;
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process the image.");
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

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
  const [warehouseId, setWarehouseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSku(editing?.sku ?? "");
    setName(editing?.name ?? "");
    setImageUrl(editing?.imageUrl ?? "");
    setStockUnit(editing?.stockUnit ?? "piece");
    setCartonContains(String(editing?.cartonContains ?? 1));
    setOpeningQty("0");
    setWarehouseId(editing ? "" : (warehouses[0]?.id ? String(warehouses[0].id) : ""));
    setError(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    setImageBusy(true);
    setError(null);
    try {
      const dataUrl = await fileToDataUrl(file);
      setImageUrl(dataUrl);
    } catch {
      setError("Could not read that image. Try a different file.");
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
            imageUrl,
            stockUnit,
            cartonContains: Number(cartonContains),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Update failed.");
        toast.push("success", "Product updated", `${sku} saved.`);
      } else {
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
            warehouseId: warehouseId ? Number(warehouseId) : null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not create the product.");
        toast.push("success", "Product listed", `${sku} added to inventory.`);
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
              <input type="file" accept="image/*" className="hidden" onChange={onFile} />
            </label>
            {imageUrl ? (
              <button
                onClick={() => setImageUrl("")}
                className="block text-[11px] font-semibold text-out hover:underline"
              >
                Remove image
              </button>
            ) : (
              <p className="text-[11px] text-ink-faint">JPG/PNG, resized automatically.</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="SKU" required hint={editing ? "read-only" : "unique identifier"}>
            <Input
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
            <Field label="Opening stock warehouse" required>
              <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
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
          <Button variant="primary" onClick={submit} loading={busy} icon={editing ? "pencil" : "plus"}>
            {editing ? "Save changes" : "List product"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
