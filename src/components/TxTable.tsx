"use client";

import Link from "next/link";
import { EmptyState, TypeChip, TX_META } from "./ui";
import { fmtDateTime, fmtInt } from "@/lib/units";
import type { TxRow } from "@/lib/types";

function ChangeCell({ tx }: { tx: TxRow }) {
  const sign = TX_META[tx.type].sign;
  const enteredNote =
    tx.enteredUnit === "carton"
      ? `${fmtInt(tx.enteredQty)} CTN`
      : tx.qtyPieces !== tx.enteredQty
        ? `${fmtInt(tx.enteredQty)} PCS`
        : null;

  if (tx.type === "adjustment") {
    return (
      <div>
        <p className="font-mono text-[13px] font-semibold text-adj">
          → {fmtInt(tx.qtyPieces)} pcs
        </p>
        <p className="text-[11px] text-ink-faint">
          final stock set{enteredNote ? ` · entered ${enteredNote}` : ""}
        </p>
      </div>
    );
  }

  const color =
    tx.type === "inbound" ? "text-in" : tx.type === "outbound" ? "text-out" : "text-move";
  return (
    <div>
      <p className={`font-mono text-[13px] font-semibold ${color}`}>
        {sign}
        {fmtInt(tx.qtyPieces)} pcs
      </p>
      {enteredNote ? <p className="text-[11px] text-ink-faint">entered {enteredNote}</p> : null}
    </div>
  );
}

function WarehouseCell({ tx }: { tx: TxRow }) {
  if (tx.type === "transfer") {
    return (
      <span className="text-xs">
        <span className="font-semibold">{tx.warehouseName ?? "—"}</span>
        <span className="mx-1 text-ink-faint">→</span>
        <span className="font-semibold">{tx.toWarehouseName ?? "—"}</span>
      </span>
    );
  }
  if (tx.type === "inbound") {
    return (
      <span className="text-xs">
        <span className="text-ink-faint">into </span>
        <span className="font-semibold">{tx.warehouseName ?? "—"}</span>
      </span>
    );
  }
  if (tx.type === "outbound") {
    return (
      <span className="text-xs">
        <span className="text-ink-faint">from </span>
        <span className="font-semibold">{tx.warehouseName ?? "—"}</span>
      </span>
    );
  }
  return <span className="text-xs font-semibold">{tx.warehouseName ?? "—"}</span>;
}

export function TxTable({
  rows,
  showProduct = true,
}: {
  rows: TxRow[];
  showProduct?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title="No transactions found"
        text="Adjust the filters or record a stock operation to see it appear here."
      />
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-card">
      <table className="w-full min-w-[820px] text-left">
        <thead>
          <tr className="border-b border-line bg-surface text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
            <th className="px-4 py-2.5">Date & time</th>
            <th className="px-4 py-2.5">Type</th>
            {showProduct ? <th className="px-4 py-2.5">Product</th> : null}
            <th className="px-4 py-2.5">Change</th>
            <th className="px-4 py-2.5">Warehouse</th>
            <th className="px-4 py-2.5">Destination / reason</th>
            <th className="px-4 py-2.5">By</th>
            <th className="px-4 py-2.5 text-right">Total after</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((tx) => (
            <tr key={tx.id} className="transition-colors hover:bg-surface/70">
              <td className="whitespace-nowrap px-4 py-3 align-top">
                <p className="text-xs font-semibold">{fmtDateTime(tx.createdAt)}</p>
              </td>
              <td className="px-4 py-3 align-top">
                <TypeChip type={tx.type} />
              </td>
              {showProduct ? (
                <td className="px-4 py-3 align-top">
                  <Link
                    href={`/products/${tx.productId}`}
                    className="font-mono text-xs font-bold text-brand hover:underline"
                  >
                    {tx.sku}
                  </Link>
                  {tx.productName ? (
                    <p className="mt-0.5 max-w-[180px] truncate text-[11px] text-ink-faint">
                      {tx.productName}
                    </p>
                  ) : null}
                </td>
              ) : null}
              <td className="px-4 py-3 align-top">
                <ChangeCell tx={tx} />
              </td>
              <td className="px-4 py-3 align-top">
                <WarehouseCell tx={tx} />
              </td>
              <td className="max-w-[220px] px-4 py-3 align-top">
                {tx.destination ? (
                  <p className="truncate text-xs font-semibold">{tx.destination}</p>
                ) : null}
                {tx.reason ? (
                  <p className="mt-0.5 truncate text-[11px] italic text-ink-soft" title={tx.reason}>
                    “{tx.reason}”
                  </p>
                ) : !tx.destination ? (
                  <span className="text-xs text-ink-faint">—</span>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-4 py-3 align-top text-xs text-ink-soft">
                {tx.userName ?? "—"}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right align-top font-mono text-xs font-semibold">
                {fmtInt(tx.resultingTotalPieces)} pcs
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
