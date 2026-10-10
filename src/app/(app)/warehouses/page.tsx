"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  useToast,
} from "@/components/ui";
import { fmtDate, fmtInt } from "@/lib/units";
import type { ProductRow, Warehouse } from "@/lib/types";

export default function WarehousesPage() {
  const toast = useToast();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Warehouse | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<Warehouse | null>(null);

  const load = useCallback(async () => {
    try {
      const [wRes, pRes] = await Promise.all([
        fetch("/api/warehouses"),
        fetch("/api/products"),
      ]);
      const [wData, pData] = await Promise.all([wRes.json(), pRes.json()]);
      if (!wRes.ok || !pRes.ok) throw new Error(wData.error ?? pData.error ?? "Load failed.");
      setWarehouses(wData.warehouses ?? []);
      setProducts(pData.products ?? []);
    } catch (e) {
      toast.push("error", "Failed to load warehouses", e instanceof Error ? e.message : undefined);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(() => {
    const map = new Map<number, { skus: number; pieces: number }>();
    for (const p of products) {
      for (const s of p.stocks) {
        const cur = map.get(s.warehouseId) ?? { skus: 0, pieces: 0 };
        if (s.qtyPieces > 0) cur.skus += 1;
        cur.pieces += s.qtyPieces;
        map.set(s.warehouseId, cur);
      }
    }
    return map;
  }, [products]);

  async function create() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/warehouses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create warehouse.");
      toast.push("success", "Warehouse created", data.warehouse.name);
      setNewName("");
      load();
    } catch (e) {
      toast.push("error", "Could not create warehouse", e instanceof Error ? e.message : undefined);
    } finally {
      setCreating(false);
    }
  }

  async function rename() {
    if (!renaming || !renameValue.trim()) return;
    try {
      const res = await fetch(`/api/warehouses/${renaming.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: renameValue.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Rename failed.");
      toast.push("success", "Warehouse renamed", data.warehouse.name);
      setRenaming(null);
      load();
    } catch (e) {
      toast.push("error", "Rename failed", e instanceof Error ? e.message : undefined);
    }
  }

  async function remove() {
    if (!deleting) return;
    try {
      const res = await fetch(`/api/warehouses/${deleting.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Delete failed.");
      toast.push("success", "Warehouse deleted", deleting.name);
      setDeleting(null);
      load();
    } catch (e) {
      toast.push("error", "Cannot delete warehouse", e instanceof Error ? e.message : undefined);
      setDeleting(null);
    }
  }

  return (
    <div className="rise-in space-y-5">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Warehouses</h1>
        <p className="mt-1 text-sm text-ink-faint">
          Stock is tracked separately per warehouse, with combined totals on every product.
        </p>
      </div>

      {/* Create */}
      <div className="flex items-end gap-2 rounded-xl border border-line bg-card p-4">
        <div className="max-w-sm flex-1">
          <Field label="New warehouse name" required>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
              placeholder="e.g. North Annex"
              maxLength={60}
            />
          </Field>
        </div>
        <Button variant="primary" icon="plus" onClick={create} loading={creating} disabled={!newName.trim()}>
          Add warehouse
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-ink/5" />
          ))}
        </div>
      ) : warehouses.length === 0 ? (
        <EmptyState
          icon="warehouse"
          title="No warehouses yet"
          text="Create your first warehouse above — every stock operation needs one."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {warehouses.map((w) => {
            const s = stats.get(w.id) ?? { skus: 0, pieces: 0 };
            return (
              <div key={w.id} className="rounded-xl border border-line bg-card p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
                      <Icon name="warehouse" className="h-4.5 w-4.5" />
                    </span>
                    <div>
                      <h2 className="font-display text-[15px] font-bold tracking-tight">{w.name}</h2>
                      <p className="text-[11px] text-ink-faint">Created {fmtDate(w.createdAt)}</p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        setRenaming(w);
                        setRenameValue(w.name);
                      }}
                      className="rounded-md p-2 text-ink-faint transition-colors hover:bg-ink/5 hover:text-brand"
                      title="Rename"
                    >
                      <Icon name="pencil" className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleting(w)}
                      className="rounded-md p-2 text-ink-faint transition-colors hover:bg-out-soft hover:text-out"
                      title="Delete"
                    >
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-surface px-3.5 py-2.5 ring-1 ring-line">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                      Stocked SKUs
                    </p>
                    <p className="mt-0.5 font-display text-lg font-bold">{fmtInt(s.skus)}</p>
                  </div>
                  <div className="rounded-lg bg-surface px-3.5 py-2.5 ring-1 ring-line">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                      Pieces on hand
                    </p>
                    <p className="mt-0.5 font-display text-lg font-bold">{fmtInt(s.pieces)}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Rename modal */}
      <Modal
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Rename warehouse"
        subtitle={renaming ? `Currently “${renaming.name}”` : undefined}
        width="max-w-sm"
      >
        <div className="space-y-4">
          <Field label="New name" required>
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename();
              }}
              maxLength={60}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={rename} disabled={!renameValue.trim()}>
              Save
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete warehouse?"
        width="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-soft">
            “{deleting?.name}” will be permanently removed. Warehouses that still hold stock or
            appear in transaction history cannot be deleted, to keep records traceable.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" icon="trash" onClick={remove}>
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
