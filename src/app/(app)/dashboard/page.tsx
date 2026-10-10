import { and, eq, gte, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { products, transactions, warehouseStock, warehouses } from "@/db/schema";
import { Icon, type IconName } from "@/components/icons";
import { ProductThumb, TypeChip } from "@/components/ui";
import { TX_META } from "@/lib/txmeta";
import { fetchProductRows, fetchTransactionRows } from "@/lib/query";
import { fmtDateTime, fmtInt, splitCartons, stockLabel } from "@/lib/units";

export const dynamic = "force-dynamic";

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: IconName;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-faint">{label}</p>
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <Icon name={icon} className="h-3.5 w-3.5" />
        </span>
      </div>
      <p className="mt-2 font-display text-[26px] font-bold leading-none tracking-tight">{value}</p>
      <p className="mt-1.5 text-xs text-ink-soft">{sub}</p>
    </div>
  );
}

export default async function DashboardPage() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    [productAgg],
    [stockAgg],
    [whAgg],
    todayTx,
    productRows,
    recent,
    seriesResult,
  ] = await Promise.all([
    db.select({ value: sql<number>`count(*)::int` }).from(products),
    db
      .select({ value: sql<number>`coalesce(sum(${warehouseStock.qtyPieces}), 0)::int` })
      .from(warehouseStock),
    db.select({ value: sql<number>`count(*)::int` }).from(warehouses),
    db
      .select({
        type: transactions.type,
        count: sql<number>`count(*)::int`,
        pcs: sql<number>`coalesce(sum(${transactions.qtyPieces}), 0)::int`,
      })
      .from(transactions)
      .where(
        and(
          gte(transactions.createdAt, todayStart),
          inArray(transactions.type, ["inbound", "outbound"]),
        ),
      )
      .groupBy(transactions.type),
    fetchProductRows(),
    fetchTransactionRows({ limit: 8 }),
    db.execute(
      sql`select date_trunc('day', ${transactions.createdAt}) as d, ${transactions.type} as type, coalesce(sum(${transactions.qtyPieces}), 0)::int as pcs
          from transactions
          where ${transactions.type} in ('inbound', 'outbound')
            and ${transactions.createdAt} >= now() - interval '6 days'
          group by 1, 2`,
    ),
  ]);

  const todayIn = todayTx.find((t) => t.type === "inbound");
  const todayOut = todayTx.find((t) => t.type === "outbound");

  const lowStock = productRows
    .filter((p) => p.totalPieces < Math.max(p.cartonContains, 1))
    .sort((a, b) => a.totalPieces - b.totalPieces)
    .slice(0, 6);

  // 7-day series
  const days: Array<{ label: string; inPcs: number; outPcs: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({
      label: new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(d),
      inPcs: 0,
      outPcs: 0,
    });
  }
  for (const r of seriesResult.rows as Array<{ d: string; type: string; pcs: number }>) {
    const dayStart = new Date(r.d);
    dayStart.setHours(0, 0, 0, 0);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const idx = 6 - Math.round((now.getTime() - dayStart.getTime()) / 86_400_000);
    if (idx >= 0 && idx < 7) {
      if (r.type === "inbound") days[idx].inPcs += Number(r.pcs);
      else days[idx].outPcs += Number(r.pcs);
    }
  }
  const maxDay = Math.max(1, ...days.map((d) => Math.max(d.inPcs, d.outPcs)));

  const totalPcs = Number(stockAgg?.value ?? 0);

  return (
    <div className="rise-in space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Live overview of stock across all warehouses ·{" "}
            {new Intl.DateTimeFormat("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            }).format(new Date())}
          </p>
        </div>
        <Link
          href="/inventory"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3.5 py-2 text-[13px] font-semibold transition-colors hover:border-brand/50 hover:bg-brand-soft/40"
        >
          <Icon name="box" className="h-3.5 w-3.5" />
          Open inventory
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon="box"
          label="Products"
          value={fmtInt(Number(productAgg?.value ?? 0))}
          sub="SKUs in the catalog"
        />
        <StatCard
          icon="warehouse"
          label="Warehouses"
          value={fmtInt(Number(whAgg?.value ?? 0))}
          sub="Active storage locations"
        />
        <StatCard
          icon="grid"
          label="Stock on hand"
          value={`${fmtInt(totalPcs)} pcs`}
          sub={`${fmtInt(
            productRows.reduce((acc, p) => acc + splitCartons(p.totalPieces, p.cartonContains).cartons, 0),
          )} cartons equivalent across warehouses`}
        />
        <StatCard
          icon="swap"
          label="Today's movement"
          value={`+${fmtInt(Number(todayIn?.pcs ?? 0))} / −${fmtInt(Number(todayOut?.pcs ?? 0))}`}
          sub={`${Number(todayIn?.count ?? 0)} inbound · ${Number(todayOut?.count ?? 0)} outbound today`}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Recent activity */}
        <div className="rounded-xl border border-line bg-card">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="font-display text-sm font-bold tracking-tight">Recent activity</h2>
            <Link href="/transactions" className="text-xs font-semibold text-brand hover:underline">
              View all
            </Link>
          </div>
          <div className="divide-y divide-line">
            {recent.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-faint">
                No transactions yet.
              </p>
            ) : (
              recent.map((t) => (
                <Link
                  key={t.id}
                  href={`/products/${t.productId}`}
                  className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface"
                >
                  <TypeChip type={t.type} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold">
                      <span className="font-mono">{t.sku}</span>
                      {t.productName ? (
                        <span className="ml-2 font-normal text-ink-soft">{t.productName}</span>
                      ) : null}
                    </p>
                    <p className="truncate text-[11px] text-ink-faint">
                      {t.type === "transfer"
                        ? `${t.warehouseName ?? "—"} → ${t.toWarehouseName ?? "—"}`
                        : t.type === "outbound"
                          ? `${t.destination ?? "Out"} · ${t.warehouseName ?? "—"}`
                          : t.warehouseName ?? "—"}
                      {t.reason ? ` · “${t.reason}”` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-[13px] font-semibold">
                      {TX_META[t.type].sign}
                      {fmtInt(t.qtyPieces)} pcs
                    </p>
                    <p className="text-[11px] text-ink-faint">{fmtDateTime(t.createdAt)}</p>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          {/* Low stock */}
          <div className="rounded-xl border border-line bg-card">
            <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <h2 className="font-display text-sm font-bold tracking-tight">Low stock alerts</h2>
              <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-bold text-warn">
                {lowStock.length}
              </span>
            </div>
            {lowStock.length === 0 ? (
              <p className="px-5 py-6 text-center text-xs text-ink-faint">
                All products hold at least one full carton.
              </p>
            ) : (
              <div className="divide-y divide-line">
                {lowStock.map((p) => (
                  <Link
                    key={p.id}
                    href={`/products/${p.id}`}
                    className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-surface"
                  >
                    <ProductThumb src={p.imageUrl} name={p.name} size="h-8 w-8" rounded="rounded-md" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs font-semibold">{p.sku}</p>
                      <p className="truncate text-[11px] text-ink-faint">{p.name || "Unnamed product"}</p>
                    </div>
                    <div className="text-right">
                      {p.totalPieces === 0 ? (
                        <span className="rounded-full bg-out-soft px-2 py-0.5 text-[10px] font-bold uppercase text-out">
                          Out of stock
                        </span>
                      ) : (
                        <span className="font-mono text-xs font-semibold">
                          {stockLabel(p.totalPieces, p.cartonContains)}
                        </span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* 7 day movement */}
          <div className="rounded-xl border border-line bg-card p-5">
            <h2 className="font-display text-sm font-bold tracking-tight">Movement · last 7 days</h2>
            <div className="mt-4 flex h-28 items-end gap-2">
              {days.map((d, i) => (
                <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
                  <div className="flex h-24 w-full items-end justify-center gap-[3px]">
                    <div
                      className="w-[38%] rounded-t-sm bg-in/85"
                      style={{ height: `${Math.max((d.inPcs / maxDay) * 100, d.inPcs > 0 ? 6 : 2)}%`, opacity: d.inPcs === 0 ? 0.18 : 1 }}
                      title={`In ${d.inPcs} pcs`}
                    />
                    <div
                      className="w-[38%] rounded-t-sm bg-out/85"
                      style={{ height: `${Math.max((d.outPcs / maxDay) * 100, d.outPcs > 0 ? 6 : 2)}%`, opacity: d.outPcs === 0 ? 0.18 : 1 }}
                      title={`Out ${d.outPcs} pcs`}
                    />
                  </div>
                  <span className="text-[10px] font-semibold text-ink-faint">{d.label}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-4 text-[11px] text-ink-soft">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-in" /> Inbound (pcs)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-out" /> Outbound (pcs)
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
