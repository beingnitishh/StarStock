"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { TxTable } from "@/components/TxTable";
import { Button, EmptyState, Input, Select, TX_META } from "@/components/ui";
import type { OpType, TxRow, Warehouse } from "@/lib/types";

export default function TransactionsPage() {
  const [rows, setRows] = useState<TxRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [type, setType] = useState<OpType | "all">("all");
  const [warehouseId, setWarehouseId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 350);
    return () => window.clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedQ) params.set("q", debouncedQ);
      if (type !== "all") params.set("type", type);
      if (warehouseId) params.set("warehouseId", warehouseId);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("limit", "300");
      const res = await fetch(`/api/transactions?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load transactions.");
      setRows(data.transactions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load transactions.");
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, type, warehouseId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    fetch("/api/warehouses")
      .then((r) => r.json())
      .then((d) => setWarehouses(d.warehouses ?? []))
      .catch(() => {});
  }, []);

  const hasFilters = q !== "" || type !== "all" || warehouseId !== "" || from !== "" || to !== "";

  return (
    <div className="rise-in space-y-5">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Transactions</h1>
        <p className="mt-1 text-sm text-ink-faint">
          Every inbound, outbound, transfer and adjustment — with date, time and reason.
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-2.5 rounded-xl border border-line bg-card p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[240px] flex-1">
            <Icon
              name="search"
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search SKU, product, reason or destination…"
              className="pl-9"
            />
          </div>
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-44">
            <option value="">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-1.5 text-xs text-ink-faint">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-36" />
            <span>→</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-36" />
          </div>
          {hasFilters ? (
            <Button
              variant="ghost"
              size="sm"
              icon="x"
              onClick={() => {
                setQ("");
                setType("all");
                setWarehouseId("");
                setFrom("");
                setTo("");
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg bg-ink/5 p-1">
          {(["all", "inbound", "outbound", "transfer", "adjustment"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`rounded-md px-3 py-1.5 text-xs font-bold capitalize transition-colors ${
                type === t ? "bg-card text-ink shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              {t === "all" ? "All types" : TX_META[t].label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-ink/5" />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon="alert"
          title="Could not load transactions"
          text={error}
          action={<Button variant="primary" onClick={load}>Retry</Button>}
        />
      ) : (
        <>
          <p className="text-xs text-ink-faint">
            Showing {rows.length} transaction{rows.length === 1 ? "" : "s"} · newest first
            {rows.length >= 300 ? " · refine filters to narrow further" : ""}
          </p>
          <TxTable rows={rows} />
        </>
      )}
    </div>
  );
}
